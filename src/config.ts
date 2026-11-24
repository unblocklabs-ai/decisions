import { isAbsolute } from "node:path";
import { DecisionError } from "./errors.js";

export const DEFAULT_DECISIONS_ENDPOINT = "https://codex.unblocklabs.ai/v1/decisions";
export const DEFAULT_DECISIONS_MODEL = "liquid/d1.2-ultra";
export const LEGACY_SYSTEMONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const LEGACY_SYSTEMONE_MODEL = "jev-1.13.0";

const CODEX_ORIGIN = "https://codex.unblocklabs.ai";
const LEGACY_ORIGIN = "https://api.typesafe.ai";
const DATE_SNAPSHOT_SUFFIX = /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/u;
const JEV_VERSION = /^jev-\d+\.\d+\.\d+$/u;

export type DecisionDialect = "decisions" | "systemone";

export interface DecisionModelConfig {
  /** Decision endpoint URL (HTTPS, or loopback HTTP for local development/tests). */
  endpoint?: string;
  /** Model alias sent in request body (e.g. "liquid/d1.2-ultra" or "jev-1.13.0"). */
  model?: string;
  /** Inline bearer token (mutually exclusive with apiKeyFile). */
  apiKey?: string;
  /** Absolute path to a raw token or dotenv file (mutually exclusive with apiKey). */
  apiKeyFile?: string;
  /** Optional explicit extractions endpoint. Derived from trailing `/decisions` -> `/extractions` when omitted. */
  extractionsEndpoint?: string;
  /** Per-request timeout in ms (1..60000). Defaults to 1500. */
  timeoutMs?: number;
  /** Wire dialect. "auto" uses "systemone" when path ends with "/systemone" and "decisions" otherwise. */
  dialect?: "auto" | DecisionDialect;
  /** Explicit environment variable names allowed for ambient process.env lookup. */
  ambientEnvKeys?: readonly string[];
  /** Explicit environment variable names allowed when parsing a dotenv apiKeyFile. */
  fileEnvKeys?: readonly string[];
  /** Origins whose HTTP 503 + Retry-After responses are confirmed pre-dispatch rejections. */
  preDispatchRetryAfterOrigins?: readonly string[];
}

export interface ResolvedDecisionConfig {
  endpoint: string;
  extractionsEndpoint?: string;
  model: string;
  apiKey?: string;
  apiKeyFile?: string;
  timeoutMs: number;
  dialect: DecisionDialect;
  ambientEnvKeys: readonly string[];
  fileEnvKeys: readonly string[];
  preDispatchRetryAfterOrigins: readonly string[];
}

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "[::1]" || lower === "::1";
}

function originOf(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function isSystemOnePath(endpoint: string): boolean {
  try {
    return new URL(endpoint).pathname.replace(/\/+$/u, "").endsWith("/systemone");
  } catch {
    return false;
  }
}

export function validateDecisionEndpoint(rawEndpoint: unknown, label = "endpoint"): string {
  if (
    typeof rawEndpoint !== "string" ||
    !rawEndpoint ||
    /\s/u.test(rawEndpoint) ||
    rawEndpoint.includes("?") ||
    rawEndpoint.includes("#")
  ) {
    throw new DecisionError(
      `Decision model ${label} must be an HTTPS (or loopback HTTP) URL without whitespace, query, or fragment`,
      "invalid_config",
    );
  }
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new DecisionError(
      `Decision model ${label} must be an HTTPS (or loopback HTTP) URL`,
      "invalid_config",
    );
  }
  const allowedProtocol = url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname));
  if (!allowedProtocol || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new DecisionError(
      `Decision model ${label} must be an HTTPS (or loopback HTTP) URL without credentials, query, or fragment`,
      "invalid_config",
    );
  }
  return url.href.replace(/\/+$/u, "");
}

