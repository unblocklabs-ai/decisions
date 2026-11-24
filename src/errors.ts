export type DecisionErrorCode =
  | "missing_credential"
  | "invalid_credential"
  | "invalid_config"
  | "timeout"
  | "cancelled"
  | "network_error"
  | "http_error"
  | "invalid_response";

/**
 * Sanitized decision/extraction error. Messages never include API keys or raw provider bodies.
 */
export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  readonly status?: number;
  /** True only when a confirmed pre-dispatch 503 + Retry-After was received. */
  readonly retryAfter?: boolean;

  constructor(
    message: string,
    code: DecisionErrorCode,
    status?: number,
    retryAfter?: boolean,
  ) {
    super(message);
    this.name = "DecisionError";
    this.code = code;
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function abortedByTimeout(signal: AbortSignal | undefined): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") return true;
  if (reason instanceof Error && reason.name === "TimeoutError") return true;
  return false;
}

export type DecisionFailureDisposition =
  | { status: "failed"; error: string }
  | { status: "ambiguous"; error: string };

/**
 * Classifies a failed decision/extraction call for durable retry ledgers:
 * - HTTP 4xx or confirmed pre-dispatch 503 Retry-After -> definitely unbilled ("failed")
 * - Timeouts, network errors, 5xx without pre-dispatch guarantee, invalid JSON -> "ambiguous"
 */
export function classifyDecisionFailure(error: unknown): DecisionFailureDisposition {
  if (error instanceof DecisionError && error.code === "http_error" && error.status !== undefined) {
    if ((error.status >= 400 && error.status < 500) || (error.status === 503 && error.retryAfter === true)) {
      return { status: "failed", error: `http_${error.status}` };
    }
    return { status: "ambiguous", error: `http_${error.status}` };
  }
  return { status: "ambiguous", error: "request_or_response_uncertain" };
}
