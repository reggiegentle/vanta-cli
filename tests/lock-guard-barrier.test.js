/**
 * Coverage item (f), round-6/round-7: the locks.guard coordination that
 * keeps 'auth unlock' from ever deleting a lock created after its own
 * observation. This test process itself becomes the barrier, holding
 * locks.guard with its own live pid for exactly as long as the test
 * chooses, so every run is deterministic proof rather than a scheduler-
 * dependent sample. Uses task 009a's fixture server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
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

test("the guard blocks both auth unlock and ordinary acquisition from reaching a dead lock underneath it, then behaves correctly once released", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "vanta-lock-guard-"));
  try {
    const vantaDir = path.join(tempConfigHome, "vanta");
    await fs.mkdir(vantaDir, { recursive: true });
    const configLockPath = path.join(vantaDir, "config.lock");
    const guardPath = path.join(vantaDir, "locks.guard");
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome, { VANTA_LOCK_WAIT_MS: "500" });

    // Step 1: a dead-owner config.lock underneath the barrier.
    await fs.writeFile(
      configLockPath,
      JSON.stringify({
        pid: 999999,
        nonce: "1".repeat(32),
        acquiredAt: new Date().toISOString(),
        command: "doctor",
      }),
    );
    const configLockBytesBeforeBarrier = await fs.readFile(configLockPath, "utf8");

    // Step 2: this test's own live pid holds the guard for exactly as
    // long as the test chooses.
    await fs.writeFile(
      guardPath,
      JSON.stringify({
        pid: process.pid,
        nonce: crypto.randomBytes(16).toString("hex"),
        acquiredAt: new Date().toISOString(),
      }),
    );

    // Step 3: 'auth unlock' (no --force) blocks on the guard and never
    // reaches the dead lock underneath.
    const unlockDuringGuard = await runCli(["auth", "unlock", "--json"], env);
    assert.equal(unlockDuringGuard.code, 1, unlockDuringGuard.stdout + unlockDuringGuard.stderr);
    const unlockDuringGuardParsed = JSON.parse(unlockDuringGuard.stdout);
    assert.equal(unlockDuringGuardParsed.ok, false);
    assert.equal(unlockDuringGuardParsed.error.code, "LOCKED");
    assert.match(
      unlockDuringGuardParsed.error.message,
      new RegExp(`guard held by pid ${process.pid}`),
    );
    const configLockBytesAfterStep3 = await fs.readFile(configLockPath, "utf8");
    assert.equal(
      configLockBytesAfterStep3,
      configLockBytesBeforeBarrier,
      "the dead-owner config.lock must be byte-for-byte unchanged after step 3",
    );
    assert.equal(fixture.requests.length, 0, "step 3 must make zero Manage API requests");
    assert.equal(fixture.tokenMintCount, 0, "step 3 must mint zero tokens");

    // Step 4: an ordinary command that needs config.lock also blocks on
    // the guard, before it ever gets far enough to observe the dead lock.
    const doctorDuringGuard = await runCli(["doctor", "--json"], env);
    assert.equal(doctorDuringGuard.code, 1, doctorDuringGuard.stdout + doctorDuringGuard.stderr);
    const doctorDuringGuardParsed = JSON.parse(doctorDuringGuard.stdout);
    assert.equal(doctorDuringGuardParsed.ok, false);
    assert.equal(doctorDuringGuardParsed.error.code, "LOCKED");
    assert.match(
      doctorDuringGuardParsed.error.message,
      new RegExp(`guard held by pid ${process.pid}`),
    );
    assert.equal(fixture.requests.length, 0, "step 4 must make zero Manage API requests");
    assert.equal(fixture.tokenMintCount, 0, "step 4 must mint zero tokens");
    const configLockBytesAfterStep4 = await fs.readFile(configLockPath, "utf8");
    assert.equal(
      configLockBytesAfterStep4,
      configLockBytesBeforeBarrier,
      "the dead-owner config.lock must be byte-for-byte unchanged after step 4",
    );

    // Step 5: release this test's own barrier; 'auth unlock' now clears
    // the dead-owner lock underneath.
    await fs.unlink(guardPath);
    const unlockAfterBarrierReleased = await runCli(["auth", "unlock", "--json"], env);
    assert.equal(
      unlockAfterBarrierReleased.code,
      0,
      unlockAfterBarrierReleased.stdout + unlockAfterBarrierReleased.stderr,
    );
    const unlockAfterBarrierReleasedParsed = JSON.parse(unlockAfterBarrierReleased.stdout);
    assert.equal(unlockAfterBarrierReleasedParsed.ok, true);
    const step5ConfigResult = unlockAfterBarrierReleasedParsed.data.results.find(
      (r) => r.lock === "config.lock",
    );
    assert.ok(step5ConfigResult, "expected a config.lock entry in the step 5 unlock results");
    assert.equal(step5ConfigResult.cleared, true);
    await assert.rejects(fs.access(configLockPath));
    // auth unlock never mints or calls the Manage API: a pure lock-file
    // operation, so these stay at zero through every remaining step too.
    assert.equal(fixture.requests.length, 0, "step 5 must make zero Manage API requests");
    assert.equal(fixture.tokenMintCount, 0, "step 5 must mint zero tokens");

    // Step 6: a live-owner config.lock (this test's own pid) survives a
    // non-force unlock.
    await fs.writeFile(
      configLockPath,
      JSON.stringify({
        pid: process.pid,
        nonce: "2".repeat(32),
        acquiredAt: new Date().toISOString(),
        command: "doctor",
      }),
    );
    const unlockAgainstLiveLock = await runCli(["auth", "unlock", "--json"], env);
    assert.equal(unlockAgainstLiveLock.code, 1, unlockAgainstLiveLock.stdout + unlockAgainstLiveLock.stderr);
    const unlockAgainstLiveLockParsed = JSON.parse(unlockAgainstLiveLock.stdout);
    assert.equal(unlockAgainstLiveLockParsed.ok, false);
    const step6ConfigResult = unlockAgainstLiveLockParsed.error.detail.results.find(
      (r) => r.lock === "config.lock",
    );
    assert.ok(step6ConfigResult, "expected a config.lock entry in the step 6 refusal's detail.results");
    assert.equal(step6ConfigResult.cleared, false);
    assert.equal(step6ConfigResult.reason, "live holder");
    await fs.access(configLockPath); // still exists; does not throw
    assert.equal(fixture.requests.length, 0, "step 6 must make zero Manage API requests");
    assert.equal(fixture.tokenMintCount, 0, "step 6 must mint zero tokens");

    // Step 7: --force clears the survivor lock, with a stderr warning.
    const forcedUnlock = await runCli(["auth", "unlock", "--force", "--json"], env);
    assert.equal(forcedUnlock.code, 0, forcedUnlock.stdout + forcedUnlock.stderr);
    const forcedUnlockParsed = JSON.parse(forcedUnlock.stdout);
    assert.equal(forcedUnlockParsed.ok, true);
    const step7ConfigResult = forcedUnlockParsed.data.results.find((r) => r.lock === "config.lock");
    assert.ok(step7ConfigResult, "expected a config.lock entry in the step 7 forced unlock results");
    assert.equal(step7ConfigResult.cleared, true);
    assert.match(
      forcedUnlock.stderr,
      new RegExp(`warning: forcing removal of config\\.lock held by pid ${process.pid}`),
    );
    await assert.rejects(fs.access(configLockPath));
    assert.equal(fixture.requests.length, 0, "step 7 must make zero Manage API requests");
    assert.equal(fixture.tokenMintCount, 0, "step 7 must mint zero tokens");
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
