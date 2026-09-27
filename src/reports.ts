/**
 * The one aggregate report (`soc2 report`) and the one worklist (`evidence
 * gaps`), plus their CLI command groups (spec.md D8, D11, task 007).
 *
 * `soc2 report` is gated by `assertSafeAggregateReport`: counts and enum
 * groupings only, no names, no titles, no ids. `evidence gaps` is a
 * distinct output class, gated by `assertSafeWorklist`: names and titles
 * are allowed because the operator needs them to act. Neither builder
 * calls the other's gate; both call their own gate on every success path,
 * before returning, so a `CHECK_FAILED` failure propagates up through
 * `runJsonAction` normally.
 *
 * Building strategy (spec.md D8): every source read goes through
 * `client.paginate(...)`, which never throws. A required source's
 * `result.error` throws a mapped CliError before `data` exists at all
 * (nothing to gate on that path). An optional source's `result.error` is
 * folded into `completeness.sourceErrors` (or `shapeErrors` when the code
 * indicates a malformed response) and the builder continues with whatever
 * partial rows `paginate()` collected.
 */

import { promises as fsPromises } from "node:fs";
import { Command } from "commander";
import { SCOPE_READ } from "./config.js";
import { codeError, isRetryable } from "./output.js";
import { clientFor, runJsonAction, unwrapPaginated } from "./cli-runtime.js";
import type { PaginationResult } from "./paginate.js";
import type { VantaApiClient } from "./vanta-api.js";
import {
  BUCKET_ALLOWLISTS,
  countBy,
  countByEnum,
  countByFlattened,
  fetchControlsWithStatus,
  type BucketCount,
  type FetchControlsWithStatusResult,
  type MergedControl,
} from "./report-helpers.js";
import { assertSafeAggregateReport, assertSafeWorklist, safeRowMeta } from "./safety.js";
import { renderEvidenceGapsWorklistMarkdown, renderSoc2ReportMarkdown } from "./report-renderer.js";

// --- Shared completeness plumbing -------------------------------------------

export interface SourceError {
  source: string;
  code: string;
  retryable: boolean;
}

export interface ShapeError {
  source: string;
  code: string;
}

export interface PaginationGap {
  source: string;
  returned: number;
}

export interface Completeness {
  complete: boolean;
  sourceErrors: SourceError[];
  shapeErrors: ShapeError[];
  paginationGaps: PaginationGap[];
  controlDetailFetched?: number;
  controlDetailTotal?: number;
}

/**
 * Codes a malformed upstream response can actually surface through this
 * codebase: `paginate.ts`'s `assertValidPage` throws `CHECK_FAILED` on a
 * page shape that isn't `{data: [], pageInfo: {...}}`, and
 * `vanta-api.ts`'s `requestPage` throws `VALIDATION` when `results.data`
 * isn't an array. Both indicate the response itself was malformed, not a
 * normal upstream failure, so both route to `shapeErrors` rather than
 * `sourceErrors`.
 */
const SHAPE_ERROR_CODES = new Set(["CHECK_FAILED", "VALIDATION"]);

function isShapeErrorCode(code: string): boolean {
  return SHAPE_ERROR_CODES.has(code);
}

/**
 * Folds an optional source's `PaginationResult` into the running
 * `sourceErrors`/`shapeErrors`/`paginationGaps` lists. Never throws: an
 * optional source's failure is recorded, not fatal, and the caller
 * continues with whatever rows came back.
 */
function foldOptionalResult<T>(
  result: PaginationResult<T>,
  source: string,
  sourceErrors: SourceError[],
  shapeErrors: ShapeError[],
  paginationGaps: PaginationGap[],
): void {
  if (result.error) {
    const code = result.error.code;
    if (isShapeErrorCode(code)) {
      shapeErrors.push({ source, code });
    } else {
      sourceErrors.push({ source, code, retryable: isRetryable({ code }) });
    }
    return;
  }
  if (!result.complete) {
    paginationGaps.push({ source, returned: result.returnedCount });
  }
}

/**
 * Same bookkeeping as `foldOptionalResult`, for a required source that has
 * already been unwrapped (via `unwrapPaginated`, which throws on
 * `result.error`) and therefore can only ever reach here on the success
 * path. Only the `paginationGaps` case is still possible.
 */
