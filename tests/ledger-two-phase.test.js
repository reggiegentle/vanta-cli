/**
 * Coverage item 6: ledger two-phase lines, dedup, --allow-duplicate, and
 * unresolved intents (sequential coverage only; task 009f owns the
 * two-process dedup race variant).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  withHarness,
  runCli,
  parseEnvelope,
  writeTempFile,
  readLedgerLines,
  ledgerFilePath,
  DOC_1,
} from "./writes-helpers.test.js";
import * as fs from "node:fs";
import * as path from "node:path";

test("documents upload: two-phase ledger lines, dedup rejection, --allow-duplicate, unresolved intent", async () => {
  await withHarness("vanta-ledger-two-phase-", async ({ env, dirs }) => {
    const filePath = writeTempFile(dirs.root, "evidence.txt", "known content for dedup checks\n");
    const expectedSha256 = crypto.createHash("sha256").update("known content for dedup checks\n").digest("hex");

    // First run: succeeds, exactly one complete operation.
    const first = await runCli(
      ["documents", "upload", filePath, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    );
    assert.equal(first.code, 0, first.stderr);
    let lines = readLedgerLines(dirs.configDir);
    assert.equal(lines.length, 2);
    const [intent1, result1] = lines;
    assert.equal(intent1.phase, "intent");
    assert.equal(result1.phase, "result");
    assert.equal(result1.opId, intent1.opId);
    assert.equal(intent1.sha256, expectedSha256);
    assert.equal(intent1.bytes, Buffer.byteLength("known content for dedup checks\n"));
    assert.equal(intent1.targetId, DOC_1);
    assert.equal(result1.readbackVerified, true);

    // Second run, same file/document, no --allow-duplicate: rejected,
    // naming the prior entry, ledger unchanged.
    const second = await runCli(
      ["documents", "upload", filePath, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    );
    assert.equal(second.code, 1, second.stderr);
    const secondEnvelope = parseEnvelope(second.stdout);
    assert.equal(secondEnvelope.ok, false);
    assert.equal(secondEnvelope.error.code, "VALIDATION");
    assert.match(secondEnvelope.error.message, new RegExp(intent1.ts.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    lines = readLedgerLines(dirs.configDir);
    assert.equal(lines.length, 2, "the ledger must be unchanged after a rejected duplicate");

    // Third run, --allow-duplicate: succeeds; two complete operations now.
    const third = await runCli(
      [
        "documents",
        "upload",
        filePath,
        "--document-id",
        DOC_1,
        "--allow-duplicate",
        "--write",
        "--confirm",
        DOC_1,
        "--json",
      ],
      env,
    );
    assert.equal(third.code, 0, third.stderr);
    lines = readLedgerLines(dirs.configDir);
    assert.equal(lines.length, 4);
    const opIds = new Set(lines.map((l) => l.opId));
    assert.equal(opIds.size, 2, "expected exactly two distinct operations");
    for (const opId of opIds) {
      const forOp = lines.filter((l) => l.opId === opId);
      assert.equal(forOp.length, 2, "every operation must have both an intent and a result line");
    }
  });
});

test("documents upload: an unresolved intent with no matching result is reported as a duplicate", async () => {
  await withHarness("vanta-ledger-unresolved-", async ({ dirs, env }) => {
    const filePath = writeTempFile(dirs.root, "orphan.txt", "orphan intent content\n");
    const expectedSha256 = crypto
      .createHash("sha256")
      .update("orphan intent content\n")
      .digest("hex");

    // Hand-write a bare intent line into a fresh ledger file.
    const ledgerDir = path.join(dirs.configDir, "vanta");
    fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
    const handWritten = {
      opId: crypto.randomUUID(),
      phase: "intent",
      ts: new Date().toISOString(),
      command: "documents upload",
      targetType: "document",
      targetId: DOC_1,
      fileName: "orphan.txt",
      sha256: expectedSha256,
      bytes: Buffer.byteLength("orphan intent content\n"),
    };
    fs.writeFileSync(ledgerFilePath(dirs.configDir), `${JSON.stringify(handWritten)}\n`, { mode: 0o600 });

    const run = await runCli(
      ["documents", "upload", filePath, "--document-id", DOC_1, "--write", "--confirm", DOC_1, "--json"],
      env,
    );
    assert.equal(run.code, 1, run.stderr);
    const envelope = parseEnvelope(run.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "VALIDATION");
    assert.match(envelope.error.message.toLowerCase(), /unresolved|not-yet-confirmed/);

    // Still just the one hand-written intent line: the preview duplicate
    // check ran before any lock-held work and stopped the command.
    const lines = readLedgerLines(dirs.configDir);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].phase, "intent");
  });
});
