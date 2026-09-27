/**
 * node:test suite: retry/limiter-slot accounting on 429 responses
 * (task 009b, coverage item 8).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers/fixture-server.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

const SYNTHETIC_CLIENT_ID = "vci_test_0001";
const SYNTHETIC_CLIENT_SECRET = "vcs_test_0001";

async function makeTempConfigHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-test-"));
}

function fixtureEnv(serverUrl, tempConfigHome, overrides = {}) {
  return {
    VANTA_CLIENT_ID: SYNTHETIC_CLIENT_ID,
    VANTA_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    VANTA_API_BASE_URL: serverUrl,
    VANTA_ALLOW_UNSAFE_API_BASE_URL: "1",
    XDG_CONFIG_HOME: tempConfigHome,
    HOME: tempConfigHome,
    PATH: process.env.PATH || "",
    ...overrides,
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

// "policies" is used here, rather than "frameworks" or "tests": it is a
// single-fixture-page resource untouched by ensureToken's own validation
// call (which hits "frameworks"), so the forced 429 queue on this path is
// consumed only by the command under test, keeping the request count exact.

test("two 429s (with Retry-After) followed by a 200 succeed, with exactly three requests recorded for that path", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    fixture.forceNextResponse(
      "policies",
      { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "0" } },
      2,
    );

    const result = await runCli(["policies", "list", "--json"], env);
    assert.equal(result.code, 0, `expected eventual success: ${result.stdout} ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);

    const policiesRequests = fixture.requests.filter((r) => r.path.startsWith("/v1/policies"));
    assert.equal(
      policiesRequests.length,
      3,
      "every attempt, including retries, consumes one throttle slot: two failed attempts plus one success",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("four consecutive 429s exhaust all retries and the command reports RATE_LIMITED", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    fixture.forceNextResponse(
      "policies",
      { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "0" } },
      4,
    );

    const result = await runCli(["policies", "list", "--json"], env);
    assert.notEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "RATE_LIMITED");
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