function notePaginationGap<T>(result: PaginationResult<T>, source: string, paginationGaps: PaginationGap[]): void {
  if (!result.error && !result.complete) {
    paginationGaps.push({ source, returned: result.returnedCount });
  }
}

/**
 * `fetchControlsWithStatus`'s own per-control detail-fetch errors
 * (`FetchControlsWithStatusResult.errors`) always fold into
 * `sourceErrors` with `source: "controls-detail"` (spec.md D8), never
 * `shapeErrors`: a single control's detail fetch failing is a per-item
 * upstream failure, not evidence the whole response was malformed.
 */
function foldControlDetailErrors(detail: FetchControlsWithStatusResult): SourceError[] {
  return detail.errors.map((e) => ({
    source: "controls-detail",
    code: e.code,
    retryable: isRetryable({ code: e.code }),
  }));
}

function isCompletenessComplete(completeness: Omit<Completeness, "complete">): boolean {
  return (
    completeness.sourceErrors.length === 0 &&
    completeness.shapeErrors.length === 0 &&
    completeness.paginationGaps.length === 0
  );
}

// --- soc2 report -------------------------------------------------------------

export interface Soc2ReportFrameworkBlock {
  ref: string;
  numControlsCompleted: number;
  numControlsTotal: number;
  numDocumentsPassing: number;
  numDocumentsTotal: number;
  numTestsPassing: number;
  numTestsTotal: number;
}

/**
 * The framework block is numeric-only, never a passthrough (spec.md
 * R4/D8): a malformed value here (a string, `NaN`, `Infinity`, missing)
 * would not match any of `assertSafeAggregateReport`'s forbidden
 * patterns and could otherwise reach the aggregate report's JSON
 * unnoticed. Fails closed, naming the field, before `data` exists.
 */
function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw codeError(
      "CHECK_FAILED",
      `soc2 report: framework field "${field}" is not a finite number.`,
    );
  }
  return value;
}

export interface Soc2ReportData {
  framework: Soc2ReportFrameworkBlock;
  controls: { byStatus: BucketCount[]; byDomain: BucketCount[] };
  tests: { byStatus: BucketCount[]; byCategory: BucketCount[] };
  documents: { byUploadStatus: BucketCount[]; byCategory: BucketCount[] };
  people: { byTaskSummaryStatus: BucketCount[] };
}

/**
 * The CLI's printed shape (spec.md D8): the report's own fields plus
 * `completeness`, flattened, with no wrapping `data` key. Distinct from
 * `Soc2Report`, `buildSoc2Report`'s own return shape, which keeps `data`
 * and `completeness` as siblings for the builder's caller; the CLI action
 * flattens once, right before printing or rendering.
 */
export type Soc2ReportFlat = Soc2ReportData & { completeness: Completeness };

export interface Soc2Report {
  data: Soc2ReportData;
  completeness: Completeness;
}

/**
 * Finds the tenant's SOC 2 framework row among `frameworks list`'s rows,
 * matching `shorthandName` or `displayName` case-insensitively against
 * "SOC 2". `displayName`/`shorthandName` are read only for this match;
 * neither is ever copied into the report's output (round-3 blocker fix,
 * spec.md D8): `assertSafeAggregateReport` structurally rejects a
 * `displayName` key, so a report that included one could never pass its
 * own gate.
 */
function findSoc2Framework(frameworks: any[]): any {
  const needle = "soc 2";
  return frameworks.find((row) => {
    const shorthand = typeof row?.shorthandName === "string" ? row.shorthandName.toLowerCase() : "";
    const display = typeof row?.displayName === "string" ? row.displayName.toLowerCase() : "";
    return shorthand.includes(needle) || display.includes(needle);
  });
}

/**
 * Builds the one sanitized aggregate report. Required sources:
 * `frameworks`, `fetchControlsWithStatus` (control status is unavailable
 * from a plain `controls.paginate` call, round-1 finding 3), `tests`,
 * `documents`. Optional source: `people`. Calls
 * `assertSafeAggregateReport` on the full report object on every success
 * path.
 */
