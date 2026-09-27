/**
 * Coverage item 2: readback verified true and false paths, for all six
 * write commands, using task 009a's forceReadbackMiss hook for the false
 * path. Every miss run's underlying POST still returns 2xx; only the
 * readback GET afterward goes stale. (An earlier draft of this file
 * worked around forceReadbackMiss not actually going stale for the three
 * single-object-route writes; fixture-server.js now clones every response
 * body, so plain forceReadbackMiss is used uniformly here.)
 *
 * Every negative case asserts readback.verified === false twice, in two
 * independent places (task 013 landed the first of these; before it, the
 * CLI's failure envelope carried no such field at all, only its error
 * code):
 *   1. The CLI's own CHECK_FAILED envelope, at error.detail.readback.verified,
 *      alongside error.detail.ids (exact keys/values named per write).
 *   2. The write ledger's own `result` line, whose readbackVerified
 *      boolean is a second, independently-written record of the same
 *      fact. For the three id-based writes (upload, link, add-document),
 *      the ledger's resultIds is cross-checked against the envelope's own
 *      id field for that write, proving both describe the same call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withHarness,
  runCli,
  parseEnvelope,
  writeTempFile,
  lastLedgerResultLine,
  DOC_1,
  DOC_2,
  CONTROL_1,
  CONTROL_2,
  USER_1,
  USER_2,
} from "./writes-helpers.test.js";

test("documents upload: readback verified true, then false via forceReadbackMiss", async () => {
  await withHarness("vanta-readback-upload-", async ({ fixture, dirs, env }) => {
    const fileA = writeTempFile(dirs.root, "a.txt", "content a\n");
    const okRun = await runCli(
      ["documents", "upload", fileA, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    );
    assert.equal(okRun.code, 0, okRun.stderr);
    const okEnvelope = parseEnvelope(okRun.stdout);
    assert.equal(okEnvelope.data.files[0].readback.verified, true);

    fixture.forceReadbackMiss(`documents/${DOC_1}/uploads`);
    const fileB = writeTempFile(dirs.root, "b.txt", "content b\n");
    const missRun = await runCli(
      ["documents", "upload", fileB, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    );
    assert.equal(missRun.code, 1, missRun.stderr);
    const missEnvelope = parseEnvelope(missRun.stdout);
    assert.equal(missEnvelope.ok, false);
    assert.equal(missEnvelope.error.code, "CHECK_FAILED");

    // (1) The envelope itself: readback.verified false, and the exact
    // ids this write names on a readback miss (documentId, uploadId).
    assert.equal(missEnvelope.error.detail.readback.verified, false);
    assert.deepEqual(new Set(Object.keys(missEnvelope.error.detail.ids)), new Set(["documentId", "uploadId"]));
    assert.equal(missEnvelope.error.detail.ids.documentId, DOC_1);
    assert.equal(typeof missEnvelope.error.detail.ids.uploadId, "string");
    assert.ok(missEnvelope.error.detail.ids.uploadId.length > 0);

    // (2) The ledger's own result line, independently.
    const missResult = lastLedgerResultLine(dirs.configDir);
    assert.equal(missResult.readbackVerified, false);
    assert.equal(missResult.resultIds.length, 1);
    assert.equal(missResult.resultIds[0], missEnvelope.error.detail.ids.uploadId);
  });
});

test("documents link: readback verified true, then false via forceReadbackMiss", async () => {
  await withHarness("vanta-readback-link-", async ({ fixture, dirs, env }) => {
    const urlOk = "https://evidence.example.test/ok-link";
    const okRun = await runCli(
      [
        "documents",
        "link",
        DOC_1,
        "--url",
        urlOk,
        "--title",
        "OK link",
        "--write",
        "--confirm",
        urlOk,
        "--json",
      ],
      env,
    );
    assert.equal(okRun.code, 0, okRun.stderr);
    assert.equal(parseEnvelope(okRun.stdout).data.readback.verified, true);

    fixture.forceReadbackMiss(`documents/${DOC_1}/links`);
    const urlMiss = "https://evidence.example.test/miss-link";
    const missRun = await runCli(
      [
        "documents",
        "link",
        DOC_1,
        "--url",
        urlMiss,
        "--title",
        "Miss link",
        "--write",
        "--confirm",
        urlMiss,
        "--json",
      ],
      env,
    );
    assert.equal(missRun.code, 1, missRun.stderr);
    const missEnvelope = parseEnvelope(missRun.stdout);
    assert.equal(missEnvelope.ok, false);
    assert.equal(missEnvelope.error.code, "CHECK_FAILED");

    assert.equal(missEnvelope.error.detail.readback.verified, false);
    assert.deepEqual(new Set(Object.keys(missEnvelope.error.detail.ids)), new Set(["documentId", "linkId"]));
    assert.equal(missEnvelope.error.detail.ids.documentId, DOC_1);
    assert.equal(typeof missEnvelope.error.detail.ids.linkId, "string");
    assert.ok(missEnvelope.error.detail.ids.linkId.length > 0);

    const missResult = lastLedgerResultLine(dirs.configDir);
    assert.equal(missResult.readbackVerified, false);
    assert.equal(missResult.resultIds.length, 1);
    assert.equal(missResult.resultIds[0], missEnvelope.error.detail.ids.linkId);
  });
});

test("documents set-owner: readback verified true, then false via a stale postRead snapshot", async () => {
  await withHarness("vanta-readback-set-owner-doc-", async ({ fixture, dirs, env }) => {
    const okRun = await runCli(
      ["documents", "set-owner", DOC_1, "--user-id", USER_2, "--write", "--confirm", USER_2, "--json"],
      env,
    );
    assert.equal(okRun.code, 0, okRun.stderr);
    assert.equal(parseEnvelope(okRun.stdout).data.readback.verified, true);

    fixture.forceReadbackMiss(`documents/${DOC_1}`);
    const missRun = await runCli(
      ["documents", "set-owner", DOC_1, "--user-id", USER_1, "--write", "--confirm", USER_1, "--json"],
      env,
    );
    assert.equal(missRun.code, 1, missRun.stderr);
    const missEnvelope = parseEnvelope(missRun.stdout);
    assert.equal(missEnvelope.ok, false);
    assert.equal(missEnvelope.error.code, "CHECK_FAILED");

    assert.equal(missEnvelope.error.detail.readback.verified, false);
    assert.deepEqual(missEnvelope.error.detail.ids, { documentId: DOC_1, userId: USER_1 });

    const missResult = lastLedgerResultLine(dirs.configDir);
    assert.equal(missResult.readbackVerified, false);
  });
});

test("documents submit: readback verified true, then false via a stale postRead snapshot; bodyless request", async () => {
  await withHarness("vanta-readback-submit-", async ({ fixture, dirs, env }) => {
    const okRun = await runCli(
      ["documents", "submit", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    );
    assert.equal(okRun.code, 0, okRun.stderr);
    assert.equal(parseEnvelope(okRun.stdout).data.readback.verified, true);
    const submitRequest = fixture.requests.find(
      (r) => r.method === "POST" && r.path.includes("/submit"),
    );
    assert.ok(submitRequest);
    assert.equal(submitRequest.headers["content-type"], undefined);
    assert.equal(submitRequest.body, undefined);

    fixture.forceReadbackMiss(`documents/${DOC_2}`);
    const missRun = await runCli(
      ["documents", "submit", DOC_2, "--write", "--confirm", DOC_2, "--json"],
      env,
    );
    assert.equal(missRun.code, 1, missRun.stderr);
    const missEnvelope = parseEnvelope(missRun.stdout);
    assert.equal(missEnvelope.ok, false);
    assert.equal(missEnvelope.error.code, "CHECK_FAILED");

    assert.equal(missEnvelope.error.detail.readback.verified, false);
    assert.deepEqual(missEnvelope.error.detail.ids, { documentId: DOC_2 });

    const missResult = lastLedgerResultLine(dirs.configDir);
    assert.equal(missResult.readbackVerified, false);
  });
});

test("controls set-owner: readback verified true, then false via a stale postRead snapshot", async () => {
  await withHarness("vanta-readback-set-owner-control-", async ({ fixture, dirs, env }) => {
    const okRun = await runCli(
      ["controls", "set-owner", CONTROL_1, "--user-id", USER_2, "--write", "--confirm", USER_2, "--json"],
      env,
    );
    assert.equal(okRun.code, 0, okRun.stderr);
    assert.equal(parseEnvelope(okRun.stdout).data.readback.verified, true);

    fixture.forceReadbackMiss(`controls/${CONTROL_1}`);
    const missRun = await runCli(
      ["controls", "set-owner", CONTROL_1, "--user-id", USER_1, "--write", "--confirm", USER_1, "--json"],
      env,
    );
    assert.equal(missRun.code, 1, missRun.stderr);
    const missEnvelope = parseEnvelope(missRun.stdout);
    assert.equal(missEnvelope.ok, false);
    assert.equal(missEnvelope.error.code, "CHECK_FAILED");

    assert.equal(missEnvelope.error.detail.readback.verified, false);
    assert.deepEqual(missEnvelope.error.detail.ids, { controlId: CONTROL_1, userId: USER_1 });

    const missResult = lastLedgerResultLine(dirs.configDir);
    assert.equal(missResult.readbackVerified, false);
  });
});

test("controls add-document: readback verified true, then false via forceReadbackMiss", async () => {
  await withHarness("vanta-readback-add-document-", async ({ fixture, dirs, env }) => {
    const okRun = await runCli(
      [
        "controls",
        "add-document",
        CONTROL_1,
        "--document-id",
        DOC_2,
        "--write",
        "--confirm",
        DOC_2,
        "--json",
      ],
      env,
    );
    assert.equal(okRun.code, 0, okRun.stderr);
    assert.equal(parseEnvelope(okRun.stdout).data.readback.verified, true);

    fixture.forceReadbackMiss(`controls/${CONTROL_2}/documents`);
    const missRun = await runCli(
      [
        "controls",
        "add-document",
        CONTROL_2,
        "--document-id",
        DOC_1,
        "--write",
        "--confirm",
        DOC_1,
        "--json",
      ],
      env,
    );
    assert.equal(missRun.code, 1, missRun.stderr);
    const missEnvelope = parseEnvelope(missRun.stdout);
    assert.equal(missEnvelope.ok, false);
    assert.equal(missEnvelope.error.code, "CHECK_FAILED");

    assert.equal(missEnvelope.error.detail.readback.verified, false);
    assert.deepEqual(missEnvelope.error.detail.ids, { controlId: CONTROL_2, documentId: DOC_1 });

    const missResult = lastLedgerResultLine(dirs.configDir);
    assert.equal(missResult.readbackVerified, false);
    assert.equal(missResult.resultIds.length, 1);
    assert.equal(typeof missResult.resultIds[0], "string");
    assert.ok(
      missResult.resultIds[0].length > 0,
      "the id the mutating add-document call returned must still be recorded",
    );
  });
});
