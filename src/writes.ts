/**
 * The six guarded write commands (spec.md D9): `documents upload`,
 * `documents link`, `documents set-owner`, `documents submit`,
 * `controls set-owner`, `controls add-document`. Owned entirely by task
 * 008b, which depends on task 008a's `src/ledger.ts` for the two-phase
 * intent/result ledger and its lock.
 *
 * Every command follows the same fixed, local-work-first order: parse and
 * validate; (upload only) hash files and detect content type; (upload
 * only) an unlocked preview duplicate check; print the dry-run plan and
 * exit 0 if `--write` is absent; check `--confirm` exactly; only then
 * compute the scope union and call `clientFor` exactly once; only then
 * proceed to the per-sub-operation, `ledger.lock`-held readback sequence.
 * `ledger.lock`, never `config.lock`, is acquired here (via task 008a's
 * `acquireLedgerLock`); `config.lock` belongs entirely to `auth.ts`'s
 * `ensureToken` and is never touched anywhere in this file.
 */

import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Command } from "commander";
import { SCOPE_READ, SCOPE_UPLOAD, SCOPE_WRITE } from "./config.js";
import { codeError, makeError, toErrorCode, VantaCliError } from "./output.js";
import { clientFor, collect, runJsonAction } from "./cli-runtime.js";
import type { VantaApiClient } from "./vanta-api.js";
import {
  acquireLedgerLock,
  appendIntentLedgerLine,
  appendResultLedgerLine,
  checkDuplicate,
  getDisplayLedgerPath,
  type LedgerLine,
  type LedgerResultInput,
} from "./ledger.js";

// --- Command name constants, used identically for requireConfirmed's
// label, every appendIntentLedgerLine call, and every matching
// appendResultLedgerLine call for the same opId, per D10's consistency fix.

const CMD_UPLOAD = "documents upload";
const CMD_LINK = "documents link";
const CMD_SET_OWNER_DOCUMENT = "documents set-owner";
const CMD_SUBMIT = "documents submit";
const CMD_SET_OWNER_CONTROL = "controls set-owner";
const CMD_ADD_DOCUMENT = "controls add-document";

interface WriteOpts {
  write?: boolean;
  confirm?: string;
  json?: boolean;
}

// --- Shared helpers ---------------------------------------------------

/**
 * Streams the file through sha256 and reads its byte size via fs.stat.
 * Computed once per file, before anything else, independent of --write.
 */
export async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  try {
    const stat = await fsp.stat(filePath);
    const hash = crypto.createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk as Buffer));
      stream.on("end", resolve);
    });
    return { sha256: hash.digest("hex"), bytes: stat.size };
  } catch (err) {
    // Gate-fix: a raw Node fs error (ENOENT, EACCES, ...) embeds the
    // absolute path in its own .message; never let that reach output.
    throw toSafeFileError(err, filePath);
  }
}

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".md": "text/plain",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".json": "application/json",
  ".zip": "application/zip",
};

/** Extension-to-MIME lookup, falling back to application/octet-stream. */
export function detectContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * Throws VALIDATION unless opts.write === true and opts.confirm === expected
 * exactly. Every write command calls this only after its dry-run plan has
 * already been printed and (for documents upload) its own preview duplicate
 * check has already passed.
 */
export function requireConfirmed(opts: WriteOpts, expected: string, label: string): void {
  if (opts.write !== true || opts.confirm !== expected) {
    throw codeError(
      "VALIDATION",
      `${label} requires --write and --confirm ${JSON.stringify(expected)} (exact match) to execute.`,
    );
  }
}

/**
 * Guards against commander's own value-parsing behavior for an
 * option that requires a value: when that option's own value is
 * omitted, commander consumes whatever token comes next, including a
 * following "--flag", as this option's value instead of failing to
 * parse. Every option-shaped ID argument in this file (--document-id,
 * --user-id, --link-control-id, --url, --title) is validated here, at
 * parse-and-validate time, before anything else, so a malformed
 * invocation like this fails VALIDATION cleanly instead of silently
 * treating a stray flag as a real value.
 */
function rejectFlagLikeValue(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw codeError("VALIDATION", `${label} is required.`);
  }
  if (value.startsWith("-")) {
    throw codeError(
      "VALIDATION",
      `${label} value ${JSON.stringify(value)} looks like a CLI flag, not a value; the preceding flag was ` +
        `likely given no value of its own, so it consumed the next flag as its value instead.`,
    );
  }
  return value;
}

