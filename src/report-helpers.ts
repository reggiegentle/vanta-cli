/**
 * Counting, grouping, and per-control detail-fetch helpers shared by the
 * report and worklist builders (spec.md D7, D8, D11).
 *
 * `countBy`/`countByFlattened`/`countByEnum` never emit an arbitrary
 * upstream string as a bucket label. Any bucketed value not present in the
 * relevant closed allowlist below folds into a single "OTHER" bucket
 * instead, so `safety.ts`'s `assertSafeAggregateReport` has a fixed,
 * closed set of legitimate bucket values to check every report against.
 */

import { codeError, toErrorCode } from "./output.js";
import type { VantaApiClient } from "./vanta-api.js";

/**
 * Every entry below is verified against the Vanta Manage OpenAPI
 * document's own named schema (not the extracted reference, wherever the
 * two differ), noted per entry. Only `soc2 report` remains an aggregate
 * report in V1 (owner direction, 2026-09-26), so this registry carries
 * only the allowlists that report actually uses.
 */
export const BUCKET_ALLOWLISTS = {
  // OpenAPI schema ControlStatus (GET controls/{controlId} response.status)
  controlStatus: ["NO_EVIDENCE_MAPPED", "NOT_STARTED", "IN_PROGRESS", "COMPLETED"],
  // OpenAPI schema ControlDomain, all 38 values verbatim, including the
  // exact "&"/space punctuation the API itself uses
  controlDomain: [
    "ARTIFICIAL_&_AUTONOMOUS_TECHNOLOGY",
    "ASSET_MANAGEMENT",
    "BUSINESS_CONTINUITY_&_DISASTER_RECOVERY",
    "CAPACITY_&_PERFORMANCE_PLANNING",
    "CHANGE_MANAGEMENT",
    "CLOUD_SECURITY",
    "COMPLIANCE",
    "CONFIGURATION_MANAGEMENT",
    "CONTINUOUS_MONITORING",
    "CRYPTOGRAPHIC_PROTECTIONS",
    "DATA_CLASSIFICATION_&_HANDLING",
    "EMBEDDED_TECHNOLOGY",
    "ENDPOINT_SECURITY",
    "HUMAN_RESOURCES_SECURITY",
    "IDENTIFICATION_&_AUTHENTICATION",
    "INCIDENT_RESPONSE",
    "INFORMATION_ASSURANCE",
    "MAINTENANCE",
    "MOBILE_DEVICE_MANAGEMENT",
    "NETWORK SECURITY",
    "PHYSICAL_&_ENVIRONMENTAL_SECURITY",
    "PRIVACY",
    "PROJECT_&_RESOURCE MANAGEMENT",
    "RISK_MANAGEMENT",
    "SECURE_ENGINEERING_&_ARCHITECTURE",
    "SECURITY_AWARENESS_&_TRAINING",
    "SECURITY_OPERATIONS",
    "SECURITY_&_PRIVACY_GOVERNANCE",
    "TECHNOLOGY_DEVELOPMENT_&_ACQUISITION",
    "THIRD-PARTY_MANAGEMENT",
    "THREAT_MANAGEMENT",
    "VULNERABILITY_&_PATCH_MANAGEMENT",
    "WEB_SECURITY",
    "ADMINISTRATIVE",
    "PHYSICAL",
    "TECHNICAL",
    "BASIC",
    "DERIVED",
  ],
  // OpenAPI schema TestStatus
  testStatus: ["OK", "DEACTIVATED", "NEEDS_ATTENTION", "IN_PROGRESS", "INVALID", "NOT_APPLICABLE"],
  // OpenAPI schema DocumentAndTestCategory: confirmed the SAME schema
  // backs both Test.category and Document.category, not two similar
  // lists that happen to overlap.
  documentAndTestCategory: [
    "Accounts access",
    "Account security",
    "Account setup",
    "Computers",
    "Custom",
    "Data storage",
    "Employees",
    "Infrastructure",
    "IT",
    "Logging",
    "Monitoring alerts",
    "People",
    "Policies",
    "Risk analysis",
    "Software development",
    "CSPM alert management",
    "Vendors",
    "Vulnerability management",
  ],
  // OpenAPI schema DocumentStatus (Document.uploadStatus)
  documentUploadStatus: ["Needs document", "Needs update", "Not relevant", "OK"],
  // OpenAPI schema TasksSummaryStatus (Person.tasksSummary.status, the
  // person's overall status, not a per-task-type status)
  tasksSummaryStatus: [
    "COMPLETE",
    "DUE_SOON",
    "NONE",
    "OFFBOARDING_COMPLETE",
    "OFFBOARDING_DUE_SOON",
    "OFFBOARDING_OVERDUE",
    "OVERDUE",
    "PAUSED",
  ],
} as const;

export const BUCKET_ALLOWLIST_UNION: string[] = [...new Set(Object.values(BUCKET_ALLOWLISTS).flat())];

export interface BucketCount {
  bucket: string;
  count: number;
}

function sortBucketCounts(counts: Map<string, number>): BucketCount[] {
  return [...counts.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket));
}

/**
 * Buckets rows by `String(keyFn(row) ?? "OTHER")`. Any bucketed value not
 * present in `allowlist` folds into a single "OTHER" bucket instead of
 * appearing under its own, arbitrary label. `allowlist` is required, not
 * optional: every call site passes one of the `BUCKET_ALLOWLISTS` entries
 * above. Returns entries sorted descending by count, ties broken by
 * `bucket` ascending.
 */
