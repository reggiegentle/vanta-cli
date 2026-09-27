/**
 * node:test suite: `documents controls <id>` and `controls documents <id>`
 * are never swapped (task 009c item 3, spec.md R3, round-1 findings 3/4).
 * `documents controls` returns Control-shaped rows (PaginatedResponse_Control_);
 * `controls documents` returns Document-shaped rows.
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
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-reads-shapes-"));
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

test("documents controls <id> --raw --json returns Control-shaped rows", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const result = await runCli(["documents", "controls", "document-001", "--raw", "--json"], env);
    const rows = parseOkData(result);
    assert.ok(Array.isArray(rows) && rows.length === 1);
    const [row] = rows;
    assert.equal(row.id, "control-001");
    assert.ok("domains" in row, "expected a Control-shaped row to carry domains");
    assert.ok("source" in row, "expected a Control-shaped row to carry source");
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, "uploadStatus"),
      false,
      "a Control-shaped row must never carry Document's uploadStatus",
    );
  });
});

test("controls documents <id> --raw --json returns Document-shaped rows", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const result = await runCli(["controls", "documents", "control-001", "--raw", "--json"], env);
    const rows = parseOkData(result);
    assert.ok(Array.isArray(rows) && rows.length === 1);
    const [row] = rows;
    assert.equal(row.id, "document-001");
    assert.ok("uploadStatus" in row, "expected a Document-shaped row to carry uploadStatus");
    assert.ok("category" in row, "expected a Document-shaped row to carry category");
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, "domains"),
      false,
      "a Document-shaped row must never carry Control's domains",
    );
  });
});
