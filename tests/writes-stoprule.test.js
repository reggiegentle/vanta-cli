/**
 * Coverage items 4 and 5: the one stop rule (no continuation past a
 * failure, whether the failure is a readback miss or the mutating call
 * itself failing), for documents upload's multi-file/multi-link packet.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withHarness,
  startCli,
  parseEnvelope,
  writeTempFile,
  readLedgerLines,
  DOC_1,
  CONTROL_1,
  CONTROL_2,
} from "./writes-helpers.test.js";

test("documents upload: one stop rule, readback failure on file 1 stops before file 2 or any link", async () => {
  await withHarness("vanta-stoprule-readback-", async ({ fixture, dirs, env }) => {
    const fileA = writeTempFile(dirs.root, "first.txt", "first file\n");
    const fileB = writeTempFile(dirs.root, "second.txt", "second file\n");

    // Force the FIRST file's readback (preRead of documents/{id}/uploads)
    // to miss by arming before the command starts.
    fixture.forceReadbackMiss(`documents/${DOC_1}/uploads`);

    const run = await startCli(
      [
        "documents",
        "upload",
        fileA,
        fileB,
        "--document-id",
        DOC_1,
        "--link-control-id",
        CONTROL_1,
        "--write",
        "--confirm",
        DOC_1,
        "--json",
      ],
      env,
    ).done;

    assert.equal(run.code, 1, run.stderr);
    const envelope = parseEnvelope(run.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "CHECK_FAILED");

    // The second file was never uploaded at all.
    const uploadRequests = fixture.requests.filter(
      (r) => r.method === "POST" && r.path.includes(`/documents/${DOC_1}/uploads`),
    );
    assert.equal(uploadRequests.length, 1, "only the first file's upload POST should have been attempted");

    // No --link-control-id request happened either, even though one was passed.
    const linkRequests = fixture.requests.filter(
      (r) => r.method === "POST" && r.path.includes("add-document-to-control"),
    );
    assert.equal(linkRequests.length, 0, "the control link step must never have been attempted");

    // Only one sub-operation's worth of ledger lines exist (file 1's intent+result).
    const lines = readLedgerLines(dirs.configDir);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].phase, "intent");
    assert.equal(lines[1].phase, "result");
    assert.equal(lines[1].readbackVerified, false);
  });
});

/** A pagination envelope matching fixture-server.js's own `envelope()` shape. */
function pageEnvelope(rows) {
  return {
    results: {
      data: rows,
      pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
    },
  };
}

