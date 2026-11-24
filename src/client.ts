import {
  decisionModelScope,
  resolveDecisionConfig,
  type DecisionModelConfig,
  type ResolvedDecisionConfig,
} from "./config.js";
import { resolveDecisionApiKey } from "./credentials.js";
import { abortedByTimeout, DecisionError } from "./errors.js";
import {
  parseExtractionResponse,
  validateExtractionRequest,
  type ExtractionAsset,
  type ExtractionResult,
  type FieldMap,
} from "./extractions.js";
import { parseDecisionResponse, type DecisionResult, type QuestionMap } from "./questions.js";

export interface RequestOverrides {
  /** Override resolved API key for this request (useful when caller already resolved/cached it). */
  apiKey?: string;
  /** Override timeout in ms (1..60000) for this request. */
  timeoutMs?: number;
  /** Caller cancellation signal. */
  signal?: AbortSignal;
  /** Default true: validate returned payload.model against configured model. */
  validateModel?: boolean;
  /** Default false: when true, project and validate requested answer keys while stripping unrequested provider extras. */
  allowExtraAnswerKeys?: boolean;
}

export interface DecisionClient {
  readonly config: ResolvedDecisionConfig;
  /** Canonical cache/cohort scope key (`model` on canonical endpoints, `model@endpoint` on custom routes). */
  readonly scope: string;
  /** Resolve the bearer token without making any network request. */
  resolveApiKey(env?: Record<string, string | undefined>): Promise<string | undefined>;
  /** Typed decision call (POST /decisions or legacy /systemone). */
  decide<const Q extends QuestionMap>(
    state: unknown,
    questions: Q,
    overrides?: RequestOverrides,
  ): Promise<DecisionResult<Q>>;
  /**
   * Low-level raw JSON decision call using the exact same HTTPS/auth/timeout/error transport,
   * for callers that intentionally tolerate partial multi-question responses or custom schemas.
   */
  decideRaw(
    state: unknown,
    questions: unknown,
    overrides?: Pick<RequestOverrides, "apiKey" | "timeoutMs" | "signal">,
  ): Promise<unknown>;
  /** Typed extraction call (POST /extractions). */
  extract<const F extends FieldMap>(
    state: unknown,
    fields: F,
    overrides?: RequestOverrides & { assets?: readonly ExtractionAsset[] },
  ): Promise<ExtractionResult<F>>;
}

function endpointOrigin(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
}

function resolveTimeoutMs(timeoutMs: number): number {
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new DecisionError("Decision model timeoutMs must be an integer between 1 and 60000", "invalid_config");
  }
  return timeoutMs;
}

async function postJson(params: {
  endpoint: string;
  apiKey: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  preDispatchRetryAfterOrigins: readonly string[];
  fetchImpl: typeof globalThis.fetch;
}): Promise<unknown> {
  const timeout = AbortSignal.timeout(resolveTimeoutMs(params.timeoutMs));
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const origin = endpointOrigin(params.endpoint);
  try {
    signal.throwIfAborted();
    const response = await params.fetchImpl(params.endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params.body),
    });
    if (!response.ok) {
      const retryAfter = response.status === 503 &&
        origin !== undefined &&
        params.preDispatchRetryAfterOrigins.includes(origin) &&
        response.headers.has("retry-after");
      try {
        await response.body?.cancel();
      } catch {
        // Status is authoritative; discard unsafe cancellation detail.
      }
      throw new DecisionError(
        `Decision model HTTP ${response.status}`,
        "http_error",
        response.status,
        retryAfter,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new DecisionError("Decision model returned invalid JSON", "invalid_response");
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof DecisionError) throw error;
    if (signal.aborted) {
      const timedOut = abortedByTimeout(signal);
      throw new DecisionError(
        timedOut ? "Decision model request timed out" : "Decision model request cancelled",
        timedOut ? "timeout" : "cancelled",
      );
    }
    throw new DecisionError("Decision model request failed", "network_error");
  }
}

