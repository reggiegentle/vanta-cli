/**
 * Coverage item (a): the two-process token-mint race. Exactly one mint
 * happens, proven with the request genuinely in flight, not just
 * eventually: the fixture server's delayNextResponse holds the winning
 * process's mint open, and the losing process is given a
 * VANTA_LOCK_WAIT_MS shorter than the mint delay, so it must exhaust its
 * wait and exit LOCKED, naming the winner's pid, before the mint ever
 * completes. Uses task 009a's fixture server.
 *
 * Determinism note: the two child processes are spawned with no await
 * between the spawn() calls, so which one wins the exclusive creation of
 * config.lock is not controlled by this test; both processes are given
 * the same short VANTA_LOCK_WAIT_MS (shorter than the mint delay), and
 * the test identifies the winner and loser from their own exit codes
 * after both have finished, then asserts against whichever process
 * turned out to be which. The ordering that is deterministic, and that
 * this test actually depends on, is the delay (a few hundred ms) being
 * comfortably longer than the wait (well under that), not which specific
 * process happens to win the underlying file-system race.
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

const MINT_DELAY_MS = 400;
const LOSER_WAIT_MS = 150;

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

test("exactly one of two concurrently spawned processes mints, with the mint genuinely in flight for the whole exclusion window", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "vanta-lock-race-"));
  try {
    // Only one /oauth/token request should ever land (the loser must
    // never reach the mint at all), so a single queued delay is enough:
    // it applies to whichever process's mint request is the one that
    // actually happens.
    fixture.delayNextResponse("/oauth/token", MINT_DELAY_MS);

    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome, {
      VANTA_LOCK_WAIT_MS: String(LOSER_WAIT_MS),
    });

    // No await between these two spawns: both processes race for the
    // same, empty tempConfigHome's config.lock.
    const first = runCli(["doctor", "--json"], env);
    const second = runCli(["doctor", "--json"], env);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const results = [firstResult, secondResult];
    const winner = results.find((r) => r.code === 0);
    const loser = results.find((r) => r.code !== 0);

    assert.ok(
      winner,
      `expected exactly one process to succeed; got codes ${results.map((r) => r.code).join(", ")}` +
        ` stdout: ${results.map((r) => r.stdout).join(" | ")}`,
    );
    assert.ok(loser, "expected exactly one process to fail");

    const loserParsed = JSON.parse(loser.stdout);
    assert.equal(loserParsed.ok, false);
    assert.equal(loser.code, 1, loser.stdout + loser.stderr);
    assert.equal(loserParsed.error.code, "LOCKED");
    assert.match(
      loserParsed.error.message,
      new RegExp(`another vanta process \\(pid ${winner.pid}`),
      `expected the loser's LOCKED message to name the winner's pid ${winner.pid}; got: ${loserParsed.error.message}`,
    );

    assert.equal(fixture.tokenMintCount, 1);
    const tokenRequests = fixture.requests.filter((r) => r.path.startsWith("/oauth/token"));
    assert.equal(tokenRequests.length, 1, "the loser must never have made its own mint request");
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