export async function buildSoc2Report(client: VantaApiClient): Promise<Soc2Report> {
  const sourceErrors: SourceError[] = [];
  const shapeErrors: ShapeError[] = [];
  const paginationGaps: PaginationGap[] = [];

  const frameworksResult = await client.paginate<any>("frameworks", {}, { all: true });
  const frameworks = unwrapPaginated(frameworksResult, "soc2 report (frameworks)");
  notePaginationGap(frameworksResult, "frameworks", paginationGaps);

  const frameworkRow = findSoc2Framework(frameworks);
  if (!frameworkRow) {
    throw codeError("NOT_FOUND", "No SOC 2 framework found in this tenant.");
  }
  const soc2Id = frameworkRow.id as string;

  const controlDetail = await fetchControlsWithStatus(client, soc2Id, { all: true });
  sourceErrors.push(...foldControlDetailErrors(controlDetail));
  const mergedRows: MergedControl[] = controlDetail.controls;

  const testsResult = await client.paginate<any>("tests", { frameworkFilter: soc2Id }, { all: true });
  const testRows = unwrapPaginated(testsResult, "soc2 report (tests)");
  notePaginationGap(testsResult, "tests", paginationGaps);

  const documentsResult = await client.paginate<any>(
    "documents",
    { frameworkMatchesAny: [soc2Id] },
    { all: true },
  );
  const documentRows = unwrapPaginated(documentsResult, "soc2 report (documents)");
  notePaginationGap(documentsResult, "documents", paginationGaps);

  const peopleResult = await client.paginate<any>("people", {}, { all: true });
  foldOptionalResult(peopleResult, "people", sourceErrors, shapeErrors, paginationGaps);
  const peopleRows = peopleResult.rows;

  const data: Soc2ReportData = {
    framework: {
      ref: String(safeRowMeta("framework", 0, frameworkRow).ref),
      numControlsCompleted: requireFiniteNumber(frameworkRow.numControlsCompleted, "numControlsCompleted"),
      numControlsTotal: requireFiniteNumber(frameworkRow.numControlsTotal, "numControlsTotal"),
      numDocumentsPassing: requireFiniteNumber(frameworkRow.numDocumentsPassing, "numDocumentsPassing"),
      numDocumentsTotal: requireFiniteNumber(frameworkRow.numDocumentsTotal, "numDocumentsTotal"),
      numTestsPassing: requireFiniteNumber(frameworkRow.numTestsPassing, "numTestsPassing"),
      numTestsTotal: requireFiniteNumber(frameworkRow.numTestsTotal, "numTestsTotal"),
    },
    controls: {
      byStatus: countBy(mergedRows, (r) => r.status, [...BUCKET_ALLOWLISTS.controlStatus]),
      byDomain: countByFlattened(mergedRows, (r) => r.domains, [...BUCKET_ALLOWLISTS.controlDomain]),
    },
    tests: {
      byStatus: countBy(testRows, (r: any) => r?.status, [...BUCKET_ALLOWLISTS.testStatus]),
      byCategory: countBy(testRows, (r: any) => r?.category, [...BUCKET_ALLOWLISTS.documentAndTestCategory]),
    },
    documents: {
      byUploadStatus: countByEnum(documentRows, (r: any) => r?.uploadStatus, [...BUCKET_ALLOWLISTS.documentUploadStatus]),
      byCategory: countBy(documentRows, (r: any) => r?.category, [...BUCKET_ALLOWLISTS.documentAndTestCategory]),
    },
    people: {
      byTaskSummaryStatus: countBy(
        peopleRows,
        (r: any) => r?.tasksSummary?.status,
        [...BUCKET_ALLOWLISTS.tasksSummaryStatus],
      ),
    },
  };

  const completeness: Completeness = {
    complete: isCompletenessComplete({ sourceErrors, shapeErrors, paginationGaps }),
    sourceErrors,
    shapeErrors,
    paginationGaps,
    controlDetailFetched: controlDetail.controlDetailFetched,
    controlDetailTotal: controlDetail.controlDetailTotal,
  };

  assertSafeAggregateReport({ ...data, completeness }, "soc2 report");

  return { data, completeness };
}

// --- evidence gaps -----------------------------------------------------------

const GAP_CONTROL_STATUSES = new Set(["NO_EVIDENCE_MAPPED", "NOT_STARTED"]);

export interface EvidenceGapsWorklistData {
  controls: {
    total: number;
    controlDetailFetched: number;
    controlDetailTotal: number;
    byDomain: BucketCount[];
    rows: Record<string, unknown>[];
  };
  documents: {
    needsDocument: { total: number; byCategory: BucketCount[]; rows: Record<string, unknown>[] };
    needsUpdate: { total: number; byCategory: BucketCount[]; rows: Record<string, unknown>[] };
  };
}

