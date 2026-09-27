/**
 * Coverage items 3 and 3a: pre-write snapshot incompleteness fails the
 * readback closed before any mutation; post-write snapshot incompleteness
 * still records a completed sub-operation (the mutating call's own id),
 * with the ledger's result line carrying readbackVerified: false and a
 * SNAPSHOT_INCOMPLETE reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withHarness,
  startCli,
  sleep,
  parseEnvelope,
  readLedgerLines,
  requestMatchesPath,
  DOC_1,
} from "./writes-helpers.test.js";

function findEnvelopeDetailString(envelope) {
  return JSON.stringify(envelope.error?.detail ?? {});
}

test("documents link: pre-write snapshot incompleteness fails closed, no mutation, no ledger lines", async () => {
  await withHarness("vanta-snapshot-pre-", async ({ fixture, dirs, env }) => {
    const url = "https://evidence.example.test/pre-incomplete";
    // Armed before the command starts: the very first matching GET after
    // arming is the write's own preRead.
    fixture.forceIncompletePage(`documents/${DOC_1}/links`);
    const run = await startCli(
      [
        "documents",
        "link",
        DOC_1,
        "--url",
        url,
        "--title",
        "Pre-incomplete link",
        "--write",
        "--confirm",
        url,
        "--json",
      ],
      env,
    ).done;

    assert.equal(run.code, 1, run.stderr);
    const envelope = parseEnvelope(run.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "CHECK_FAILED");
    assert.match(findEnvelopeDetailString(envelope), /SNAPSHOT_INCOMPLETE/);

    // No mutating POST to the links route was ever made.
    const mutatingRequests = fixture.requests.filter(
      (r) => r.method === "POST" && r.path.includes(`/documents/${DOC_1}/links`),
    );
    assert.equal(mutatingRequests.length, 0, "the mutating POST must never have been attempted");

    // No ledger lines at all for this attempt: the failure happens before
    // an intent line would ever be written.
    assert.deepEqual(readLedgerLines(dirs.configDir), []);
  });
});

test("controls add-document: pre-write snapshot incompleteness fails closed, no mutation, no ledger lines", async () => {
  await withHarness("vanta-snapshot-pre-add-document-", async ({ fixture, dirs, env }) => {
    fixture.forceIncompletePage(`controls/control-002/documents`);
    const run = await startCli(
      ["controls", "add-document", "control-002", "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    ).done;

    assert.equal(run.code, 1, run.stderr);
    const envelope = parseEnvelope(run.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "CHECK_FAILED");
    assert.match(findEnvelopeDetailString(envelope), /SNAPSHOT_INCOMPLETE/);

    const mutatingRequests = fixture.requests.filter(
      (r) => r.method === "POST" && r.path.includes("add-document-to-control"),
    );
    assert.equal(mutatingRequests.length, 0);
    assert.deepEqual(readLedgerLines(dirs.configDir), []);
  });
});

/**
 * Waits until `matcher` has matched at least `count` entries of
 * fixture.requests, polling rather than guessing a fixed sleep duration.
 */
async function waitForRequestCount(fixture, matcher, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fixture.requests.filter(matcher).length >= count) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected request count");
    await sleep(5);
  }
}

test("documents link: post-write snapshot incompleteness still records the completed call (intent+result, verified:false)", async () => {
  await withHarness("vanta-snapshot-post-", async ({ fixture, dirs, env }) => {
    const url = "https://evidence.example.test/post-incomplete";
    const linksPath = `documents/${DOC_1}/links`;
    const matcher = (r) => r.method === "GET" && requestMatchesPath(r, linksPath);
    const baseline = fixture.requests.filter(matcher).length;

    // Delay the mutating POST's response so there is a real window between
    // preRead (which must stay complete) and postRead (which must not).
    fixture.delayNextResponse(linksPath, 300);
    const { done } = startCli(
      [
        "documents",
        "link",
        DOC_1,
        "--url",
        url,
        "--title",
        "Post-incomplete link",
        "--write",
        "--confirm",
        url,
        "--json",
      ],
      env,
    );

    // Arm forceIncompletePage only after preRead's own GET has already
    // landed, so preRead itself stays a normal, complete snapshot.
    await waitForRequestCount(fixture, matcher, baseline + 1);
    fixture.forceIncompletePage(linksPath);

    const run = await done;
    assert.equal(run.code, 1, run.stderr);
    const envelope = parseEnvelope(run.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "CHECK_FAILED");
    assert.match(findEnvelopeDetailString(envelope), /SNAPSHOT_INCOMPLETE/);

    // The mutating POST DID happen and DID succeed.
    const mutatingRequests = fixture.requests.filter(
      (r) => r.method === "POST" && requestMatchesPath(r, linksPath),
    );
    assert.equal(mutatingRequests.length, 1);

    const lines = readLedgerLines(dirs.configDir);
    assert.equal(lines.length, 2, "expected exactly one intent line and one matching result line");
    const [intent, result] = lines;
    assert.equal(intent.phase, "intent");
    assert.equal(result.phase, "result");
    assert.equal(result.opId, intent.opId);
    assert.equal(result.readbackVerified, false);
    assert.ok(result.readbackError, "expected a readbackError on the result line");
    assert.match(result.readbackError.message, /SNAPSHOT_INCOMPLETE/);
    // resultIds carries the id the mutating call actually returned, proving
    // the command captured the call's success even though the readback
    // that was supposed to confirm it failed.
    assert.equal(result.resultIds.length, 1);
    assert.equal(typeof result.resultIds[0], "string");
    assert.ok(result.resultIds[0].length > 0);
  });
});
