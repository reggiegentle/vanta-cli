/**
 * node:test suite: `controls list` plain vs. `--with-status` (task 009c
 * item 2, spec.md R3/D5/D7). Verifies the base list never carries
 * `status`, the detail-fetch path merges it in with exactly one
 * `GET controls/{controlId}` per control, a per-control detail failure is
 * recorded in `completeness` without failing the whole command, and a
 * missing `--framework` fails VALIDATION once the fixture tenant carries
 * more than one framework.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureServer } from "./helpers/fixture-server.js";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
const SOC2_FRAMEWORK_ID = "framework-soc2";

async function makeTempHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-reads-status-"));
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

// Requires the "/v1" prefix: fixture.requests[].path always carries it,
// matching production's own https://api.vanta.com/v1 base.
function controlDetailGetPaths(fixture) {
  return fixture.requests.filter(
    (r) => r.method === "GET" && /^\/v1\/controls\/[^/?]+$/.test(r.path),
  );
}

function twoFrameworkPage() {
  return {
    status: 200,
    body: {
      results: {
        data: [
          { id: SOC2_FRAMEWORK_ID, displayName: "SOC 2 framework", shorthandName: "SOC 2" },
          { id: "framework-iso27001", displayName: "ISO 27001 framework", shorthandName: "ISO 27001" },
        ],
        pageInfo: { endCursor: null, hasNextPage: false, hasPreviousPage: false, startCursor: null },
      },
    },
  };
}

test("controls list --json (no --with-status) returns rows with no status key", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const result = await runCli(["controls", "list", "--json"], env);
    const rows = parseOkData(result);
    assert.ok(Array.isArray(rows) && rows.length > 0);
    for (const row of rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, "status"), false);
    }
  });
});

test("controls list --with-status --framework <id> --json merges status via one detail GET per control", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    const result = await runCli(
      ["controls", "list", "--with-status", "--framework", SOC2_FRAMEWORK_ID, "--json"],
      env,
    );
    const data = parseOkData(result);
    assert.ok(Array.isArray(data.rows) && data.rows.length === 2);
    for (const row of data.rows) {
      assert.equal(typeof row.status, "string");
    }
    assert.deepEqual(
      data.completeness,
      { controlDetailTotal: 2, controlDetailFetched: 2, complete: true, errors: [] },
    );

    const detailGets = controlDetailGetPaths(fixture);
    assert.equal(detailGets.length, data.rows.length, "expected exactly one detail GET per control");
    const distinctPaths = new Set(detailGets.map((r) => r.path));
    assert.equal(distinctPaths.size, detailGets.length, "expected no duplicate per-control detail GET");
  });
});

test("controls list --with-status --json with no --framework fails VALIDATION when the tenant has more than one framework", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    fixture.forceNextResponse("frameworks", twoFrameworkPage(), 2);
    const result = await runCli(["controls", "list", "--with-status", "--json"], env);
    const error = parseFailure(result);
    assert.equal(error.code, "VALIDATION");
    assert.match(error.message, /--framework/);
  });
});

test("controls list --with-status records a per-control detail failure in completeness without failing the whole command", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    // 404 (NOT_FOUND) is not retryable, so this fails immediately instead
    // of walking the client's retry/backoff ladder.
    fixture.forceNextResponse("controls/control-002", { status: 404, body: { error: "not_found" } }, 1);
    const result = await runCli(
      ["controls", "list", "--with-status", "--framework", SOC2_FRAMEWORK_ID, "--json"],
      env,
    );
    const data = parseOkData(result);
    assert.equal(data.completeness.complete, false);
    assert.equal(data.completeness.controlDetailTotal, 2);
    assert.equal(data.completeness.controlDetailFetched, 1);
    assert.equal(data.completeness.errors.length, 1);
    assert.equal(data.completeness.errors[0].ref, "control-002");
    assert.equal(data.completeness.errors[0].code, "NOT_FOUND");

    const failedRow = data.rows[1];
    assert.equal(failedRow.status, null);
    assert.equal(failedRow.detailError, "NOT_FOUND");
    const okRow = data.rows[0];
    assert.equal(typeof okRow.status, "string");
  });
});
