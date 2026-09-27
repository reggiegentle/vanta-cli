/**
 * node:test suite: the one worklist, `evidence gaps` (task 009c items 4
 * and 8; spec.md R7, R10). Verifies it succeeds on clean fixture data in
 * both output formats, that `needsDocument`/`needsUpdate` are always kept
 * as two separate groups (never merged into one combined rows array),
 * that names are shown without ids by default and with ids under
 * `--show-ids`, and that a missing `--framework` fails VALIDATION once the
 * tenant carries more than one framework (mirroring `controls list
 * --with-status`'s own rule, spec.md D11).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureServer } from "./helpers/fixture-server.js";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");
const SOC2_FRAMEWORK_ID = "framework-soc2";

const FORBIDDEN_PATTERNS = [
  { name: "an email address", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { name: "a URL", pattern: /https?:\/\// },
  { name: "a UUID", pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i },
  { name: "a Vanta OAuth secret", pattern: /vcs_[A-Za-z0-9._~+/=-]{10,}/ },
  { name: "a local absolute path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
];

function assertNoForbiddenPattern(text) {
  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    assert.equal(pattern.test(text), false, `output unexpectedly contains ${name}`);
  }
}

async function makeTempHome() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-reports-gaps-"));
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

function parseFailure(result) {
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, false, `expected ok:false, got ${result.stdout}`);
  return parsed.error;
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

function twoFrameworkPage() {
  return {
    status: 200,
    body: {
      results: {
        data: [
          { id: SOC2_FRAMEWORK_ID, displayName: "SOC 2 framework", shorthandName: "SOC 2" },
          { id: "framework-iso27001", displayName: "ISO 27001 framework", shorthandName: "ISO 27001" },
        ],
        pageInfo: { endCursor: null, hasNextPage: false, hasPreviousPage: false, startCursor: null },
      },
    },
  };
}

function threeStatusDocumentsPage() {
  return {
    status: 200,
    body: {
      results: {
        data: [
          {
            id: "document-needs-doc",
            ownerId: "user-001",
            category: "Account security",
            title: "Needs-Document Sample Policy",
            uploadStatus: "Needs document",
            uploadStatusDate: null,
            isSensitive: false,
            url: null,
          },
          {
            id: "document-needs-update",
            ownerId: "user-002",
            category: "Data storage",
            title: "Needs-Update Sample Evidence",
            uploadStatus: "Needs update",
            uploadStatusDate: "2026-01-01T00:00:00.000Z",
            isSensitive: false,
            url: null,
          },
          {
            id: "document-ok",
            ownerId: "user-001",
            category: "Account security",
            title: "Already OK Sample Policy",
            uploadStatus: "OK",
            uploadStatusDate: "2026-01-02T00:00:00.000Z",
            isSensitive: false,
            url: null,
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false, hasPreviousPage: false, startCursor: null },
      },
    },
  };
}

test("evidence gaps --json succeeds on clean fixture data", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const result = await runCli(["evidence", "gaps", "--json"], env);
    const data = parseOkData(result);
    assert.equal(data.completeness.complete, true);
  });
});

test("evidence gaps --format markdown --out <path> --json writes a sanitized markdown file", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const homeDir = env.HOME;
    const outPath = path.join(homeDir, "evidence-gaps.md");
    const result = await runCli(
      ["evidence", "gaps", "--format", "markdown", "--out", outPath, "--json"],
      env,
    );
    const data = parseOkData(result);
    assert.deepEqual(data, { format: "markdown", written: true });

    const markdown = await fs.readFile(outPath, "utf8");
    assert.match(markdown, /^# Evidence Gaps/);
    assertNoForbiddenPattern(markdown);
  });
});

test("evidence gaps never merges needsDocument and needsUpdate into one group", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    fixture.forceNextResponse("documents", threeStatusDocumentsPage(), 1);
    const result = await runCli(["evidence", "gaps", "--json"], env);
    const data = parseOkData(result);

    assert.deepEqual(Object.keys(data.documents).sort(), ["needsDocument", "needsUpdate"]);

    assert.equal(data.documents.needsDocument.total, 1);
    assert.equal(data.documents.needsDocument.rows.length, 1);
    assert.equal(data.documents.needsDocument.rows[0].title, "Needs-Document Sample Policy");

    assert.equal(data.documents.needsUpdate.total, 1);
    assert.equal(data.documents.needsUpdate.rows.length, 1);
    assert.equal(data.documents.needsUpdate.rows[0].title, "Needs-Update Sample Evidence");

    const needsDocTitles = data.documents.needsDocument.rows.map((r) => r.title);
    const needsUpdateTitles = data.documents.needsUpdate.rows.map((r) => r.title);
    for (const title of needsDocTitles) {
      assert.equal(needsUpdateTitles.includes(title), false, "the same row must never appear in both groups");
    }
  });
});

test("evidence gaps shows control names without ids by default, and ids only with --show-ids", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const defaultResult = await runCli(["evidence", "gaps", "--json"], env);
    const defaultData = parseOkData(defaultResult);
    assert.ok(defaultData.controls.rows.length > 0);
    for (const row of defaultData.controls.rows) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, "id"), false);
      assert.equal(typeof row.name, "string");
    }
  });

  await withFixtureAndHome(async (_fixture, env) => {
    const showIdsResult = await runCli(["evidence", "gaps", "--show-ids", "--json"], env);
    const showIdsData = parseOkData(showIdsResult);
    assert.ok(showIdsData.controls.rows.length > 0);
    assert.ok(showIdsData.controls.rows.some((row) => row.id === "control-002"));
  });
});

test("evidence gaps requires --framework once the tenant has more than one framework", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    fixture.forceNextResponse("frameworks", twoFrameworkPage(), 2);
    const result = await runCli(["evidence", "gaps", "--json"], env);
    const error = parseFailure(result);
    assert.equal(error.code, "VALIDATION");
    assert.match(error.message, /--framework/);
  });
});