export function deriveExtractionsEndpoint(decisionsEndpoint: string): string | undefined {
  try {
    const url = new URL(decisionsEndpoint);
    const trimmedPath = url.pathname.replace(/\/+$/u, "");
    if (!trimmedPath.endsWith("/decisions")) return undefined;
    url.pathname = `${trimmedPath.slice(0, -"/decisions".length)}/extractions`;
    return url.href.replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

export function defaultDecisionModel(endpoint = DEFAULT_DECISIONS_ENDPOINT): string {
  return originOf(endpoint) === LEGACY_ORIGIN ? LEGACY_SYSTEMONE_MODEL : DEFAULT_DECISIONS_MODEL;
}

export function defaultAmbientEnvKeys(endpoint = DEFAULT_DECISIONS_ENDPOINT): readonly string[] {
  const origin = originOf(endpoint);
  if (origin === CODEX_ORIGIN) return ["CODEX_LB_API_KEY"];
  if (origin === LEGACY_ORIGIN) return ["TYPESAFE_API_KEY"];
  return [];
}

export function defaultFileEnvKeys(endpoint = DEFAULT_DECISIONS_ENDPOINT): readonly string[] {
  const origin = originOf(endpoint);
  if (origin === CODEX_ORIGIN) return ["CODEX_LB_API_KEY"];
  if (origin === LEGACY_ORIGIN) return ["TYPESAFE_API_KEY"];
  return isSystemOnePath(endpoint) ? ["TYPESAFE_API_KEY"] : ["CODEX_LB_API_KEY", "DECISION_MODEL_API_KEY"];
}

/**
 * Accept the exact requested model, a provider-dated snapshot (e.g. `liquid/d1.2-ultra-20261116`),
 * or `jev-latest` -> `jev-X.Y.Z`. Rejects unrelated variants such as `liquid/d1.2-ultra-mini`.
 */
export function matchesDecisionModel(returned: unknown, requested = DEFAULT_DECISIONS_MODEL): returned is string {
  if (typeof returned !== "string" || !returned) return false;
  if (returned === requested) return true;
  if (requested === "jev-latest") return JEV_VERSION.test(returned);
  if (returned.startsWith(`${requested}-`)) {
    return DATE_SNAPSHOT_SUFFIX.test(returned.slice(requested.length + 1));
  }
  return false;
}

/**
 * Namespace caches/cohorts by canonical endpoint when a non-canonical route is used,
 * preserving clean model keys on the canonical default and legacy routes.
 */
export function decisionModelScope(model = DEFAULT_DECISIONS_MODEL, endpoint?: string): string {
  if (!endpoint) return model;
  const canonical = endpoint.replace(/\/+$/u, "");
  if (canonical === DEFAULT_DECISIONS_ENDPOINT && model === DEFAULT_DECISIONS_MODEL) return model;
  if (canonical === LEGACY_SYSTEMONE_ENDPOINT && model.startsWith("jev-")) return model;
  return `${model}@${canonical}`;
}

/** Conservative token estimate (ceil(chars / 3)) for pre-flight state budgeting. */
export function estimateStateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 3);
}

export function resolveDecisionConfig(input: DecisionModelConfig = {}): ResolvedDecisionConfig {
  const endpoint = validateDecisionEndpoint(input.endpoint ?? DEFAULT_DECISIONS_ENDPOINT, "endpoint");
  const extractionsEndpoint = input.extractionsEndpoint !== undefined
    ? validateDecisionEndpoint(input.extractionsEndpoint, "extractionsEndpoint")
    : deriveExtractionsEndpoint(endpoint);

  if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim())) {
    throw new DecisionError("Decision model must be a non-empty string", "invalid_config");
  }
  const model = input.model !== undefined ? input.model.trim() : defaultDecisionModel(endpoint);
  if (endpoint === DEFAULT_DECISIONS_ENDPOINT && model.startsWith(`${DEFAULT_DECISIONS_MODEL}-`)) {
    throw new DecisionError(
      `Decision model must use the alias "${DEFAULT_DECISIONS_MODEL}" for ${DEFAULT_DECISIONS_ENDPOINT}`,
      "invalid_config",
    );
  }

  for (const field of ["apiKey", "apiKeyFile"] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new DecisionError(`Decision model ${field} must be a non-empty string`, "invalid_config");
    }
  }
  const apiKey = input.apiKey?.trim();
  const apiKeyFile = input.apiKeyFile?.trim();
  if (apiKey && apiKeyFile) {
    throw new DecisionError("Decision model accepts apiKey or apiKeyFile, not both", "invalid_config");
  }
  if (apiKeyFile && !isAbsolute(apiKeyFile)) {
    throw new DecisionError("Decision model apiKeyFile must be an absolute path", "invalid_config");
  }

  const timeoutMs = input.timeoutMs ?? 1500;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new DecisionError("Decision model timeoutMs must be an integer between 1 and 60000", "invalid_config");
  }

  const dialect: DecisionDialect = input.dialect === undefined || input.dialect === "auto"
    ? (isSystemOnePath(endpoint) ? "systemone" : "decisions")
    : input.dialect;

  return {
    endpoint,
    ...(extractionsEndpoint ? { extractionsEndpoint } : {}),
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyFile ? { apiKeyFile } : {}),
    timeoutMs,
    dialect,
    ambientEnvKeys: input.ambientEnvKeys ?? defaultAmbientEnvKeys(endpoint),
    fileEnvKeys: input.fileEnvKeys ?? defaultFileEnvKeys(endpoint),
    preDispatchRetryAfterOrigins: input.preDispatchRetryAfterOrigins ?? [CODEX_ORIGIN],
  };
}
