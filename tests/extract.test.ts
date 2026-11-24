import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_SYSTEMONE_ENDPOINT,
  createDecisionClient,
  dateField,
  estimateField,
  listField,
  numberField,
  textField,
} from "../index.js";

test("extract() posts to derived /extractions endpoint, validates fields, and normalizes prompt/completion usage", async () => {
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
            vendor: { type: "text", value: "Acme Corp", p_null: 0.01, confidence: 0.98, span: [42, 51] },
            total: { type: "number", value: 3850, p_null: 0.001, confidence: 0.99 },
            due_date: { type: "date", value: "2026-11-28", p_null: 0.02, confidence: 0.97 },
          },
          usage: { prompt_tokens: 400, completion_tokens: 35, total_tokens: 435 },
        });
      },
    },
  );

  const result = await client.extract(
    "Invoice total is $3,850 due by 2026-11-28 from Acme Corp.",
    {
      vendor: textField({ null_threshold: 0.5 }),
      total: numberField({ decimals: 2, null_threshold: 0.5 }),
      due_date: dateField({ null_threshold: 0.5 }),
    },
  );

  assert.equal(seenUrl, "https://codex.unblocklabs.ai/v1/extractions");
  assert.equal(seenBody?.model, "liquid/d1.2-ultra");
  assert.equal(seenBody?.state, "Invoice total is $3,850 due by 2026-11-28 from Acme Corp.");
  assert.equal(result.answers.vendor.value, "Acme Corp");
  assert.equal(result.answers.total.value, 3850);
  assert.equal(result.answers.due_date.value, "2026-11-28");
  assert.deepEqual(result.usage, { input_tokens: 400, output_tokens: 35 });
});

test("extract() enforces Liquid d1.2 null_threshold and image-asset constraints before network calls", async () => {
  let called = false;
  const client = createDecisionClient(
    { apiKey: "test-key" },
    {
      fetch: async () => {
        called = true;
        return Response.json({
          model: "liquid/d1.2-ultra",
          answers: { count: { type: "estimate", mean: 4.2, median: 4, p10: 3, p90: 6 } },
        });
      },
    },
  );

  // Missing null_threshold on d1.2 text field fails before dispatch
  await assert.rejects(
    client.extract("hello", { vendor: textField() }),
    { name: "DecisionError", code: "invalid_config" },
  );
  // Image asset paired with text field on d1.2 fails before dispatch
  await assert.rejects(
    client.extract("hello", { vendor: textField({ null_threshold: 0.5 }) }, {
      assets: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
    }),
    { name: "DecisionError", code: "invalid_config" },
  );
  // null_threshold rejected on list field
  await assert.rejects(
    client.extract("hello", { items: listField({ null_threshold: 0.5 } as never) }),
    { name: "DecisionError", code: "invalid_config" },
  );
  assert.equal(called, false);

  // Image asset with estimate field succeeds on d1.2
  const est = await client.extract("Estimate count", { count: estimateField({ unit: "boxes" }) }, {
    assets: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
  });
  assert.equal(called, true);
  assert.equal(est.answers.count.median, 4);

  // Legacy /systemone without extractionsEndpoint rejects extract() cleanly
  const legacy = createDecisionClient({ endpoint: LEGACY_SYSTEMONE_ENDPOINT, apiKey: "k" });
  await assert.rejects(
    legacy.extract("hello", { vendor: textField({ null_threshold: 0.5 }) }),
    { name: "DecisionError", code: "invalid_config" },
  );
});
