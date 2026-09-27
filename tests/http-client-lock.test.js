/**
 * node:test suite: VantaApiClient never touches config.lock or its
 * coordinating guard (locks.guard); only ensureToken does, genuinely
 * spanning its own in-flight validation call, and fully releasing both
 * before the client's own request phase ever begins (task 009b,
 * coverage item 11).
 *
 * A sampler alone cannot prove this: a brief lock acquisition could begin
 * after one check returns false and end before the next, invisible to
 * any fixed-interval poll no matter how tight. So this test does not
 * rely on sampling to prove absence. It plants two real, live-pid lock
 * files of its own, at two different points in the command's run, and
 * holds both until the child exits:
 *
 *   - locks.guard is planted the first time the validation request has
 *     landed and config.lock is still genuinely present (ensureToken is
 *     mid-call, its own lock legitimately held); every acquireLock
 *     creation attempt goes through withGuard first (src/config.ts), so
 *     from this instant on, before the client even exists, any attempt
 *     by the client to acquire config.lock has to contend with this
 *     guard and fails LOCKED after waiting the guard's own fixed 5s
 *     window. ensureToken's own release() never touches the guard, so
 *     this plant does not block ensureToken's own legitimate release.
 *   - config.lock is planted the first time the validation request has
 *     landed and config.lock reads absent (ensureToken has released it);
 *     this catches a direct touch that somehow bypassed the guard.
 *
 * From the moment both are planted, the command can only exit 0 with the
 * expected documents payload if it never touched either lock during the
 * request phase at all: a hard failure on any regression, not a missed
 * sample.
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

const SYNTHETIC_CLIENT_ID = "vci_test_0001";
const SYNTHETIC_CLIENT_SECRET = "vcs_test_0001";

async function makeTempConfigHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-test-"));
}

function fixtureEnv(apiBaseUrl, tempConfigHome, overrides = {}) {
  return {
    VANTA_CLIENT_ID: SYNTHETIC_CLIENT_ID,
    VANTA_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    VANTA_API_BASE_URL: apiBaseUrl,
    VANTA_ALLOW_UNSAFE_API_BASE_URL: "1",
    XDG_CONFIG_HOME: tempConfigHome,
    HOME: tempConfigHome,
    PATH: process.env.PATH || "",
    ...overrides,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(candidate) {
  return fs.access(candidate).then(
    () => true,
    () => false,
  );
}

function spawnCli(args, env) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { exited };
}

function hasRequest(fixture, method, pathPrefix) {
  return fixture.requests.some((r) => r.method === method && r.path.startsWith(pathPrefix));
}

/**
 * Exclusive-create a lock file ourselves (used for both config.lock and
 * locks.guard), in the same {pid, nonce, acquiredAt} shape src/config.ts's
 * own LockRecord writes, with our own, genuinely live process id:
 * classifyLockFile's `process.kill(pid, 0)` check will see this test's
 * own pid as alive, exactly the way it would see any other live holder,
 * so any later acquireLock/acquireGuard attempt against this same path
 * must treat it as a real, contested, live lock, not a stale one it can
 * clear. Throws (EEXIST) if the real, legitimate holder still has the
 * path under us; callers retry on the next sample.
 */
async function plantLiveLock(targetPath) {
  const nonce = crypto.randomBytes(16).toString("hex");
  const record = { pid: process.pid, nonce, acquiredAt: new Date().toISOString() };
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.open(targetPath, "wx");
  try {
    await handle.writeFile(JSON.stringify(record));
  } finally {
    await handle.close();
  }
  return record;
}

/**
 * Polls once per interval, fully awaited (never a dangling fs.access
 * promise), from the moment this is invoked until `donePromise` settles.
 * Every observation records config.lock's state and, anchored to the
 * fixture's own request log (never inferred from the lock samples
 * themselves), which phase of the command has happened by that instant.
 *
 * Plants locks.guard the first time the validation request has landed
 * while config.lock is still genuinely present (ensureToken's own,
 * legitimate hold), and plants config.lock itself the first time the
 * validation request has landed and config.lock reads absent
 * (ensureToken has released it); both are planted before the sample that
 * triggered them is recorded, so neither boundary sample can show a
 * false negative.
 */
