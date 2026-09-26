/**
 * The one shared {ok,data} / {ok:false,error} JSON output contract used by
 * every command in this CLI (spec.md D4).
 */

export type ErrorCode =
  | "AUTH_MISSING"
  | "AUTH_INVALID"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_5XX"
  | "VALIDATION"
  | "CHECK_FAILED"
  | "LOCKED"
  | "UNKNOWN";

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "AUTH_MISSING",
  "AUTH_INVALID",
  "NOT_FOUND",
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_5XX",
  "VALIDATION",
  "CHECK_FAILED",
  "LOCKED",
  "UNKNOWN",
]);

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_5XX",
]);

export interface CliError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  http?: number;
  detail?: unknown;
}

export interface OkEnvelope<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface FailEnvelope {
  ok: false;
  error: CliError;
  meta?: Record<string, unknown>;
}

/**
 * A thrown, Error-shaped carrier for a CliError. Every codeError(...) call
 * returns one of these so it can be thrown directly and later normalized
 * back into a plain CliError by makeError/toErrorCode.
 */
export class VantaCliError extends Error implements CliError {
  code: ErrorCode;
  retryable: boolean;
  http?: number;
  detail?: unknown;

  constructor(error: CliError) {
    super(error.message);
    this.name = "VantaCliError";
    this.code = error.code;
    this.retryable = error.retryable;
    this.http = error.http;
    this.detail = error.detail;
  }
}

export function codeError(
  code: ErrorCode,
  message: string,
  options?: { detail?: unknown; http?: number; retryable?: boolean },
): VantaCliError {
  return new VantaCliError({
    code,
    message,
    retryable: options?.retryable ?? RETRYABLE_CODES.has(code),
    http: options?.http,
    detail: options?.detail,
  });
}

export function ok<T>(data: T, meta?: Record<string, unknown>): OkEnvelope<T> {
  return meta === undefined ? { ok: true, data } : { ok: true, data, meta };
}

export function fail(error: CliError, meta?: Record<string, unknown>): FailEnvelope {
  return meta === undefined ? { ok: false, error } : { ok: false, error, meta };
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && ERROR_CODES.has(value);
}

export function toErrorCode(err: unknown): ErrorCode {
  if (err instanceof VantaCliError) {
    return err.code;
  }
  if (err && typeof err === "object" && "code" in err) {
    const candidate = (err as { code: unknown }).code;
    if (isErrorCode(candidate)) {
      return candidate;
    }
  }
  return "UNKNOWN";
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof VantaCliError) {
    return err.retryable;
  }
  if (err && typeof err === "object" && "retryable" in err) {
    const candidate = (err as { retryable: unknown }).retryable;
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return RETRYABLE_CODES.has(toErrorCode(err));
}

function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "AUTH_INVALID";
  if (status >= 500) return "UPSTREAM_5XX";
  if (status >= 400) return "VALIDATION";
  return "UNKNOWN";
}

/**
 * Normalizes any caught value (a VantaCliError, a plain Error, a thrown
 * string, anything) into a plain CliError. `override` wins over anything
 * derived from `err`.
 */
export function makeError(err: unknown, override?: Partial<CliError>): CliError {
  const inferredHttp =
    override?.http ?? (err instanceof VantaCliError ? err.http : undefined);
  const inferredCode = toErrorCode(err);
  const code =
    override?.code ??
    (inferredCode === "UNKNOWN" && typeof inferredHttp === "number"
      ? httpStatusToErrorCode(inferredHttp)
      : inferredCode);
  const message =
    override?.message ??
    (err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error.");
  const detail =
    override?.detail ?? (err instanceof VantaCliError ? err.detail : undefined);
  const retryable = override?.retryable ?? RETRYABLE_CODES.has(code);
  const result: CliError = { code, message, retryable };
  if (inferredHttp !== undefined) result.http = inferredHttp;
  if (detail !== undefined) result.detail = detail;
  return result;
}

/**
 * D4's exit code contract: 0 success, 1 execution/upstream/lock failure,
 * 2 auth missing/invalid.
 */
export function exitCodeForError(code: ErrorCode): 1 | 2 {
  return code === "AUTH_MISSING" || code === "AUTH_INVALID" ? 2 : 1;
}