export interface EvidenceGapsWorklist {
  data: EvidenceGapsWorklistData;
  completeness: Completeness;
}

/** The CLI's printed shape for `evidence gaps`; see `Soc2ReportFlat`'s note. */
export type EvidenceGapsWorklistFlat = EvidenceGapsWorklistData & { completeness: Completeness };

export interface BuildEvidenceGapsWorklistOpts {
  showIds?: boolean;
  framework?: string;
}

/**
 * Resolves the framework id to scope this worklist to: `--framework` if
 * given, else the tenant's sole framework, else `VALIDATION` (same rule
 * as `controls list --with-status`, spec.md D5/D11).
 */
async function resolveFrameworkId(client: VantaApiClient, framework: string | undefined): Promise<string> {
  if (framework) return framework;
  const frameworksResult = await client.paginate<any>("frameworks", {}, { all: true, limit: 1000 });
  const frameworks = unwrapPaginated(frameworksResult, "evidence gaps (resolving --framework)");
  if (frameworks.length !== 1) {
    throw codeError(
      "VALIDATION",
      "evidence gaps requires --framework unless the tenant has exactly one framework.",
    );
  }
  return frameworks[0].id as string;
}

function projectControlRow(r: MergedControl, showIds: boolean): Record<string, unknown> {
  return {
    ...(showIds ? { id: r.id } : {}),
    name: r.name,
    status: r.status,
    domains: r.domains,
  };
}

function projectDocumentRow(r: any, showIds: boolean): Record<string, unknown> {
  return {
    ...(showIds ? { id: r?.id } : {}),
    title: r?.title,
    category: r?.category,
  };
}

/**
 * Builds the one V1 worklist. Required sources: `fetchControlsWithStatus`
 * (status is unavailable from a plain `controls.paginate` call, round-1
 * finding 3) and `documents.paginate({}, {all: true})`. Documents split
 * into two separate, never-merged groups (`needsDocument`/`needsUpdate`,
 * spec.md R7). Calls `assertSafeWorklist` on the full worklist object on
 * every success path, never `assertSafeAggregateReport`.
 */
export async function buildEvidenceGapsWorklist(
  client: VantaApiClient,
  opts: BuildEvidenceGapsWorklistOpts,
): Promise<EvidenceGapsWorklist> {
  const sourceErrors: SourceError[] = [];
  const shapeErrors: ShapeError[] = [];
  const paginationGaps: PaginationGap[] = [];

  const frameworkId = await resolveFrameworkId(client, opts.framework);

  const controlDetail = await fetchControlsWithStatus(client, frameworkId, { all: true });
  sourceErrors.push(...foldControlDetailErrors(controlDetail));

  const documentsResult = await client.paginate<any>("documents", {}, { all: true });
  const documentRows = unwrapPaginated(documentsResult, "evidence gaps (documents)");
  notePaginationGap(documentsResult, "documents", paginationGaps);

  const showIds = Boolean(opts.showIds);

  const filteredControls = controlDetail.controls.filter(
    (r) => typeof r.status === "string" && GAP_CONTROL_STATUSES.has(r.status),
  );
  const needsDocument = documentRows.filter((r: any) => r?.uploadStatus === "Needs document");
  const needsUpdate = documentRows.filter((r: any) => r?.uploadStatus === "Needs update");

  const data: EvidenceGapsWorklistData = {
    controls: {
      total: filteredControls.length,
      controlDetailFetched: controlDetail.controlDetailFetched,
      controlDetailTotal: controlDetail.controlDetailTotal,
      byDomain: countByFlattened(filteredControls, (r) => r.domains, [...BUCKET_ALLOWLISTS.controlDomain]),
      rows: filteredControls.map((r) => projectControlRow(r, showIds)),
    },
    documents: {
      needsDocument: {
        total: needsDocument.length,
        byCategory: countBy(needsDocument, (r: any) => r?.category, [...BUCKET_ALLOWLISTS.documentAndTestCategory]),
        rows: needsDocument.map((r: any) => projectDocumentRow(r, showIds)),
      },
      needsUpdate: {
        total: needsUpdate.length,
        byCategory: countBy(needsUpdate, (r: any) => r?.category, [...BUCKET_ALLOWLISTS.documentAndTestCategory]),
        rows: needsUpdate.map((r: any) => projectDocumentRow(r, showIds)),
      },
    },
  };

  const completeness: Completeness = {
    complete: isCompletenessComplete({ sourceErrors, shapeErrors, paginationGaps }),
    sourceErrors,
    shapeErrors,
    paginationGaps,
    controlDetailFetched: controlDetail.controlDetailFetched,
    controlDetailTotal: controlDetail.controlDetailTotal,
  };

  assertSafeWorklist({ ...data, completeness }, "evidence gaps", { allowIds: showIds });

  return { data, completeness };
}