test(
  "documents upload: partial failure on the call itself (500), not just readback, stops before the next file or any link",
  async () => {
    await withHarness("vanta-stoprule-call-failure-", async ({ fixture, dirs, env }) => {
      const fileA = writeTempFile(dirs.root, "file-a.txt", "file a content\n");
      const fileB = writeTempFile(dirs.root, "file-b.txt", "file b content\n");
      const uploadsPath = `documents/${DOC_1}/uploads`;
      const uploadAId = "fixture-forced-upload-a";

      // Deterministic, no polling or interval: forceNextResponse is keyed
      // by path only, not method, and documents/{id}/uploads is the exact
      // path used by file-a's own preRead GET, its POST, and its postRead
      // GET, as well as file-b's own preRead GET, so this queue has to
      // account for every one of those requests in strict arrival order,
      // not just file-b's four POST attempts. Queuing only file-b's
      // failures on this shared path would have them consumed by file-a's
      // own requests instead. This is why forceUploadFailure (task 009a's
      // per-filename hook, immune to this because it's keyed off the
      // parsed multipart filename, not the path) cannot simply be swapped
      // in with a "times" argument either: it does not currently take
      // one, and a real 500 is retried by vanta-api.ts up to 4 attempts
      // with real 2s/4s/8s backoff, so a single-shot arm only fails
      // attempt 1 and lets attempt 2 quietly succeed.
      fixture.forceNextResponse(uploadsPath, { status: 200, body: pageEnvelope([]) }); // file-a preRead
      fixture.forceNextResponse(uploadsPath, {
        status: 201,
        body: { id: uploadAId, fileName: "file-a.txt" },
      }); // file-a call()
      fixture.forceNextResponse(uploadsPath, {
        status: 200,
        body: pageEnvelope([{ id: uploadAId }]),
      }); // file-a postRead
      fixture.forceNextResponse(uploadsPath, {
        status: 200,
        body: pageEnvelope([{ id: uploadAId }]),
      }); // file-b preRead
      fixture.forceNextResponse(uploadsPath, { status: 500, body: { error: "forced_upload_failure" } }, 4); // file-b's 4 real attempts (initial + 3 retries)

      const run = await startCli(
        [
          "documents",
          "upload",
          fileA,
          fileB,
          "--document-id",
          DOC_1,
          "--link-control-id",
          CONTROL_1,
          "--link-control-id",
          CONTROL_2,
          "--write",
          "--confirm",
          DOC_1,
          "--json",
        ],
        env,
      ).done;

      assert.equal(run.code, 1, run.stderr);
      const envelope = parseEnvelope(run.stdout);
      assert.equal(envelope.ok, false);
      // The top-level error code the command actually exits with is
      // CHECK_FAILED, not the underlying UPSTREAM_5XX the API call itself
      // returned: attachUploadProgress re-throws via codeError(normalized.code, ...)
      // where normalized.code is already CHECK_FAILED (set by
      // readbackByIdInList's own call()-failure wrapper), so the raw
      // upstream code is demoted to error.detail.callError.code below,
      // never left to leak to the top level.
      assert.equal(envelope.error.code, "CHECK_FAILED");

      // The API call itself failed (a real, retried-then-exhausted 500),
      // named directly in the envelope: task 013 landed
      // error.detail.callError for exactly this path (an API call failure
      // before any readback could even run).
      assert.equal(envelope.error.detail.callError.code, "UPSTREAM_5XX");
      assert.equal(typeof envelope.error.detail.callError.message, "string");

      // file-a's upload succeeded; detail.completed.files lists only that
      // one file, never file-b (which never got a chance to complete).
      const completedFiles = envelope.error.detail?.completed?.files ?? [];
      assert.equal(completedFiles.length, 1);
      assert.equal(completedFiles[0].fileName, "file-a.txt");

      // The command's own error output names which file(s) completed
      // before the failure.
      assert.match(JSON.stringify(envelope.error.detail), /file-a\.txt/);

      // No add-document-to-control request was made for either control.
      const linkRequests = fixture.requests.filter(
        (r) => r.method === "POST" && r.path.includes("add-document-to-control"),
      );
      assert.equal(linkRequests.length, 0);

      // file-a has a complete ledger entry (intent + result, verified true).
      // Only the intent line carries fileName; the matching result line is
      // found by opId, not by fileName.
      const lines = readLedgerLines(dirs.configDir);
      const fileAIntent = lines.find((l) => l.phase === "intent" && l.fileName === "file-a.txt");
      assert.ok(fileAIntent, "expected an intent line for file-a.txt");
      const fileALines = lines.filter((l) => l.opId === fileAIntent.opId);
      assert.equal(fileALines.length, 2);
      const fileAResult = fileALines.find((l) => l.phase === "result");
      assert.equal(fileAResult.readbackVerified, true);

      // file-b has, at most, an unresolved intent line: the mutating call
      // itself threw before a result line was ever written for it (D10's
      // orphaned-intent contract; call() appends its intent before
      // attempting the upload, and that throw propagates past the point
      // where appendResultLine would run).
      const fileBIntent = lines.find((l) => l.phase === "intent" && l.fileName === "file-b.txt");
      assert.ok(fileBIntent, "expected an intent line for file-b.txt");
      const fileBLines = lines.filter((l) => l.opId === fileBIntent.opId);
      assert.equal(fileBLines.length, 1, "file-b must not have a completed ledger entry");
      assert.equal(fileBLines[0].phase, "intent");
    });
  },
);