/**
 * Round-2 blocker fix: every list-based readback snapshot goes through this,
 * never a raw client.paginate(...).rows. Fails closed with CHECK_FAILED,
 * detail.reason SNAPSHOT_INCOMPLETE, naming path and the underlying error's
 * code/message when present, if the pagination behind it was not complete.
 */
export async function readCompleteList<T>(
  client: VantaApiClient,
  path: string,
  query: Record<string, unknown>,
): Promise<T[]> {
  const result = await client.paginate<T>(path, query, { all: true });
  if (!result.complete || result.error) {
    const underlying = result.error;
    throw codeError(
      "CHECK_FAILED",
      `SNAPSHOT_INCOMPLETE: the pre/post-write snapshot of "${path}" did not complete` +
        (underlying ? ` (${underlying.code}: ${underlying.message})` : "") +
        ".",
      { detail: { reason: "SNAPSHOT_INCOMPLETE", path, underlying } },
    );
  }
  return result.rows;
}

function toReadbackError(err: unknown): { code: string; message: string } {
  const normalized = makeError(err);
  return { code: normalized.code, message: normalized.message };
}

/**
 * Gate-fix: a filesystem error while writing the intent line must become
 * CHECK_FAILED naming the safe display ledger path and the underlying
 * errno code, and must stop the sub-operation before its mutating API call
 * is ever attempted. Every appendIntentLedgerLine call in this file goes
 * through this wrapper, inside the call() closure, so a throw here never
 * lets that closure reach its own client.post/uploadDocument line.
 */
async function appendIntentLine(entry: Omit<LedgerLine, "phase">): Promise<void> {
  try {
    await appendIntentLedgerLine(entry);
  } catch (err) {
    const code = fileSystemErrorCode(err) ?? "UNKNOWN";
    throw codeError(
      "CHECK_FAILED",
      `could not append the intent line to ${getDisplayLedgerPath()}: ${code}`,
      { detail: { path: getDisplayLedgerPath(), code } },
    );
  }
}

/**
 * Gate-fix: identifies a genuine Node filesystem errno code (ENOENT,
 * EACCES, EPERM, ...), never one of this CLI's own ErrorCode strings
 * (VALIDATION, NOT_FOUND, ...), so a VantaCliError/VantaApiError is never
 * mistaken for a filesystem failure. Node's errno codes all match
 * /^E[A-Z]+$/; none of this CLI's own error codes do.
 */
function fileSystemErrorCode(err: unknown): string | undefined {
  if (err instanceof VantaCliError) return undefined;
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
      return code;
    }
  }
  return undefined;
}

/**
 * Gate-fix: sanitizes a raw Node filesystem error (whose own .message
 * embeds the absolute local path) down to the file's basename and its
 * errno code only. Any error that is not recognizably a filesystem error
 * (an upstream VantaApiError/VantaCliError, for instance) passes through
 * unchanged, since those never carry a local path in the first place.
 */
function toSafeFileError(err: unknown, filePath: string): unknown {
  const code = fileSystemErrorCode(err);
  if (code === undefined) return err;
  return codeError("VALIDATION", `could not read ${path.basename(filePath)} (${code}).`);
}

export interface IdInListReadbackResult {
  verified: boolean;
  callResult: unknown;
  id: string | undefined;
  readbackError?: { code: string; message: string };
}

/**
 * List-creation writes (upload, link, both add-document forms). preRead()
 * propagates any throw as-is (nothing has been attempted). Task 013 fix:
 * call() no longer propagates its own throw as-is; a failure there is
 * caught and rethrown as CHECK_FAILED with detail: {ids, callError}, since
 * that is the affected write's own known-before-the-call ids plus the
 * caught error, normalized, per spec.md D9's corrected envelope shape.
 * Round-10 blocker fix: once call() has succeeded, identity extraction,
 * postRead(), and the comparison itself are all one protected try; any
 * failure inside it becomes {verified: false, readbackError}, never
 * rethrown, with id left undefined if extraction itself never completed.
 */
