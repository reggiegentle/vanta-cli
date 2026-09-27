/**
 * CLI-wide runtime helpers shared by every command. Owned entirely by
 * task 002; task 005 appends clientFor/parsePositiveInteger/
 * parseQueryPairs/collect/unwrapPaginated once vanta-api.ts exists.
 */

import { createRequire } from "node:module";
import { CommanderError, type Command } from "commander";
import { ensureToken } from "./auth.js";
import { resolveApiBaseUrl, resolveCredentials, readConfig } from "./config.js";
import {
  codeError,
  exitCodeForError,
  fail,
  makeError,
  ok,
  printJson,
  toErrorCode,
  type CliError,
} from "./output.js";
import type { PaginationResult } from "./paginate.js";
import { VantaApiClient } from "./vanta-api.js";

interface JsonAwareOptions {
  json?: boolean;
}

export function wantsJsonOutput(): boolean {
  return process.argv.includes("--json");
}

export function jsonRequested(opts?: JsonAwareOptions): boolean {
  return Boolean(opts?.json);
}

export function getCliVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

/**
 * Fails AUTH_MISSING (pointed at 'vanta auth login') if no credentials are
 * resolvable and no cached token exists either.
 */
export async function requireCredentials(opts?: JsonAwareOptions): Promise<void> {
  void opts;
  const resolved = await resolveCredentials();
  const saved = await readConfig();
  const hasCredentials = Boolean(resolved.clientId && resolved.clientSecret);
  const hasCachedToken = Boolean(saved.token);
  if (!hasCredentials && !hasCachedToken) {
    throw codeError("AUTH_MISSING", "No Vanta credentials. Run 'vanta auth login'.");
  }
}

export function render(value: unknown, opts?: JsonAwareOptions): void {
  if (jsonRequested(opts) || wantsJsonOutput()) {
    printJson(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

export function printFailure(
  error: CliError,
  opts?: JsonAwareOptions,
  exitCode?: number,
): void {
  render(fail(error), opts);
  process.exitCode = exitCode ?? exitCodeForError(error.code);
}

export async function runJsonAction<T>(
  action: () => Promise<T>,
  opts?: JsonAwareOptions,
  writeResult?: (data: T) => void,
): Promise<void> {
  try {
    const data = await action();
    render(ok(data), opts);
    if (writeResult) writeResult(data);
  } catch (err) {
    printFailure(makeError(err), opts);
  }
}

export function handleParseFailure(error: unknown): void {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) {
      process.exitCode = 0;
      return;
    }
    printFailure(codeError("VALIDATION", error.message));
    return;
  }
  printFailure(makeError(error));
}

export function configureParserContract(command: Command): void {
  command.exitOverride();
  command.showHelpAfterError(false);
  for (const sub of command.commands) {
    configureParserContract(sub);
  }
}

// --- Appended by task 005, once src/vanta-api.ts and src/paginate.ts exist
// for these helpers to reference (spec.md D4/D5, round-1 finding 11). ---

/**
 * Mints or reuses a token for `scopeUnion` (via `ensureToken`, the only
 * function in this codebase that mints one), then constructs a
 * `VantaApiClient` around a plain bearer-token string. Performs no host
 * check itself: `ensureToken` already ran `assertSafeApiBaseUrl` against
 * this same `apiBaseUrl` before minting or validating any token, so the
 * host is already proven safe by the time this constructs the client.
 * Every read command calls this exactly once, at the top of its action
 * handler, before making any request.
 */
export async function clientFor(scopeUnion: string[]): Promise<VantaApiClient> {
  const token = await ensureToken(scopeUnion);
  const { apiBaseUrl, allowUnsafeApiBaseUrl } = await resolveApiBaseUrl();
  return new VantaApiClient({
    apiBaseUrl,
    allowUnsafeApiBaseUrl,
    token: token.accessToken,
    userAgent: `vanta-cli/${getCliVersion()}`,
  });
}

/**
 * Parses a flag value as a positive integer, failing VALIDATION on
 * anything empty, non-numeric, zero, negative, or above `max`.
 */
export function parsePositiveInteger(value: string, label: string, max = 1000): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw codeError("VALIDATION", `${label} must be a positive integer, got an empty value.`);
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw codeError("VALIDATION", `${label} must be a positive integer, got "${value}".`);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw codeError(
      "VALIDATION",
      `${label} must be a positive integer between 1 and ${max}, got "${value}".`,
    );
  }
  return parsed;
}

/**
 * Splits each `key=value` pair on the first `=`, failing VALIDATION on a
 * malformed pair (no `=`, or an empty key). Used by `api get --query`
 * (task 006).
 */
export function parseQueryPairs(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      throw codeError(
        "VALIDATION",
        `--query value "${pair}" is malformed; expected key=value with a non-empty key.`,
      );
    }
    const key = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    result[key] = value;
  }
  return result;
}

/**
 * The standard commander.js multi-flag accumulator, used by
 * `--link-control-id` (task 008b) and `--query` (task 006).
 */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * The single place that converts `paginate.ts`'s never-throwing
 * `PaginationResult` into a thrown `CliError` for a typed read command
 * (spec.md D3's "callers must not assume a throw" note). Every `list`
 * subcommand in `reads-a.ts`/`reads-b.ts` calls this immediately after
 * `client.paginate(...)`, before summarizing.
 */
export function unwrapPaginated<T>(result: PaginationResult<T>, sourceLabel: string): T[] {
  if (result.error) {
    const code = toErrorCode(result.error);
    throw codeError(code, `${sourceLabel}: ${result.error.message}`, { detail: result.error });
  }
  return result.rows;
}
