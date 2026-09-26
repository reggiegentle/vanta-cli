/**
 * The Vanta Manage API HTTP client (spec.md D3). Constructed once, per
 * command, with a plain bearer token the caller has already resolved:
 * this file never mints or refreshes a token, never reads or writes the
 * config file, and never touches either coordination lock. A 401 at any
 * point is a real, surfaced AUTH_INVALID failure, never a retry trigger.
 */

import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { codeError, makeError, VantaCliError, type ErrorCode } from "./output.js";
import { paginate, type PaginateOptions, type PaginationResult, type PageFetchResult } from "./paginate.js";

export { assertSafeApiBaseUrl } from "./config.js";
import { assertSafeApiBaseUrl } from "./config.js";

const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX_REQUESTS = 45;
const MAX_ATTEMPTS = 4; // one initial attempt plus three retries
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MESSAGE_SEGMENT_CHARS = 12;
const MESSAGE_SEGMENT_KEEP_CHARS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * A short, safe label for an error message: the query string (and
 * anything after a stray "?"/"#" that should never have reached here) is
 * stripped, and any single path segment longer than 12 characters is
 * replaced by its first 8 characters plus "...". Error messages never
 * carry the raw path, the query object, or the full URL.
 */
function redactPathForMessage(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0];
  return withoutQuery
    .split("/")
    .map((segment) =>
      segment.length > MAX_MESSAGE_SEGMENT_CHARS
        ? `${segment.slice(0, MESSAGE_SEGMENT_KEEP_CHARS)}...`
        : segment,
    )
    .join("/");
}

