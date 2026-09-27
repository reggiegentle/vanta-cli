/**
 * Coverage item 8: ledger.lock is held by design across a sub-operation's
 * HTTP call (not just the ledger-file writes around it); config.lock is
 * absent throughout a write; an unrelated read command run concurrently
 * against the same fixture server and config dir is not blocked by a
 * write's hold on ledger.lock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  withHarness,
  startCli,
  runCli,
  sleep,
  parseEnvelope,
  requestMatchesPath,
  ledgerLockPath,
  configLockPath,
  DOC_1,
  USER_2,
} from "./writes-helpers.test.js";

test("documents set-owner: ledger.lock spans the HTTP call; config.lock is absent throughout; unrelated reads are not blocked", async () => {
  await withHarness("vanta-lock-visibility-", async ({ fixture, dirs, env }) => {
    // documents set-owner is used here (not documents upload) because its
    // mutating path ("documents/{id}/set-owner") is distinct from its
    // readback path ("documents/{id}"): task 009a's delayNextResponse
    // hook keys purely by path, not by method, so a write whose readback
    // GET and mutating POST share one path (upload, link) would have its
    // *preRead* delayed instead of its mutating call, leaving only a
    // razor-thin, scheduler-jitter-prone window before the lock releases
    // (confirmed empirically while building this test: it produced
    // exactly this suite's intermittent failure). A route with disjoint
    // paths lets the delay land on the mutating call alone.
    const setOwnerPath = `documents/${DOC_1}/set-owner`;

    assert.equal(fs.existsSync(configLockPath(dirs.configDir)), false);
    assert.equal(fs.existsSync(ledgerLockPath(dirs.configDir)), false);

    // Delay the mutating POST's response so the lock is observably held
    // while that request is genuinely in flight, not just around the
    // ledger-file writes on either side of it.
    const DELAY_MS = 1000;
    fixture.delayNextResponse(setOwnerPath, DELAY_MS);

    const { done } = startCli(
      // document-001's seeded owner is user-001; user-002 is a real
      // change, so the readback verifies true and the command exits 0.
      ["documents", "set-owner", DOC_1, "--user-id", USER_2, "--write", "--confirm", USER_2, "--json"],
      env,
    );

    // Poll until the mutating POST has actually landed at the fixture
    // (proving the request is genuinely in flight, held by the delay),
    // then assert on lock state while it is still pending.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const landed = fixture.requests.some((r) => r.method === "POST" && requestMatchesPath(r, setOwnerPath));
      if (landed) break;
      if (Date.now() > deadline) throw new Error("timed out waiting for the set-owner POST to land");
      await sleep(5);
    }

    assert.equal(
      fs.existsSync(ledgerLockPath(dirs.configDir)),
      true,
      "ledger.lock must exist while the set-owner mutating request is in flight",
    );
    assert.equal(
      fs.existsSync(configLockPath(dirs.configDir)),
      false,
      "config.lock must be absent during a write (ensureToken already released it before the first request)",
    );

    // An unrelated read, run concurrently against the same fixture and
    // config dir, is not blocked by the write's hold on ledger.lock.
    const readStart = Date.now();
    const readResult = await runCli(["frameworks", "list", "--json"], env);
    const readElapsedMs = Date.now() - readStart;
    assert.equal(readResult.code, 0, readResult.stderr);
    const readEnvelope = parseEnvelope(readResult.stdout);
    assert.equal(readEnvelope.ok, true);
    assert.ok(
      readElapsedMs < DELAY_MS / 2,
      `an unrelated read should not wait on ledger.lock (took ${readElapsedMs}ms, delay was ${DELAY_MS}ms)`,
    );

    const writeResult = await done;
    assert.equal(writeResult.code, 0, writeResult.stderr);

    // Released once the write command has finished.
    assert.equal(fs.existsSync(ledgerLockPath(dirs.configDir)), false);
    assert.equal(fs.existsSync(configLockPath(dirs.configDir)), false);
  });
});