export function createDecisionClient(
  input: DecisionModelConfig = {},
  options?: { fetch?: typeof globalThis.fetch },
): DecisionClient {
  const config = resolveDecisionConfig(input);
  const scope = decisionModelScope(config.model, config.endpoint);
  const fetchImpl = options?.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));

  async function requireKey(override?: string): Promise<string> {
    if (override !== undefined) {
      const trimmed = override.trim();
      if (!trimmed || /\s/u.test(trimmed)) {
        throw new DecisionError("Decision model apiKey override is invalid", "invalid_credential");
      }
      return trimmed;
    }
    const resolved = await resolveDecisionApiKey(config);
    if (!resolved) {
      throw new DecisionError("Decision model credential is unavailable", "missing_credential");
    }
    return resolved;
  }

  return {
    config,
    scope,
    resolveApiKey: (env?: Record<string, string | undefined>) => resolveDecisionApiKey(config, env),

    async decide<const Q extends QuestionMap>(
      state: unknown,
      questions: Q,
      overrides?: RequestOverrides,
    ): Promise<DecisionResult<Q>> {
      if (Object.keys(questions).length === 0) {
        throw new DecisionError("Decision request requires at least one question", "invalid_config");
      }
      const timeoutMs = resolveTimeoutMs(overrides?.timeoutMs ?? config.timeoutMs);
      const apiKey = await requireKey(overrides?.apiKey);
      const requestState = config.dialect === "systemone" || Array.isArray(state) || typeof state === "string"
        ? state
        : [state];
      const payload = await postJson({
        endpoint: config.endpoint,
        apiKey,
        body: { model: config.model, state: requestState, questions },
        timeoutMs,
        signal: overrides?.signal,
        preDispatchRetryAfterOrigins: config.preDispatchRetryAfterOrigins,
        fetchImpl,
      });
      return parseDecisionResponse(
        payload,
        questions,
        config.model,
        overrides?.validateModel ?? true,
        overrides?.allowExtraAnswerKeys ?? false,
      );
    },

    async decideRaw(
      state: unknown,
      questions: unknown,
      overrides?: Pick<RequestOverrides, "apiKey" | "timeoutMs" | "signal">,
    ): Promise<unknown> {
      const timeoutMs = resolveTimeoutMs(overrides?.timeoutMs ?? config.timeoutMs);
      const apiKey = await requireKey(overrides?.apiKey);
      const requestState = config.dialect === "systemone" || Array.isArray(state) || typeof state === "string"
        ? state
        : [state];
      return postJson({
        endpoint: config.endpoint,
        apiKey,
        body: { model: config.model, state: requestState, questions },
        timeoutMs,
        signal: overrides?.signal,
        preDispatchRetryAfterOrigins: config.preDispatchRetryAfterOrigins,
        fetchImpl,
      });
    },

    async extract<const F extends FieldMap>(
      state: unknown,
      fields: F,
      overrides?: RequestOverrides & { assets?: readonly ExtractionAsset[] },
    ): Promise<ExtractionResult<F>> {
      if (!config.extractionsEndpoint) {
        throw new DecisionError(
          "Extractions endpoint is not configured and could not be derived from endpoint",
          "invalid_config",
        );
      }
      const timeoutMs = resolveTimeoutMs(overrides?.timeoutMs ?? config.timeoutMs);
      validateExtractionRequest(config.model, fields, overrides?.assets);
      let requestState: string | undefined;
      if (typeof state === "string") {
        requestState = state;
      } else {
        try {
          requestState = JSON.stringify(state);
        } catch {
          throw new DecisionError("Extraction state must be a non-empty string or JSON-serializable value", "invalid_config");
        }
      }
      if (typeof requestState !== "string" || !requestState) {
        throw new DecisionError("Extraction state must be a non-empty string or JSON-serializable value", "invalid_config");
      }
      const apiKey = await requireKey(overrides?.apiKey);
      const payload = await postJson({
        endpoint: config.extractionsEndpoint,
        apiKey,
        body: {
          model: config.model,
          state: requestState,
          ...(overrides?.assets?.length ? { assets: overrides.assets } : {}),
          fields,
        },
        timeoutMs,
        signal: overrides?.signal,
        preDispatchRetryAfterOrigins: config.preDispatchRetryAfterOrigins,
        fetchImpl,
      });
      return parseExtractionResponse(payload, fields, config.model, overrides?.validateModel ?? true);
    },
  };
}