function buildRequestErrorMessage(method: string, path: string, status: number): string {
  return `${method} ${redactPathForMessage(path)} -> ${status}`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  // Deliberately not wrapped in a catch: a stalled body must let its
  // AbortError propagate to the caller so it can map to TIMEOUT, exactly
  // like a stalled response-header wait does.
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The one typed error class this file's request() throws on every
 * non-2xx upstream response. `code` carries the ErrorCode string that
 * output.ts's own centralized `makeError`/`toErrorCode` derived from the
 * HTTP status, so `toErrorCode` picks it up through its generic "has a
 * code field" fallback without this file keeping a second copy of the
 * status-to-code mapping.
 */
export class VantaApiError extends Error {
  status: number;
  data?: unknown;
  code?: string;

  constructor(message: string, status: number, data?: unknown, code?: string) {
    super(message);
    this.name = "VantaApiError";
    this.status = status;
    this.data = data;
    this.code = code;
  }
}

export interface VantaApiClientOptions {
  apiBaseUrl: string;
  allowUnsafeApiBaseUrl: boolean;
  token: string;
  userAgent: string;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown> | FormData;
  bodyType?: "json" | "form";
}

export class VantaApiClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly userAgent: string;
  private readonly requestTimestamps: number[] = [];

  constructor(options: VantaApiClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    // Defense in depth: this same check already ran once, earlier in the
    // command, before any token was minted (src/config.ts, called from
    // the token-acquisition step). Re-checking here means a cached,
    // previously-allowed unsafe base URL can never reach a request
    // without this constructor seeing it too.
    assertSafeApiBaseUrl(this.apiBaseUrl, options.allowUnsafeApiBaseUrl);
    this.token = options.token;
    this.userAgent = options.userAgent;
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const joined = this.apiBaseUrl.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    const url = new URL(joined);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === "") continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async throttle(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (
        this.requestTimestamps.length > 0 &&
        this.requestTimestamps[0] <= now - THROTTLE_WINDOW_MS
      ) {
        this.requestTimestamps.shift();
      }
      if (this.requestTimestamps.length < THROTTLE_MAX_REQUESTS) {
        this.requestTimestamps.push(Date.now());
        return;
      }
      const oldest = this.requestTimestamps[0];
      const waitMs = oldest + THROTTLE_WINDOW_MS - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
  }

  private async request(
    path: string,
    query?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<any> {
    const url = this.buildUrl(path, query);
    const method = options?.method ?? "GET";
    const isFormBody = options?.bodyType === "form" || options?.body instanceof FormData;
    const hasBody = options?.body !== undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.throttle();

      const headers: Record<string, string> = {
        Accept: "application/json",
        "User-Agent": this.userAgent,
        Authorization: `Bearer ${this.token}`,
      };
      // Constructed conditionally: when there is no body, "body" is not
      // a key on this object at all, not a key holding `undefined`, and
      // no Content-Type header is ever added.
      const bodyInit: { body?: BodyInit } = {};
      if (hasBody) {
        if (isFormBody) {
          bodyInit.body = options!.body as FormData;
        } else {
          headers["Content-Type"] = "application/json";
          bodyInit.body = JSON.stringify(options!.body);
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const init: RequestInit = { method, headers, signal: controller.signal, ...bodyInit };

      try {
        let response: Response;
        try {
          response = await fetch(url, init);
        } catch (err) {
          const timedOut = isAbortError(err);
          throw codeError(
            timedOut ? "TIMEOUT" : "UNKNOWN",
            timedOut
              ? `${buildRequestErrorMessage(method, path, 0)} timed out after ${REQUEST_TIMEOUT_MS}ms.`
              : `${buildRequestErrorMessage(method, path, 0)} failed: ${err instanceof Error ? err.message : String(err)}`,
            { retryable: timedOut },
          );
        }

        if (response.status >= 200 && response.status < 300) {
          if (response.status === 204) return undefined;
          try {
            return await readJsonBody(response);
          } catch (err) {
            const timedOut = isAbortError(err);
            throw codeError(
              timedOut ? "TIMEOUT" : "UNKNOWN",
              timedOut
                ? `${buildRequestErrorMessage(method, path, response.status)} timed out reading the response body.`
                : `${buildRequestErrorMessage(method, path, response.status)} failed reading the response body.`,
              { retryable: timedOut },
            );
          }
        }

        let errorBody: unknown;
        try {
          errorBody = await readJsonBody(response);
        } catch (err) {
          const timedOut = isAbortError(err);
          throw codeError(
            timedOut ? "TIMEOUT" : "UNKNOWN",
            timedOut
              ? `${buildRequestErrorMessage(method, path, response.status)} timed out reading the response body.`
              : `${buildRequestErrorMessage(method, path, response.status)} failed reading the response body.`,
            { retryable: timedOut },
          );
        }

        // The single, centralized status-to-code mapping lives in
        // output.ts; makeError derives `code` from `http` for us so this
        // file never keeps a second copy of that table.
        const mapped = makeError(undefined, {
          http: response.status,
          message: buildRequestErrorMessage(method, path, response.status),
        });
        const attemptsRemain = attempt < MAX_ATTEMPTS;

        if (mapped.retryable && attemptsRemain) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
          const delayMs =
            Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
              ? retryAfterSeconds * 1000
              : RETRY_DELAYS_MS[attempt - 1];
          await sleep(delayMs);
          continue;
        }

        throw new VantaApiError(mapped.message, response.status, errorBody, mapped.code);
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable: the loop above always either returns or throws before
    // running out of attempts. Kept only to satisfy the type checker.
    throw new VantaCliError({ code: "UNKNOWN", message: "Request exhausted all attempts.", retryable: false });
  }

  private async requestPage<T>(
    path: string,
    query: Record<string, unknown>,
  ): Promise<PageFetchResult<T>> {
    const response = await this.request(path, query);
    const data = response?.results?.data;
    if (!Array.isArray(data)) {
      throw codeError(
        "VALIDATION",
        `Unexpected response shape from ${redactPathForMessage(path)}: results.data is not an array.`,
        { detail: response },
      );
    }
    const pageInfo = response?.results?.pageInfo ?? {};
    return {
      data: data as T[],
      pageInfo: {
        hasNextPage: Boolean(pageInfo.hasNextPage),
        endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
      },
    };
  }

  async paginate<T>(
    path: string,
    query: Record<string, unknown>,
    opts: PaginateOptions,
  ): Promise<PaginationResult<T>> {
    return paginate<T>((q) => this.requestPage<T>(path, q), query, opts);
  }

  /** Single-object GET (detail-by-id endpoints), no pagination. Can throw directly. */
  async get(path: string, query?: Record<string, unknown>): Promise<any> {
    return this.request(path, query);
  }

  /**
   * JSON POST. `body` is genuinely optional: when omitted, no request
   * body and no Content-Type header reach fetch at all, never a literal
   * `{}`.
   */
  async post(path: string, body?: Record<string, unknown>): Promise<any> {
    return this.request(path, undefined, body === undefined ? { method: "POST" } : { method: "POST", body });
  }

  async uploadDocument(
    documentId: string,
    filePath: string,
    meta: { effectiveAtDate?: string; description?: string },
  ): Promise<any> {
    const buffer = await nodeFs.readFile(filePath);
    const form = new FormData();
    form.set("file", new Blob([buffer]), nodePath.basename(filePath));
    if (meta.effectiveAtDate !== undefined) form.set("effectiveAtDate", meta.effectiveAtDate);
    if (meta.description !== undefined) form.set("description", meta.description);
    return this.request(`documents/${documentId}/uploads`, undefined, {
      method: "POST",
      body: form,
      bodyType: "form",
    });
  }

  /**
   * For `api get`: rejects, before any URL construction, anything that
   * looks like an attempt to leave the `/v1` resource tree or to smuggle
   * a query string through the path argument: an absolute URL
   * ("://"), a protocol-relative path ("//..."), a backslash, an inline
   * "?" or "#" (query parameters come only through the typed query
   * object), or, once percent-decoded and split on "/", any "."/".."
   * segment. Accepts one optional leading "/" and, whether or not that
   * leading slash was present, one optional leading "v1/" immediately
   * after it, so "v1/frameworks", "/v1/frameworks", "/frameworks", and
   * "frameworks" all normalize to "frameworks"; stripping stops after
   * that single pass, so "v1/v1/x" normalizes to "v1/x", not "x".
   */
  async getRaw(path: string, query?: Record<string, string>): Promise<unknown> {
    const normalized = normalizeRawPath(path);
    return this.request(normalized, query);
  }
}

function normalizeRawPath(input: string): string {
  const reject = (reason: string): never => {
    throw codeError("VALIDATION", `Unsafe raw path: ${reason}.`);
  };

  if (input.includes("://")) reject("absolute URLs are not accepted");
  if (input.startsWith("//")) reject("protocol-relative paths are not accepted");
  if (input.includes("\\")) reject("backslashes are not accepted");
  if (input.includes("?") || input.includes("#")) {
    reject("query parameters must be passed as the query argument, not inline");
  }

  let rest = input;
  if (rest.startsWith("/")) {
    rest = rest.slice(1);
  }
  if (rest.startsWith("v1/")) {
    rest = rest.slice(3);
  }
  if (rest.startsWith("/")) reject("unexpected leading slash after normalization");

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    reject("invalid percent-encoding");
    return ""; // unreachable, satisfies the type checker
  }

  if (decoded.length === 0) reject("path must not be empty");

  for (const segment of decoded.split("/")) {
    if (segment === "." || segment === "..") {
      reject("relative path segments are not accepted");
    }
  }

  return rest;
}
