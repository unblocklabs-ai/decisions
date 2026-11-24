import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LEGACY_SYSTEMONE_ENDPOINT,
  resolveDecisionApiKey,
  resolveDecisionConfig,
} from "../index.js";

test("credentials strictly isolate Codex LB, legacy TypeSafe, and custom origins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decisions-cred-"));
  const mixedEnvFile = join(dir, "mixed.env");
  const legacyOnlyFile = join(dir, "legacy.env");
  const codexOnlyFile = join(dir, "codex.env");
  const rawKeyFile = join(dir, "raw.key");
  const badKeyFile = join(dir, "bad.key");

  await writeFile(mixedEnvFile, 'TYPESAFE_API_KEY="ts-secret"\nCODEX_LB_API_KEY="codex-secret"\n');
  await writeFile(legacyOnlyFile, 'TYPESAFE_API_KEY="ts-only"\n');
  await writeFile(codexOnlyFile, 'CODEX_LB_API_KEY="codex-only"\n');
  await writeFile(rawKeyFile, "raw-bearer-token\n");
  await writeFile(badKeyFile, "not a valid single token\n");

  const envBoth = { CODEX_LB_API_KEY: "env-codex", TYPESAFE_API_KEY: "env-ts" };
  const envTsOnly = { TYPESAFE_API_KEY: "env-ts" };
  const envCodexOnly = { CODEX_LB_API_KEY: "env-codex" };

  // Ambient env isolation
  assert.equal(await resolveDecisionApiKey(resolveDecisionConfig(), envBoth), "env-codex");
  assert.equal(await resolveDecisionApiKey(resolveDecisionConfig(), envTsOnly), undefined);
  assert.equal(
    await resolveDecisionApiKey(resolveDecisionConfig({ endpoint: LEGACY_SYSTEMONE_ENDPOINT }), envBoth),
    "env-ts",
  );
  assert.equal(
    await resolveDecisionApiKey(resolveDecisionConfig({ endpoint: LEGACY_SYSTEMONE_ENDPOINT }), envCodexOnly),
    undefined,
  );
  // Custom HTTPS and loopback HTTP get ZERO ambient env fallback
  assert.equal(
    await resolveDecisionApiKey(resolveDecisionConfig({ endpoint: "https://custom.example/v1/decisions" }), envBoth),
    undefined,
  );
  assert.equal(
    await resolveDecisionApiKey(resolveDecisionConfig({ endpoint: "http://127.0.0.1:8787/v1/decisions" }), envBoth),
    undefined,
  );

  // Dotenv file provider isolation
  assert.equal(await resolveDecisionApiKey(resolveDecisionConfig({ apiKeyFile: mixedEnvFile }), {}), "codex-secret");
  assert.equal(await resolveDecisionApiKey(resolveDecisionConfig({ apiKeyFile: legacyOnlyFile }), {}), undefined);
  assert.equal(
    await resolveDecisionApiKey(resolveDecisionConfig({ endpoint: LEGACY_SYSTEMONE_ENDPOINT, apiKeyFile: mixedEnvFile }), {}),
    "ts-secret",
  );
  assert.equal(
    await resolveDecisionApiKey(resolveDecisionConfig({ endpoint: LEGACY_SYSTEMONE_ENDPOINT, apiKeyFile: codexOnlyFile }), {}),
    undefined,
  );

  // Raw token file, missing file, inline key, whitespace rejection
  assert.equal(await resolveDecisionApiKey(resolveDecisionConfig({ apiKeyFile: rawKeyFile }), {}), "raw-bearer-token");
  assert.equal(await resolveDecisionApiKey(resolveDecisionConfig({ apiKeyFile: join(dir, "missing.env") }), envBoth), undefined);
  assert.equal(await resolveDecisionApiKey(resolveDecisionConfig({ apiKey: "inline-key" }), {}), "inline-key");
  await assert.rejects(
    resolveDecisionApiKey(resolveDecisionConfig({ apiKeyFile: badKeyFile }), {}),
    { name: "DecisionError", code: "invalid_credential" },
  );
  await assert.rejects(
    resolveDecisionApiKey({ apiKey: "", ambientEnvKeys: ["CODEX_LB_API_KEY"], fileEnvKeys: [] }, envBoth),
    { name: "DecisionError", code: "invalid_credential" },
  );
});
