#!/usr/bin/env node
import { Command } from "commander";
import * as auth from "./auth.js";
import { SCOPE_READ } from "./config.js";
import { registerLedgerCommand } from "./ledger.js";
import { codeError } from "./output.js";
import {
  configureParserContract,
  getCliVersion,
  handleParseFailure,
  runJsonAction,
} from "./cli-runtime.js";
import {
  registerControlsCommand,
  registerDocumentsCommand,
  registerFrameworksCommand,
  registerPoliciesCommand,
  registerTestsCommand,
} from "./reads-a.js";
import {
  registerApiCommand,
  registerIntegrationsCommand,
  registerPeopleCommand,
  registerRiskScenariosCommand,
  registerUsersCommand,
  registerVendorsCommand,
} from "./reads-b.js";
import { registerControlWriteCommands, registerDocumentWriteCommands } from "./writes.js";
import { registerEvidenceCommand, registerSoc2Command } from "./reports.js";

const program = new Command();
program
  .name("vanta")
  .description("Agent-first CLI for the official Vanta Manage API")
  .version(getCliVersion());

const authCmd = program
  .command("auth")
  .description("Manage Vanta OAuth credentials, cached tokens, and process locks.");

authCmd
  .command("login")
  .description("Reuse a cached token or mint a new one from the resolved credentials.")
  .option("--env-file <path>", "Read the client id/secret from this env file.")
  .option("--force-mint", "Mint a fresh token even if a valid one is cached.")
  .option("--json", "Print machine-readable JSON output.")
  .action(async (opts: { envFile?: string; forceMint?: boolean; json?: boolean }) => {
    await runJsonAction(
      () => auth.login({ envFile: opts.envFile, forceMint: Boolean(opts.forceMint) }),
      opts,
    );
  });

authCmd
  .command("status")
  .description("Report configured credentials and cached token state.")
  .option("--json", "Print machine-readable JSON output.")
  .action(async (opts: { json?: boolean }) => {
    await runJsonAction(() => auth.status(), opts);
  });

authCmd
  .command("clear")
  .description("Delete the saved config file (credentials and cached token) and any stale temp files.")
  .option("--json", "Print machine-readable JSON output.")
  .action(async (opts: { json?: boolean }) => {
    await runJsonAction(async () => {
      const result = await auth.clear();
      if (result.failures.length > 0) {
        throw codeError(
          "CHECK_FAILED",
          `${result.failures.length} stale config temp file(s) could not be removed`,
          { detail: { failures: result.failures } },
        );
      }
      return { configRemoved: result.configRemoved, tempFilesRemoved: result.tempFilesRemoved };
    }, opts);
  });

authCmd
  .command("unlock")
  .description("Clear a dead or malformed process lock; --force clears a live one too.")
  .option("--force", "Clear a lock even if its owning process is still running.")
  .option("--json", "Print machine-readable JSON output.")
  .action(async (opts: { force?: boolean; json?: boolean }) => {
    await runJsonAction(() => auth.unlock({ force: Boolean(opts.force) }), opts);
  });

program
  .command("doctor")
  .description("Verify Vanta credentials and connectivity against the configured API host.")
  .option("--json", "Print machine-readable JSON output.")
  .action(async (opts: { json?: boolean }) => {
    await runJsonAction(async () => {
      const report = await auth.status();
      await auth.ensureToken([SCOPE_READ]);
      return report;
    }, opts);
  });

registerFrameworksCommand(program);
const controlsCmd = registerControlsCommand(program);
registerTestsCommand(program);
const documentsCmd = registerDocumentsCommand(program);
registerPoliciesCommand(program);

registerDocumentWriteCommands(documentsCmd);
registerControlWriteCommands(controlsCmd);

registerPeopleCommand(program);
registerUsersCommand(program);
registerVendorsCommand(program);
registerRiskScenariosCommand(program);
registerIntegrationsCommand(program);
registerApiCommand(program);

registerLedgerCommand(program);

registerSoc2Command(program);
registerEvidenceCommand(program);

configureParserContract(program);
program.parseAsync(process.argv).catch(handleParseFailure);
