/**
 * Coverage item (c): a live-owner config.lock makes 'vanta auth unlock'
 * refuse without --force, and --force clears it with a stderr warning.
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

test("a live-owner config.lock makes auth unlock refuse without --force, and --force clears it with a stderr warning", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "vanta-lock-live-"));
  try {
    const vantaDir = path.join(tempConfigHome, "vanta");
    await fs.mkdir(vantaDir, { recursive: true });
    const lockPath = path.join(vantaDir, "config.lock");
    // This test's own running process id: guaranteed alive for the test's
    // duration, so classifyLockFile observes it as a live holder.
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        nonce: "b".repeat(32),
        acquiredAt: new Date().toISOString(),
        command: "doctor",
      }),
    );

    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);

    const refuse = await runCli(["auth", "unlock", "--json"], env);
    assert.equal(refuse.code, 1, refuse.stdout + refuse.stderr);
    const refuseParsed = JSON.parse(refuse.stdout);
    assert.equal(refuseParsed.ok, false);
    assert.equal(refuseParsed.error.code, "LOCKED");
    const refuseConfigResult = refuseParsed.error.detail.results.find((r) => r.lock === "config.lock");
    assert.ok(refuseConfigResult, "expected a config.lock entry in the refusal's detail.results");
    assert.equal(refuseConfigResult.cleared, false);
    assert.equal(refuseConfigResult.reason, "live holder");
    await fs.access(lockPath); // still exists; does not throw

    const forced = await runCli(["auth", "unlock", "--force", "--json"], env);
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
    const forcedParsed = JSON.parse(forced.stdout);
    assert.equal(forcedParsed.ok, true);
    const forcedConfigResult = forcedParsed.data.results.find((r) => r.lock === "config.lock");
    assert.ok(forcedConfigResult, "expected a config.lock entry in the forced unlock's results");
    assert.equal(forcedConfigResult.cleared, true);
    assert.match(
      forced.stderr,
      new RegExp(`warning: forcing removal of config\\.lock held by pid ${process.pid}`),
    );
    await assert.rejects(fs.access(lockPath));
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