export async function readbackByIdInList<T extends { id: string }>(
  preRead: () => Promise<T[]>,
  call: () => Promise<unknown>,
  postRead: () => Promise<T[]>,
  extractId: (callResult: unknown) => string,
  ids: Record<string, string | undefined>,
): Promise<IdInListReadbackResult> {
  const preRows = await preRead();
  let callResult: unknown;
  try {
    callResult = await call();
  } catch (err) {
    throw codeError("CHECK_FAILED", "the write's own API call failed before any readback could run.", {
      detail: { ids, callError: toReadbackError(err) },
    });
  }
  // Gate-fix: id is captured as soon as extraction itself succeeds, outside
  // the rest of the protected try, so a later postRead/comparison failure
  // still reports the real id the mutating call created (resultIds: [id]),
  // not []. id stays undefined only when extraction itself never completed.
  let id: string | undefined;
  try {
    const extracted = extractId(callResult);
    if (typeof extracted !== "string" || extracted.length === 0) {
      throw codeError(
        "CHECK_FAILED",
        "extractId returned an empty or non-string identity for this write's response.",
      );
    }
    id = extracted;
    const postRows = await postRead();
    const verified = postRows.some((r) => r.id === id) && !preRows.some((r) => r.id === id);
    return { verified, callResult, id };
  } catch (err) {
    return { verified: false, callResult, id, readbackError: toReadbackError(err) };
  }
}

export interface AttributeReadbackResult {
  verified: boolean;
  preValue: unknown;
  readbackError?: { code: string; message: string };
}

/**
 * Attribute-update writes (documents set-owner, controls set-owner).
 * verified is true if the post-write value equals the value that was sent,
 * regardless of whether it differed before the call.
 */
export async function readbackByAttribute<T>(
  preRead: () => Promise<T>,
  call: () => Promise<unknown>,
  postRead: () => Promise<T>,
  extractAttribute: (obj: T) => unknown,
  sentValue: unknown,
  ids: Record<string, string | undefined>,
): Promise<AttributeReadbackResult> {
  const pre = await preRead();
  const preValue = extractAttribute(pre);
  try {
    await call();
  } catch (err) {
    throw codeError("CHECK_FAILED", "the write's own API call failed before any readback could run.", {
      detail: { ids, callError: toReadbackError(err) },
    });
  }
  try {
    const post = await postRead();
    const verified = extractAttribute(post) === sentValue;
    return { verified, preValue };
  } catch (err) {
    return { verified: false, preValue, readbackError: toReadbackError(err) };
  }
}

export interface StateChangeReadbackResult {
  verified: boolean;
  readbackError?: { code: string; message: string };
}

/**
 * documents submit (204, no response body, no id at all). verified is true
 * only if uploadStatus or uploadStatusDate differs from the pre-write
 * snapshot; unchanged means verified: false.
 */
export async function readbackByStateChange(
  preRead: () => Promise<{ uploadStatus: unknown; uploadStatusDate: unknown }>,
  call: () => Promise<void>,
  postRead: () => Promise<{ uploadStatus: unknown; uploadStatusDate: unknown }>,
  ids: Record<string, string | undefined>,
): Promise<StateChangeReadbackResult> {
  const pre = await preRead();
  try {
    await call();
  } catch (err) {
    throw codeError("CHECK_FAILED", "the write's own API call failed before any readback could run.", {
      detail: { ids, callError: toReadbackError(err) },
    });
  }
  try {
    const post = await postRead();
    const verified = post.uploadStatus !== pre.uploadStatus || post.uploadStatusDate !== pre.uploadStatusDate;
    return { verified };
  } catch (err) {
    return { verified: false, readbackError: toReadbackError(err) };
  }
}

/**
 * appendResultLedgerLine is called unconditionally once call() has
 * succeeded (readback resolved normally, verified true or false). If the
 * append itself throws, the command exits 1 CHECK_FAILED, printing the
 * call's returned id(s) and the literal JSON line the operator must append
 * by hand (D10, R6).
 */
async function appendResultLine(
  opId: string,
  command: string,
  targetType: LedgerLine["targetType"],
  targetId: string,
  resultIds: string[],
  readbackVerified: boolean,
  readbackError?: { code: string; message: string },
): Promise<void> {
  const result: LedgerResultInput = {
    command,
    targetType,
    targetId,
    resultIds,
    readbackVerified,
    ...(readbackError ? { readbackError } : {}),
  };
  try {
    await appendResultLedgerLine(opId, result);
  } catch (err) {
    const handWritten = JSON.stringify({ opId, phase: "result", ts: new Date().toISOString(), ...result });
    const idsText = resultIds.length > 0 ? resultIds.join(", ") : "none extracted";
    throw codeError(
      "CHECK_FAILED",
      `The write call for opId ${opId} succeeded (resultIds: ${idsText}) but its result ledger line could ` +
        `not be written: ${err instanceof Error ? err.message : String(err)}. Append this line to the ` +
        `ledger by hand: ${handWritten}`,
      { detail: { resultIds, appendError: err instanceof Error ? err.message : String(err) } },
    );
  }
}

