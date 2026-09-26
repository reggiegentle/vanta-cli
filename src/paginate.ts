/**
 * The one canonical pagination contract in this codebase (spec.md D3).
 * Pure and caller-agnostic: this file has no dependency on vanta-api.ts or
 * on anything else in the repo. It never throws; a rejected fetchPage, or
 * a fetchPage that resolves with a malformed page shape, both resolve as
 * an incomplete, errored result instead, so every caller (typed read
 * commands, report builders, the worklist builder) checks `.error` for
 * itself rather than wrapping this call in a try/catch.
 */

export type PageFetchResult<T> = {
  data: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

export type PaginationResult<T> = {
  rows: T[];
  pagesFetched: number;
  returnedCount: number;
  complete: boolean;
  lastCursor: string | null;
  error?: { code: string; message: string };
};

export interface PaginateOptions {
  all?: boolean;
  limit?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_PAGE_SIZE = 100;

function describeError(err: unknown): { code: string; message: string } {
  if (err && typeof err === "object") {
    const candidateCode = (err as { code?: unknown }).code;
    const candidateMessage = (err as { message?: unknown }).message;
    return {
      code: typeof candidateCode === "string" ? candidateCode : "UNKNOWN",
      message: typeof candidateMessage === "string" ? candidateMessage : String(err),
    };
  }
  return { code: "UNKNOWN", message: String(err) };
}

/**
 * Validates a page returned by `fetchPage` at runtime, since a caller's
 * closure can resolve with any shape at all regardless of what its own
 * type signature promises. Throws a CHECK_FAILED-coded error, caught by
 * the same try block that already catches a `fetchPage` rejection, on
 * anything other than `{data: T[], pageInfo: {hasNextPage: boolean,
 * endCursor: string | null}}`.
 */
function malformedPageError(): Error {
  return Object.assign(new Error("malformed page shape"), { code: "CHECK_FAILED" });
}

function assertValidPage<T>(candidate: unknown): PageFetchResult<T> {
  if (!candidate || typeof candidate !== "object") throw malformedPageError();
  const data = (candidate as { data?: unknown }).data;
  if (!Array.isArray(data)) throw malformedPageError();
  const pageInfo = (candidate as { pageInfo?: unknown }).pageInfo;
  if (!pageInfo || typeof pageInfo !== "object") throw malformedPageError();
  const hasNextPage = (pageInfo as { hasNextPage?: unknown }).hasNextPage;
  if (typeof hasNextPage !== "boolean") throw malformedPageError();
  const endCursorRaw = (pageInfo as { endCursor?: unknown }).endCursor;
  const endCursor = typeof endCursorRaw === "string" ? endCursorRaw : null;
  return { data: data as T[], pageInfo: { hasNextPage, endCursor } };
}

/**
 * Walks pages via a caller-supplied `fetchPage` closure, page size capped
 * at 100, threading `pageCursor` through `baseQuery` on every call after
 * the first.
 *
 * `opts.limit` (default 100) applies only when `opts.all` is not true: in
 * that mode, pagination keeps fetching additional pages (truncating the
 * final page's rows to exactly the limit) until either the limit is
 * reached or the upstream itself runs out of pages, whichever comes
 * first. When `opts.all` is true, the limit is ignored entirely and
 * pagination walks every page until `hasNextPage` is false.
 *
 * `complete` is true whenever pagination reached the caller's requested
 * completion with no error along the way: either the last fetched page's
 * `hasNextPage` was false (upstream truly exhausted), or, in non-`all`
 * mode, the row limit was reached (`lastCursor` is still set on that
 * result so a caller that wants more can resume from it). `complete` is
 * false only when a `fetchPage` rejection or a malformed page stopped
 * pagination before either of those was reached.
 */
export async function paginate<T>(
  fetchPage: (query: Record<string, unknown>) => Promise<PageFetchResult<T>>,
  baseQuery: Record<string, unknown>,
  opts: PaginateOptions,
): Promise<PaginationResult<T>> {
  const rows: T[] = [];
  const limit = opts.limit ?? DEFAULT_LIMIT;
  let pagesFetched = 0;
  let lastCursor: string | null = null;
  let cursor: string | undefined;

  for (;;) {
    let page: PageFetchResult<T>;
    try {
      const rawPage = await fetchPage({
        ...baseQuery,
        pageSize: MAX_PAGE_SIZE,
        pageCursor: cursor,
      });
      page = assertValidPage<T>(rawPage);
    } catch (err) {
      return {
        rows,
        pagesFetched,
        returnedCount: rows.length,
        complete: false,
        lastCursor,
        error: describeError(err),
      };
    }

    pagesFetched += 1;
    rows.push(...page.data);
    lastCursor = page.pageInfo.endCursor;

    if (!opts.all) {
      if (rows.length >= limit) {
        if (rows.length > limit) {
          rows.length = limit;
        }
        return {
          rows,
          pagesFetched,
          returnedCount: rows.length,
          complete: true,
          lastCursor,
        };
      }
      if (!page.pageInfo.hasNextPage) {
        return {
          rows,
          pagesFetched,
          returnedCount: rows.length,
          complete: true,
          lastCursor,
        };
      }
      cursor = page.pageInfo.endCursor ?? undefined;
      continue;
    }

    // opts.all: the row limit is ignored entirely; keep walking until
    // the upstream itself runs out of pages.
    if (!page.pageInfo.hasNextPage) {
      return {
        rows,
        pagesFetched,
        returnedCount: rows.length,
        complete: true,
        lastCursor,
      };
    }
    cursor = page.pageInfo.endCursor ?? undefined;
  }
}
