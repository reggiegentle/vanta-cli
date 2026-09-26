/**
 * Config file, credential resolution, atomic writes, the host allowlist
 * check, and the three coordination files (config.lock, ledger.lock,
 * locks.guard) with the exclusive-creation lock primitive that guards
 * them. Owned entirely by task 002 (spec.md D2).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { codeError } from "./output.js";

export interface VantaToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  clientIdFingerprint: string;
}

export interface VantaConfig {
  clientId?: string;
  clientSecret?: string;
  apiBaseUrl?: string;
  allowUnsafeApiBaseUrl?: boolean;
  token?: VantaToken;
}

export const SCOPE_READ = "vanta-api.all:read";
export const SCOPE_WRITE = "vanta-api.all:write";
export const SCOPE_UPLOAD = "vanta-api.documents:upload";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUnsafeGateOpen(): boolean {
  const value = process.env.VANTA_ALLOW_UNSAFE_API_BASE_URL;
  return value === "1" || value === "true";
}

// --- Paths -----------------------------------------------------------

export function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : path.join(os.homedir(), ".config");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "vanta", "config.json");
}

export function getConfigLockPath(): string {
  return path.join(getConfigDir(), "vanta", "config.lock");
}

export function getLedgerLockPath(): string {
  return path.join(getConfigDir(), "vanta", "ledger.lock");
}

export function getLockGuardPath(): string {
  return path.join(getConfigDir(), "vanta", "locks.guard");
}

export function getDisplayConfigPath(): string {
  return process.env.XDG_CONFIG_HOME?.trim()
    ? "$XDG_CONFIG_HOME/vanta/config.json"
    : "~/.config/vanta/config.json";
}

// --- Fingerprints ------------------------------------------------------

export function computeClientIdFingerprint(clientId: string): string {
  return crypto.createHash("sha256").update(clientId).digest("hex").slice(0, 16);
}

// --- Plain config read/write --------------------------------------------

export async function readConfig(): Promise<VantaConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as VantaConfig;
    }
    return {};
  } catch {
    return {};
  }
}

export async function writeConfig(config: VantaConfig): Promise<void> {
  const configPath = getConfigPath();
  const displayPath = getDisplayConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  // Never follow a symlink at the destination path: refuse outright if
  // config.json is currently a symlink, before creating or writing
  // anything.
  let destinationIsSymlink = false;
  try {
    const existing = await fs.lstat(configPath);
    destinationIsSymlink = existing.isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (destinationIsSymlink) {
    throw codeError(
      "VALIDATION",
      `Refusing to write ${displayPath}: it is a symlink, not a regular file.`,
    );
  }

  // A unique, unpredictable temp name, opened with "wx" (exclusive
  // create) so a pre-existing file or symlink at that exact path is never
  // followed or overwritten; on a collision, retry with a new suffix
  // rather than falling back to a predictable, non-exclusive open.
  let tempPath = "";
  let handle;
  for (;;) {
    const suffix = crypto.randomBytes(6).toString("hex");
    tempPath = `${configPath}.tmp-${process.pid}-${suffix}`;
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }

  // A single failure boundary across write, sync, chmod, close, and
  // rename: on any failure here, close the handle if it is still open and
  // remove tempPath before rethrowing, so a failed write never leaves
  // durable credential material sitting under a ".tmp-*" name outside the
  // canonical config file.
  let handleOpen = true;
  try {
    await handle.writeFile(JSON.stringify(config));
    await handle.sync();
    // Belt and suspenders beyond the create-time mode: force 0600 on the
    // descriptor itself before it is ever renamed into place, in case a
    // restrictive umask was not the only thing relied on.
    await handle.chmod(0o600);
    await handle.close();
    handleOpen = false;
    await fs.rename(tempPath, configPath);
  } catch (err) {
    if (handleOpen) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }

  // Verify what actually landed at configPath after the atomic rename;
  // fail closed rather than trusting the create mode blindly. The temp
  // file no longer exists to clean up: rename already consumed it.
  const finalStat = await fs.lstat(configPath);
  if (!finalStat.isFile()) {
    throw codeError(
      "CHECK_FAILED",
      `Refusing to trust ${displayPath}: it is not a regular file after writing.`,
    );
  }
  if ((finalStat.mode & 0o777) !== 0o600) {
    throw codeError(
      "CHECK_FAILED",
      `Refusing to trust ${displayPath}: its permissions were not 600 after writing.`,
    );
  }
}

export interface ClearConfigFailure {
  name: string;
  code: string;
}

export interface ClearConfigResult {
  configRemoved: boolean;
  tempFilesRemoved: number;
  failures: ClearConfigFailure[];
}

export async function clearConfig(): Promise<ClearConfigResult> {
  const configPath = getConfigPath();
  const failures: ClearConfigFailure[] = [];
  let configRemoved = false;

  try {
    await fs.unlink(configPath);
    configRemoved = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      failures.push({ name: path.basename(configPath), code: code ?? "UNKNOWN" });
    }
  }

  // A crash between writeConfig's temp-file create and its rename can
  // leave a stale "<config.json>.tmp-*" file behind, still carrying
  // credential material; sweep the config directory for any and remove
  // them too, since auth unlock never touches config.json or its temp
  // files and auth clear is the one documented operator command for
  // this. Every per-file failure other than ENOENT (already gone) is
  // recorded, never silently swallowed, so a caller can never be told
  // cleanup succeeded when a credential-bearing file remains.
  const configDir = path.dirname(configPath);
  const tempPrefix = `${path.basename(configPath)}.tmp-`;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(configDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let tempFilesRemoved = 0;
  for (const entry of entries) {
    if (!entry.startsWith(tempPrefix)) continue;
    try {
      await fs.unlink(path.join(configDir, entry));
      tempFilesRemoved += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      failures.push({ name: entry, code: code ?? "UNKNOWN" });
    }
  }

  return { configRemoved, tempFilesRemoved, failures };
}

// --- Host allowlist ------------------------------------------------------

const HOST_ALLOWLIST_MESSAGE =
  "Refusing to send Vanta bearer token to a non-Vanta API host. Set VANTA_ALLOW_UNSAFE_API_BASE_URL=1 only for synthetic local tests.";

export function assertSafeApiBaseUrl(value: string, allowUnsafeApiBaseUrl: boolean): void {
  if (allowUnsafeApiBaseUrl) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw codeError("VALIDATION", HOST_ALLOWLIST_MESSAGE);
  }
  const hostname = url.hostname;
  const isExactHost = hostname === "api.vanta.com" || hostname === "api.vanta-gov.com";
  const isSubdomain =
    hostname.endsWith(".api.vanta.com") || hostname.endsWith(".api.vanta-gov.com");
  if (url.protocol !== "https:" || !(isExactHost || isSubdomain)) {
    throw codeError("VALIDATION", HOST_ALLOWLIST_MESSAGE);
  }
}

// --- Lock wait override --------------------------------------------------

export function resolveLockWaitMs(): number {
  const DEFAULT_WAIT_MS = 30_000;
  const raw = process.env.VANTA_LOCK_WAIT_MS;
  if (raw === undefined) return DEFAULT_WAIT_MS;
  if (!isUnsafeGateOpen()) {
    process.stderr.write(
      `warning: ignoring VANTA_LOCK_WAIT_MS="${raw}" because VANTA_ALLOW_UNSAFE_API_BASE_URL is not set; using default ${DEFAULT_WAIT_MS}ms.\n`,
    );
    return DEFAULT_WAIT_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 600_000) {
    process.stderr.write(
      `warning: ignoring invalid VANTA_LOCK_WAIT_MS="${raw}"; using default ${DEFAULT_WAIT_MS}ms.\n`,
    );
    return DEFAULT_WAIT_MS;
  }
  return value;
}

// --- Lock records ----------------------------------------------------------

export interface LockRecord {
  pid: number;
  nonce: string;
  acquiredAt: string;
  command?: string;
}

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid <= 0) return null;
  if (typeof obj.nonce !== "string" || !NONCE_PATTERN.test(obj.nonce)) return null;
  if (typeof obj.acquiredAt !== "string" || Number.isNaN(Date.parse(obj.acquiredAt))) return null;
  if (obj.command !== undefined && typeof obj.command !== "string") return null;
  const record: LockRecord = {
    pid: obj.pid,
    nonce: obj.nonce,
    acquiredAt: obj.acquiredAt,
  };
  if (typeof obj.command === "string") record.command = obj.command;
  return record;
}

export type LockClassification =
  | { status: "absent"; record: null }
  | { status: "live" | "dead"; record: LockRecord }
  | { status: "malformed"; record: null; reason?: string };

export async function classifyLockFile(lockPath: string): Promise<LockClassification> {
  try {
    await fs.access(lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { status: "absent", record: null };
    }
    // Any other access failure (EACCES, EIO, EISDIR, ELOOP, and so on) is
    // not "the file is not there"; treat it as malformed so the caller
    // takes the bounded malformed path instead of spinning or reporting a
    // lock it could not read as simply not present.
    return { status: "malformed", record: null, reason: code ?? "UNKNOWN" };
  }
  const record = await readLockRecord(lockPath);
  if (!record) {
    return { status: "malformed", record: null };
  }
  try {
    process.kill(record.pid, 0);
    return { status: "live", record };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return { status: "dead", record };
    }
    // EPERM (or anything else): the process exists, owned by someone else.
    return { status: "live", record };
  }
}

function makeReleaseFn(lockPath: string, nonce: string): () => Promise<void> {
  return async () => {
    const current = await readLockRecord(lockPath);
    if (current?.nonce === nonce) {
      await fs.unlink(lockPath).catch(() => {});
    } else {
      process.stderr.write(
        `warning: lock ${lockPath} was modified by another process before this one released it; not deleting it.\n`,
      );
    }
  };
}

// --- The guard (round-6 coordination primitive) --------------------------

const GUARD_LIVE_WAIT_MS = 5_000;
const GUARD_POLL_INTERVAL_MS = 50;

export async function acquireGuard(): Promise<() => Promise<void>> {
  const guardPath = getLockGuardPath();
  await fs.mkdir(path.dirname(guardPath), { recursive: true, mode: 0o700 });
  // One deadline for the whole call, exactly like acquireLock's own
  // waitMs deadline: five seconds total, even if the guard changes hands
  // (a live holder releases and a different live holder appears) during
  // the wait. Recomputing a fresh deadline on every new "live" sighting
  // would let acquisition wait indefinitely under contention.
  const deadline = Date.now() + GUARD_LIVE_WAIT_MS;

  for (;;) {
    let handle;
    try {
      handle = await fs.open(guardPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const classification = await classifyLockFile(guardPath);
      if (classification.status === "absent") continue;
      if (classification.status === "live") {
        if (Date.now() >= deadline) {
          throw codeError("LOCKED", `guard held by pid ${classification.record.pid} at ${guardPath}`);
        }
        await sleep(GUARD_POLL_INTERVAL_MS);
        continue;
      }
      // dead or malformed, observed at any point: only --force clears the guard.
      throw codeError(
        "LOCKED",
        `guard left by a dead or malformed holder at ${guardPath}; run 'vanta auth unlock --force' to clear it.`,
      );
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    try {
      const record: LockRecord = { pid: process.pid, nonce, acquiredAt: new Date().toISOString() };
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } catch (writeErr) {
      await handle.close().catch(() => {});
      await fs.unlink(guardPath).catch(() => {});
      throw writeErr;
    }
    await handle.close();
    return makeReleaseFn(guardPath, nonce);
  }
}

export async function withGuard<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireGuard();
  try {
    return await fn();
  } finally {
    await release();
  }
}

// --- The generic exclusive-creation lock ----------------------------------

type LockCreateOutcome =
  | { acquired: true; nonce: string }
  | { acquired: false; classification: LockClassification };

const LOCK_POLL_INTERVAL_MS = 200;
const MALFORMED_GRACE_MS = 2_000;

export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const waitMs = resolveLockWaitMs();
  const deadline = Date.now() + waitMs;
  let malformedSince: number | null = null;

  for (;;) {
    const outcome: LockCreateOutcome = await withGuard(async (): Promise<LockCreateOutcome> => {
      await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      const nonce = crypto.randomBytes(16).toString("hex");
      let handle;
      try {
        handle = await fs.open(lockPath, "wx");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        return { acquired: false, classification: await classifyLockFile(lockPath) };
      }
      try {
        const record: LockRecord = {
          pid: process.pid,
          nonce,
          acquiredAt: new Date().toISOString(),
          command: process.argv.slice(2).join(" "),
        };
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } catch (writeErr) {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
        throw writeErr;
      }
      await handle.close();
      return { acquired: true, nonce };
    });

    if (outcome.acquired) {
      return makeReleaseFn(lockPath, outcome.nonce);
    }

    const c = outcome.classification;
    if (c.status === "absent") {
      continue;
    }
    if (c.status === "dead") {
      throw codeError(
        "LOCKED",
        `stale lock left by pid ${c.record.pid} (not running) at ${lockPath}; run 'vanta auth unlock' to clear it.`,
      );
    }
    if (c.status === "malformed") {
      malformedSince = malformedSince ?? Date.now();
      if (Date.now() - malformedSince > MALFORMED_GRACE_MS) {
        throw codeError(
          "LOCKED",
          `malformed lock at ${lockPath}; confirm no vanta process is running (pgrep -f vanta) and run 'vanta auth unlock'.`,
        );
      }
      await sleep(200);
      continue;
    }
    // c.status === "live"
    if (Date.now() > deadline) {
      throw codeError(
        "LOCKED",
        `another vanta process (pid ${c.record.pid}, started ${c.record.acquiredAt}, ${c.record.command}) holds ${lockPath}`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

export async function acquireConfigLock(): Promise<() => Promise<void>> {
  return acquireLock(getConfigLockPath());
}

// --- Credential and API base URL resolution -------------------------------

export interface ResolvedCredentials {
  clientId?: string;
  clientSecret?: string;
  source: "env" | "env-file" | "config" | "none";
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function parseEnvFile(filePath: string): Promise<{ clientId?: string; clientSecret?: string }> {
  const raw = await fs.readFile(filePath, "utf8");
  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    values[key] = value;
  }
  return {
    clientId: values.VANTA_CLIENT_ID ?? values.VANTA_OAUTH_CLIENT_ID,
    clientSecret: values.VANTA_CLIENT_SECRET ?? values.VANTA_OAUTH_CLIENT_SECRET,
  };
}

export async function resolveCredentials(envFileOverride?: string): Promise<ResolvedCredentials> {
  const envClientId = process.env.VANTA_CLIENT_ID;
  const envClientSecret = process.env.VANTA_CLIENT_SECRET;
  if (envClientId || envClientSecret) {
    return { clientId: envClientId, clientSecret: envClientSecret, source: "env" };
  }

  const oauthClientId = process.env.VANTA_OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.VANTA_OAUTH_CLIENT_SECRET;
  if (oauthClientId || oauthClientSecret) {
    return { clientId: oauthClientId, clientSecret: oauthClientSecret, source: "env" };
  }

  const envFilePath = envFileOverride ?? path.join(os.homedir(), ".config", "vanta", ".env");
  if (await fileExists(envFilePath)) {
    const parsed = await parseEnvFile(envFilePath);
    if (parsed.clientId || parsed.clientSecret) {
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, source: "env-file" };
    }
  }

  const config = await readConfig();
  if (config.clientId || config.clientSecret) {
    return { clientId: config.clientId, clientSecret: config.clientSecret, source: "config" };
  }

  return { source: "none" };
}

export async function resolveApiBaseUrl(): Promise<{
  apiBaseUrl: string;
  allowUnsafeApiBaseUrl: boolean;
}> {
  const allowUnsafeApiBaseUrl = isUnsafeGateOpen();
  const envApiBaseUrl = process.env.VANTA_API_BASE_URL;
  if (envApiBaseUrl) {
    return { apiBaseUrl: stripTrailingSlash(envApiBaseUrl), allowUnsafeApiBaseUrl };
  }
  const config = await readConfig();
  if (config.apiBaseUrl) {
    return { apiBaseUrl: stripTrailingSlash(config.apiBaseUrl), allowUnsafeApiBaseUrl };
  }
  return { apiBaseUrl: "https://api.vanta.com/v1", allowUnsafeApiBaseUrl };
}

// --- Small helpers ---------------------------------------------------------

export function redactSecret(value: string | undefined): string | null {
  if (!value) return null;
  const visible = value.slice(0, 4);
  return `${visible}...(${value.length} chars)`;
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