/**
 * Re-throws err with an additional detail.completed field naming which
 * prior sub-operations of a documents-upload packet already completed,
 * per D9's rule that a mid-packet failure reports exactly that.
 */
function attachUploadProgress(
  err: unknown,
  completed: { files: unknown[]; linkedControlIds: unknown[] },
): never {
  const normalized =
    err instanceof VantaCliError
      ? err
      : codeError(toErrorCode(err), err instanceof Error ? err.message : String(err));
  const existingDetail =
    normalized.detail && typeof normalized.detail === "object"
      ? (normalized.detail as Record<string, unknown>)
      : {};
  throw codeError(normalized.code, normalized.message, {
    http: normalized.http,
    retryable: normalized.retryable,
    detail: { ...existingDetail, completed },
  });
}

function duplicateFailure(
  check: "preview" | "authoritative",
  fileName: string,
  duplicate: { ts?: string; unresolved?: boolean },
): VantaCliError {
  const state = duplicate.unresolved ? "not-yet-confirmed (unresolved)" : "completed";
  return codeError(
    "VALIDATION",
    `documents upload: ${fileName} matches a ${state} upload already recorded at ${duplicate.ts} for ` +
      `this document (${check} check); pass --allow-duplicate to upload it anyway.`,
    { detail: { check, fileName, ts: duplicate.ts, unresolved: duplicate.unresolved ?? false } },
  );
}

// --- documents upload ---------------------------------------------------

interface UploadOpts extends WriteOpts {
  documentId: string;
  linkControlId: string[];
  effectiveDate?: string;
  description?: string;
  allowDuplicate?: boolean;
}

