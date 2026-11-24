import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import type { ResolvedDecisionConfig } from "./config.js";
import { DecisionError } from "./errors.js";

function firstNonEmpty(values: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = values[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolves the bearer credential for a resolved decision-model config:
 *   1. Inline `apiKey`
 *   2. Explicit `apiKeyFile` (raw token or dotenv parsed against `fileEnvKeys` only; ENOENT -> undefined)
 *   3. Ambient `process.env` checked strictly against `ambientEnvKeys` (empty on custom/unlisted origins)
 *
 * Errors are sanitized and never include token contents or file paths.
 */
export async function resolveDecisionApiKey(
  config: Pick<ResolvedDecisionConfig, "apiKey" | "apiKeyFile" | "ambientEnvKeys" | "fileEnvKeys">,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (config.apiKey !== undefined) {
    const inline = config.apiKey.trim();
    if (!inline || /\s/u.test(inline)) {
      throw new DecisionError("Decision model apiKey must be a non-empty token without whitespace", "invalid_credential");
    }
    return inline;
  }
  if (!config.apiKeyFile) {
    return firstNonEmpty(env, config.ambientEnvKeys);
  }
  let contents: string;
  try {
    contents = (await readFile(config.apiKeyFile, "utf8")).trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new DecisionError("Decision model credential file could not be read", "invalid_credential");
  }
  if (!contents) return undefined;
  if (/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(contents) || contents.startsWith("#")) {
    return firstNonEmpty(parseEnv(contents), config.fileEnvKeys);
  }
  if (/\s/u.test(contents)) {
    throw new DecisionError("Decision model credential file must contain a key or dotenv entries", "invalid_credential");
  }
  return contents;
}
