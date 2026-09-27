/**
 * Coverage item 1: dry-run vs. --write --confirm, for all six write
 * commands, including zero token acquisition on the two paths that must
 * never touch the network at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withHarness,
  runCli,
  parseEnvelope,
  writeTempFile,
  DOC_1,
  DOC_2,
  CONTROL_1,
  CONTROL_2,
  USER_1,
} from "./writes-helpers.test.js";

/**
 * The bare (no /v1) resource path of a logged request, or null if it was
 * not served under /v1 at all (every real domain request in this suite
 * is).
 */
function bareResourcePath(request) {
  const withoutQuery = request.path.split("?")[0];
  return withoutQuery.startsWith("/v1/") ? withoutQuery.slice(4) : null;
}

/**
 * True for exactly the two requests every clientFor() call makes before
 * any write-specific request: ensureToken's own token mint (POST, served
 * at the origin root, no /v1) and its immediate validateToken call (GET
 * /v1/frameworks?pageSize=1, matched exactly, query string and all).
 * Nothing else is ever excluded here.
 */
function isSharedAuthRequest(request) {
  if (request.method === "POST" && request.path === "/oauth/token") return true;
  if (request.method === "GET" && request.path === "/v1/frameworks?pageSize=1") return true;
  return false;
}

/**
 * Asserts that every request fixture.requests gained since `beforeCount`,
 * after removing only the two shared auth requests every write makes
 * (isSharedAuthRequest), is exactly `expected`, in exactly that order: not
 * a superset, not a subset, not reordered, and never silently narrowed to
 * a chosen path allowlist first. A request to any path at all beyond
 * `expected`, not just this write's own domain path(s), fails this.
 */
function assertExactRequestSequence(fixture, beforeCount, expected) {
  const actual = fixture.requests
    .slice(beforeCount)
    .filter((r) => !isSharedAuthRequest(r))
    .map((r) => ({ method: r.method, path: bareResourcePath(r) }));
  assert.deepEqual(
    actual,
    expected,
    `expected exactly ${JSON.stringify(expected)} after removing the two shared auth requests, got ${JSON.stringify(actual)}`,
  );
}

/**
 * Runs the shared dry-run / bad-confirm / good-confirm sequence for one
 * write command and returns the good-confirm envelope for the caller's
 * own additional assertions. `expectedRequests` is the exact, ordered
 * {method, path} sequence (bare resource paths, /v1 implied) this write's
 * own domain path(s) must show after the good-confirm run: pre-read GET,
 * the one mutating call, post-read GET, and nothing else, per write (plus
 * documents upload's own extra final, unledgered status GET).
 */
async function assertDryRunConfirmContract({
  fixture,
  env,
  args,
  wrongConfirm,
  goodConfirm,
  expectedRequests,
}) {
  // (a) No --write: zero requests, zero mints, dryRun: true.
  const beforeRequests = fixture.requests.length;
  const beforeMint = fixture.tokenMintCount;
  const dry = await runCli([...args, "--json"], env);
  assert.equal(dry.code, 0, `dry run should exit 0: ${dry.stdout} ${dry.stderr}`);
  const dryEnvelope = parseEnvelope(dry.stdout);
  assert.equal(dryEnvelope.ok, true);
  assert.equal(dryEnvelope.data.dryRun, true);
  assert.equal(fixture.requests.length, beforeRequests, "dry run must make zero fixture requests");
  assert.equal(fixture.tokenMintCount, beforeMint, "dry run must mint zero tokens");

  // (b) --write --confirm <wrong value>: still zero requests, zero mints, VALIDATION.
  const beforeRequests2 = fixture.requests.length;
  const beforeMint2 = fixture.tokenMintCount;
  const bad = await runCli([...args, "--write", "--confirm", wrongConfirm, "--json"], env);
  assert.equal(bad.code, 1, `bad confirm should exit 1: ${bad.stdout} ${bad.stderr}`);
  const badEnvelope = parseEnvelope(bad.stdout);
  assert.equal(badEnvelope.ok, false);
  assert.equal(badEnvelope.error.code, "VALIDATION");
  assert.equal(fixture.requests.length, beforeRequests2, "bad confirm must make zero fixture requests");
  assert.equal(fixture.tokenMintCount, beforeMint2, "bad confirm must mint zero tokens");

  // (c) --write --confirm <correct value>: exactly one token minted,
  // exactly the expected request(s) on this write's own domain path(s),
  // and succeeds.
  const beforeMint3 = fixture.tokenMintCount;
  const beforeRequests3 = fixture.requests.length;
  const good = await runCli([...args, "--write", "--confirm", goodConfirm, "--json"], env);
  assert.equal(good.code, 0, `good confirm should exit 0: ${good.stdout} ${good.stderr}`);
  const goodEnvelope = parseEnvelope(good.stdout);
  assert.equal(goodEnvelope.ok, true);
  assert.equal(fixture.tokenMintCount, beforeMint3 + 1, "good confirm must mint exactly one token");
  assertExactRequestSequence(fixture, beforeRequests3, expectedRequests);
  return goodEnvelope;
}

