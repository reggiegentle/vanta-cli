/**
 * The OAuth client-credentials mint/validate flow, the single-mint guard,
 * and the auth/doctor command bodies. `ensureToken` is the only function
 * in this codebase that acquires config.lock or calls /oauth/token, in
 * every mode (spec.md R2, D2).
 */

import * as fs from "node:fs/promises";
import {
  acquireConfigLock,
  assertSafeApiBaseUrl,
  classifyLockFile,
  clearConfig,
  computeClientIdFingerprint,
  getConfigLockPath,
  getDisplayConfigPath,
  getLedgerLockPath,
  getLockGuardPath,
  readConfig,
  resolveApiBaseUrl,
  resolveCredentials,
  SCOPE_READ,
  withGuard,
  writeConfig,
  type ClearConfigResult,
  type LockClassification,
  type VantaToken,
} from "./config.js";
import { codeError, type ErrorCode } from "./output.js";

// --- Minting and validation -------------------------------------------------

export async function mintToken(params: {
  clientId: string;
  clientSecret: string;
  scope: string;
  oauthTokenUrl: string;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const { clientId, clientSecret, scope, oauthTokenUrl } = params;

  let response: Response;
  try {
    response = await fetch(oauthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        scope,
        grant_type: "client_credentials",
      }),
    });
  } catch {
    throw codeError("UPSTREAM_5XX", "Could not reach the Vanta OAuth token endpoint.");
  }

  const bodyText = await response.text().catch(() => "");

  if (!response.ok) {
    if ((response.status === 401 || response.status === 403) && bodyText.includes("invalid_client")) {
      throw codeError("AUTH_INVALID", "Vanta rejected the OAuth client credentials.", {
        http: response.status,
      });
    }
    if (response.status === 400 && bodyText.includes("invalid_scope")) {
      throw codeError("VALIDATION", "Vanta rejected the requested OAuth scope.", {
        http: response.status,
      });
    }
    throw codeError(
      httpStatusToErrorCode(response.status),
      `Vanta OAuth token request failed with status ${response.status}.`,
      { http: response.status },
    );
  }

  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw codeError("VALIDATION", "Vanta OAuth token response was not valid JSON.");
  }
  if (typeof parsed.access_token !== "string" || typeof parsed.expires_in !== "number") {
    throw codeError("VALIDATION", "Vanta OAuth token response was missing required fields.");
  }

  return {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + parsed.expires_in * 1000,
  };
}

function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "AUTH_INVALID";
  if (status >= 500) return "UPSTREAM_5XX";
  return "VALIDATION";
}

