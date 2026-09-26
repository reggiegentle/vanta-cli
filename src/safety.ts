/**
 * Two gates for two distinct output classes (round-1 finding 10), never
 * used on each other's output, never merged into one function.
 *
 * `assertSafeAggregateReport` is used only by the one aggregate report
 * (`soc2 report`): counts and enum groupings only, no names, no titles, no
 * ids. `assertSafeWorklist` is used only by the one worklist (`evidence
 * gaps`): names and titles are allowed because the operator needs them to
 * act, but emails, URLs, secrets, local paths, and raw ids without
 * `--show-ids` are still forbidden.
 */

import { codeError } from "./output.js";
import { BUCKET_ALLOWLIST_UNION } from "./report-helpers.js";

interface PatternCheck {
  name: string;
  pattern: RegExp;
}

// Shared across both gates: email, URL, local absolute path, Vanta OAuth
// secret shapes, and bearer/JWT-looking tokens are never safe in either
// output class.
const SHARED_PATTERNS: PatternCheck[] = [
  { name: "an email address", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { name: "a URL", pattern: /https?:\/\//i },
  { name: "a local absolute path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "a Vanta OAuth client secret", pattern: /\bvcs_[A-Za-z0-9._~+/=-]{10,}/ },
  { name: "a Vanta OAuth client id", pattern: /\bvci_[A-Za-z0-9._~+/=-]{10,}/ },
  { name: "a bearer token", pattern: /\bBearer [A-Za-z0-9._~+/=-]{10,}/i },
  { name: "a JWT-looking token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i },
];

// Aggregate-report-only patterns: a UUID/internal-id shape and a
// file-like name are additional signals that a raw row leaked into a
// report that should carry counts and enum groupings only. A worklist
// legitimately shows document/control titles, some of which end in a
// file extension, so this pattern would false-positive there and is not
// part of the worklist's own pattern set.
const AGGREGATE_PATTERNS: PatternCheck[] = [
  SHARED_PATTERNS[0],
  SHARED_PATTERNS[1],
  {
    name: "a UUID/internal ID",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  },
  SHARED_PATTERNS[2],
  SHARED_PATTERNS[3],
  SHARED_PATTERNS[4],
  SHARED_PATTERNS[5],
  SHARED_PATTERNS[6],
  {
    name: "a file-like name",
    pattern: /\b[A-Za-z0-9][A-Za-z0-9_. -]*\.(?:csv|tsv|xlsx?|docx?|pdf|png|jpe?g|webp|zip)\b/i,
  },
];

const WORKLIST_PATTERNS: PatternCheck[] = [...SHARED_PATTERNS];

function findFirstPatternMatch(serialized: string, patterns: PatternCheck[]): string | null {
  for (const { name, pattern } of patterns) {
    if (pattern.test(serialized)) return name;
  }
  return null;
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

const FORBIDDEN_AGGREGATE_KEY_NAMES = new Set(["name", "title", "displayName", "email", "url", "fileName", "id"]);
const ID_SUFFIX_PATTERN = /Id$/;

/**
 * Walks a parsed value looking for the first object key that is exactly
 * one of the forbidden aggregate-report key names, or that matches
 * `/Id$/` (e.g. `ownerId`, `documentId`). This list deliberately excludes
 * `bucket`, the one key every count entry legitimately carries.
 */
function findForbiddenAggregateKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenAggregateKey(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_AGGREGATE_KEY_NAMES.has(key) || ID_SUFFIX_PATTERN.test(key)) {
        return key;
      }
      const found = findForbiddenAggregateKey(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

const NOT_FOUND = Symbol("bucket-value-not-found");

/**
 * Walks a parsed value looking for the first value found under a key
 * named exactly `bucket` that is neither the literal string "OTHER" nor a
 * member of `allowedValues`.
 */
function findInvalidBucketValue(value: unknown, allowedValues: Set<string>): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInvalidBucketValue(item, allowedValues);
      if (found !== NOT_FOUND) return found;
    }
    return NOT_FOUND;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === "bucket" && !(nested === "OTHER" || (typeof nested === "string" && allowedValues.has(nested)))) {
        return nested;
      }
      const found = findInvalidBucketValue(nested, allowedValues);
      if (found !== NOT_FOUND) return found;
    }
  }
  return NOT_FOUND;
}

/**
 * Walks a parsed value looking for the first object key that is exactly
 * `id`, or that matches `/Id$/` (e.g. `ownerId`, `documentId`,
 * `controlId`). Used only by `assertSafeWorklist`, and only when the
 * caller has not passed `{allowIds: true}`.
 */
function findIdKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findIdKey(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === "id" || ID_SUFFIX_PATTERN.test(key)) return key;
      const found = findIdKey(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Used only by the one aggregate report (`soc2 report`). Scans the
 * serialized report for email/URL/UUID/local-path/secret/bearer/JWT/
 * file-like-name patterns, throwing on the first match found (in that
 * order). Then parses the report back with `JSON.parse` and walks it,
 * rejecting any object key that is exactly `name`, `title`, `displayName`,
 * `email`, `url`, `fileName`, or `id`, or that matches `/Id$/` (excluding
 * `bucket`, the one key every count entry legitimately carries), and
 * separately verifying that every value found under a key named exactly
 * `bucket` anywhere in the tree is a member of `BUCKET_ALLOWLIST_UNION` or
 * is the literal string "OTHER".
 */
export function assertSafeAggregateReport(report: unknown, label = "Aggregate report"): void {
  const serialized = serialize(report);

  const patternMatch = findFirstPatternMatch(serialized, AGGREGATE_PATTERNS);
  if (patternMatch !== null) {
    throw codeError("CHECK_FAILED", `${label} failed the safety gate: contains ${patternMatch}.`);
  }

  const parsed = JSON.parse(serialized);

  const forbiddenKey = findForbiddenAggregateKey(parsed);
  if (forbiddenKey !== null) {
    throw codeError(
      "CHECK_FAILED",
      `${label} failed the safety gate: contains a forbidden key "${forbiddenKey}".`,
    );
  }

  const allowedBucketValues = new Set(BUCKET_ALLOWLIST_UNION);
  const invalidBucketValue = findInvalidBucketValue(parsed, allowedBucketValues);
  if (invalidBucketValue !== NOT_FOUND) {
    throw codeError(
      "CHECK_FAILED",
      `${label} failed the safety gate: bucket value ${JSON.stringify(invalidBucketValue)} is not in the allowlist.`,
    );
  }
}

/**
 * Used only by the one worklist (`evidence gaps`). Scans for the same
 * email/URL/local-path/secret/bearer/JWT patterns as
 * `assertSafeAggregateReport`, throwing the same `CHECK_FAILED`-coded
 * error. Does not scan for `name`/`title`/`bucket`-shaped keys or values,
 * or reject them structurally: a worklist exists precisely so an operator
 * can act on named control/document rows. It does additionally reject a
 * raw `id` key (or any `/Id$/`-matching key) appearing anywhere in the
 * serialized output unless `opts.allowIds` is true (set only when the
 * command was run with `--show-ids`).
 */
export function assertSafeWorklist(worklist: unknown, label = "Worklist", opts?: { allowIds?: boolean }): void {
  const serialized = serialize(worklist);

  const patternMatch = findFirstPatternMatch(serialized, WORKLIST_PATTERNS);
  if (patternMatch !== null) {
    throw codeError("CHECK_FAILED", `${label} failed the safety gate: contains ${patternMatch}.`);
  }

  if (!opts?.allowIds) {
    const parsed = JSON.parse(serialized);
    const idKey = findIdKey(parsed);
    if (idKey !== null) {
      throw codeError(
        "CHECK_FAILED",
        `${label} failed the safety gate: contains a raw id key "${idKey}" (pass --show-ids to allow this).`,
      );
    }
  }
}

/**
 * A stable local reference string standing in for the raw upstream id.
 * Used by every list-command summarizer regardless of which output class
 * later consumes its rows; this is a read-command convention, not a
 * report/worklist one.
 */
export function safeRowMeta(prefix: string, index: number, row: any): Record<string, unknown> {
  const padded = String(index + 1).padStart(3, "0");
  return { ref: `${prefix}-${padded}`, hasId: Boolean(row?.id) };
}
