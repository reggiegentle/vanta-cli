/**
 * node:test suite: `--all` crosses every fixture page while a smaller
 * `--limit` stops early, and the request path join is correct
 * (task 009b, coverage item 7).
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

test("--all walks every fixture page while a smaller --limit stops early, for the resource seeded with two pages", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);

    const limited = await runCli(["tests", "list", "--limit", "1", "--json"], env);
    assert.equal(limited.code, 0, `expected success: ${limited.stdout} ${limited.stderr}`);
    const limitedRows = JSON.parse(limited.stdout).data;
    assert.equal(limitedRows.length, 1, "a --limit smaller than the full row count returns fewer rows");

    const all = await runCli(["tests", "list", "--all", "--json"], env);
    assert.equal(all.code, 0, `expected success: ${all.stdout} ${all.stderr}`);
    const allRows = JSON.parse(all.stdout).data;
    assert.equal(allRows.length, 2, "--all must cross both fixture pages and return rows from each");
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("a plain frameworks list request's path is exactly /v1/frameworks, with the full pageSize query string and no dropped segment", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    const result = await runCli(["frameworks", "list", "--json"], env);
    assert.equal(result.code, 0, `expected success: ${result.stdout} ${result.stderr}`);

    // The very first request to "/v1/frameworks" is ensureToken's own
    // validation call (GET /v1/frameworks?pageSize=1); the request this
    // test is actually about is the second one, made by the "frameworks
    // list" command itself.
    const frameworksRequests = fixture.requests.filter((r) => r.path.startsWith("/v1/frameworks"));
    assert.equal(frameworksRequests.length, 2);
    assert.equal(frameworksRequests[0].path, "/v1/frameworks?pageSize=1");
    assert.equal(
      frameworksRequests[1].path,
      "/v1/frameworks?pageSize=100",
      "the join between apiBaseUrl and the resource path must produce exactly /v1/frameworks, " +
        "never a dropped or malformed apiBaseUrl path segment",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
