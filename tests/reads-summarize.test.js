/**
 * node:test suite: default summarization hides raw upstream ids, --raw
 * reveals them, and every enum-shaped read flag validates before any
 * network call (task 009c, spec.md R3/R10). Runs the built CLI
 * (dist/cli.js) against tests/helpers/fixture-server.js.
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
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-reads-"));
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

function parseOkData(result) {
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, true, `expected ok:true, got ${result.stdout}`);
  return parsed.data;
}

function parseFailure(result) {
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, false, `expected ok:false, got ${result.stdout}`);
  return parsed.error;
}

async function withFixtureAndHome(run) {
  const fixture = await startFixtureServer();
  const homeDir = await makeTempHome();
  try {
    await run(fixture, fixtureEnv(fixture, homeDir));
  } finally {
    await fixture.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

// --- Item 1: summarization omits raw ids without --raw, --raw reveals them --

const SUMMARIZED_LIST_CASES = [
  { command: ["frameworks", "list"], rawIds: ["framework-soc2"] },
  { command: ["controls", "list"], rawIds: ["control-001", "control-002"] },
  { command: ["documents", "list"], rawIds: ["document-001", "document-002"] },
];

for (const { command, rawIds } of SUMMARIZED_LIST_CASES) {
  test(`${command.join(" ")} --json hides raw ids by default`, async () => {
    await withFixtureAndHome(async (_fixture, env) => {
      const result = await runCli([...command, "--json"], env);
      const rows = parseOkData(result);
      assert.ok(Array.isArray(rows), "expected an array of summarized rows");
      assert.ok(rows.length > 0, "expected at least one row");
      for (const row of rows) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(row, "id"),
          false,
          `summarized row unexpectedly carries a top-level "id": ${JSON.stringify(row)}`,
        );
      }
    });
  });

  test(`${command.join(" ")} --raw --json reveals the raw upstream ids`, async () => {
    await withFixtureAndHome(async (_fixture, env) => {
      const result = await runCli([...command, "--raw", "--json"], env);
      const rows = parseOkData(result);
      assert.ok(Array.isArray(rows), "expected an array of raw rows");
      const seenIds = rows.map((row) => row.id);
      for (const expectedId of rawIds) {
        assert.ok(
          seenIds.includes(expectedId),
          `expected raw output to include id "${expectedId}", got ${JSON.stringify(seenIds)}`,
        );
      }
    });
  });
}

// --- Bonus: every enum-shaped read flag validates before any network call --

test("tests list --status with an invalid value fails VALIDATION before any request reaches the fixture", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    const result = await runCli(["tests", "list", "--status", "NOT_A_REAL_STATUS", "--json"], env);
    const error = parseFailure(result);
    assert.equal(error.code, "VALIDATION");
    assert.match(error.message, /--status/);
    assert.equal(fixture.requests.length, 0, "expected zero requests to reach the fixture server");
    assert.equal(fixture.tokenMintCount, 0, "expected no token to be minted before validation ran");
  });
});

test("documents list --status with an invalid value fails VALIDATION before any request reaches the fixture", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    const result = await runCli(["documents", "list", "--status", "NOT_A_REAL_STATUS", "--json"], env);
    const error = parseFailure(result);
    assert.equal(error.code, "VALIDATION");
    assert.match(error.message, /--status/);
    assert.equal(fixture.requests.length, 0, "expected zero requests to reach the fixture server");
  });
});