interface FileInfo {
  filePath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

function registerUploadCommand(documentsCmd: Command): void {
  documentsCmd
    .command("upload <files...>")
    .description(
      "Upload one or more files to a document, and optionally link the document to controls. " +
        "Dry-run by default; requires --write --confirm <document-id> to execute.",
    )
    .requiredOption("--document-id <id>", "The document's upstream ID.")
    .option(
      "--link-control-id <id>",
      "Link the document to this control after every file uploads (repeatable).",
      collect,
      [],
    )
    .option("--effective-date <date>", "Effective date applied to every file in this packet.")
    .option("--description <text>", "Description applied to every file in this packet.")
    .option(
      "--allow-duplicate",
      "Skip the (sha256, document id) duplicate check for a file already recorded in the ledger.",
    )
    .option("--write", "Perform the upload. Without this flag, only the dry-run plan is printed.")
    .option("--confirm <value>", "Must exactly equal the document id to authorize the write.")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (files: string[], opts: UploadOpts) => {
      await runJsonAction(async () => {
        const documentId = rejectFlagLikeValue(opts.documentId, "--document-id");
        const linkControlIds = (opts.linkControlId ?? []).map((id) =>
          rejectFlagLikeValue(id, "--link-control-id"),
        );

        // Step (a): hash, detect content type, stat every file, in file
        // order. No network, no lock.
        const fileInfos: FileInfo[] = [];
        for (const filePath of files) {
          // Gate-fix: sha256File itself now sanitizes any fs error (ENOENT,
          // EACCES, ...) down to basename + errno code before it ever
          // throws, so no special-casing or raw filePath interpolation
          // belongs here.
          const hashed = await sha256File(filePath);
          fileInfos.push({
            filePath,
            fileName: path.basename(filePath),
            bytes: hashed.bytes,
            sha256: hashed.sha256,
            contentType: detectContentType(filePath),
          });
        }

        // Step (b): preview duplicate check, unlocked, on every invocation
        // including a bare dry run. Stops at the first duplicate found,
        // before touching any other file.
        if (!opts.allowDuplicate) {
          for (const file of fileInfos) {
            const duplicate = await checkDuplicate(file.sha256, documentId);
            if (duplicate.found) {
              throw duplicateFailure("preview", file.fileName, duplicate);
            }
          }
        }

        // Step (c): dry-run plan. No request of any kind, and no token
        // acquisition, has happened yet.
        const dryRunPlan = {
          dryRun: true,
          documentId,
          files: fileInfos.map((f) => ({
            fileName: f.fileName,
            bytes: f.bytes,
            contentType: f.contentType,
            sha256: f.sha256,
          })),
          linkControlIds,
          requiredConfirm: documentId,
        };
        if (!opts.write) {
          return dryRunPlan;
        }

        // Step (d): exact --confirm check, still zero requests, zero token
        // acquisition, on a mismatch.
        requireConfirmed(opts, documentId, CMD_UPLOAD);

        // Step (e): only now, one clientFor call for the whole command.
        const client = await clientFor([SCOPE_READ, SCOPE_WRITE, SCOPE_UPLOAD]);

        const uploadedFiles: Array<{ fileName: string; uploadId: string | undefined; readback: { verified: true } }> =
          [];
        const linkedControlIds: Array<{ controlId: string; readback: { verified: true } }> = [];

        try {
          for (const file of fileInfos) {
            const opId = crypto.randomUUID();
            const release = await acquireLedgerLock();
            try {
              // Round-3 blocker fix: repeat the duplicate check under the
              // lock; this is the authoritative gate, not step (b)'s
              // preview.
              if (!opts.allowDuplicate) {
                const duplicate = await checkDuplicate(file.sha256, documentId);
                if (duplicate.found) {
                  throw duplicateFailure("authoritative", file.fileName, duplicate);
                }
              }

              const preRead = () => readCompleteList<{ id: string }>(client, `documents/${documentId}/uploads`, {});
              const postRead = () => readCompleteList<{ id: string }>(client, `documents/${documentId}/uploads`, {});
              const call = async () => {
                await appendIntentLine({
                  opId,
                  ts: new Date().toISOString(),
                  command: CMD_UPLOAD,
                  targetType: "document",
                  targetId: documentId,
                  fileName: file.fileName,
                  sha256: file.sha256,
                  bytes: file.bytes,
                });
                try {
                  return await client.uploadDocument(documentId, file.filePath, {
                    effectiveAtDate: opts.effectiveDate,
                    description: opts.description,
                  });
                } catch (err) {
                  // Gate-fix: the client's own file read can throw a raw fs
                  // error embedding the absolute path (e.g. the file was
                  // removed or its permissions changed after hashing);
                  // never let that reach output unsanitized.
                  throw toSafeFileError(err, file.filePath);
                }
              };

              const ids: Record<string, string | undefined> = { documentId };
              const readback = await readbackByIdInList<{ id: string }>(
                preRead,
                call,
                postRead,
                (r) => (r as { id: string }).id,
                ids,
              );
              await appendResultLine(
                opId,
                CMD_UPLOAD,
                "document",
                documentId,
                readback.id ? [readback.id] : [],
                readback.verified,
                readback.readbackError,
              );
              if (!readback.verified) {
                throw codeError(
                  "CHECK_FAILED",
                  `documents upload: readback for ${file.fileName} did not verify.`,
                  {
                    detail: {
                      readback: { verified: false, readbackError: readback.readbackError },
                      ids: { ...ids, uploadId: readback.id },
                    },
                  },
                );
              }
              uploadedFiles.push({ fileName: file.fileName, uploadId: readback.id, readback: { verified: true } });
            } finally {
              await release();
            }
          }

          for (const controlId of linkControlIds) {
            const opId = crypto.randomUUID();
            const release = await acquireLedgerLock();
            try {
              const preRead = () => readCompleteList<{ id: string }>(client, `documents/${documentId}/controls`, {});
              const postRead = () => readCompleteList<{ id: string }>(client, `documents/${documentId}/controls`, {});
              const call = async () => {
                await appendIntentLine({
                  opId,
                  ts: new Date().toISOString(),
                  command: CMD_ADD_DOCUMENT,
                  targetType: "control",
                  targetId: controlId,
                });
                return client.post(`controls/${controlId}/add-document-to-control`, { documentId });
              };

              const ids: Record<string, string | undefined> = { documentId, controlId };
              const readback = await readbackByIdInList<{ id: string }>(
                preRead,
                call,
                postRead,
                (r) => (r as { control: { id: string } }).control.id,
                ids,
              );
              await appendResultLine(
                opId,
                CMD_ADD_DOCUMENT,
                "control",
                controlId,
                readback.id ? [readback.id] : [],
                readback.verified,
                readback.readbackError,
              );
              if (!readback.verified) {
                throw codeError(
                  "CHECK_FAILED",
                  `documents upload: link to control ${controlId} did not verify.`,
                  {
                    detail: {
                      readback: { verified: false, readbackError: readback.readbackError },
                      ids,
                    },
                  },
                );
              }
              linkedControlIds.push({ controlId, readback: { verified: true } });
            } finally {
              await release();
            }
          }
        } catch (err) {
          attachUploadProgress(err, { files: uploadedFiles, linkedControlIds });
        }

        // Step (g): one final, unledgered, unlocked plain read.
        const finalDocument = (await client.get(`documents/${documentId}`)) as {
          uploadStatus: unknown;
          uploadStatusDate: unknown;
        };
        return {
          documentId,
          files: uploadedFiles,
          linkedControlIds,
          uploadStatus: finalDocument.uploadStatus,
          uploadStatusDate: finalDocument.uploadStatusDate,
        };
      }, opts);
    });
}

