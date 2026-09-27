/**
 * node:test suite: the host allowlist is checked before the mint, not
 * just before the first read request (task 009b, coverage item 10).
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

/**
 * Deliberately does not set VANTA_ALLOW_UNSAFE_API_BASE_URL: these tests
 * are exactly the ones proving the allowlist rejects an unsafe host when
 * that gate is closed.
 */
function unsafeHostEnv(apiBaseUrl, tempConfigHome) {
  return {
    VANTA_CLIENT_ID: SYNTHETIC_CLIENT_ID,
    VANTA_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    VANTA_API_BASE_URL: apiBaseUrl,
    XDG_CONFIG_HOME: tempConfigHome,
    HOME: tempConfigHome,
    PATH: process.env.PATH || "",
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

const UNSAFE_HOST_CASES = [
  { label: "a non-Vanta host", apiBaseUrl: "https://evil.example.test" },
  {
    label: "a bare .vanta.com suffix host, deliberately outside the narrowed allowlist",
    apiBaseUrl: "https://evil.vanta.com",
  },
];

for (const testCase of UNSAFE_HOST_CASES) {
  test(`VANTA_API_BASE_URL pointed at ${testCase.label} fails VALIDATION before any request or mint, when the unsafe gate is closed`, async () => {
    // The fixture server itself is never contacted in this test (the
    // rejection must happen before any network call reaches it), but it
    // still needs to run so fixture.requests/tokenMintCount have
    // something authoritative to assert zero against.
    const fixture = await startFixtureServer();
    const tempConfigHome = await makeTempConfigHome();
    try {
      const env = unsafeHostEnv(testCase.apiBaseUrl, tempConfigHome);
      const result = await runCli(["tests", "list", "--json"], env);
      assert.notEqual(result.code, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, "VALIDATION");

      assert.equal(fixture.requests.length, 0, "no request of any kind must reach the (unrelated) fixture server");
      assert.equal(
        fixture.tokenMintCount,
        0,
        "the host check must run before the mint, not just before the first read request",
      );
    } finally {
      await fixture.close();
      await fs.rm(tempConfigHome, { recursive: true, force: true });
    }
  });
}
