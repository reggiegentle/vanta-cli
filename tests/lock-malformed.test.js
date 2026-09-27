/**
 * Coverage item (e): a malformed (zero-byte) config.lock waits through the
 * round-6 malformed grace window (noticeably longer than the immediate
 * dead-owner case, noticeably shorter than the full live-holder wait) and
 * then exits LOCKED; 'vanta auth unlock' clears it and the retry succeeds.
 * Uses task 009a's fixture server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { startFixtureServer } from "./helpers/fixture-server.js";

const dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CLI_PATH = path.join(dirname, "..", "dist", "cli.js");

function fixtureEnv(serverUrl, tempConfigHome, overrides = {}) {
  return {
    VANTA_CLIENT_ID: "vci_test_0001",
    VANTA_CLIENT_SECRET: "vcs_test_0001",
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
    child.on("close", (code) => resolve({ code, stdout, stderr, pid: child.pid }));
  });
}

test("a malformed config.lock waits through the grace window, exits LOCKED, and auth unlock clears it", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "vanta-lock-malformed-"));
  try {
    const vantaDir = path.join(tempConfigHome, "vanta");
    await fs.mkdir(vantaDir, { recursive: true });
    const lockPath = path.join(vantaDir, "config.lock");
    await fs.writeFile(lockPath, ""); // zero-byte, unparseable lock record

    // Generous relative to the roughly 2-second malformed grace window,
    // so a pass here is attributable to the grace window closing, not to
    // the wait deadline being reached.
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome, { VANTA_LOCK_WAIT_MS: "10000" });

    const start = Date.now();
    const result = await runCli(["doctor", "--json"], env);
    const elapsedMs = Date.now() - start;

    assert.equal(result.code, 1, result.stdout + result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "LOCKED");
    assert.match(parsed.error.message, /malformed lock/);
    assert.match(parsed.error.message, /pgrep -f vanta/);
    assert.match(parsed.error.message, /vanta auth unlock/);
    assert.ok(
      elapsedMs >= 1500,
      `expected the ~2s malformed grace window to have run, took only ${elapsedMs}ms`,
    );
    assert.ok(
      elapsedMs < 8000,
      `expected well under the full 10000ms wait deadline, took ${elapsedMs}ms`,
    );
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.tokenMintCount, 0);

    const unlockResult = await runCli(["auth", "unlock", "--json"], env);
    assert.equal(unlockResult.code, 0, unlockResult.stdout + unlockResult.stderr);
    const unlockParsed = JSON.parse(unlockResult.stdout);
    assert.equal(unlockParsed.ok, true);
    const configLockResult = unlockParsed.data.results.find((r) => r.lock === "config.lock");
    assert.ok(configLockResult, "expected a config.lock entry in the unlock results");
    assert.equal(configLockResult.cleared, true);
    assert.equal(configLockResult.malformed, true);
    await assert.rejects(fs.access(lockPath));

    const retryResult = await runCli(["doctor", "--json"], env);
    assert.equal(retryResult.code, 0, retryResult.stdout + retryResult.stderr);
    const retryParsed = JSON.parse(retryResult.stdout);
    assert.equal(retryParsed.ok, true);
    assert.equal(fixture.tokenMintCount, 1);
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
