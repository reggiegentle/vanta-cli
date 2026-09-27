/**
 * node:test suite: scope-union single mint for a command that needs read,
 * write, and upload scopes across its pre-reads, its mutating call, and a
 * follow-up link call (task 009b, coverage item 4).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { SCOPE_READ, SCOPE_UPLOAD, SCOPE_WRITE } from "../dist/config.js";

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

test("documents upload mints exactly once for the whole command, requesting the read, write, and upload scope union in that single mint", async () => {
  const fixture = await startFixtureServer();
  const tempConfigHome = await makeTempConfigHome();
  try {
    const env = fixtureEnv(fixture.apiBaseUrl, tempConfigHome);

    const filePath = path.join(tempConfigHome, "evidence.txt");
    await fs.writeFile(filePath, "synthetic evidence body for the fixture upload route");

    // document-002 and control-002 are both seeded with no pre-existing
    // link between them, so the readback for the link sub-operation has a
    // clean pre/post distinction to verify against.
    const result = await runCli(
      [
        "documents",
        "upload",
        filePath,
        "--document-id",
        "document-002",
        "--link-control-id",
        "control-002",
        "--write",
        "--confirm",
        "document-002",
        "--json",
      ],
      env,
    );
    assert.equal(result.code, 0, `expected the upload to succeed: ${result.stdout} ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.files[0].readback.verified, true);
    assert.equal(parsed.data.linkedControlIds[0].readback.verified, true);

    assert.equal(
      fixture.tokenMintCount,
      1,
      "a command needing read, write, and upload scopes across pre-reads, the upload call, and the link call " +
        "must still mint exactly once",
    );

    const tokenRequests = fixture.requests.filter((r) => r.path === "/oauth/token");
    assert.equal(tokenRequests.length, 1, "exactly one /oauth/token request for the whole command");

    const requestedScopes = String(tokenRequests[0].body.scope).split(" ").filter(Boolean).sort();
    const expectedScopes = [SCOPE_READ, SCOPE_WRITE, SCOPE_UPLOAD].sort();
    assert.deepEqual(
      requestedScopes,
      expectedScopes,
      "the single mint's request body must request the full read+write+upload scope union",
    );
  } finally {
    await fixture.close();
    await fs.rm(tempConfigHome, { recursive: true, force: true });
  }
});
