/**
 * Markdown rendering for the two output classes defined in
 * `src/reports.ts` (spec.md D8, D11): `renderSoc2ReportMarkdown` for the
 * one aggregate report, `renderEvidenceGapsWorklistMarkdown` for the one
 * worklist. Both reuse the same small set of local table/list/sanitize
 * helpers defined in this file; neither imports from a shared markdown
 * module, since none exists in this design.
 *
 * `renderSoc2ReportMarkdown`'s tables never carry a "Control"/"Document"
 * name/title column; `renderEvidenceGapsWorklistMarkdown`'s per-row
 * tables are allowed one, since a worklist exists precisely so an
 * operator can act on named items (spec.md R10).
 */

import type { BucketCount } from "./report-helpers.js";
import type { Completeness, EvidenceGapsWorklistFlat, Soc2ReportFlat } from "./reports.js";

// --- Shared markdown helpers -------------------------------------------------

/**
 * Redacts the same secret-shaped substrings `safety.ts`'s pattern checks
 * look for (`vcs_`/`vci_` client secret/id prefixes, `Bearer ` tokens).
 * Defense in depth only: both renderers only ever receive a report or
 * worklist that has already passed its own safety gate, so this should
 * never actually match anything in practice.
 */
export function sanitizeText(value: string): string {
  return value
    .replace(/\bvcs_[A-Za-z0-9._~+/=-]{10,}/g, "[redacted]")
    .replace(/\bvci_[A-Za-z0-9._~+/=-]{10,}/g, "[redacted]")
    .replace(/\bBearer [A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [redacted]");
}

/**
 * Matches every line-terminator shape that can appear in a cell value:
 * CRLF, bare CR, bare LF, and the Unicode line/paragraph separators
 * U+2028/U+2029 (built via `String.fromCharCode` rather than a literal
 * escape in this source file, since those code points are themselves
 * line terminators in JS/TS source text).
 */
const LINE_TERMINATOR_PATTERN = new RegExp(
  `\r\n|\r|\n|${String.fromCharCode(0x2028)}|${String.fromCharCode(0x2029)}`,
  "g",
);

/**
 * Escapes a markdown table cell: pipes cannot survive as-is, and every
 * line-terminator shape (CRLF, bare CR, bare LF, and the Unicode line/
 * paragraph separators U+2028/U+2029) is collapsed to a single space.
 * Markdown treats a bare CR as a line ending too, so a crafted name or
 * title containing one could otherwise escape its table row and alter
 * table structure; matching CRLF before bare CR/LF keeps a real CRLF
 * pair from collapsing to two spaces.
 */
export function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return sanitizeText(text)
    .replace(/\|/g, "\\|")
    .replace(LINE_TERMINATOR_PATTERN, " ");
}

/** Formats a possibly-missing numeric field without ever throwing. */
export function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

export function booleanLabel(value: boolean): string {
  return value ? "Yes" : "No";
}

/** `byUploadStatus` -> "By Upload Status"; `controls-detail` -> "Controls Detail". */
export function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Renders a well-formed markdown table for any row count, including
 * zero: an empty breakdown or worklist group is a normal successful
 * output (spec.md D8/D11), not an edge case to special-case away. The
 * header and separator rows always carry exactly `headers.length`
 * columns; an empty `rows` renders one additional row reading "none" in
 * the first column with every remaining column blank, never a row with
 * the wrong column count.
 */
export function table(headers: string[], rows: string[][]): string {
  const headerLine = `| ${headers.join(" | ")} |`;
  const separatorLine = `| ${headers.map(() => "---").join(" | ")} |`;
  if (rows.length === 0) {
    const emptyRow = ["none", ...headers.slice(1).map(() => "")];
    return [headerLine, separatorLine, `| ${emptyRow.join(" | ")} |`].join("\n");
  }
  const bodyLines = rows.map((row) => `| ${row.join(" | ")} |`);
  return [headerLine, separatorLine, ...bodyLines].join("\n");
}

export function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function bucketTable(title: string, buckets: BucketCount[]): string {
  const rows = buckets.map((b) => [escapeCell(b.bucket), escapeCell(b.count)]);
  return `## ${title}\n\n${table(["Bucket", "Count"], rows)}`;
}

function summaryTable(rows: [string, string][]): string {
  return table(
    ["Signal", "Value"],
    rows.map(([signal, value]) => [escapeCell(signal), escapeCell(value)]),
  );
}

function completenessSection(completeness: Completeness): string {
  const sections: string[] = ["## Partial Source Errors"];

  if (completeness.sourceErrors.length > 0) {
    sections.push(
      table(
        ["Source", "Code", "Retryable"],
        completeness.sourceErrors.map((e) => [
          escapeCell(e.source),
          escapeCell(e.code),
          escapeCell(booleanLabel(e.retryable)),
        ]),
      ),
    );
  }

  if (completeness.shapeErrors.length > 0) {
    sections.push(
      "### Shape Errors",
      table(
        ["Source", "Code"],
        completeness.shapeErrors.map((e) => [escapeCell(e.source), escapeCell(e.code)]),
      ),
    );
  }

  if (completeness.paginationGaps.length > 0) {
    sections.push(
      "### Pagination Gaps",
      table(
        ["Source", "Returned"],
        completeness.paginationGaps.map((g) => [escapeCell(g.source), escapeCell(g.returned)]),
      ),
    );
  }

  return sections.join("\n\n");
}

// --- soc2 report --------------------------------------------------------------

export function renderSoc2ReportMarkdown(report: Soc2ReportFlat): string {
  const { completeness, ...data } = report;

  const sections: string[] = ["# SOC 2 Report"];

  sections.push(
    summaryTable([
      ["Framework", data.framework.ref],
      ["Controls Completed / Total", `${formatNumber(data.framework.numControlsCompleted)} / ${formatNumber(data.framework.numControlsTotal)}`],
      ["Documents Passing / Total", `${formatNumber(data.framework.numDocumentsPassing)} / ${formatNumber(data.framework.numDocumentsTotal)}`],
      ["Tests Passing / Total", `${formatNumber(data.framework.numTestsPassing)} / ${formatNumber(data.framework.numTestsTotal)}`],
      ["Complete", booleanLabel(completeness.complete)],
    ]),
  );

  sections.push(bucketTable("Controls By Status", data.controls.byStatus));
  sections.push(bucketTable("Controls By Domain", data.controls.byDomain));
  sections.push(bucketTable("Tests By Status", data.tests.byStatus));
  sections.push(bucketTable("Tests By Category", data.tests.byCategory));
  sections.push(bucketTable("Documents By Upload Status", data.documents.byUploadStatus));
  sections.push(bucketTable("Documents By Category", data.documents.byCategory));
  sections.push(bucketTable("People By Task Summary Status", data.people.byTaskSummaryStatus));

  if (!completeness.complete) {
    sections.push(completenessSection(completeness));
  }

  return `${sections.join("\n\n")}\n`;
}

// --- evidence gaps --------------------------------------------------------------

function documentGroupSection(title: string, group: { total: number; byCategory: BucketCount[]; rows: Record<string, unknown>[] }): string {
  const hasIds = group.rows.some((row) => "id" in row);
  const headers = hasIds ? ["ID", "Document", "Category"] : ["Document", "Category"];
  const rows = group.rows.map((row) => {
    const cells = hasIds ? [escapeCell(row.id)] : [];
    cells.push(escapeCell(row.title), escapeCell(row.category));
    return cells;
  });

  return [
    `## ${title} (${group.total})`,
    table(headers, rows),
    bucketTable(`${title} By Category`, group.byCategory),
  ].join("\n\n");
}

export function renderEvidenceGapsWorklistMarkdown(worklist: EvidenceGapsWorklistFlat): string {
  const { completeness, ...data } = worklist;

  const sections: string[] = ["# Evidence Gaps"];

  sections.push(
    summaryTable([
      ["Controls Needing Evidence", formatNumber(data.controls.total)],
      ["Documents Needing Document", formatNumber(data.documents.needsDocument.total)],
      ["Documents Needing Update", formatNumber(data.documents.needsUpdate.total)],
      ["Complete", booleanLabel(completeness.complete)],
    ]),
  );

  sections.push(bucketTable("Controls By Domain", data.controls.byDomain));

  const hasControlIds = data.controls.rows.some((row) => "id" in row);
  const controlHeaders = hasControlIds ? ["ID", "Control", "Status", "Domains"] : ["Control", "Status", "Domains"];
  const controlRows = data.controls.rows.map((row) => {
    const cells = hasControlIds ? [escapeCell(row.id)] : [];
    const domains = Array.isArray(row.domains) ? row.domains.join(", ") : row.domains;
    cells.push(escapeCell(row.name), escapeCell(row.status), escapeCell(domains));
    return cells;
  });
  sections.push(`## Controls Needing Evidence (${data.controls.total})`, table(controlHeaders, controlRows));

  sections.push(documentGroupSection("Documents Needing Document", data.documents.needsDocument));
  sections.push(documentGroupSection("Documents Needing Update", data.documents.needsUpdate));

  if (!completeness.complete) {
    sections.push(completenessSection(completeness));
  }

  return `${sections.join("\n\n")}\n`;
}