export async function validateToken(accessToken: string, apiBaseUrl: string): Promise<void> {
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/frameworks?pageSize=1`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw codeError("AUTH_INVALID", "Could not validate the newly minted Vanta token.");
  }
  if (!response.ok) {
    throw codeError("AUTH_INVALID", `Vanta rejected the newly minted token (status ${response.status}).`, {
      http: response.status,
    });
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw codeError("VALIDATION", "Vanta token validation response was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || !("results" in parsed)) {
    throw codeError("VALIDATION", "Vanta token validation response did not contain a results field.");
  }
}

// --- ensureToken: the single mint path -------------------------------------

let hasMintedThisProcess = false;

export interface EnsureTokenOptions {
  credentials?: { clientId: string; clientSecret: string };
  report?: { source?: "cached" | "minted" };
  forceMint?: boolean;
}

export async function ensureToken(
  scopeUnion: string[],
  opts?: EnsureTokenOptions,
): Promise<VantaToken> {
  const { apiBaseUrl, allowUnsafeApiBaseUrl } = await resolveApiBaseUrl();
  assertSafeApiBaseUrl(apiBaseUrl, allowUnsafeApiBaseUrl);
  const oauthTokenUrl = `${new URL(apiBaseUrl).origin}/oauth/token`;

  const release = await acquireConfigLock();
  try {
    const fresh = await readConfig();

    let currentClientId: string | undefined;
    let currentClientSecret: string | undefined;
    if (opts?.credentials) {
      currentClientId = opts.credentials.clientId;
      currentClientSecret = opts.credentials.clientSecret;
    } else {
      const resolved = await resolveCredentials();
      currentClientId = resolved.clientId;
      currentClientSecret = resolved.clientSecret;
    }

    if (typeof currentClientId !== "string" || currentClientId.length === 0) {
      throw codeError("AUTH_MISSING", "No Vanta clientId configured. Run 'vanta auth login'.", {
        detail: { missing: "clientId" },
      });
    }
    if (typeof currentClientSecret !== "string" || currentClientSecret.length === 0) {
      throw codeError("AUTH_MISSING", "No Vanta clientSecret configured. Run 'vanta auth login'.", {
        detail: { missing: "clientSecret" },
      });
    }

    const currentFingerprint = computeClientIdFingerprint(currentClientId);

    if (!opts?.forceMint) {
      const cached = fresh.token;
      const cacheHit =
        Boolean(cached) &&
        cached!.clientIdFingerprint === currentFingerprint &&
        cached!.expiresAt - Date.now() > 120_000 &&
        scopeUnion.every((s) => cached!.scopes.includes(s));

      if (cacheHit) {
        if (opts?.credentials) {
          await writeConfig({
            ...fresh,
            clientId: currentClientId,
            clientSecret: currentClientSecret,
          });
        }
        if (opts?.report) opts.report.source = "cached";
        return cached as VantaToken;
      }
    }

    if (hasMintedThisProcess) {
      throw codeError(
        "VALIDATION",
        "ensureToken was called a second time in this process for a scope its upfront scope-union computation did not request; this is a caller bug, not a retryable condition.",
      );
    }
    hasMintedThisProcess = true;

    const minted = await mintToken({
      clientId: currentClientId,
      clientSecret: currentClientSecret,
      scope: scopeUnion.join(" "),
      oauthTokenUrl,
    });

    await validateToken(minted.accessToken, apiBaseUrl);

    const token: VantaToken = {
      accessToken: minted.accessToken,
      expiresAt: minted.expiresAt,
      scopes: scopeUnion,
      clientIdFingerprint: currentFingerprint,
    };
    await writeConfig({
      ...fresh,
      clientId: currentClientId,
      clientSecret: currentClientSecret,
      apiBaseUrl,
      token,
    });
    if (opts?.report) opts.report.source = "minted";
    return token;
  } finally {
    await release();
  }
}

// --- login/status/clear -----------------------------------------------------

export interface LoginResult {
  clientIdFingerprint8: string;
  scopes: string[];
  expiresAt: number;
  tokenSource: "cached" | "minted";
  configPath: string;
}

export async function login(params: {
  envFile?: string;
  forceMint?: boolean;
}): Promise<LoginResult> {
  const resolved = await resolveCredentials(params.envFile);
  if (!resolved.clientId || !resolved.clientSecret) {
    throw codeError(
      "AUTH_MISSING",
      "No Vanta credentials found (checked VANTA_CLIENT_ID/SECRET, VANTA_OAUTH_CLIENT_ID/SECRET, an env file, and the saved config).",
    );
  }
  if (params.forceMint) {
    process.stderr.write(
      "warning: --force-mint will revoke the tenant's currently active Vanta access token.\n",
    );
  }

  const report: { source?: "cached" | "minted" } = {};
  const token = await ensureToken([SCOPE_READ], {
    credentials: { clientId: resolved.clientId, clientSecret: resolved.clientSecret },
    report,
    forceMint: Boolean(params.forceMint),
  });

  return {
    clientIdFingerprint8: token.clientIdFingerprint.slice(0, 8),
    scopes: token.scopes,
    expiresAt: token.expiresAt,
    tokenSource: report.source as "cached" | "minted",
    configPath: getDisplayConfigPath(),
  };
}

export interface StatusResult {
  hasClientId: boolean;
  hasClientSecret: boolean;
  tokenPresent: boolean;
  tokenMatchesCurrentClient: boolean;
  tokenExpiresInSeconds: number | null;
  scopes: string[];
  clientIdFingerprint8: string | null;
}

export async function status(): Promise<StatusResult> {
  const config = await readConfig();
  const resolved = await resolveCredentials();
  const currentClientId = resolved.clientId;

  const hasClientId = typeof currentClientId === "string" && currentClientId.length > 0;
  const hasClientSecret =
    typeof resolved.clientSecret === "string" && resolved.clientSecret.length > 0;

  const tokenMatchesCurrentClient = Boolean(
    config.token &&
      computeClientIdFingerprint(currentClientId ?? "") === config.token.clientIdFingerprint,
  );

  const tokenExpiresInSeconds = config.token
    ? Math.round((config.token.expiresAt - Date.now()) / 1000)
    : null;

  const clientIdFingerprint8 = hasClientId
    ? computeClientIdFingerprint(currentClientId as string).slice(0, 8)
    : null;

  return {
    hasClientId,
    hasClientSecret,
    tokenPresent: Boolean(config.token),
    tokenMatchesCurrentClient,
    tokenExpiresInSeconds,
    scopes: config.token?.scopes ?? [],
    clientIdFingerprint8,
  };
}

export async function clear(): Promise<ClearConfigResult> {
  return clearConfig();
}

// --- unlock ------------------------------------------------------------------

export interface UnlockLockResult {
  lock: "config.lock" | "ledger.lock" | "locks.guard";
  pid?: number;
  acquiredAt?: string;
  command?: string;
  cleared: boolean;
  malformed?: boolean;
  reason?: string;
}

export interface UnlockResult {
  results: UnlockLockResult[];
}

type UnlinkOutcome = { ok: true } | { ok: false; code: string };

async function tryUnlinkLock(lockPath: string): Promise<UnlinkOutcome> {
  try {
    await fs.unlink(lockPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException).code ?? "UNKNOWN" };
  }
}

async function classifyAndClearWithoutForce(
  name: "config.lock" | "ledger.lock",
  lockPath: string,
): Promise<UnlockLockResult> {
  const classification: LockClassification = await classifyLockFile(lockPath);
  if (classification.status === "absent") {
    return { lock: name, cleared: false, reason: "not present" };
  }
  if (classification.status === "live") {
    return {
      lock: name,
      pid: classification.record.pid,
      acquiredAt: classification.record.acquiredAt,
      cleared: false,
      reason: "live holder",
    };
  }
  // dead or malformed
  const unlinked = await tryUnlinkLock(lockPath);
  if (!unlinked.ok) {
    if (unlinked.code === "ENOENT") {
      return { lock: name, cleared: false, reason: "not present" };
    }
    return { lock: name, cleared: false, reason: `unlink failed: ${unlinked.code}` };
  }
  if (classification.status === "dead") {
    return {
      lock: name,
      pid: classification.record.pid,
      acquiredAt: classification.record.acquiredAt,
      cleared: true,
      malformed: false,
    };
  }
  return { lock: name, cleared: true, malformed: true };
}

async function unlockWithoutForce(): Promise<UnlockResult> {
  return withGuard(async () => {
    const results: UnlockLockResult[] = [];
    results.push(await classifyAndClearWithoutForce("config.lock", getConfigLockPath()));
    results.push(await classifyAndClearWithoutForce("ledger.lock", getLedgerLockPath()));

    const liveResults = results.filter((r) => r.reason === "live holder");
    const failedResults = results.filter((r) => r.reason?.startsWith("unlink failed"));
    if (liveResults.length > 0 || failedResults.length > 0) {
      const parts: string[] = [];
      if (liveResults.length > 0) {
        parts.push(`${liveResults.length} lock(s) held by a live process; pass --force to override.`);
      }
      if (failedResults.length > 0) {
        parts.push(`${failedResults.length} lock(s) could not be removed.`);
      }
      throw codeError("LOCKED", parts.join(" "), { detail: { results } });
    }
    return { results };
  });
}

async function unlockWithForce(): Promise<UnlockResult> {
  const targets: Array<{ name: "config.lock" | "ledger.lock" | "locks.guard"; lockPath: string }> = [
    { name: "config.lock", lockPath: getConfigLockPath() },
    { name: "ledger.lock", lockPath: getLedgerLockPath() },
    { name: "locks.guard", lockPath: getLockGuardPath() },
  ];

  const results: UnlockLockResult[] = [];
  for (const target of targets) {
    const classification: LockClassification = await classifyLockFile(target.lockPath);
    if (classification.status === "absent") {
      results.push({ lock: target.name, cleared: false, reason: "not present" });
      continue;
    }
    if (classification.status === "live") {
      process.stderr.write(
        `warning: forcing removal of ${target.name} held by pid ${classification.record.pid}; a running vanta process may currently be minting, writing to the ledger, or mid-acquisition. Clearing it now is your own risk.\n`,
      );
    }

    // live (forced), dead, or malformed: attempt the removal and report
    // exactly what happened, never assume success.
    const unlinked = await tryUnlinkLock(target.lockPath);
    if (!unlinked.ok) {
      if (unlinked.code === "ENOENT") {
        results.push({ lock: target.name, cleared: false, reason: "not present" });
        continue;
      }
      results.push({
        lock: target.name,
        pid: classification.record?.pid,
        acquiredAt: classification.record?.acquiredAt,
        cleared: false,
        reason: `unlink failed: ${unlinked.code}`,
      });
      continue;
    }

    if (classification.status === "dead") {
      results.push({
        lock: target.name,
        pid: classification.record.pid,
        acquiredAt: classification.record.acquiredAt,
        cleared: true,
        malformed: false,
      });
    } else if (classification.status === "malformed") {
      results.push({ lock: target.name, cleared: true, malformed: true });
    } else {
      // live, forced
      results.push({
        lock: target.name,
        pid: classification.record.pid,
        acquiredAt: classification.record.acquiredAt,
        cleared: true,
      });
    }
  }

  const failedResults = results.filter((r) => r.reason?.startsWith("unlink failed"));
  if (failedResults.length > 0) {
    throw codeError("LOCKED", `${failedResults.length} lock(s) could not be removed.`, {
      detail: { results },
    });
  }
  return { results };
}

export async function unlock(params: { force: boolean }): Promise<UnlockResult> {
  return params.force ? unlockWithForce() : unlockWithoutForce();
}
