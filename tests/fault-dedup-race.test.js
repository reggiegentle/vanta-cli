/**
 * node:test suite: the two-process same-(sha256, documentId) dedup race
 * (task 009f, spec.md R5/R6/D10). Runs the built CLI (dist/cli.js) as two
 * concurrently spawned child processes against tests/helpers/fixture-
 * server.js, proving the ledger-lock-held repeat duplicate check is the
 * real gate, not the unlocked preview check.
 *
 * Each test below runs the genuine two-process race exactly once, with no
 * artificial stagger between the two spawns (staggering would defeat the
 * very race being tested). A prior version of this file retried and
 * dynamically skipped around a since-fixed race in src/config.ts's
 * acquireGuard/classifyLockFile (task 012, commit 569bf1c gave the
 * malformed branch the same grace period acquireLock already had); now
 * that it is fixed, an anomalous result (a LOCKED failure, or output that
 * does not even parse as this CLI's own {ok,...} envelope) is asserted
 * against directly, as a real failure, not silently skipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureServer } from "./helpers/fixture-server.js";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
const SEEDED_DOCUMENT_ID = "document-001";

async function makeTempHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-fault-dedup-"));
}

function fixtureEnv(fixture, homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, "xdg-config"),
    VANTA_ALLOW_UNSAFE_API_BASE_URL: "1",
    VANTA_API_BASE_URL: fixture.apiBaseUrl,
    VANTA_CLIENT_ID: "vci_test_0001",
    VANTA_CLIENT_SECRET: "vcs_test_0001",
  };
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonOutput(result) {
  return JSON.parse(result.stdout.trim());
}

function ledgerFilePath(homeDir) {
  return path.join(homeDir, "xdg-config", "vanta", "write-ledger.jsonl");
}

async function readLedgerLines(homeDir) {
  const raw = await fs.readFile(ledgerFilePath(homeDir), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function requestPathname(request) {
  return new URL(request.path, "http://fixture.local").pathname;
}

/**
 * True for any outcome that is not a legitimate dedup-check result: any
 * LOCKED failure, or stdout that does not even parse as this CLI's own
 * {ok,...}/{ok:false,...} envelope at all. Every legitimate code path in
 * writes.ts/ledger.ts always prints through that envelope, so either
 * shape here is a real bug to fail loudly on, not a "loser" outcome this
 * test cares about asserting on.
 */
function isAnomalousResult(result) {
  let output;
  try {
    output = parseJsonOutput(result);
  } catch {
    return true;
  }
  return output.ok === false && output.error.code === "LOCKED";
}

function anomalyMessage(resultA, resultB) {
  return (
    `expected neither process to hit a LOCKED failure or an unparseable result, got: ` +
    `A: code=${resultA.code} stdout=${JSON.stringify(resultA.stdout)}; ` +
    `B: code=${resultB.code} stdout=${JSON.stringify(resultB.stdout)}`
  );
}

