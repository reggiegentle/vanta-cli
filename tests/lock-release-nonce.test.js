/**
 * Coverage item (d): release only deletes the lock file when its nonce
 * still matches this acquisition's own nonce (the safety net against a
 * concurrent rewrite, e.g. by a concurrent 'auth unlock --force'). Uses a
 * direct import of the built config.js for precise control, rather than
 * going through the CLI subprocess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

test("release leaves the lock file in place and warns when its nonce was rewritten before release", async () => {
  const tempConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "vanta-lock-nonce-"));
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempConfigHome;

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderrCaptured = "";

  try {
    // Imported after XDG_CONFIG_HOME is set, since getConfigDir() reads
    // process.env.XDG_CONFIG_HOME at call time, not at import time.
    const configModule = await import("../dist/config.js");
    const lockPath = configModule.getConfigLockPath();

    const release = await configModule.acquireLock(lockPath);
    const acquiredRecord = await configModule.readLockRecord(lockPath);
    assert.ok(acquiredRecord, "expected acquireLock to have written a readable lock record");
    assert.equal(acquiredRecord.pid, process.pid);

    // Simulate some other write to the file (e.g. a concurrent
    // 'auth unlock --force') by externally rewriting its nonce.
    const foreignNonce = "f".repeat(32);
    await fs.writeFile(
      lockPath,
      JSON.stringify({ ...acquiredRecord, nonce: foreignNonce }),
    );

    process.stderr.write = (chunk, ...rest) => {
      stderrCaptured += chunk;
      return originalStderrWrite(chunk, ...rest);
    };
    await release();
    process.stderr.write = originalStderrWrite;

    // The lock file still exists, unlinked, because the release's own
    // nonce no longer matches what is on disk.
    await fs.access(lockPath);
    const finalContents = JSON.parse(await fs.readFile(lockPath, "utf8"));
    assert.equal(finalContents.nonce, foreignNonce);
    assert.match(
      stderrCaptured,
      /was modified by another process before this one released it; not deleting it\./,
    );
  } finally {
    process.stderr.write = originalStderrWrite;
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
