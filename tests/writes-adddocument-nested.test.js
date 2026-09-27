/**
 * Coverage item 9: add-document's readback verifies against the real,
 * nested {document, control} response shape for both forms (proven by
 * the ordinary readback-true assertions here, run against the fixture's
 * unmodified, genuinely nested handler response), plus three negative
 * controls proving extraction failure itself is caught inside the same
 * protected block as postRead, never leaving a dangling intent with no
 * matching result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withHarness,
  runCli,
  parseEnvelope,
  writeTempFile,
  readLedgerLines,
  DOC_1,
  DOC_2,
  CONTROL_1,
  CONTROL_2,
} from "./writes-helpers.test.js";

test("documents upload --link-control-id: verifies true against the real nested {document, control} response (extracts control.id)", async () => {
  await withHarness("vanta-nested-upload-link-", async ({ dirs, env }) => {
    const filePath = writeTempFile(dirs.root, "nested-upload.txt", "nested shape upload content\n");
    // document-002/control-002 are not pre-linked in the fixture's seed
    // data (unlike document-001/control-001): the readback requires the
    // link's id absent before and present after, so a pre-existing link
    // would make this a no-op the readback correctly refuses to verify,
    // for an unrelated reason having nothing to do with this test.
    const run = await runCli(
      [
        "documents",
        "upload",
        filePath,
        "--document-id",
        DOC_2,
        "--link-control-id",
        CONTROL_2,
        "--write",
        "--confirm",
        DOC_2,
        "--json",
      ],
      env,
    );
    assert.equal(run.code, 0, run.stderr);
    const envelope = parseEnvelope(run.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.linkedControlIds.length, 1);
    assert.equal(envelope.data.linkedControlIds[0].controlId, CONTROL_2);
    assert.equal(envelope.data.linkedControlIds[0].readback.verified, true);
  });
});

test("controls add-document (standalone): verifies true against the real nested {document, control} response (extracts document.id)", async () => {
  await withHarness("vanta-nested-add-document-", async ({ env }) => {
    const run = await runCli(
      ["controls", "add-document", CONTROL_1, "--document-id", DOC_2, "--write", "--confirm", DOC_2, "--json"],
      env,
    );
    assert.equal(run.code, 0, run.stderr);
    const envelope = parseEnvelope(run.stdout);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.controlId, CONTROL_1);
    assert.equal(envelope.data.documentId, DOC_2);
    assert.equal(envelope.data.readback.verified, true);
  });
});

function assertDanglingIntentNeverHappened(lines) {
  // Every operation present must have BOTH an intent and a matching
  // result line: this is the round-10 blocker fix's core guarantee.
  const opIds = new Set(lines.map((l) => l.opId));
  for (const opId of opIds) {
    const forOp = lines.filter((l) => l.opId === opId);
    assert.equal(forOp.length, 2, `opId ${opId} must have exactly one intent and one matching result line`);
    const intent = forOp.find((l) => l.phase === "intent");
    const result = forOp.find((l) => l.phase === "result");
    assert.ok(intent, `opId ${opId} missing its intent line`);
    assert.ok(result, `opId ${opId} missing its result line (a dangling intent)`);
  }
}

test(
  "negative control (a): upload-packet link step, control.id missing from the nested response, fails closed with no dangling intent",
  async () => {
    await withHarness("vanta-nested-negative-a-", async ({ fixture, dirs, env }) => {
      const filePath = writeTempFile(dirs.root, "negative-a.txt", "negative control a content\n");
      // This step's own extractId reads control.id, so control.id, not
      // document.id, must be the field missing to exercise its
      // extraction-failure path (round-10 blocker fix's own correction).
      fixture.forceNextResponse(`controls/${CONTROL_2}/add-document-to-control`, {
        status: 200,
        body: { document: { id: DOC_1 }, control: {} },
      });

      const run = await runCli(
        [
          "documents",
          "upload",
          filePath,
          "--document-id",
          DOC_1,
          "--link-control-id",
          CONTROL_2,
          "--write",
          "--confirm",
          DOC_1,
          "--json",
        ],
        env,
      );
      assert.equal(run.code, 1, run.stderr);
      const envelope = parseEnvelope(run.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "CHECK_FAILED");

      const lines = readLedgerLines(dirs.configDir);
      assertDanglingIntentNeverHappened(lines);
      const linkOp = lines.filter((l) => l.targetType === "control" && l.targetId === CONTROL_2);
      assert.equal(linkOp.length, 2);
      const result = linkOp.find((l) => l.phase === "result");
      assert.equal(result.readbackVerified, false);
      assert.ok(result.readbackError);
      assert.equal(typeof result.readbackError.code, "string");
      assert.equal(typeof result.readbackError.message, "string");
      assert.deepEqual(result.resultIds, []);
    });
  },
);

test(
  "negative control (b): standalone add-document, document.id missing from the nested response, fails closed with no dangling intent",
  async () => {
    await withHarness("vanta-nested-negative-b-", async ({ fixture, dirs, env }) => {
      // This path's own extractId reads document.id, so document.id must
      // be the field missing here.
      fixture.forceNextResponse(`controls/${CONTROL_1}/add-document-to-control`, {
        status: 200,
        body: { document: {}, control: { id: "ctl-1" } },
      });

      const run = await runCli(
        ["controls", "add-document", CONTROL_1, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
        env,
      );
      assert.equal(run.code, 1, run.stderr);
      const envelope = parseEnvelope(run.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "CHECK_FAILED");

      const lines = readLedgerLines(dirs.configDir);
      assertDanglingIntentNeverHappened(lines);
      assert.equal(lines.length, 2);
      const result = lines.find((l) => l.phase === "result");
      assert.equal(result.readbackVerified, false);
      assert.ok(result.readbackError);
      assert.equal(typeof result.readbackError.code, "string");
      assert.equal(typeof result.readbackError.message, "string");
      assert.deepEqual(result.resultIds, []);
    });
  },
);

test(
  "negative control (c): response is valid JSON but not an object at all, fails closed with no dangling intent",
  async () => {
    await withHarness("vanta-nested-negative-c-", async ({ fixture, dirs, env }) => {
      fixture.forceNextResponse(`controls/${CONTROL_1}/add-document-to-control`, {
        status: 200,
        body: "not an object at all",
      });

      const run = await runCli(
        ["controls", "add-document", CONTROL_1, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
        env,
      );
      assert.equal(run.code, 1, run.stderr);
      const envelope = parseEnvelope(run.stdout);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "CHECK_FAILED");

      const lines = readLedgerLines(dirs.configDir);
      assertDanglingIntentNeverHappened(lines);
      assert.equal(lines.length, 2);
      const result = lines.find((l) => l.phase === "result");
      assert.equal(result.readbackVerified, false);
      assert.ok(result.readbackError);
      assert.equal(typeof result.readbackError.code, "string");
      assert.equal(typeof result.readbackError.message, "string");
      assert.deepEqual(result.resultIds, []);
    });
  },
);
