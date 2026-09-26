/**
 * One `summarize<Resource>(rows)` (list) or `summarize<Resource>Detail(raw)`
 * (single object) function per resource. Every list-summarizer takes
 * `PaginationResult<T>.rows` (`src/paginate.ts`), i.e. the calling
 * command has already run `client.paginate(...)` and unwrapped it before
 * ever calling a function in this file; there is no `{rows, returnedCount,
 * hasMore}` shape received here, only the already-unwrapped `T[]` array
 * (or, defensively, anything else that is not an array, which every
 * function below treats the same as an empty list rather than throwing).
 *
 * These functions are only ever called when `--raw` is false; the calling
 * command renders `rows` unmodified, without calling anything here, when
 * `--raw` is true. No function below includes a raw `id`, `email`,
 * `emailAddress`, `websiteUrl`, `accountManagerEmail`, or free-text
 * `description`/`note` field verbatim: identifying or contact fields are
 * always replaced with a derived boolean presence flag, or dropped
 * outright.
 */

import { safeRowMeta } from "./safety.js";

function summarizeList<T = any>(prefix: string, rows: T[], project: (row: any, ref: string, hasId: boolean) => Record<string, unknown>): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const meta = safeRowMeta(prefix, index, row);
    return project(row, String(meta.ref), Boolean(meta.hasId));
  });
}

// --- Frameworks (endpoint reference lines 8-11, 13-15) ---------------------

export function summarizeFrameworks(rows: any[]): unknown[] {
  return summarizeList("framework", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    displayName: row?.displayName,
    shorthandName: row?.shorthandName,
    numControlsCompleted: row?.numControlsCompleted,
    numControlsTotal: row?.numControlsTotal,
    numDocumentsPassing: row?.numDocumentsPassing,
    numDocumentsTotal: row?.numDocumentsTotal,
    numTestsPassing: row?.numTestsPassing,
    numTestsTotal: row?.numTestsTotal,
  }));
}

export function summarizeFrameworkDetail(raw: any): unknown {
  return {
    displayName: raw?.displayName,
    shorthandName: raw?.shorthandName,
    numControlsCompleted: raw?.numControlsCompleted,
    numControlsTotal: raw?.numControlsTotal,
    numDocumentsPassing: raw?.numDocumentsPassing,
    numDocumentsTotal: raw?.numDocumentsTotal,
    numTestsPassing: raw?.numTestsPassing,
    numTestsTotal: raw?.numTestsTotal,
    requirementCategoryCount: Array.isArray(raw?.requirementCategories) ? raw.requirementCategories.length : 0,
  };
}

// --- Controls (endpoint reference lines 28-31, base; 42-44, detail) --------

/**
 * Accepts either a base `Control` row (`GET controls`, no `status`) or a
 * merged row carrying the `--with-status` detail fields (`GET
 * controls/{controlId}`, or `fetchControlsWithStatus`'s merged rows,
 * round-1 finding 3: the list endpoint never carries `status`). Includes
 * `status`/`numDocumentsPassing`/`numDocumentsTotal`/`numTestsPassing`/
 * `numTestsTotal` only when present on the input row; never fabricates
 * them on a base-shape row.
 *
 * Also used, unchanged, for `documents controls <id>`'s rows (that
 * endpoint's response schema is `Control`-shaped, round-1 finding 4).
 * `controls/{controlId}/documents`'s rows are `Document`-shaped instead;
 * summarize those with `summarizeDocuments`, not this function.
 */
export function summarizeControls(rows: any[]): unknown[] {
  return summarizeList("control", rows, (row, ref, hasId) => {
    const summary: Record<string, unknown> = {
      ref,
      hasId,
      name: row?.name,
      hasDescription: Boolean(row?.description),
      source: row?.source,
      domains: row?.domains,
      hasOwner: Boolean(row?.owner),
    };
    if (row?.status !== undefined) summary.status = row.status;
    if (row?.numDocumentsPassing !== undefined) summary.numDocumentsPassing = row.numDocumentsPassing;
    if (row?.numDocumentsTotal !== undefined) summary.numDocumentsTotal = row.numDocumentsTotal;
    if (row?.numTestsPassing !== undefined) summary.numTestsPassing = row.numTestsPassing;
    if (row?.numTestsTotal !== undefined) summary.numTestsTotal = row.numTestsTotal;
    return summary;
  });
}

// --- Tests (endpoint reference lines 68-75) ---------------------------------

export function summarizeTests(rows: any[]): unknown[] {
  return summarizeList("test", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    name: row?.name,
    category: row?.category,
    status: row?.status,
    hasOwner: Boolean(row?.owner),
    lastTestRunDate: row?.lastTestRunDate,
    latestFlipDate: row?.latestFlipDate,
    remediationStatus: row?.remediationStatusInfo?.status ?? null,
  }));
}

// --- Test entities (endpoint reference lines 77-80) -------------------------

/**
 * `hasId` is always `false` here: entity rows in the reference carry an
 * `id` that is itself a resource-shaped identifier the safety posture
 * treats like other IDs, so it is never used to derive a presence flag
 * the way every other summarizer's `hasId` is. This note is about the
 * summarized shape only; the `--raw` output path is the calling
 * command's separate, unmodified-passthrough path and is unaffected.
 */