// --- CLI wiring ---------------------------------------------------------------

type OutputFormat = "json" | "markdown";

function validateFormat(value: string): OutputFormat {
  if (value !== "json" && value !== "markdown") {
    throw codeError("VALIDATION", `--format must be one of: json, markdown. Got "${value}".`);
  }
  return value;
}

function requireOutPath(format: OutputFormat, out: string | undefined): string {
  if (format === "markdown" && !out) {
    throw codeError("VALIDATION", "--format markdown requires --out <path>.");
  }
  return out as string;
}

interface Soc2ReportOpts {
  format: string;
  out?: string;
  json?: boolean;
}

interface EvidenceGapsOpts {
  showIds?: boolean;
  framework?: string;
  format: string;
  out?: string;
  json?: boolean;
}

const CONTROL_DETAIL_RATE_NOTE =
  "Detail-fetches control status per control, sequentially, through the throttled client " +
  "(45 requests/minute); at that rate, detail-fetching roughly 75 controls costs about " +
  "two minutes of wall time.";

export function registerSoc2Command(program: Command): Command {
  const cmd = program.command("soc2").description("SOC 2 aggregate reporting.");

  cmd
    .command("report")
    .description(
      "Sanitized SOC 2 aggregate report: counts and enum groupings only, never names, " +
        `titles, or ids. ${CONTROL_DETAIL_RATE_NOTE}`,
    )
    .option("--format <format>", "Output format: json or markdown (default json).", "json")
    .option("--out <path>", "Write rendered markdown to this path (required with --format markdown).")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (opts: Soc2ReportOpts) => {
      await runJsonAction(async () => {
        const format = validateFormat(opts.format);
        const outPath = format === "markdown" ? requireOutPath(format, opts.out) : undefined;
        const client = await clientFor([SCOPE_READ]);
        const report = await buildSoc2Report(client);
        const flattened: Soc2ReportFlat = { ...report.data, completeness: report.completeness };
        if (format === "markdown") {
          const markdown = renderSoc2ReportMarkdown(flattened);
          await fsPromises.writeFile(outPath as string, markdown, "utf8");
          return { format: "markdown" as const, written: true };
        }
        return flattened;
      }, opts);
    });

  return cmd;
}

export function registerEvidenceCommand(program: Command): Command {
  const cmd = program.command("evidence").description("Evidence-gap worklists.");

  cmd
    .command("gaps")
    .description(
      "Worklist of controls missing evidence and documents needing attention. Names and " +
        `titles are included; pass --show-ids for raw upstream ids. ${CONTROL_DETAIL_RATE_NOTE}`,
    )
    .option("--show-ids", "Include raw upstream ids in the output.")
    .option("--framework <id>", "Framework id (defaults to the tenant's sole framework, else required).")
    .option("--format <format>", "Output format: json or markdown (default json).", "json")
    .option("--out <path>", "Write rendered markdown to this path (required with --format markdown).")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (opts: EvidenceGapsOpts) => {
      await runJsonAction(async () => {
        const format = validateFormat(opts.format);
        const outPath = format === "markdown" ? requireOutPath(format, opts.out) : undefined;
        const client = await clientFor([SCOPE_READ]);
        const worklist = await buildEvidenceGapsWorklist(client, {
          showIds: Boolean(opts.showIds),
          framework: opts.framework,
        });
        const flattened: EvidenceGapsWorklistFlat = { ...worklist.data, completeness: worklist.completeness };
        if (format === "markdown") {
          const markdown = renderEvidenceGapsWorklistMarkdown(flattened);
          await fsPromises.writeFile(outPath as string, markdown, "utf8");
          return { format: "markdown" as const, written: true };
        }
        return flattened;
      }, opts);
    });

  return cmd;
}