test("documents upload: dry-run/confirm contract, dry-run payload carries sha256/bytes/contentType", async () => {
  await withHarness("vanta-dryrun-upload-", async ({ fixture, dirs, env }) => {
    const filePath = writeTempFile(dirs.root, "evidence.txt", "hello evidence\n");
    const dry = await runCli(
      ["documents", "upload", filePath, "--document-id", DOC_1, "--json"],
      env,
    );
    assert.equal(dry.code, 0, dry.stderr);
    const dryEnvelope = parseEnvelope(dry.stdout);
    assert.equal(dryEnvelope.data.dryRun, true);
    assert.equal(dryEnvelope.data.files.length, 1);
    const fileEntry = dryEnvelope.data.files[0];
    assert.equal(typeof fileEntry.sha256, "string");
    assert.match(fileEntry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof fileEntry.bytes, "number");
    assert.equal(typeof fileEntry.contentType, "string");
    // The confirm value must be the document id, never a filename.
    assert.equal(dryEnvelope.data.requiredConfirm, DOC_1);

    const uploadsPath = `documents/${DOC_1}/uploads`;
    const goodEnvelope = await assertDryRunConfirmContract({
      fixture,
      env,
      args: ["documents", "upload", filePath, "--document-id", DOC_1],
      wrongConfirm: "not-the-document-id",
      goodConfirm: DOC_1,
      // preRead, the one mutating POST, postRead, then upload's own extra
      // final, unledgered status GET on documents/{id} (step g).
      expectedRequests: [
        { method: "GET", path: uploadsPath },
        { method: "POST", path: uploadsPath },
        { method: "GET", path: uploadsPath },
        { method: "GET", path: `documents/${DOC_1}` },
      ],
    });
    assert.equal(goodEnvelope.data.files[0].readback.verified, true);
  });
});

test("documents link: dry-run/confirm contract (requires --title)", async () => {
  await withHarness("vanta-dryrun-link-", async ({ fixture, env }) => {
    const url = "https://evidence.example.test/policy";
    const linksPath = `documents/${DOC_1}/links`;
    const goodEnvelope = await assertDryRunConfirmContract({
      fixture,
      env,
      args: ["documents", "link", DOC_1, "--url", url, "--title", "Access control evidence"],
      wrongConfirm: "https://not-the-url.test",
      goodConfirm: url,
      expectedRequests: [
        { method: "GET", path: linksPath },
        { method: "POST", path: linksPath },
        { method: "GET", path: linksPath },
      ],
    });
    assert.equal(goodEnvelope.data.readback.verified, true);
  });
});

test("documents set-owner: dry-run/confirm contract", async () => {
  await withHarness("vanta-dryrun-set-owner-doc-", async ({ fixture, env }) => {
    const docPath = `documents/${DOC_2}`;
    const goodEnvelope = await assertDryRunConfirmContract({
      fixture,
      env,
      args: ["documents", "set-owner", DOC_2, "--user-id", USER_1],
      wrongConfirm: "not-the-user-id",
      goodConfirm: USER_1,
      expectedRequests: [
        { method: "GET", path: docPath },
        { method: "POST", path: `${docPath}/set-owner` },
        { method: "GET", path: docPath },
      ],
    });
    assert.equal(goodEnvelope.data.readback.verified, true);
  });
});

test("documents submit: dry-run/confirm contract, sends no Content-Type and no body", async () => {
  await withHarness("vanta-dryrun-submit-", async ({ fixture, env }) => {
    const docPath = `documents/${DOC_1}`;
    await assertDryRunConfirmContract({
      fixture,
      env,
      args: ["documents", "submit", DOC_1],
      wrongConfirm: "not-the-document-id",
      goodConfirm: DOC_1,
      expectedRequests: [
        { method: "GET", path: docPath },
        { method: "POST", path: `${docPath}/submit` },
        { method: "GET", path: docPath },
      ],
    });
    const submitRequest = fixture.requests.find(
      (r) => r.method === "POST" && r.path.includes("/submit"),
    );
    assert.ok(submitRequest, "expected a POST .../submit request to have been recorded");
    assert.equal(submitRequest.headers["content-type"], undefined);
    assert.equal(submitRequest.body, undefined);
  });
});

test("controls set-owner: dry-run/confirm contract", async () => {
  await withHarness("vanta-dryrun-set-owner-control-", async ({ fixture, env }) => {
    const controlPath = `controls/${CONTROL_2}`;
    const goodEnvelope = await assertDryRunConfirmContract({
      fixture,
      env,
      args: ["controls", "set-owner", CONTROL_2, "--user-id", USER_1],
      wrongConfirm: "not-the-user-id",
      goodConfirm: USER_1,
      expectedRequests: [
        { method: "GET", path: controlPath },
        { method: "POST", path: `${controlPath}/set-owner` },
        { method: "GET", path: controlPath },
      ],
    });
    assert.equal(goodEnvelope.data.readback.verified, true);
  });
});

test("controls add-document: dry-run/confirm contract", async () => {
  await withHarness("vanta-dryrun-add-document-", async ({ fixture, env }) => {
    const documentsOfControlPath = `controls/${CONTROL_2}/documents`;
    const goodEnvelope = await assertDryRunConfirmContract({
      fixture,
      env,
      args: ["controls", "add-document", CONTROL_2, "--document-id", DOC_2],
      wrongConfirm: "not-the-document-id",
      goodConfirm: DOC_2,
      expectedRequests: [
        { method: "GET", path: documentsOfControlPath },
        { method: "POST", path: `controls/${CONTROL_2}/add-document-to-control` },
        { method: "GET", path: documentsOfControlPath },
      ],
    });
    assert.equal(goodEnvelope.data.readback.verified, true);
  });
});
