/**
 * node:test suite: single-mint guard, cache reuse across processes, expiry
 * remint, client-id-mismatch remint, mint-then-validate-then-write ordering,
 * and invalid_scope handling (task 009b, coverage items 1, 2, 3, 5, 6).
 *
 * Every test runs the built CLI (dist/cli.js) as a child process against the
 * task 009a fixture server, in an isolated HOME/XDG_CONFIG_HOME, with
 * VANTA_ALLOW_UNSAFE_API_BASE_URL=1 and synthetic vci_/vcs_ credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { computeClientIdFingerprint } from "../dist/config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

const SYNTHETIC_CLIENT_ID = "vci_test_0001";
const SYNTHETIC_CLIENT_SECRET = "vcs_test_0001";
const OTHER_CLIENT_ID = "vci_test_old";

async function makeTempConfigHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-test-"));
}

/**
 * Isolated env for a spawned CLI process. Deliberately does not spread
 * process.env: only the values the CLI actually needs are ever passed
 * through, so nothing from the machine running the test can leak in.
 */
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

function configJsonPath(tempConfigHome) {
  return path.join(tempConfigHome, "vanta", "config.json");
}

async function readConfigJson(tempConfigHome) {
  const raw = await fs.readFile(configJsonPath(tempConfigHome), "utf8");
  return JSON.parse(raw);
}

async function configJsonExists(tempConfigHome) {
  return fs.access(configJsonPath(tempConfigHome)).then(
    () => true,
    () => false,
  );
}

async function writeConfigJsonDirect(tempConfigHome, contents) {
  await fs.mkdir(path.dirname(configJsonPath(tempConfigHome)), { recursive: true });
  await fs.writeFile(configJsonPath(tempConfigHome), JSON.stringify(contents));
}

test("single mint per process, and a fresh process reuses the cached token instead of minting again", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);

    // "tests" is the one fixture resource forced into multiple pages
    // (FORCED_CHUNK_SIZES.tests = 1 for 2 seeded rows), so --all here
    // genuinely makes more than one paginated resource request within a
    // single command invocation.
    const first = await runCli(["tests", "list", "--all", "--json"], env);
    assert.equal(first.code, 0, `first invocation should succeed: ${first.stdout} ${first.stderr}`);
    assert.equal(fixture.tokenMintCount, 1, "exactly one mint after the first invocation");

    const second = await runCli(["tests", "list", "--all", "--json"], env);
    assert.equal(second.code, 0, `second invocation should succeed: ${second.stdout} ${second.stderr}`);
    assert.equal(
      fixture.tokenMintCount,
      1,
      "a second, fresh process against the same config dir must reuse the cached token, not mint again",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("an already-expired cached token triggers exactly one remint and updates expiresAt into the future", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    const fingerprint = computeClientIdFingerprint(SYNTHETIC_CLIENT_ID);
    await writeConfigJsonDirect(tempConfigHome, {
      clientId: SYNTHETIC_CLIENT_ID,
      clientSecret: SYNTHETIC_CLIENT_SECRET,
      token: {
        accessToken: "stale-expired-token",
        expiresAt: Date.now() - 60_000,
        scopes: ["vanta-api.all:read"],
        clientIdFingerprint: fingerprint,
      },
    });

    const result = await runCli(["tests", "list", "--json"], env);
    assert.equal(result.code, 0, `expected success: ${result.stdout} ${result.stderr}`);
    assert.equal(fixture.tokenMintCount, 1, "exactly one remint for an expired cached token");

    const finalConfig = await readConfigJson(tempConfigHome);
    assert.ok(
      finalConfig.token.expiresAt > Date.now(),
      "the config file must be updated with a new expiresAt in the future",
    );
    assert.notEqual(
      finalConfig.token.accessToken,
      "stale-expired-token",
      "the expired access token must be replaced by the freshly minted one",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("a valid, unexpired token minted for a different client id is never reused", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    const otherFingerprint = computeClientIdFingerprint(OTHER_CLIENT_ID);
    await writeConfigJsonDirect(tempConfigHome, {
      clientId: SYNTHETIC_CLIENT_ID,
      clientSecret: SYNTHETIC_CLIENT_SECRET,
      token: {
        accessToken: "stale-token-for-a-different-client",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["vanta-api.all:read"],
        clientIdFingerprint: otherFingerprint,
      },
    });

    const result = await runCli(["tests", "list", "--json"], env);
    assert.equal(result.code, 0, `expected success: ${result.stdout} ${result.stderr}`);
    assert.equal(
      fixture.tokenMintCount,
      1,
      "a stale token fingerprinted to a different client id must not be reused; exactly one mint happens instead",
    );

    const finalConfig = await readConfigJson(tempConfigHome);
    assert.equal(finalConfig.token.clientIdFingerprint, computeClientIdFingerprint(SYNTHETIC_CLIENT_ID));
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("a 500 from the post-mint validation call fails the command and writes no config file at all", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    // ensureToken's own validation call is a GET to "frameworks"; force it
    // to fail once, after the mint has already happened.
    fixture.forceNextResponse("frameworks", { status: 500, body: { error: "boom" } });

    const result = await runCli(["tests", "list", "--json"], env);
    assert.notEqual(result.code, 0, "the command must fail when token validation fails");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "AUTH_INVALID");

    const exists = await configJsonExists(tempConfigHome);
    assert.equal(
      exists,
      false,
      "no config file, not even a partial one with the unvalidated token, must be written on a failed validation",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("an invalid_scope 400 from /oauth/token is reported as a VALIDATION failure, not an unhandled exception", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    fixture.forceNextResponse("oauth/token", { status: 400, body: { error: "invalid_scope" } });

    const result = await runCli(["tests", "list", "--json"], env);
    assert.notEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "VALIDATION");
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
