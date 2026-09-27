/**
 * node:test suite: `auth login --force-mint` mints exactly once through
 * ensureToken itself, bypassing a valid cache, with no second mint code
 * path (task 009b, coverage item 16).
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

function configJsonPath(tempConfigHome) {
  return path.join(tempConfigHome, "vanta", "config.json");
}

async function writeConfigJsonDirect(tempConfigHome, contents) {
  await fs.mkdir(path.dirname(configJsonPath(tempConfigHome)), { recursive: true });
  await fs.writeFile(configJsonPath(tempConfigHome), JSON.stringify(contents));
}

test("auth login --force-mint bypasses a valid cache, mints exactly once, and warns on stderr about revoking the active token", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const fingerprint = computeClientIdFingerprint(SYNTHETIC_CLIENT_ID);
    await writeConfigJsonDirect(tempConfigHome, {
      clientId: SYNTHETIC_CLIENT_ID,
      clientSecret: SYNTHETIC_CLIENT_SECRET,
      token: {
        accessToken: "already-valid-cached-token",
        expiresAt: Date.now() + 3_600_000,
        scopes: ["vanta-api.all:read"],
        clientIdFingerprint: fingerprint,
      },
    });

    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);
    const result = await runCli(["auth", "login", "--force-mint", "--json"], env);
    assert.equal(result.code, 0, `expected success: ${result.stdout} ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(
      parsed.data.tokenSource,
      "minted",
      "an ordinary login would be a pure cache hit; --force-mint must bypass that cache",
    );

    assert.equal(fixture.tokenMintCount, 1, "exactly one mint, proving the cache was bypassed and not reused");
    const tokenRequests = fixture.requests.filter((r) => r.path === "/oauth/token");
    assert.equal(
      tokenRequests.length,
      1,
      "exactly one /oauth/token request for this invocation, never a second, separate mint call",
    );

    assert.match(
      result.stderr,
      /revok(e|ing)/i,
      "a warning about revoking the tenant's currently active token must be written to stderr",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