// --- documents link -------------------------------------------------------

interface LinkOpts extends WriteOpts {
  url: string;
  title: string;
  description?: string;
  effectiveDate?: string;
}

function registerLinkCommand(documentsCmd: Command): void {
  documentsCmd
    .command("link <documentId>")
    .description(
      "Create a link for a document. Dry-run by default; requires --write --confirm <url> to execute.",
    )
    .requiredOption("--url <url>", "The link's URL.")
    .requiredOption("--title <title>", "The link's title.")
    .option("--description <text>", "The link's description.")
    .option("--effective-date <date>", "The link's effective date.")
    .option("--write", "Perform the write. Without this flag, only the dry-run plan is printed.")
    .option("--confirm <value>", "Must exactly equal the URL to authorize the write.")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (documentId: string, opts: LinkOpts) => {
      await runJsonAction(async () => {
        const url = rejectFlagLikeValue(opts.url, "--url");
        const title = rejectFlagLikeValue(opts.title, "--title");
        const dryRunPlan = {
          dryRun: true,
          documentId,
          url,
          title,
          description: opts.description,
          effectiveDate: opts.effectiveDate,
          requiredConfirm: url,
        };
        if (!opts.write) return dryRunPlan;
        requireConfirmed(opts, url, CMD_LINK);

        const client = await clientFor([SCOPE_READ, SCOPE_WRITE]);
        const opId = crypto.randomUUID();
        const release = await acquireLedgerLock();
        try {
          const preRead = () => readCompleteList<{ id: string }>(client, `documents/${documentId}/links`, {});
          const postRead = () => readCompleteList<{ id: string }>(client, `documents/${documentId}/links`, {});
          const call = async () => {
            await appendIntentLine({
              opId,
              ts: new Date().toISOString(),
              command: CMD_LINK,
              targetType: "document",
              targetId: documentId,
            });
            return client.post(`documents/${documentId}/links`, {
              url,
              title,
              description: opts.description,
              effectiveDate: opts.effectiveDate,
            });
          };

          const ids: Record<string, string | undefined> = { documentId };
          const readback = await readbackByIdInList<{ id: string }>(
            preRead,
            call,
            postRead,
            (r) => (r as { id: string }).id,
            ids,
          );
          await appendResultLine(
            opId,
            CMD_LINK,
            "document",
            documentId,
            readback.id ? [readback.id] : [],
            readback.verified,
            readback.readbackError,
          );
          if (!readback.verified) {
            throw codeError("CHECK_FAILED", "documents link: readback did not verify the new link.", {
              detail: {
                readback: { verified: false, readbackError: readback.readbackError },
                ids: { ...ids, linkId: readback.id },
              },
            });
          }
          return { documentId, linkId: readback.id, readback: { verified: true } };
        } finally {
          await release();
        }
      }, opts);
    });
}

// --- documents set-owner ---------------------------------------------------

interface SetOwnerOpts extends WriteOpts {
  userId: string;
}

function registerDocumentSetOwnerCommand(documentsCmd: Command): void {
  documentsCmd
    .command("set-owner <documentId>")
    .description(
      "Assign a user as a document's owner. Dry-run by default; requires --write --confirm <user-id>.",
    )
    .requiredOption("--user-id <id>", "The new owner's upstream user ID.")
    .option("--write", "Perform the write. Without this flag, only the dry-run plan is printed.")
    .option("--confirm <value>", "Must exactly equal the user id to authorize the write.")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (documentId: string, opts: SetOwnerOpts) => {
      await runJsonAction(async () => {
        const userId = rejectFlagLikeValue(opts.userId, "--user-id");
        const dryRunPlan = { dryRun: true, documentId, userId, requiredConfirm: userId };
        if (!opts.write) return dryRunPlan;
        requireConfirmed(opts, userId, CMD_SET_OWNER_DOCUMENT);

        const client = await clientFor([SCOPE_READ, SCOPE_WRITE]);
        const opId = crypto.randomUUID();
        const release = await acquireLedgerLock();
        try {
          const preRead = () => client.get(`documents/${documentId}`) as Promise<{ ownerId: unknown }>;
          const postRead = () => client.get(`documents/${documentId}`) as Promise<{ ownerId: unknown }>;
          const call = async () => {
            await appendIntentLine({
              opId,
              ts: new Date().toISOString(),
              command: CMD_SET_OWNER_DOCUMENT,
              targetType: "document",
              targetId: documentId,
            });
            return client.post(`documents/${documentId}/set-owner`, { userId });
          };

          const ids: Record<string, string | undefined> = { documentId, userId };
          const readback = await readbackByAttribute(
            preRead,
            call,
            postRead,
            (doc) => doc.ownerId,
            userId,
            ids,
          );
          await appendResultLine(
            opId,
            CMD_SET_OWNER_DOCUMENT,
            "document",
            documentId,
            [],
            readback.verified,
            readback.readbackError,
          );
          if (!readback.verified) {
            throw codeError("CHECK_FAILED", "documents set-owner: readback did not verify the new owner.", {
              detail: {
                readback: { verified: false, readbackError: readback.readbackError },
                ids,
              },
            });
          }
          return { documentId, ownerId: userId, readback: { verified: true } };
        } finally {
          await release();
        }
      }, opts);
    });
}

