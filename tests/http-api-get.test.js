/**
 * node:test suite: `api get` requires --unsafe-raw, and both accepted
 * path forms normalize to the identical request (task 009b, coverage
 * item 9).
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

test("api get without --unsafe-raw fails VALIDATION and makes zero requests", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    const result = await runCli(["api", "get", "frameworks", "--json"], env);
    assert.notEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "VALIDATION");
    assert.equal(fixture.requests.length, 0, "no request at all without --unsafe-raw");
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("api get --unsafe-raw succeeds against a seeded route, and both accepted path forms produce the identical recorded request path", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);

    const withLeadingSlashAndV1 = await runCli(["api", "get", "/v1/frameworks", "--unsafe-raw", "--json"], env);
    assert.equal(
      withLeadingSlashAndV1.code,
      0,
      `expected success: ${withLeadingSlashAndV1.stdout} ${withLeadingSlashAndV1.stderr}`,
    );

    const bareForm = await runCli(["api", "get", "frameworks", "--unsafe-raw", "--json"], env);
    assert.equal(bareForm.code, 0, `expected success: ${bareForm.stdout} ${bareForm.stderr}`);

    // The very first "/v1/frameworks" request is ensureToken's own
    // validation call; the two this test cares about are the ones made
    // by the two "api get" invocations above.
    const apiGetRequests = fixture.requests.filter((r) => r.path === "/v1/frameworks");
    assert.equal(apiGetRequests.length, 2, "both api get invocations must have reached the fixture server");
    assert.equal(
      apiGetRequests[0].path,
      apiGetRequests[1].path,
      "'api get /v1/frameworks --unsafe-raw' and 'api get frameworks --unsafe-raw' must normalize to the same request",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