export function summarizeTestEntities(rows: any[]): unknown[] {
  return summarizeList("test-entity", rows, (row, ref) => ({
    ref,
    hasId: false,
    entityStatus: row?.entityStatus,
    responseType: row?.responseType,
    hasDisplayName: Boolean(row?.displayName),
    deactivatedReason: row?.deactivatedReason,
    lastUpdatedDate: row?.lastUpdatedDate,
    createdDate: row?.createdDate,
  }));
}

// --- Documents (endpoint reference lines 88-98) ------------------------------

/**
 * `uploadStatus`/`uploadStatusDate` are mandatory contract fields, not
 * incidental ones: a missing value is coerced to `null` explicitly rather
 * than left `undefined`, since `JSON.stringify` drops `undefined` values
 * entirely and would otherwise silently make the key disappear from CLI
 * output instead of reporting it as unknown.
 */
export function summarizeDocuments(rows: any[]): unknown[] {
  return summarizeList("document", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    hasTitle: Boolean(row?.title),
    category: row?.category,
    uploadStatus: row?.uploadStatus ?? null,
    uploadStatusDate: row?.uploadStatusDate ?? null,
    isSensitive: row?.isSensitive,
    hasOwner: Boolean(row?.ownerId),
  }));
}

// --- Document uploads (endpoint reference lines 100-109) --------------------

export function summarizeDocumentUploads(rows: any[]): unknown[] {
  return summarizeList("document-upload", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    hasFileName: Boolean(row?.fileName),
    hasTitle: Boolean(row?.title),
    mimeType: row?.mimeType,
    uploadedByType: row?.uploadedBy?.type ?? null,
    creationDate: row?.creationDate,
    effectiveDate: row?.effectiveDate,
  }));
}

// --- Document links (endpoint reference lines 117-126) ----------------------

export function summarizeDocumentLinks(rows: any[]): unknown[] {
  return summarizeList("document-link", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    hasTitle: Boolean(row?.title),
    hasUrl: Boolean(row?.url),
    creationDate: row?.creationDate,
    effectiveDate: row?.effectiveDate,
  }));
}

// --- Policies (endpoint reference lines 128-135) -----------------------------

export function summarizePolicies(rows: any[]): unknown[] {
  return summarizeList("policy", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    hasName: Boolean(row?.name),
    status: row?.status,
    approvedAtDate: row?.approvedAtDate,
  }));
}

// --- People (endpoint reference lines 137-150) -------------------------------

/** Never includes `emailAddress` in the summarized shape. */
export function summarizePeople(rows: any[]): unknown[] {
  return summarizeList("person", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    employmentStatus: row?.employment?.status ?? null,
    tasksSummaryStatus: row?.tasksSummary?.status ?? null,
    groupCount: Array.isArray(row?.groupIds) ? row.groupIds.length : 0,
    hasName: Boolean(row?.name),
  }));
}

// --- Users (endpoint reference lines 163-166) --------------------------------

/** Never includes `email` in the summarized shape. */
export function summarizeUsers(rows: any[]): unknown[] {
  return summarizeList("user", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    hasDisplayName: Boolean(row?.displayName),
    isActive: row?.isActive,
  }));
}

// --- Vendors (endpoint reference lines 174-181) ------------------------------

/** Never includes `websiteUrl` or `accountManagerEmail` in the summarized shape. */
export function summarizeVendors(rows: any[]): unknown[] {
  return summarizeList("vendor", rows, (row, ref, hasId) => ({
    ref,
    hasId,
    hasName: Boolean(row?.name),
    status: row?.status,
    inherentRiskLevel: row?.inherentRiskLevel,
    residualRiskLevel: row?.residualRiskLevel,
    hasNextSecurityReviewDate: Boolean(row?.nextSecurityReviewDueDate),
  }));
}

// --- Risk scenarios (endpoint reference lines 192-201) -----------------------

/**
 * Risk scenarios use `riskId`, not `id`; `hasId` is `Boolean(row.riskId)`.
 * `categories` passes through as-is: these are catalog category strings,
 * not PII, and the field has no closed enum to bucket against (a
 * deliberate omission from `report-helpers.ts`'s allowlist registry, not
 * a gap to fill in later).
 */
export function summarizeRiskScenarios(rows: any[]): unknown[] {
  return summarizeList("risk-scenario", rows, (row, ref) => ({
    ref,
    hasId: Boolean(row?.riskId),
    hasDescription: Boolean(row?.description),
    likelihood: row?.likelihood,
    impact: row?.impact,
    residualLikelihood: row?.residualLikelihood,
    residualImpact: row?.residualImpact,
    reviewStatus: row?.reviewStatus,
    type: row?.type,
    categories: row?.categories,
  }));
}

// --- Integrations (endpoint reference lines 203-206) -------------------------

/** Integrations use `integrationId`, not `id`; `hasId` is `Boolean(row.integrationId)`. */
export function summarizeIntegrations(rows: any[]): unknown[] {
  return summarizeList("integration", rows, (row, ref) => ({
    ref,
    hasId: Boolean(row?.integrationId),
    hasDisplayName: Boolean(row?.displayName),
    resourceKindCount: Array.isArray(row?.resourceKinds) ? row.resourceKinds.length : 0,
    connectionCount: Array.isArray(row?.connections) ? row.connections.length : 0,
  }));
}