export function countBy<T>(rows: T[], keyFn: (row: T) => unknown, allowlist: string[]): BucketCount[] {
  const allowed = new Set(allowlist);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = String(keyFn(row) ?? "OTHER");
    const bucket = allowed.has(raw) ? raw : "OTHER";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return sortBucketCounts(counts);
}

/**
 * Like `countBy`, but `keyFn` returns an array per row (e.g. a control's
 * `domains`); each array element is checked against `allowlist`
 * independently and contributes one count to its own bucket, or to
 * "OTHER" if not allowlisted. A row whose `keyFn` result is not an array
 * (null, undefined, or otherwise) contributes nothing.
 */
export function countByFlattened<T>(
  rows: T[],
  keyFn: (row: T) => unknown[] | null | undefined,
  allowlist: string[],
): BucketCount[] {
  const allowed = new Set(allowlist);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const values = keyFn(row);
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const raw = String(value ?? "OTHER");
      const bucket = allowed.has(raw) ? raw : "OTHER";
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }
  return sortBucketCounts(counts);
}

/**
 * Returns exactly one entry per value in `enumValues`, in that fixed
 * order, zero-filled, plus one additional `{bucket: "OTHER", count: N}`
 * entry for any row whose value is not in `enumValues`, so nothing is
 * silently dropped and nothing escapes the closed set (`enumValues`
 * doubles as this function's allowlist, no separate parameter needed).
 */
export function countByEnum<T>(rows: T[], keyFn: (row: T) => unknown, enumValues: string[]): BucketCount[] {
  const counts = new Map<string, number>();
  for (const value of enumValues) counts.set(value, 0);
  counts.set("OTHER", 0);
  const allowed = new Set(enumValues);
  for (const row of rows) {
    const raw = String(keyFn(row) ?? "OTHER");
    const bucket = allowed.has(raw) ? raw : "OTHER";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...enumValues, "OTHER"].map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
}

/**
 * Groups full rows by stringified key. An internal grouping helper, never
 * serialized directly into report output, so the bucket-allowlist rule
 * does not apply to it.
 */
export function groupBy<T>(rows: T[], keyFn: (row: T) => unknown): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = String(keyFn(row) ?? "OTHER");
    const existing = map.get(key);
    if (existing) {
      existing.push(row);
    } else {
      map.set(key, [row]);
    }
  }
  return map;
}

/**
 * Returns `null` if `denominator` is 0, else the percentage rounded to one
 * decimal place. An internal math helper, same reasoning as `groupBy`.
 */
export function percent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export interface MergedControl {
  id: string;
  externalId?: string;
  name?: string;
  description?: string;
  source?: string;
  domains?: string[];
  owner?: unknown;
  role?: string;
  customFields?: unknown;
  creationDate?: string;
  modificationDate?: string;
  implementationDetails?: string;
  status?: string;
  numDocumentsPassing?: number;
  numDocumentsTotal?: number;
  numTestsPassing?: number;
  numTestsTotal?: number;
  note?: string;
}

export interface ControlDetailError {
  controlId: string;
  code: string;
}

export interface FetchControlsWithStatusResult {
  controls: MergedControl[];
  controlDetailFetched: number;
  controlDetailTotal: number;
  errors: ControlDetailError[];
}

/**
 * `GET controls` (list) never carries `status`; only `GET
 * controls/{controlId}` (detail) does (round-1 finding 3). This helper
 * fetches the framework-scoped control list via `client.paginate`, then
 * merges `status`, `numDocumentsPassing`, `numDocumentsTotal`,
 * `numTestsPassing`, `numTestsTotal`, `note` onto each control's row by
 * calling `client.get("controls/" + control.id)` sequentially, one at a
 * time, through the same throttled client (never in parallel: the
 * throttle already caps outbound calls at 45/min regardless, and
 * sequential keeps this helper's own logic simple).
 *
 * Rate cost, stated plainly: at 45 requests/minute, roughly 75 controls
 * costs about two minutes of wall time. Every caller of this function
 * (`controls list --with-status`, `soc2 report`, `evidence gaps`) must
 * state that cost in its own help text or output too.
 *
 * A rejected detail fetch for one control does not stop the loop: it is
 * pushed into `errors` and that control's row keeps its base shape (no
 * `status`), and the loop continues with the next control.
 */
export async function fetchControlsWithStatus(
  client: VantaApiClient,
  frameworkId: string,
  opts: { all?: boolean; limit?: number },
): Promise<FetchControlsWithStatusResult> {
  const listResult = await client.paginate<MergedControl>("controls", { frameworkMatchesAny: [frameworkId] }, opts);
  if (listResult.error) {
    throw codeError(toErrorCode(listResult.error), listResult.error.message, { detail: listResult.error });
  }

  const controls: MergedControl[] = listResult.rows.map((row) => ({ ...row }));
  const errors: ControlDetailError[] = [];
  let controlDetailFetched = 0;

  for (const control of controls) {
    try {
      const detail = await client.get(`controls/${control.id}`);
      control.status = detail?.status;
      control.numDocumentsPassing = detail?.numDocumentsPassing;
      control.numDocumentsTotal = detail?.numDocumentsTotal;
      control.numTestsPassing = detail?.numTestsPassing;
      control.numTestsTotal = detail?.numTestsTotal;
      control.note = detail?.note;
      controlDetailFetched += 1;
    } catch (err) {
      errors.push({ controlId: control.id, code: toErrorCode(err) });
    }
  }

  return {
    controls,
    controlDetailFetched,
    controlDetailTotal: controls.length,
    errors,
  };
}