// --- documents submit -------------------------------------------------------

function registerSubmitCommand(documentsCmd: Command): void {
  documentsCmd
    .command("submit <documentId>")
    .description(
      "Submit a document's collection for review. Dry-run by default; requires --write --confirm <document-id>.",
    )
    .option("--write", "Perform the write. Without this flag, only the dry-run plan is printed.")
    .option("--confirm <value>", "Must exactly equal the document id to authorize the write.")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (documentId: string, opts: WriteOpts) => {
      await runJsonAction(async () => {
        const dryRunPlan = { dryRun: true, documentId, requiredConfirm: documentId };
        if (!opts.write) return dryRunPlan;
        requireConfirmed(opts, documentId, CMD_SUBMIT);

        const client = await clientFor([SCOPE_READ, SCOPE_WRITE]);
        const opId = crypto.randomUUID();
        const release = await acquireLedgerLock();
        try {
          type DocumentState = { uploadStatus: unknown; uploadStatusDate: unknown };
          let postSnapshot: DocumentState | undefined;
          const preRead = () => client.get(`documents/${documentId}`) as Promise<DocumentState>;
          const postRead = async () => {
            const state = (await client.get(`documents/${documentId}`)) as DocumentState;
            postSnapshot = state;
            return state;
          };
          const call = async (): Promise<void> => {
            await appendIntentLine({
              opId,
              ts: new Date().toISOString(),
              command: CMD_SUBMIT,
              targetType: "document",
              targetId: documentId,
            });
            // No second argument at all: the OpenAPI operation declares no
            // request body, and that is a different wire request from a
            // literal {}.
            await client.post(`documents/${documentId}/submit`);
          };

          const ids: Record<string, string | undefined> = { documentId };
          const readback = await readbackByStateChange(preRead, call, postRead, ids);
          await appendResultLine(
            opId,
            CMD_SUBMIT,
            "document",
            documentId,
            [],
            readback.verified,
            readback.readbackError,
          );
          if (!readback.verified) {
            throw codeError(
              "CHECK_FAILED",
              "documents submit: readback did not detect a status change.",
              {
                detail: {
                  readback: { verified: false, readbackError: readback.readbackError },
                  ids,
                },
              },
            );
          }
          return {
            documentId,
            submitted: true,
            uploadStatus: postSnapshot?.uploadStatus,
            readback: { verified: true },
          };
        } finally {
          await release();
        }
      }, opts);
    });
}

// --- controls set-owner ---------------------------------------------------

