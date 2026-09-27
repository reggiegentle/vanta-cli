/**
 * node:test suite: credential completeness (a partial or absent pair mints
 * nothing) and clientIdFingerprint8 exposure in auth status / doctor
 * (task 009b, coverage items 13, 15).
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

/**
 * A base env carrying no credential env vars at all (no VANTA_CLIENT_ID/
 * SECRET, no VANTA_OAUTH_CLIENT_ID/SECRET), so resolveCredentials falls
 * through past env vars entirely. Individual tests layer specific
 * credential env vars on top via overrides.
 */
function credentiallessEnv(serverUrl, tempConfigHome, overrides = {}) {
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

const CREDENTIAL_COMPLETENESS_CASES = [
  { label: "no credential env vars at all and no config file", overrides: {} },
  { label: "VANTA_CLIENT_ID set, VANTA_CLIENT_SECRET unset", overrides: { VANTA_CLIENT_ID: SYNTHETIC_CLIENT_ID } },
  {
    label: "VANTA_CLIENT_SECRET set, VANTA_CLIENT_ID unset",
    overrides: { VANTA_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET },
  },
  {
    label: "both VANTA_CLIENT_ID and VANTA_CLIENT_SECRET set to the empty string",
    overrides: { VANTA_CLIENT_ID: "", VANTA_CLIENT_SECRET: "" },
  },
];

for (const testCase of CREDENTIAL_COMPLETENESS_CASES) {
  test(`doctor exits 2 AUTH_MISSING before any network call when ${testCase.label}`, async () => {
    const fixture = await startFixtureServer();
    const tempConfigHome = await makeTempConfigHome();
    try {
      const env = credentiallessEnv(fixture.apiBaseUrl, tempConfigHome, testCase.overrides);
      const result = await runCli(["doctor", "--json"], env);
      assert.equal(result.code, 2, `expected exit code 2: ${result.stdout} ${result.stderr}`);

      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, "AUTH_MISSING");

      assert.equal(fixture.requests.length, 0, "no HTTP request of any kind should have been made");
      assert.equal(fixture.tokenMintCount, 0, "no token should have been minted");
    } finally {
      await fixture.close();
      await fs.rm(tempConfigHome, { recursive: true, force: true });
    }
  });
}

test("auth status and doctor expose clientIdFingerprint8 as exactly 8 hex chars, never the client id, secret, or full 16-char fingerprint", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = credentiallessEnv(fixture.apiBaseUrl, tempConfigHome, {
      VANTA_CLIENT_ID: SYNTHETIC_CLIENT_ID,
      VANTA_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    });

    const fullFingerprint = computeClientIdFingerprint(SYNTHETIC_CLIENT_ID);
    const expectedFingerprint8 = fullFingerprint.slice(0, 8);

    for (const args of [["auth", "status", "--json"], ["doctor", "--json"]]) {
      const result = await runCli(args, env);
      assert.equal(result.code, 0, `expected success for ${args.join(" ")}: ${result.stdout} ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);

      const fingerprint8 = parsed.data.clientIdFingerprint8;
      assert.match(fingerprint8, /^[0-9a-f]{8}$/, "clientIdFingerprint8 must be exactly 8 hex characters");
      assert.equal(fingerprint8, expectedFingerprint8);

      const serialized = JSON.stringify(parsed);
      assert.equal(serialized.includes(SYNTHETIC_CLIENT_ID), false, "the client id must never appear in output");
      assert.equal(
        serialized.includes(SYNTHETIC_CLIENT_SECRET),
        false,
        "the client secret must never appear in output",
      );
      assert.equal(
        serialized.includes(fullFingerprint),
        false,
        "the full 16-character fingerprint must never appear in output",
      );
    }
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});

test("auth status reports clientIdFingerprint8 as null when no credentials are configured", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = credentiallessEnv(fixture.apiBaseUrl, tempConfigHome);
    const result = await runCli(["auth", "status", "--json"], env);
    assert.equal(result.code, 0, `expected success: ${result.stdout} ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.clientIdFingerprint8, null);
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
