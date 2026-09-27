/**
 * node:test suite: the two-gate split itself (task 009c items 6 and 7;
 * spec.md R4/R10, round-1 finding 10). `assertSafeAggregateReport`'s
 * structural key/bucket checks are exercised directly against
 * `dist/safety.js`, since no current report builder actually produces a
 * bare forbidden key or an out-of-allowlist bucket value on its own; the
 * CLI-level half shows that `evidence gaps` (the worklist) is allowed to
 * carry a name the aggregate gate would reject.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureServer } from "./helpers/fixture-server.js";
import { assertSafeAggregateReport } from "../dist/safety.js";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
const DISTINCTIVE_NAME = "Zephyr-Distinctive-Control-Marker-83f2";

async function makeTempHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-reports-gate-"));
}

function fixtureEnv(fixture, homeDir) {
  return {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, "xdg-config"),
    VANTA_ALLOW_UNSAFE_API_BASE_URL: "1",
    VANTA_API_BASE_URL: fixture.apiBaseUrl,
    VANTA_CLIENT_ID: "vci_test_0001",
    VANTA_CLIENT_SECRET: "vcs_test_0001",
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

function parseOkData(result) {
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, true, `expected ok:true, got ${result.stdout}`);
  return parsed.data;
}

async function withFixtureAndHome(run) {
  const fixture = await startFixtureServer();
  const homeDir = await makeTempHome();
  try {
    await run(fixture, fixtureEnv(fixture, homeDir));
  } finally {
    await fixture.close();
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function namedControlsPage() {
  return {
    status: 200,
    body: {
      results: {
        data: [
          { id: "control-001", name: "Access reviews are performed quarterly", source: "Vanta", domains: ["ACCESS_CONTROL"] },
          { id: "control-002", name: DISTINCTIVE_NAME, source: "Vanta", domains: ["CLOUD_SECURITY"] },
        ],
        pageInfo: { endCursor: null, hasNextPage: false, hasPreviousPage: false, startCursor: null },
      },
    },
  };
}

// --- Item 6: the structural backstop, exercised directly ------------------

test("assertSafeAggregateReport throws CHECK_FAILED on a bare forbidden key", () => {
  assert.throws(
    () => assertSafeAggregateReport({ name: "leaked control name" }),
    (err) => err.code === "CHECK_FAILED",
  );
});

test("assertSafeAggregateReport throws CHECK_FAILED on a bucket value outside the allowlist union", () => {
  assert.throws(
    () => assertSafeAggregateReport({ controls: { byStatus: [{ bucket: "NOT_A_REAL_BUCKET_VALUE", count: 1 }] } }),
    (err) => err.code === "CHECK_FAILED",
  );
});

test("assertSafeAggregateReport does not throw on a clean, real-report-shaped object", () => {
  assert.doesNotThrow(() =>
    assertSafeAggregateReport({
      framework: { ref: "framework-001", numControlsCompleted: 1, numControlsTotal: 2 },
      controls: { byStatus: [{ bucket: "COMPLETED", count: 1 }] },
    }),
  );
});

// --- Item 7: the worklist allows names; the aggregate gate does not -------

test("evidence gaps includes a distinctive control name; the same string fails closed under the aggregate gate", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    fixture.forceNextResponse("controls", namedControlsPage(), 1);
    const result = await runCli(["evidence", "gaps", "--json"], env);
    const data = parseOkData(result);
    const serialized = JSON.stringify(data);
    assert.ok(
      serialized.includes(DISTINCTIVE_NAME),
      "the worklist gate allows control names through",
    );
  });

  // soc2 report's real output shape has no free-text passthrough field for
  // this string to ride through untouched: every value is either numeric,
  // the safe `ref` string, or folded through a closed bucket allowlist
  // (report-helpers.ts's countBy/countByFlattened/countByEnum), so a
  // made-up string can never reach it as a bucket value either (item 5
  // already proves that fold). Per this task's own fallback instruction,
  // exercise the same distinctive string through the structural-key
  // check instead, proving the aggregate gate would reject it outright if
  // a future report builder ever let it leak in as a raw key's value.
  assert.throws(
    () => assertSafeAggregateReport({ name: DISTINCTIVE_NAME }),
    (err) => err.code === "CHECK_FAILED",
  );
});
