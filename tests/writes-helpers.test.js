/**
 * Shared helpers for task 009d's ordinary writes/ledger test suite. Not a
 * standalone task 009a fixture: this file only wires the built CLI to that
 * fixture through isolated per-test HOME/XDG_CONFIG_HOME directories. Every
 * tests/writes-*.test.js and tests/ledger-*.test.js file in this task
 * imports from here. This file matches the writes-* prefix this task owns,
 * so it carries one real smoke test of its own rather than sitting outside
 * node:test's discovery with zero coverage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startFixtureServer } from "./helpers/fixture-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const CLI_PATH = path.join(REPO_ROOT, "dist", "cli.js");

// Synthetic, obviously-fake OAuth client credentials. Never real values.
// Kept short (at most 12 characters after the vci_/vcs_ prefix) so
// scripts/secret-sweep.sh's own vci_/vcs_ pattern, tuned to catch a real
// 16+ character credential, does not flag these as one.
export const SYNTHETIC_CLIENT_ID = "vci_test_0001";
export const SYNTHETIC_CLIENT_SECRET = "vcs_test_0001";

// Seeded fixture ids this suite writes against (see fixture-server.js's
// buildInitialState). Using seeded ids keeps set-owner/submit/add-document
// routes (which 404 on an unknown target) working without any extra setup.
export const DOC_1 = "document-001";
export const DOC_2 = "document-002";
export const CONTROL_1 = "control-001";
export const CONTROL_2 = "control-002";
export const USER_1 = "user-001";
export const USER_2 = "user-002";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh, isolated HOME + XDG_CONFIG_HOME pair under the OS temp dir. */
export function makeIsolatedDirs(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, "home");
  const configDir = path.join(root, "config");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return {
    root,
    homeDir,
    configDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The full env object every CLI invocation in this suite runs with. */
export function fixtureEnv(fixture, dirs, extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: dirs.homeDir,
    XDG_CONFIG_HOME: dirs.configDir,
    VANTA_ALLOW_UNSAFE_API_BASE_URL: "1",
    VANTA_CLIENT_ID: SYNTHETIC_CLIENT_ID,
    VANTA_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
    // fixture.apiBaseUrl is the /v1 URL (matches production); every route
    // this suite hits is served there.
    VANTA_API_BASE_URL: fixture.apiBaseUrl,
    ...extra,
  };
}

/**
 * True if a logged request's path (fixture.requests[].path, taken straight
 * from req.url) is exactly `/v1/${resourcePath}` (query string aside). The
 * /v1 prefix is required, not optional: a logged path served outside /v1
 * must not match, since every real route this suite exercises is served
 * under /v1 (fixture.apiBaseUrl).
 */
export function requestMatchesPath(request, resourcePath) {
  const withoutQuery = request.path.split("?")[0];
  return withoutQuery === `/v1/${resourcePath}`;
}

/**
 * Spawns the built CLI without waiting for it to finish. Returns the child
 * process plus a `done` promise resolving to {code, stdout, stderr} once
 * the process closes. Used when a test needs to act (arm a fixture hook,
 * check a lock file) while the command is still in flight.
 */
export function startCli(args, env) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { env, cwd: REPO_ROOT });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  return { child, done };
}

/** Spawns the built CLI and waits for it to finish. */
export async function runCli(args, env) {
  const { done } = startCli(args, env);
  return done;
}

/** Parses a CLI invocation's stdout as the one {ok,data}/{ok:false,error} envelope. */
export function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  assert.ok(trimmed.length > 0, "expected non-empty JSON stdout from the CLI");
  return JSON.parse(trimmed);
}

export function ledgerFilePath(configDir) {
  return path.join(configDir, "vanta", "write-ledger.jsonl");
}

export function ledgerLockPath(configDir) {
  return path.join(configDir, "vanta", "ledger.lock");
}

export function configLockPath(configDir) {
  return path.join(configDir, "vanta", "config.lock");
}

/** Reads and JSON-parses every non-empty line of the write ledger, raw (no schema validation). */
export function readLedgerLines(configDir) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerFilePath(configDir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * The most recently appended `result`-phase ledger line: since the ledger
 * is strictly append-only and every write command appends its result line
 * unconditionally (verified true or false) before ever throwing on a
 * failed readback, a test that runs an ok write then a miss write in the
 * same ledger file finds the miss's own result line here.
 */
export function lastLedgerResultLine(configDir) {
  const results = readLedgerLines(configDir).filter((l) => l.phase === "result");
  return results[results.length - 1];
}

/** Writes a file with the given content under the test's own temp directory. */
export function writeTempFile(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Starts a fresh fixture server plus a fresh isolated HOME/XDG_CONFIG_HOME
 * pair, hands both (plus the ready-made env object) to `fn`, and tears
 * both down in a finally block regardless of how `fn` exits.
 */
export async function withHarness(prefix, fn) {
  const fixture = await startFixtureServer();
  const dirs = makeIsolatedDirs(prefix);
  try {
    const env = fixtureEnv(fixture, dirs);
    await fn({ fixture, dirs, env });
  } finally {
    await fixture.close();
    dirs.cleanup();
  }
}

test("writes-helpers: exports the shared harness surface", () => {
  assert.equal(typeof startCli, "function");
  assert.equal(typeof runCli, "function");
  assert.equal(typeof withHarness, "function");
  assert.equal(typeof readLedgerLines, "function");
  assert.ok(fs.existsSync(CLI_PATH), `expected a built CLI at ${CLI_PATH}; run npm run build first`);
});
