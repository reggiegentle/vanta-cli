/**
 * The two-phase (intent/result) write ledger: append-only record format,
 * the content-hash duplicate check, the ledger lockfile wiring, and the
 * `ledger list` command. Owned entirely by task 008a (spec.md D10).
 *
 * This file never acquires ledger.lock itself. Every write sub-operation in
 * writes.ts (task 008b) holds `ledger.lock` for the whole span from its
 * duplicate check through its result append; the functions here only ever
 * answer the question they are asked.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Command } from "commander";
import { acquireLock, getConfigDir, getLedgerLockPath } from "./config.js";
import { codeError } from "./output.js";
import { runJsonAction } from "./cli-runtime.js";

// Spec fix, 2026-09-26: command, targetType, and targetId are required on
// every line, not optional (matching readLedgerLines's schema validation
// below). resultIds/readbackVerified stay optional in this flat type since
// only result lines carry them (readLedgerLines enforces them as required
// specifically for phase "result").
export interface LedgerLine {
  opId: string;
  phase: "intent" | "result";
  ts: string;
  command: string;
  targetType: "document" | "control";
  targetId: string;
  fileName?: string;
  sha256?: string;
  bytes?: number;
  resultIds?: string[];
  readbackVerified?: boolean;
  readbackError?: { code: string; message: string };
  /**
   * Round-2 gate fix: the 1-indexed physical line this line was read from
   * in the ledger file, attached in memory by readLedgerLines for
   * diagnostics only (groupIntoOperations's orphan-result error). Never
   * written to disk: appendLedgerLine strips it before serializing, so no
   * line this file ever appends carries it, regardless of how it got
   * onto an in-memory object.
   */
  lineNumber?: number;
}

export interface LedgerResultInput {
  command: string;
  targetType: LedgerLine["targetType"];
  targetId: string;
  resultIds: string[];
  readbackVerified: boolean;
  readbackError?: { code: string; message: string };
}

export interface LedgerOperation {
  intent: LedgerLine;
  result?: LedgerLine;
}

// --- Paths -----------------------------------------------------------

export function getLedgerPath(): string {
  return path.join(getConfigDir(), "vanta", "write-ledger.jsonl");
}

export function getDisplayLedgerPath(): string {
  return process.env.XDG_CONFIG_HOME?.trim()
    ? "$XDG_CONFIG_HOME/vanta/write-ledger.jsonl"
    : "~/.config/vanta/write-ledger.jsonl";
}

// --- Locking (delegates entirely to config.ts's shared primitive) --------

export async function acquireLedgerLock(): Promise<() => Promise<void>> {
  return acquireLock(getLedgerLockPath());
}

// --- Appends -----------------------------------------------------------

