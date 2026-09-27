/**
 * node:test suite: malformed ledger line fails closed (task 009f, spec.md
 * D10). A hand-written ledger file whose second line is not valid JSON
 * must fail every ledger-reading command with VALIDATION naming line 2,
 * both for `ledger list` and for `documents upload`'s duplicate-check
 * step. Runs the built CLI (dist/cli.js) against tests/helpers/fixture-
 * server.js.
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
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-fault-malformed-"));
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

async function writeCorruptedLedger(homeDir, malformedLine) {
  const ledgerPath = ledgerFilePath(homeDir);
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const validIntentLine = JSON.stringify({
    opId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    phase: "intent",
    ts: new Date().toISOString(),
    command: "documents upload",
    targetType: "document",
    targetId: "doc-1",
    fileName: "evidence.txt",
    sha256: "a".repeat(64),
    bytes: 10,
  });
  await fs.writeFile(ledgerPath, `${validIntentLine}\n${malformedLine}\n`);
  return ledgerPath;
}

test("ledger list --json fails VALIDATION naming the malformed line number", async () => {
  const fixture = await startFixtureServer();
  const homeDir = await makeTempHome();
  try {
    const env = fixtureEnv(fixture, homeDir);
    await writeCorruptedLedger(homeDir, "{ this line is not valid json");

    const result = await runCli(["ledger", "list", "--json"], env);
    console.log(`fault-malformed-ledger (ledger list): exited ${result.code}, stdout = ${result.stdout.trim()}`);

    assert.equal(result.code, 1);
    const output = parseJsonOutput(result);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "VALIDATION");
    assert.match(output.error.message, /line 2/);
  } finally {
    await fixture.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("documents upload's duplicate check fails VALIDATION naming the malformed line number against the same corrupted ledger", async () => {
  const fixture = await startFixtureServer();
  const homeDir = await makeTempHome();
  try {
    const env = fixtureEnv(fixture, homeDir);
    await writeCorruptedLedger(homeDir, "not json at all");

    const filesDir = path.join(homeDir, "files");
    await fs.mkdir(filesDir, { recursive: true });
    const filePath = path.join(filesDir, "evidence.txt");
    await fs.writeFile(filePath, "duplicate-check probe content against a corrupted ledger\n");

    const result = await runCli(
      ["documents", "upload", filePath, "--document-id", "doc-1", "--json"],
      env,
    );
    console.log(`fault-malformed-ledger (documents upload): exited ${result.code}, stdout = ${result.stdout.trim()}`);

    assert.equal(result.code, 1);
    const output = parseJsonOutput(result);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "VALIDATION");
    assert.match(output.error.message, /line 2/);

    const postRequests = fixture.requests.filter((r) => r.method === "POST");
    assert.equal(
      postRequests.length,
      0,
      "the malformed ledger must fail the duplicate check before any network request is ever made",
    );
  } finally {
    await fixture.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