function registerControlSetOwnerCommand(controlsCmd: Command): void {
  controlsCmd
    .command("set-owner <controlId>")
    .description(
      "Assign a user as a control's owner. Dry-run by default; requires --write --confirm <user-id>.",
    )
    .requiredOption("--user-id <id>", "The new owner's upstream user ID.")
    .option("--write", "Perform the write. Without this flag, only the dry-run plan is printed.")
    .option("--confirm <value>", "Must exactly equal the user id to authorize the write.")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (controlId: string, opts: SetOwnerOpts) => {
      await runJsonAction(async () => {
        const userId = rejectFlagLikeValue(opts.userId, "--user-id");
        const dryRunPlan = { dryRun: true, controlId, userId, requiredConfirm: userId };
        if (!opts.write) return dryRunPlan;
        requireConfirmed(opts, userId, CMD_SET_OWNER_CONTROL);

        const client = await clientFor([SCOPE_READ, SCOPE_WRITE]);
        const opId = crypto.randomUUID();
        const release = await acquireLedgerLock();
        try {
          type ControlState = { owner?: { id: unknown } | null };
          const preRead = () => client.get(`controls/${controlId}`) as Promise<ControlState>;
          const postRead = () => client.get(`controls/${controlId}`) as Promise<ControlState>;
          const call = async () => {
            await appendIntentLine({
              opId,
              ts: new Date().toISOString(),
              command: CMD_SET_OWNER_CONTROL,
              targetType: "control",
              targetId: controlId,
            });
            return client.post(`controls/${controlId}/set-owner`, { userId });
          };

          const ids: Record<string, string | undefined> = { controlId, userId };
          const readback = await readbackByAttribute(
            preRead,
            call,
            postRead,
            (ctrl) => ctrl.owner?.id,
            userId,
            ids,
          );
          await appendResultLine(
            opId,
            CMD_SET_OWNER_CONTROL,
            "control",
            controlId,
            [],
            readback.verified,
            readback.readbackError,
          );
          if (!readback.verified) {
            throw codeError("CHECK_FAILED", "controls set-owner: readback did not verify the new owner.", {
              detail: {
                readback: { verified: false, readbackError: readback.readbackError },
                ids,
              },
            });
          }
          return { controlId, ownerId: userId, readback: { verified: true } };
        } finally {
          await release();
        }
      }, opts);
    });
}

// --- controls add-document -------------------------------------------------

interface AddDocumentOpts extends WriteOpts {
  documentId: string;
}

function registerAddDocumentCommand(controlsCmd: Command): void {
  controlsCmd
    .command("add-document <controlId>")
    .description(
      "Add a document to a control (standalone; distinct from documents upload --link-control-id). " +
        "Dry-run by default; requires --write --confirm <document-id>.",
    )
    .requiredOption("--document-id <id>", "The document's upstream ID to add to this control.")
    .option("--write", "Perform the write. Without this flag, only the dry-run plan is printed.")
    .option("--confirm <value>", "Must exactly equal the document id to authorize the write.")
    .option("--json", "Print machine-readable JSON output.")
    .action(async (controlId: string, opts: AddDocumentOpts) => {
      await runJsonAction(async () => {
        const documentId = rejectFlagLikeValue(opts.documentId, "--document-id");
        const dryRunPlan = { dryRun: true, controlId, documentId, requiredConfirm: documentId };
        if (!opts.write) return dryRunPlan;
        requireConfirmed(opts, documentId, CMD_ADD_DOCUMENT);

        const client = await clientFor([SCOPE_READ, SCOPE_WRITE]);
        const opId = crypto.randomUUID();
        const release = await acquireLedgerLock();
        try {
          const preRead = () => readCompleteList<{ id: string }>(client, `controls/${controlId}/documents`, {});
          const postRead = () => readCompleteList<{ id: string }>(client, `controls/${controlId}/documents`, {});
          const call = async () => {
            await appendIntentLine({
              opId,
              ts: new Date().toISOString(),
              command: CMD_ADD_DOCUMENT,
              targetType: "control",
              targetId: controlId,
            });
            return client.post(`controls/${controlId}/add-document-to-control`, { documentId });
          };

          const ids: Record<string, string | undefined> = { controlId, documentId };
          const readback = await readbackByIdInList<{ id: string }>(
            preRead,
            call,
            postRead,
            (r) => (r as { document: { id: string } }).document.id,
            ids,
          );
          await appendResultLine(
            opId,
            CMD_ADD_DOCUMENT,
            "control",
            controlId,
            readback.id ? [readback.id] : [],
            readback.verified,
            readback.readbackError,
          );
          if (!readback.verified) {
            throw codeError("CHECK_FAILED", "controls add-document: readback did not verify the mapping.", {
              detail: {
                readback: { verified: false, readbackError: readback.readbackError },
                ids,
              },
            });
          }
          return { controlId, documentId, readback: { verified: true } };
        } finally {
          await release();
        }
      }, opts);
    });
}

// --- Registration entry points, called from cli.ts ------------------------

/** Attaches documents upload/link/set-owner/submit to the existing `documents` Command. */
export function registerDocumentWriteCommands(documentsCmd: Command): void {
  registerUploadCommand(documentsCmd);
  registerLinkCommand(documentsCmd);
  registerDocumentSetOwnerCommand(documentsCmd);
  registerSubmitCommand(documentsCmd);
}

/** Attaches controls set-owner/add-document to the existing `controls` Command. */
export function registerControlWriteCommands(controlsCmd: Command): void {
  registerControlSetOwnerCommand(controlsCmd);
  registerAddDocumentCommand(controlsCmd);
}