async function appendLedgerLine(line: LedgerLine): Promise<void> {
  // Belt and suspenders: lineNumber is a read-side-only diagnostic field
  // that never belongs on disk. Nothing in this file ever sets it on a
  // line it appends, but strip it explicitly here too so it can never
  // leak into the ledger regardless of what a caller passed in.
  const { lineNumber: _lineNumber, ...persisted } = line;
  const ledgerPath = getLedgerPath();
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(ledgerPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  // Best-effort: appendFile's mode only takes effect when the file is
  // created, not when it already exists, so force 0600 again on every
  // append regardless of who owned the file before this process touched it.
  await fs.chmod(ledgerPath, 0o600).catch(() => {});
}

export async function appendIntentLedgerLine(entry: Omit<LedgerLine, "phase">): Promise<void> {
  await appendLedgerLine({ ...entry, phase: "intent" });
}

export async function appendResultLedgerLine(opId: string, result: LedgerResultInput): Promise<void> {
  await appendLedgerLine({
    opId,
    phase: "result",
    ts: new Date().toISOString(),
    ...result,
  });
}

// --- Reads -----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validates a parsed JSON value against the complete LedgerLine schema,
 * failing closed with VALIDATION naming lineNumber on any mismatch,
 * including a type mismatch on an optional field, never just a missing
 * required one. Required on every line regardless of phase: ts (a string
 * that round-trips through `new Date(ts).toISOString()` unchanged, i.e. a
 * real, fully-specified ISO timestamp, not merely Date.parse-able),
 * opId (non-empty string), phase (exactly "intent" or "result"), command
 * (non-empty string), targetType ("document" or "control"), and targetId
 * (non-empty string). Required in addition for a result line: resultIds
 * (an array whose every member is a non-empty string) and
 * readbackVerified (a boolean), unconditionally. Optional fields, when
 * present, are strictly typed: fileName a non-empty string, sha256
 * exactly 64 lowercase hex characters, bytes a non-negative safe integer,
 * readbackError an object with string code and string message (no other
 * required shape). Nothing is coerced or defaulted; a line either matches
 * the shape or the whole read fails. checkDuplicate relies on this: a
 * non-string sha256 must never reach its `!==` comparison.
 */
function validateLedgerLine(value: unknown, lineNumber: number): LedgerLine {
  const fail = (reason: string): never => {
    throw codeError(
      "VALIDATION",
      `Ledger file ${getDisplayLedgerPath()} is corrupt at line ${lineNumber}: ${reason}`,
    );
  };

  if (!isPlainObject(value)) {
    fail("expected a JSON object, not null, an array, or a scalar");
  }
  const obj = value as Record<string, unknown>;

  if (!isNonEmptyString(obj.opId)) {
    fail('missing or invalid "opId" (expected a non-empty string)');
  }
  if (typeof obj.ts !== "string") {
    fail('missing or invalid "ts" (expected an ISO timestamp string)');
  }
  const ts = obj.ts as string;
  const parsedTs = new Date(ts);
  if (Number.isNaN(parsedTs.getTime()) || parsedTs.toISOString() !== ts) {
    fail('missing or invalid "ts" (expected a round-trippable ISO timestamp string)');
  }
  if (obj.phase !== "intent" && obj.phase !== "result") {
    fail('missing or invalid "phase" (expected "intent" or "result")');
  }
  if (!isNonEmptyString(obj.command)) {
    fail('missing or invalid "command" (expected a non-empty string)');
  }
  if (obj.targetType !== "document" && obj.targetType !== "control") {
    fail('missing or invalid "targetType" (expected "document" or "control")');
  }
  if (!isNonEmptyString(obj.targetId)) {
    fail('missing or invalid "targetId" (expected a non-empty string)');
  }

  if (obj.fileName !== undefined && !isNonEmptyString(obj.fileName)) {
    fail('invalid "fileName" (expected a non-empty string when present)');
  }
  if (
    obj.sha256 !== undefined &&
    (typeof obj.sha256 !== "string" || !SHA256_HEX_PATTERN.test(obj.sha256))
  ) {
    fail('invalid "sha256" (expected exactly 64 lowercase hex characters when present)');
  }
  if (
    obj.bytes !== undefined &&
    (typeof obj.bytes !== "number" || !Number.isSafeInteger(obj.bytes) || obj.bytes < 0)
  ) {
    fail('invalid "bytes" (expected a non-negative safe integer when present)');
  }
  if (obj.readbackError !== undefined) {
    const readbackError = obj.readbackError;
    if (
      !isPlainObject(readbackError) ||
      typeof readbackError.code !== "string" ||
      typeof readbackError.message !== "string"
    ) {
      fail('invalid "readbackError" (expected an object with string "code" and "message" when present)');
    }
  }

  if (obj.phase === "result") {
    if (!Array.isArray(obj.resultIds) || !obj.resultIds.every((item) => isNonEmptyString(item))) {
      fail('result line missing or invalid "resultIds" (expected an array of non-empty strings)');
    }
    if (typeof obj.readbackVerified !== "boolean") {
      fail('result line missing or invalid "readbackVerified" (expected a boolean)');
    }
  }

  const line = obj as unknown as LedgerLine;
  line.lineNumber = lineNumber;
  return line;
}

export async function readLedgerLines(): Promise<LedgerLine[]> {
  const ledgerPath = getLedgerPath();
  let raw: string;
  try {
    raw = await fs.readFile(ledgerPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const rawLines = raw.split("\n");
  const lines: LedgerLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const lineNumber = i + 1;
    const rawLine = rawLines[i];
    if (rawLine.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw codeError(
        "VALIDATION",
        `Ledger file ${getDisplayLedgerPath()} is corrupt at line ${lineNumber}: ${detail}`,
      );
    }

    lines.push(validateLedgerLine(parsed, lineNumber));
  }
  return lines;
}

/**
 * Groups already-validated lines by opId. An opId with an intent and no
 * result is unresolved. An opId with a result line and no intent line
 * anywhere in the input is ledger corruption, not a third kind of grouped
 * operation: this throws VALIDATION naming the 1-indexed physical line
 * number of that orphaned result line (round-2 gate fix: that number
 * comes from the line's own `lineNumber`, attached by
 * readLedgerLines/validateLedgerLine, never recomputed from position).
 *
 * Round-3 gate fix: D10 defines an orphan as a result with no matching
 * intent anywhere in the file, not only among earlier lines, so a result
 * cannot be classified until every intent in the whole input has been
 * seen. This runs in two passes over `lines` for exactly that reason:
 * the first pass collects every intent by opId regardless of its
 * position; the second pass attaches each result to its now-known
 * intent (or fails on one with none). A result that physically precedes
 * its own intent therefore groups into one ordinary completed operation,
 * not corruption.
 */
export function groupIntoOperations(lines: LedgerLine[]): Map<string, LedgerOperation> {
  const operations = new Map<string, LedgerOperation>();

  for (const line of lines) {
    if (line.phase === "intent") {
      operations.set(line.opId, { intent: line });
    }
  }

  for (const line of lines) {
    if (line.phase !== "result") continue;
    const existing = operations.get(line.opId);
    if (!existing) {
      throw codeError(
        "VALIDATION",
        `Ledger file ${getDisplayLedgerPath()} is corrupt at line ${line.lineNumber ?? "unknown"}: ` +
          `result for opId "${line.opId}" has no matching intent line.`,
      );
    }
    existing.result = line;
  }

  return operations;
}

// --- Duplicate check -----------------------------------------------------

export async function checkDuplicate(
  sha256: string,
  targetId: string,
): Promise<{ found: boolean; ts?: string; unresolved?: boolean }> {
  const lines = await readLedgerLines();
  const operations = groupIntoOperations(lines);
  for (const operation of operations.values()) {
    const intent = operation.intent;
    if (intent.command !== "documents upload") continue;
    if (intent.sha256 !== sha256 || intent.targetId !== targetId) continue;
    if (operation.result) {
      return { found: true, ts: intent.ts };
    }
    return { found: true, ts: intent.ts, unresolved: true };
  }
  return { found: false };
}

// --- `ledger list` ------------------------------------------------------

function parseLimit(raw: string | undefined): number {
  const value = Number(raw ?? "20");
  if (!Number.isInteger(value) || value <= 0) {
    throw codeError("VALIDATION", `--limit must be a positive integer, got "${raw}".`);
  }
  return value;
}

export function registerLedgerCommand(program: Command): Command {
  const ledgerCmd = program
    .command("ledger")
    .description("Inspect the local, crash-safe write ledger.");

  ledgerCmd
    .command("list")
    .description(
      "Summarize logged write operations: totals, breakdowns, recent entries, and unresolved intents.",
    )
    .option("--limit <n>", "Maximum number of recent operations to show.", "20")
    .option("--show-ids", "Also show full upstream targetId/sha256 alongside the truncated refs.")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (opts: { limit?: string; showIds?: boolean; json?: boolean }) => {
      await runJsonAction(async () => {
        const limit = parseLimit(opts.limit);
        const showIds = Boolean(opts.showIds);
        const lines = await readLedgerLines();
        const operations = groupIntoOperations(lines);
        const allOperations = [...operations.values()];

        let unresolvedCount = 0;
        const byCommandCounts = new Map<string, number>();
        const byDayCounts = new Map<string, number>();
        for (const operation of allOperations) {
          if (!operation.result) unresolvedCount += 1;
          const command = operation.intent.command;
          byCommandCounts.set(command, (byCommandCounts.get(command) ?? 0) + 1);
          const day = operation.intent.ts.slice(0, 10);
          byDayCounts.set(day, (byDayCounts.get(day) ?? 0) + 1);
        }

        const byCommand = [...byCommandCounts.entries()].map(([command, count]) => ({
          command,
          count,
        }));
        const byDay = [...byDayCounts.entries()].map(([day, count]) => ({ day, count }));
        // opId is always shown in full: it is this CLI's own local
        // correlation id, never an upstream Vanta identifier. targetRef
        // (first 8 of targetId) and sha256Prefix (first 12 hex) are always
        // shown too; the full targetId/sha256 are added, not substituted,
        // only when --show-ids is passed, closing the conflict with R3's
        // rule that default list output never carries a raw upstream id.
        const recent = allOperations.slice(-limit).map((operation) => ({
          opId: operation.intent.opId,
          ts: operation.intent.ts,
          command: operation.intent.command,
          targetType: operation.intent.targetType,
          targetRef: operation.intent.targetId ? operation.intent.targetId.slice(0, 8) : null,
          sha256Prefix: operation.intent.sha256?.slice(0, 12) ?? null,
          readbackVerified: operation.result?.readbackVerified ?? null,
          unresolved: !operation.result,
          ...(showIds
            ? {
                targetId: operation.intent.targetId ?? null,
                sha256: operation.intent.sha256 ?? null,
              }
            : {}),
        }));

        return {
          totalOperations: operations.size,
          unresolvedCount,
          byCommand,
          byDay,
          recent,
        };
      }, opts);
    });

  return ledgerCmd;
}