test("two concurrent `documents upload` invocations for the same (sha256, documentId) let exactly one succeed", async () => {
  const fixture = await startFixtureServer();
  const homeDir = await makeTempHome();
  try {
    const env = fixtureEnv(fixture, homeDir);
    const filesDir = path.join(homeDir, "files");
    await fs.mkdir(filesDir, { recursive: true });
    const filePath = path.join(filesDir, "evidence.txt");
    const content = "dedup race fixture content, same bytes for both processes\n";
    await fs.writeFile(filePath, content);
    const expectedSha256 = crypto.createHash("sha256").update(content).digest("hex");

    const args = [
      "documents",
      "upload",
      filePath,
      "--document-id",
      SEEDED_DOCUMENT_ID,
      "--write",
      "--confirm",
      SEEDED_DOCUMENT_ID,
      "--json",
    ];

    // No await between the two spawns: both child processes race for the
    // same fixture, the same tempConfigHome, and the same ledger.lock.
    const promiseA = runCli(args, env);
    const promiseB = runCli(args, env);
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);
    console.log(`fault-dedup-race: process A exited ${resultA.code}, process B exited ${resultB.code}`);

    assert.ok(!isAnomalousResult(resultA) && !isAnomalousResult(resultB), anomalyMessage(resultA, resultB));

    const results = [resultA, resultB];
    const winners = results.filter((r) => r.code === 0);
    const losers = results.filter((r) => r.code !== 0);
    assert.equal(
      winners.length,
      1,
      `expected exactly one winning process, got exit codes ${results.map((r) => r.code)}: ${results.map((r) => r.stdout)}`,
    );
    assert.equal(
      losers.length,
      1,
      `expected exactly one losing process, got exit codes ${results.map((r) => r.code)}`,
    );

    const loser = losers[0];
    assert.equal(loser.code, 1, "the losing process must exit 1");
    const loserOutput = parseJsonOutput(loser);
    assert.equal(loserOutput.ok, false);
    assert.equal(loserOutput.error.code, "VALIDATION");
    assert.match(loserOutput.error.message, /duplicate/i);

    const winner = winners[0];
    const winnerOutput = parseJsonOutput(winner);
    assert.equal(winnerOutput.ok, true);
    assert.equal(winnerOutput.data.files.length, 1);
    assert.equal(winnerOutput.data.files[0].fileName, "evidence.txt");
    assert.equal(winnerOutput.data.files[0].readback.verified, true);
    assert.equal(typeof winnerOutput.data.files[0].uploadId, "string");

    const uploadPostRequests = fixture.requests.filter(
      (r) => r.method === "POST" && requestPathname(r) === `/v1/documents/${SEEDED_DOCUMENT_ID}/uploads`,
    );
    assert.equal(
      uploadPostRequests.length,
      1,
      `expected exactly one POST documents/${SEEDED_DOCUMENT_ID}/uploads to reach the fixture, got ${uploadPostRequests.length}`,
    );

    const ledgerLines = await readLedgerLines(homeDir);
    console.log(`fault-dedup-race: final ledger contents = ${JSON.stringify(ledgerLines)}`);

    const matchingIntents = ledgerLines.filter(
      (line) =>
        line.phase === "intent" &&
        line.command === "documents upload" &&
        line.sha256 === expectedSha256 &&
        line.targetId === SEEDED_DOCUMENT_ID,
    );
    assert.equal(
      matchingIntents.length,
      1,
      "expected exactly one intent line for this (sha256, documentId) pair, not two",
    );

    const matchingResults = ledgerLines.filter(
      (line) => line.phase === "result" && line.opId === matchingIntents[0].opId,
    );
    assert.equal(
      matchingResults.length,
      1,
      "expected exactly one completed operation for this (sha256, documentId) pair, not two",
    );
    assert.equal(matchingResults[0].readbackVerified, true);
  } finally {
    await fixture.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("--allow-duplicate on both invocations lets both processes upload the same file", async () => {
  const fixture = await startFixtureServer();
  const homeDir = await makeTempHome();
  try {
    const env = fixtureEnv(fixture, homeDir);
    const filesDir = path.join(homeDir, "files");
    await fs.mkdir(filesDir, { recursive: true });
    const filePath = path.join(filesDir, "evidence.txt");
    await fs.writeFile(filePath, "allow-duplicate probe content\n");

    const args = [
      "documents",
      "upload",
      filePath,
      "--document-id",
      SEEDED_DOCUMENT_ID,
      "--allow-duplicate",
      "--write",
      "--confirm",
      SEEDED_DOCUMENT_ID,
      "--json",
    ];

    const [resultA, resultB] = await Promise.all([runCli(args, env), runCli(args, env)]);
    console.log(
      `fault-dedup-race allow-duplicate: process A exited ${resultA.code}, process B exited ${resultB.code}`,
    );

    assert.ok(!isAnomalousResult(resultA) && !isAnomalousResult(resultB), anomalyMessage(resultA, resultB));

    assert.equal(resultA.code, 0, `expected process A to succeed, got: ${resultA.stdout}`);
    assert.equal(resultB.code, 0, `expected process B to succeed, got: ${resultB.stdout}`);

    const uploadPostRequests = fixture.requests.filter(
      (r) => r.method === "POST" && requestPathname(r) === `/v1/documents/${SEEDED_DOCUMENT_ID}/uploads`,
    );
    assert.equal(
      uploadPostRequests.length,
      2,
      "--allow-duplicate on both invocations must let both uploads reach the fixture",
    );
  } finally {
    await fixture.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
