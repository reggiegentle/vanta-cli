/**
 * CLI-wide runtime helpers shared by every command. Owned entirely by
 * task 002; task 005 appends clientFor/parsePositiveInteger/
 * parseQueryPairs/collect/unwrapPaginated once vanta-api.ts exists.
 */

import { createRequire } from "node:module";
import { CommanderError, type Command } from "commander";
import { resolveCredentials, readConfig } from "./config.js";
import {
  codeError,
  exitCodeForError,
  fail,
  makeError,
  ok,
  printJson,
  type CliError,
} from "./output.js";

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
