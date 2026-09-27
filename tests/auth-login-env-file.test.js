/**
 * node:test suite: `auth login --env-file` credential threading, output
 * shape, and the persist-on-cache-hit path under config.lock
 * (task 009b, coverage items 12, 14).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { computeClientIdFingerprint } from "../dist/config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

const CLIENT_X_ID = "vci_test_X";
const CLIENT_X_SECRET = "vcs_test_X";
const CLIENT_Y_ID = "vci_test_Y";
const CLIENT_Y_SECRET = "vcs_test_Y";
const CLIENT_Y_WRONG_SECRET = "vcs_test_wrong";

async function makeTempConfigHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-test-"));
}

/**
 * No VANTA_CLIENT_ID/SECRET or VANTA_OAUTH_CLIENT_ID/SECRET at all: every
 * test in this file supplies credentials only through --env-file or the
 * saved config, never through env vars, so resolveCredentials' env-var
 * precedence step never masks the env file it is meant to be exercising.
 */
function envFileTestEnv(serverUrl, tempConfigHome, overrides = {}) {
  return {
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

async function writeConfigJsonDirect(tempConfigHome, contents) {
  await fs.mkdir(path.dirname(configJsonPath(tempConfigHome)), { recursive: true });
  await fs.writeFile(configJsonPath(tempConfigHome), JSON.stringify(contents));
}

async function readConfigJsonDirect(tempConfigHome) {
  const raw = await fs.readFile(configJsonPath(tempConfigHome), "utf8");
  return JSON.parse(raw);
}

async function writeEnvFile(tempConfigHome, clientId, clientSecret) {
  const envFilePath = path.join(tempConfigHome, "credentials.env");
  await fs.writeFile(envFilePath, `VANTA_CLIENT_ID=${clientId}\nVANTA_CLIENT_SECRET=${clientSecret}\n`);
  return envFilePath;
}

test("auth login --env-file mints with the env file's credentials, not the saved config's, and never leaks either client id, secret, or the full fingerprint", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    await writeConfigJsonDirect(tempConfigHome, { clientId: CLIENT_X_ID, clientSecret: CLIENT_X_SECRET });
    const envFilePath = await writeEnvFile(tempConfigHome, CLIENT_Y_ID, CLIENT_Y_SECRET);

    const env = envFileTestEnv(fixture.apiBaseUrl, tempConfigHome);
    const result = await runCli(["auth", "login", "--env-file", envFilePath, "--json"], env);
    assert.equal(result.code, 0, `expected success: ${result.stdout} ${result.stderr}`);

    const tokenRequests = fixture.requests.filter((r) => r.path === "/oauth/token");
    assert.equal(tokenRequests.length, 1);
    assert.equal(
      tokenRequests[0].body.client_id,
      CLIENT_Y_ID,
      "the single /oauth/token request must use client Y's id, not client X's",
    );

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    const data = parsed.data;
    const expectedFingerprint8 = computeClientIdFingerprint(CLIENT_Y_ID).slice(0, 8);
    assert.equal(data.clientIdFingerprint8, expectedFingerprint8);
    assert.equal(data.tokenSource, "minted");
    assert.ok(typeof data.expiresAt === "number");
    assert.ok(Array.isArray(data.scopes));
    assert.equal(typeof data.configPath, "string");

    assert.deepEqual(
      Object.keys(data).sort(),
      ["clientIdFingerprint8", "configPath", "expiresAt", "scopes", "tokenSource"].sort(),
      "the login result must carry exactly these fields at the top level of data, nothing else",
    );

    const serialized = JSON.stringify(parsed);
    assert.equal(serialized.includes(CLIENT_X_ID), false, "client X's id must never appear in output");
    assert.equal(serialized.includes(CLIENT_Y_ID), false, "client Y's id must never appear in output");
    assert.equal(serialized.includes(CLIENT_X_SECRET), false, "client X's secret must never appear in output");
    assert.equal(serialized.includes(CLIENT_Y_SECRET), false, "client Y's secret must never appear in output");

    const finalConfig = await readConfigJsonDirect(tempConfigHome);
    assert.equal(finalConfig.clientId, CLIENT_Y_ID);
    assert.equal(finalConfig.clientSecret, CLIENT_Y_SECRET);
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("auth login --env-file with a valid cache hit persists the env file's correct secret over a stale config value, without minting", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const fingerprintY = computeClientIdFingerprint(CLIENT_Y_ID);
    await writeConfigJsonDirect(tempConfigHome, {
      clientId: CLIENT_Y_ID,
      clientSecret: CLIENT_Y_WRONG_SECRET,
      token: {
        accessToken: "cached-token-for-client-y",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["vanta-api.all:read"],
        clientIdFingerprint: fingerprintY,
      },
    });
    const envFilePath = await writeEnvFile(tempConfigHome, CLIENT_Y_ID, CLIENT_Y_SECRET);
    const env = envFileTestEnv(fixture.apiBaseUrl, tempConfigHome);

    const result = await runCli(["auth", "login", "--env-file", envFilePath, "--json"], env);
    assert.equal(result.code, 0, `expected success: ${result.stdout} ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.data.tokenSource, "cached");
    assert.equal(fixture.tokenMintCount, 0, "the cache hit must be reused; no new /oauth/token request");
    assert.equal(fixture.requests.filter((r) => r.path === "/oauth/token").length, 0);

    const finalConfig = await readConfigJsonDirect(tempConfigHome);
    assert.equal(
      finalConfig.clientSecret,
      CLIENT_Y_SECRET,
      "the wrong stored secret must be overwritten with the env file's correct one, even though no mint happened",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("auth login --env-file exits 1 LOCKED and leaves config.json untouched when config.lock is held by a live process", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const fingerprintY = computeClientIdFingerprint(CLIENT_Y_ID);
    await writeConfigJsonDirect(tempConfigHome, {
      clientId: CLIENT_Y_ID,
      clientSecret: CLIENT_Y_WRONG_SECRET,
      token: {
        accessToken: "cached-token-for-client-y",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["vanta-api.all:read"],
        clientIdFingerprint: fingerprintY,
      },
    });
    const envFilePath = await writeEnvFile(tempConfigHome, CLIENT_Y_ID, CLIENT_Y_SECRET);

    const lockPath = path.join(tempConfigHome, "vanta", "config.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        nonce: crypto.randomBytes(16).toString("hex"),
        acquiredAt: new Date().toISOString(),
        command: "auth login --env-file (hand-planted, live pid, for this test)",
      }),
    );

    // VANTA_LOCK_WAIT_MS is only honored when the unsafe gate is open,
    // which envFileTestEnv already sets; this just keeps the test fast
    // instead of waiting the real 30s default deadline.
    const env = envFileTestEnv(fixture.apiBaseUrl, tempConfigHome, { VANTA_LOCK_WAIT_MS: "300" });

    const result = await runCli(["auth", "login", "--env-file", envFilePath, "--json"], env);
    assert.equal(result.code, 1, `expected exit code 1: ${result.stdout} ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "LOCKED");

    const finalConfig = await readConfigJsonDirect(tempConfigHome);
    assert.equal(
      finalConfig.clientSecret,
      CLIENT_Y_WRONG_SECRET,
      "the persist-on-cache-hit write happens under config.lock; a held lock must block it entirely, " +
        "proving it is not a separate, unguarded step after ensureToken returns",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
