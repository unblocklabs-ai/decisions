import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DECISIONS_ENDPOINT,
  DEFAULT_DECISIONS_MODEL,
  LEGACY_SYSTEMONE_ENDPOINT,
  LEGACY_SYSTEMONE_MODEL,
  decisionModelScope,
  deriveExtractionsEndpoint,
  estimateStateTokens,
  matchesDecisionModel,
  resolveDecisionConfig,
} from "../index.js";

test("resolveDecisionConfig defaults to Codex LB decisions and derives /extractions", () => {
  const cfg = resolveDecisionConfig();
  assert.equal(cfg.endpoint, DEFAULT_DECISIONS_ENDPOINT);
  assert.equal(cfg.extractionsEndpoint, "https://codex.unblocklabs.ai/v1/extractions");
  assert.equal(cfg.model, DEFAULT_DECISIONS_MODEL);
  assert.equal(cfg.dialect, "decisions");
  assert.equal(cfg.timeoutMs, 1500);
  assert.deepEqual(cfg.ambientEnvKeys, ["CODEX_LB_API_KEY"]);
  assert.deepEqual(cfg.fileEnvKeys, ["CODEX_LB_API_KEY"]);
});

test("resolveDecisionConfig infers legacy SystemOne defaults and omits extractionsEndpoint", () => {
  const cfg = resolveDecisionConfig({ endpoint: `${LEGACY_SYSTEMONE_ENDPOINT}///` });
  assert.equal(cfg.endpoint, LEGACY_SYSTEMONE_ENDPOINT);
  assert.equal(cfg.extractionsEndpoint, undefined);
  assert.equal(cfg.model, LEGACY_SYSTEMONE_MODEL);
  assert.equal(cfg.dialect, "systemone");
  assert.deepEqual(cfg.ambientEnvKeys, ["TYPESAFE_API_KEY"]);
  assert.deepEqual(cfg.fileEnvKeys, ["TYPESAFE_API_KEY"]);
});

test("resolveDecisionConfig enforces HTTPS or loopback HTTP and rejects unsafe URLs and dated Codex models", () => {
  for (const ok of [
    "https://openrouter.ai/api/alpha/decisions",
    "http://127.0.0.1:8787/v1/decisions",
    "http://localhost:8787/v1/decisions",
    "http://[::1]:8787/v1/decisions",
  ]) {
    const resolved = resolveDecisionConfig({ endpoint: ok });
    assert.equal(resolved.endpoint, ok);
    assert.deepEqual(resolved.ambientEnvKeys, []);
    assert.equal(resolved.extractionsEndpoint, deriveExtractionsEndpoint(ok));
  }

  for (const bad of [
    { endpoint: "http://evil.example/v1/decisions" },
    { endpoint: "http://api.typesafe.ai/v1/systemone" },
    { endpoint: "ftp://other.example/v1/decisions" },
    { endpoint: "https://" },
    { endpoint: "https://:443/v1/decisions" },
    { endpoint: "https://user:pass@other.example/v1/decisions" },
    { endpoint: "https://other.example/v1/decisions?" },
    { endpoint: "https://other.example/v1/decisions#" },
    { endpoint: "https://other.example/v1/decisions?a=1" },
    { endpoint: "https://other.example/v1/decisions#frag" },
    { endpoint: " https://codex.unblocklabs.ai/v1/decisions " },
    { endpoint: "https://codex.unblocklabs.ai/v1/decisions path" },
    { model: " " },
    { model: "liquid/d1.2-ultra-20261116" },
    { apiKey: "a", apiKeyFile: "/tmp/key" },
    { apiKeyFile: "relative/key.env" },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { timeoutMs: 1.5 },
  ]) {
    assert.throws(() => resolveDecisionConfig(bad as never), { name: "DecisionError", code: "invalid_config" });
  }
});

test("matchesDecisionModel, decisionModelScope, and estimateStateTokens behave strictly", () => {
  assert.equal(matchesDecisionModel("liquid/d1.2-ultra", "liquid/d1.2-ultra"), true);
  assert.equal(matchesDecisionModel("liquid/d1.2-ultra-20261116", "liquid/d1.2-ultra"), true);
  assert.equal(matchesDecisionModel("liquid/d1.2-ultra-2026-11-16", "liquid/d1.2-ultra"), true);
  assert.equal(matchesDecisionModel("jev-1.14.0", "jev-latest"), true);
  for (const bad of ["liquid/d1.2-ultra-mini", "liquid/d1.2-ultra-", "liquid/d1.2-ultra2", "jev-1.13.0", "", 42, null]) {
    assert.equal(matchesDecisionModel(bad, "liquid/d1.2-ultra"), false, String(bad));
  }

  assert.equal(decisionModelScope("liquid/d1.2-ultra", DEFAULT_DECISIONS_ENDPOINT), "liquid/d1.2-ultra");
  assert.equal(decisionModelScope("jev-1.13.0", LEGACY_SYSTEMONE_ENDPOINT), "jev-1.13.0");
  assert.equal(
    decisionModelScope("liquid/d1.2-ultra", "https://openrouter.ai/api/alpha/decisions"),
    "liquid/d1.2-ultra@https://openrouter.ai/api/alpha/decisions",
  );
  assert.equal(estimateStateTokens("123456"), 2);
});
