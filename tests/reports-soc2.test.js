/**
 * node:test suite: the one aggregate report, `soc2 report` (task 009c
 * items 4, 5, 9, 10; spec.md R4, R10). Verifies it succeeds on clean
 * fixture data in both output formats, that `documents.byUploadStatus`
 * always carries all five enum buckets, that a non-allowlisted bucket
 * value folds into "OTHER" instead of leaking, and that the framework
 * block is numeric-only and never leaks the fixture's deliberately
 * email-shaped `displayName`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startFixtureServer } from "./helpers/fixture-server.js";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "dist", "cli.js");

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
  return await fs.mkdtemp(path.join(os.tmpdir(), "vanta-cli-reports-soc2-"));
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

function bogusDomainControlsPage() {
  return {
    status: 200,
    body: {
      results: {
        data: [
          {
            id: "control-001",
            name: "Access reviews are performed quarterly",
            source: "Vanta",
            domains: ["NOT_A_REAL_DOMAIN_ZZZ"],
          },
          {
            id: "control-002",
            name: "Production backups are encrypted at rest",
            source: "Vanta",
            domains: ["CLOUD_SECURITY"],
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false, hasPreviousPage: false, startCursor: null },
      },
    },
  };
}

test("soc2 report --json succeeds on clean fixture data with all five upload-status buckets", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const result = await runCli(["soc2", "report", "--json"], env);
    const data = parseOkData(result);
    assert.equal(data.completeness.complete, true);

    const byUploadStatus = data.documents.byUploadStatus;
    assert.equal(byUploadStatus.length, 5);
    const buckets = byUploadStatus.map((b) => b.bucket).sort();
    assert.deepEqual(buckets, ["Needs document", "Needs update", "Not relevant", "OK", "OTHER"].sort());
    const byBucket = new Map(byUploadStatus.map((b) => [b.bucket, b.count]));
    // Fixture seeds one "OK" document and one "Needs document" document;
    // the two unused enum values must still be present, zero-filled.
    assert.equal(byBucket.get("OK"), 1);
    assert.equal(byBucket.get("Needs document"), 1);
    assert.equal(byBucket.get("Needs update"), 0);
    assert.equal(byBucket.get("Not relevant"), 0);
    assert.equal(byBucket.get("OTHER"), 0);
  });
});

test("soc2 report --format markdown --out <path> --json writes a sanitized markdown file", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const homeDir = env.HOME;
    const outPath = path.join(homeDir, "soc2-report.md");
    const result = await runCli(["soc2", "report", "--format", "markdown", "--out", outPath, "--json"], env);
    const data = parseOkData(result);
    assert.deepEqual(data, { format: "markdown", written: true });

    const markdown = await fs.readFile(outPath, "utf8");
    assert.match(markdown, /^# SOC 2 Report/);
    assertNoForbiddenPattern(markdown);
  });
});

test("soc2 report folds a non-allowlisted control domain into OTHER instead of leaking it", async () => {
  await withFixtureAndHome(async (fixture, env) => {
    fixture.forceNextResponse("controls", bogusDomainControlsPage(), 1);
    const result = await runCli(["soc2", "report", "--json"], env);
    const data = parseOkData(result);

    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes("NOT_A_REAL_DOMAIN_ZZZ"), false);

    const otherBucket = data.controls.byDomain.find((b) => b.bucket === "OTHER");
    assert.ok(otherBucket, "expected an OTHER bucket in controls.byDomain");
    assert.ok(otherBucket.count >= 1);
  });
});

test("soc2 report's framework block is numeric-only and never leaks the email-shaped displayName", async () => {
  await withFixtureAndHome(async (_fixture, env) => {
    const result = await runCli(["soc2", "report", "--json"], env);
    const data = parseOkData(result);

    const frameworkKeys = Object.keys(data.framework).sort();
    assert.deepEqual(
      frameworkKeys,
      [
        "numControlsCompleted",
        "numControlsTotal",
        "numDocumentsPassing",
        "numDocumentsTotal",
        "numTestsPassing",
        "numTestsTotal",
        "ref",
      ].sort(),
    );
    for (const key of frameworkKeys) {
      if (key === "ref") continue;
      assert.equal(typeof data.framework[key], "number");
    }

    const serialized = JSON.stringify(data);
    assert.equal(serialized.includes("compliance-lead@acme.test"), false);
    assert.equal(serialized.includes("@"), false, "no email-shaped substring should reach the output at all");
  });
});
