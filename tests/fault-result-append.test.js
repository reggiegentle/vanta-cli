/**
 * node:test suite: the deterministic ledger result-append-failure path
 * (task 009f, spec.md R6/D10). Uses task 009a's chmodBeforeResponding
 * hook to make the ledger file read-only at the moment the fixture is
 * about to respond 2xx to the upload's own POST, strictly after this
 * process's intent line has already appended and strictly before its
 * result line would. Runs the built CLI (dist/cli.js) against
 * tests/helpers/fixture-server.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureServer } from "./helpers/fixture-server.js";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

async function makeTempHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-fault-result-append-"));
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

function requestPathname(request) {
  return new URL(request.path, "http://fixture.local").pathname;
}

async function waitUntil(predicate, timeoutMs, pollMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

test("ledger result-append failure after a successful upload exits CHECK_FAILED and leaves an orphaned intent", async () => {
  const fixture = await startFixtureServer();
  const homeDir = await makeTempHome();
  const ledgerPath = ledgerFilePath(homeDir);
  try {
    const env = fixtureEnv(fixture, homeDir);
    const filesDir = path.join(homeDir, "files");
    await fs.mkdir(filesDir, { recursive: true });
    const filePath = path.join(filesDir, "evidence.txt");
    await fs.writeFile(filePath, "result append failure fixture content\n");

    // Delay the upload's preRead GET response so this test has a
    // deterministic window to register chmodBeforeResponding for the
    // very next request to the same path (the upload's own POST), only
    // after confirming the preRead GET (and therefore this process's
    // intent-line append, which always happens before the POST is ever
    // sent) has already reached the fixture.
    fixture.delayNextResponse("documents/doc-1/uploads", 200);

    const args = [
      "documents",
      "upload",
      filePath,
      "--document-id",
      "doc-1",
      "--write",
      "--confirm",
      "doc-1",
      "--json",
    ];
    const runPromise = runCli(args, env);

    const sawPreRead = await waitUntil(
      () =>
        fixture.requests.some(
          (r) => r.method === "GET" && requestPathname(r) === "/v1/documents/doc-1/uploads",
        ),
      5000,
    );
    assert.ok(sawPreRead, "expected the upload's preRead GET to reach the fixture before the delay elapsed");

    fixture.chmodBeforeResponding("documents/doc-1/uploads", { targetPath: ledgerPath, mode: 0o400 });

    const result = await runPromise;
    console.log(`fault-result-append: process exited ${result.code}, stdout = ${result.stdout.trim()}`);

    const output = parseJsonOutput(result);
    assert.equal(result.code, 1, "expected exit code 1");
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "CHECK_FAILED");

    assert.ok(Array.isArray(output.error.detail?.resultIds), "expected error.detail.resultIds to be an array");
    assert.equal(output.error.detail.resultIds.length, 1, "expected exactly one returned id printed");
    assert.equal(typeof output.error.detail.resultIds[0], "string");

    const handWrittenMatch = /Append this line to the ledger by hand: (\{.*\})$/.exec(output.error.message);
    assert.ok(handWrittenMatch, `expected a literal JSON line in the error message, got: ${output.error.message}`);
    const handWrittenLine = JSON.parse(handWrittenMatch[1]);
    assert.equal(handWrittenLine.phase, "result");
    assert.equal(handWrittenLine.command, "documents upload");
    assert.equal(handWrittenLine.targetType, "document");
    assert.equal(handWrittenLine.targetId, "doc-1");
    assert.equal(handWrittenLine.readbackVerified, true);
    assert.deepEqual(handWrittenLine.resultIds, output.error.detail.resultIds);
    assert.equal(typeof handWrittenLine.opId, "string");
    assert.ok(handWrittenLine.opId.length > 0);

    const opIdMatch = /write call for opId (\S+) succeeded/.exec(output.error.message);
    assert.ok(opIdMatch, `expected the message to name the opId, got: ${output.error.message}`);
    assert.equal(handWrittenLine.opId, opIdMatch[1]);

    const rawLedger = await fs.readFile(ledgerPath, "utf8");
    console.log(`fault-result-append: ledger contents after the test = ${JSON.stringify(rawLedger)}`);
    const ledgerLines = rawLedger
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const intentLine = ledgerLines.find((line) => line.phase === "intent" && line.opId === handWrittenLine.opId);
    assert.ok(intentLine, "expected the intent line for this opId to be present in the ledger");
    assert.equal(intentLine.command, "documents upload");
    assert.equal(intentLine.targetId, "doc-1");

    const resultLine = ledgerLines.find((line) => line.phase === "result" && line.opId === handWrittenLine.opId);
    assert.equal(
      resultLine,
      undefined,
      "expected no matching result line for this opId, proving the failure landed on the result append, not the intent append",
    );
  } finally {
    await fs.chmod(ledgerPath, 0o600).catch(() => {});
    await fixture.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
