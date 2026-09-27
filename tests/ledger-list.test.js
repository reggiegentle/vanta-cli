/**
 * Coverage item 7: `ledger list` never prints an absolute path, and its
 * default output never carries a raw upstream id or a filename; --show-ids
 * adds the full targetId/sha256 back, and opId is always shown in full in
 * both modes (it is this CLI's own local correlation id, never an
 * upstream Vanta identifier).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withHarness,
  runCli,
  parseEnvelope,
  writeTempFile,
  DOC_1,
  DOC_2,
} from "./writes-helpers.test.js";

test("ledger list: default output hides filesystem paths and raw ids; --show-ids adds them back", async () => {
  await withHarness("vanta-ledger-list-", async ({ dirs, env }) => {
    const fileA = writeTempFile(dirs.root, "a.txt", "content a for ledger list\n");
    const fileB = writeTempFile(dirs.root, "b.txt", "content b for ledger list\n");

    const uploadA = await runCli(
      ["documents", "upload", fileA, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    );
    assert.equal(uploadA.code, 0, uploadA.stderr);
    const uploadB = await runCli(
      ["documents", "upload", fileB, "--document-id", DOC_2, "--write", "--confirm", DOC_2, "--json"],
      env,
    );
    assert.equal(uploadB.code, 0, uploadB.stderr);

    const defaultRun = await runCli(["ledger", "list", "--json"], env);
    assert.equal(defaultRun.code, 0, defaultRun.stderr);
    const defaultEnvelope = parseEnvelope(defaultRun.stdout);
    assert.equal(defaultEnvelope.ok, true);
    const defaultText = JSON.stringify(defaultEnvelope);

    // No filesystem path (this test's own temp directory) anywhere.
    assert.ok(
      !defaultText.includes(dirs.root),
      "default ledger list output must never include the test's own temp directory path",
    );

    assert.equal(defaultEnvelope.data.totalOperations, 2);
    assert.equal(defaultEnvelope.data.unresolvedCount, 0);
    for (const entry of defaultEnvelope.data.recent) {
      assert.equal(typeof entry.opId, "string");
      assert.ok(entry.opId.length > 0);
      assert.equal(typeof entry.targetRef, "string");
      assert.equal(typeof entry.sha256Prefix, "string");
      assert.equal("fileName" in entry, false, "default recent entries must not carry fileName");
      assert.equal("targetId" in entry, false, "default recent entries must not carry the full targetId");
      assert.equal("sha256" in entry, false, "default recent entries must not carry the full sha256");
    }

    // A plain string search: neither seeded document id, in full, appears
    // anywhere in the default output (only their 8-char targetRef prefix
    // does, and DOC_1/DOC_2 are both exactly 11 characters, so the
    // truncated ref can never collide with the full id).
    assert.ok(!defaultText.includes(DOC_1));
    assert.ok(!defaultText.includes(DOC_2));

    // The full sha256 values must not appear either.
    const showIdsRun = await runCli(["ledger", "list", "--show-ids", "--json"], env);
    assert.equal(showIdsRun.code, 0, showIdsRun.stderr);
    const showIdsEnvelope = parseEnvelope(showIdsRun.stdout);
    const fullShas = showIdsEnvelope.data.recent.map((e) => e.sha256);
    for (const sha of fullShas) {
      assert.equal(typeof sha, "string");
      assert.match(sha, /^[0-9a-f]{64}$/);
      assert.ok(!defaultText.includes(sha), "the full sha256 must not appear in the default (non-show-ids) output");
    }

    // --show-ids adds targetId/sha256 in full, on the same ledger file.
    assert.equal(showIdsEnvelope.data.recent.length, defaultEnvelope.data.recent.length);
    const targetIds = showIdsEnvelope.data.recent.map((e) => e.targetId);
    assert.ok(targetIds.includes(DOC_1));
    assert.ok(targetIds.includes(DOC_2));
    for (const entry of showIdsEnvelope.data.recent) {
      assert.equal(typeof entry.opId, "string");
      assert.ok(entry.opId.length > 0);
    }

    // opId is present, in full, in both runs (never truncated or omitted).
    const defaultOpIds = defaultEnvelope.data.recent.map((e) => e.opId).sort();
    const showIdsOpIds = showIdsEnvelope.data.recent.map((e) => e.opId).sort();
    assert.deepEqual(defaultOpIds, showIdsOpIds);
  });
});
