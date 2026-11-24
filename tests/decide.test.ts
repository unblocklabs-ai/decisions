import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_SYSTEMONE_ENDPOINT,
  choice,
  classifyDecisionFailure,
  createDecisionClient,
  noul,
  score,
} from "../index.js";

test("decide() sends array-wrapped state on /decisions, validates answers, strips extra keys, and normalizes usage", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> | undefined;
  const client = createDecisionClient(
    { apiKey: "test-key" },
    {
      fetch: async (url, init) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init?.body));
        return Response.json({
          model: "liquid/d1.2-ultra-20261116",
          answers: {
            useful: { type: "noul", noul: 0.88, extra_provider_field: "ignored" },
            kind: {
              type: "choice",
              choice: "a",
              confidence: 0.7,
              probabilities: { a: 0.7, b: 0.3 },
            },
            quality: {
              type: "score",
              score: 2.1,
              confidence: 0.8,
              probabilities: { "0": 0.05, "1": 0.1, "2": 0.55, "3": 0.3 },
            },
          },
          usage: { input_tokens: 120, output_tokens: 0, cost: 0.0001 },
        });
      },
    },
  );

  const result = await client.decide(
    { request: "hello" },
    {
      useful: noul("Useful?"),
      kind: choice("Kind?", { a: "Option A", b: "Option B" }),
      quality: score("Quality?", ["0", "1", "2", "3"]),
    },
  );

  assert.equal(seenUrl, "https://codex.unblocklabs.ai/v1/decisions");
  assert.equal(seenBody?.model, "liquid/d1.2-ultra");
  assert.deepEqual(seenBody?.state, [{ request: "hello" }]);
  assert.equal(result.model, "liquid/d1.2-ultra-20261116");
  assert.deepEqual(result.answers.useful, { type: "noul", noul: 0.88 });
  assert.equal(result.answers.kind.choice, "a");
  assert.equal(result.answers.quality.score, 2.1);
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 0 });
});

test("decide() sends bare object state on legacy /systemone", async () => {
  let seenBody: Record<string, unknown> | undefined;
  const client = createDecisionClient(
    { endpoint: LEGACY_SYSTEMONE_ENDPOINT, apiKey: "legacy-key" },
    {
      fetch: async (_url, init) => {
        seenBody = JSON.parse(String(init?.body));
        return Response.json({
          model: "jev-1.13.0",
          answers: { ok: { type: "noul", noul: 0.5 } },
        });
      },
    },
  );

  const result = await client.decide({ text: "hi" }, { ok: noul("Ok?") });
  assert.equal(seenBody?.model, "jev-1.13.0");
  assert.deepEqual(seenBody?.state, { text: "hi" });
  assert.equal(result.answers.ok.noul, 0.5);
});

test("decide() allows 2-decimal rounding across 8 options but rejects extra unknown probability keys", async () => {
  const options = { o1: "1", o2: "2", o3: "3", o4: "4", o5: "5", o6: "6", o7: "7", o8: "8" };
  const validRounded = Object.fromEntries(Object.keys(options).map(k => [k, 0.13])); // sum = 1.04

  const okClient = createDecisionClient(
    { apiKey: "k" },
    {
      fetch: async () => Response.json({
        model: "liquid/d1.2-ultra",
        answers: { target: { type: "choice", choice: "o1", confidence: 0.13, probabilities: validRounded } },
      }),
    },
  );
  const res = await okClient.decide("state", { target: choice("Pick", options) });
  assert.equal(res.answers.target.choice, "o1");

  const badClient = createDecisionClient(
    { apiKey: "k" },
    {
      fetch: async () => Response.json({
        model: "liquid/d1.2-ultra",
        answers: {
          target: {
            type: "choice",
            choice: "o1",
            confidence: 0.132,
            probabilities: { ...Object.fromEntries(Object.keys(options).map(k => [k, 0.132])), bogus1: 0, bogus2: 0 },
          },
        },
      }),
    },
  );
  await assert.rejects(badClient.decide("state", { target: choice("Pick", options) }), {
    name: "DecisionError",
    code: "invalid_response",
  });
});

test("decide() scopes 503 Retry-After to confirmed pre-dispatch origins, sanitizes errors, and honors timeout/abort", async () => {
  const codexClient = createDecisionClient(
    { apiKey: "k" },
    { fetch: async () => new Response("secret-body", { status: 503, headers: { "Retry-After": "3" } }) },
  );
  await assert.rejects(
    codexClient.decide("s", { ok: noul("?") }),
    err => {
      assert.equal(err instanceof Error && !err.message.includes("secret-body"), true);
      assert.deepEqual(classifyDecisionFailure(err), { status: "failed", error: "http_503" });
      return true;
    },
  );

  const legacyClient = createDecisionClient(
    { endpoint: LEGACY_SYSTEMONE_ENDPOINT, apiKey: "k" },
    { fetch: async () => new Response("busy", { status: 503, headers: { "Retry-After": "3" } }) },
  );
  await assert.rejects(
    legacyClient.decide("s", { ok: noul("?") }),
    err => {
      assert.deepEqual(classifyDecisionFailure(err), { status: "ambiguous", error: "http_503" });
      return true;
    },
  );

  const slowClient = createDecisionClient(
    { apiKey: "k", timeoutMs: 25 },
    {
      fetch: async (_url, init) => new Promise<Response>((_res, rej) => {
        const timer = setTimeout(() => rej(new Error("timeout did not fire")), 1000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); rej(init.signal?.reason); }, { once: true });
      }),
    },
  );
  await assert.rejects(slowClient.decide("s", { ok: noul("?") }), { name: "DecisionError", code: "timeout" });

  // Caller cancellation is distinguished from timeout
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(
    slowClient.decide("s", { ok: noul("?") }, { signal: controller.signal }),
    { name: "DecisionError", code: "cancelled" },
  );
});