async function pollAndTrap(fixture, lockPath, guardPath, donePromise, intervalMs) {
  const observations = [];
  let done = false;
  let guardPlantedAt = null;
  let guardRecord = null;
  let releaseObservedAt = null;
  let configLockRecord = null;
  donePromise.then(() => {
    done = true;
  });
  while (!done) {
    let present = await pathExists(lockPath);
    const validationRequested = hasRequest(fixture, "GET", "/v1/frameworks");
    const documentsRequested = hasRequest(fixture, "GET", "/v1/documents");
    const mintRequested = hasRequest(fixture, "POST", "/oauth/token");

    if (guardPlantedAt === null && validationRequested && present) {
      try {
        guardRecord = await plantLiveLock(guardPath);
        guardPlantedAt = observations.length;
      } catch {
        // The guard was momentarily held by ensureToken's own withGuard
        // call (a real, brief, legitimate hold): retry on the next sample.
      }
    }

    if (releaseObservedAt === null && validationRequested && !present) {
      try {
        configLockRecord = await plantLiveLock(lockPath);
        releaseObservedAt = observations.length;
        present = true;
      } catch {
        // TOCTOU: a genuine ensureToken-held lock was still there under
        // us between the access check above and this open: retry on the
        // next sample.
      }
    }

    observations.push({ present, mintRequested, validationRequested, documentsRequested });
    await sleep(intervalMs);
  }
  return { observations, guardPlantedAt, guardRecord, releaseObservedAt, configLockRecord };
}

test("locks.guard and config.lock both span ensureToken's own in-flight phase only; any later touch by the client is forced into a hard LOCKED failure", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  const lockPath = path.join(tempConfigHome, "vanta", "config.lock");
  const guardPath = path.join(tempConfigHome, "vanta", "locks.guard");
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome, { VANTA_LOCK_WAIT_MS: "200" });

    // Held long enough to make the token phase unambiguous: ensureToken's
    // own validation call (validateToken's GET to "frameworks", made
    // after minting, before writeConfig/release) stays in flight for
    // 300ms, and the client's own "documents" list request is held open
    // for 300ms too, giving this test a wide, real window over the
    // request phase to have never seen either trap sprung.
    fixture.delayNextResponse("frameworks", 300);
    fixture.delayNextResponse("documents", 300);

    const { exited } = spawnCli(["documents", "list", "--json"], env);
    const { observations, guardPlantedAt, guardRecord, releaseObservedAt, configLockRecord } =
      await pollAndTrap(fixture, lockPath, guardPath, exited, 5);
    const result = await exited;

    // If either trap ever sprung (a regression tried to acquire
    // config.lock or the guard during the request phase), the command
    // fails LOCKED here instead of exiting 0; this assertion, not a
    // sample count, is the real proof.
    assert.equal(
      result.code,
      0,
      `expected success (a LOCKED failure here means a trap sprung): ${result.stdout} ${result.stderr}`,
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.data) && parsed.data.length > 0, "expected the documents payload");

    assert.ok(
      observations.length > 20,
      "the poll must have actually sampled many times across the command's run, not just once or twice",
    );
    assert.notEqual(guardPlantedAt, null, "the guard trap must have actually been planted during this run");
    assert.ok(guardRecord, "a planted guard record must have been captured");
    assert.notEqual(releaseObservedAt, null, "the config.lock trap must have actually been planted during this run");
    assert.ok(configLockRecord, "a planted config.lock record must have been captured");
    assert.ok(
      guardPlantedAt < releaseObservedAt,
      "the guard must be planted while ensureToken still genuinely holds config.lock, strictly before its " +
        "release is ever observed",
    );

    const beforeDocuments = observations.filter((o) => !o.documentsRequested);
    const fromDocumentsOnward = observations.filter((o) => o.documentsRequested);

    assert.ok(
      beforeDocuments.length > 0,
      "there must be at least one sample recorded before the documents request was ever sent",
    );
    assert.ok(
      beforeDocuments.some((o) => o.present),
      "config.lock must have been observed present at some point before the documents request was ever " +
        "sent (during ensureToken's own in-flight validation call), before either trap ever existed",
    );

    assert.ok(
      fromDocumentsOnward.length > 5,
      "there must be a real, multiply-sampled window from the documents request's first appearance " +
        "through process exit (the 300ms delay on it exists to guarantee this)",
    );
    const firstDocumentsIndex = observations.findIndex((o) => o.documentsRequested);
    assert.ok(
      releaseObservedAt <= firstDocumentsIndex,
      "the config.lock trap must be planted at or before the documents request's first appearance, since " +
        "the command cannot dispatch that request until ensureToken has already returned and released its " +
        "own lock",
    );
    assert.equal(
      fromDocumentsOnward.every((o) => o.present === true),
      true,
      "every sample from the documents request's first appearance through process exit shows present:true " +
        "only because of this test's own plant, never a real re-acquisition (a real one would have made " +
        "the command exit non-zero LOCKED instead)",
    );

    // Both traps must still be exactly what this test planted: read them
    // back directly (never through the CLI) and require the same pid and
    // nonce, proving nobody deleted or recreated either one while held.
    const finalLock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(finalLock.pid, configLockRecord.pid);
    assert.equal(finalLock.nonce, configLockRecord.nonce);

    const finalGuard = JSON.parse(await fs.readFile(guardPath, "utf8"));
    assert.equal(finalGuard.pid, guardRecord.pid);
    assert.equal(finalGuard.nonce, guardRecord.nonce);
  } finally {
    await fs.rm(lockPath, { force: true });
    await fs.rm(guardPath, { force: true });
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
