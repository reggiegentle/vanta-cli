/**
 * Typed read commands, group B: `people`, `users`, `vendors`,
 * `risk-scenarios`, `integrations`, plus the `api get` raw-passthrough
 * escape hatch (spec.md D6). Each `register*Command(program)` function
 * creates its own `program.command("<name>")`, which attaches it to
 * `program` immediately, and returns that same, already-attached
 * `Command` instance; there is no separate `program.addCommand` step
 * anywhere in this file, since that would attach the command a second
 * time.
 */

import { Command } from "commander";
import { SCOPE_READ } from "./config.js";
import { codeError } from "./output.js";
import {
  clientFor,
  collect,
  parsePositiveInteger,
  parseQueryPairs,
  runJsonAction,
  unwrapPaginated,
} from "./cli-runtime.js";
import {
  summarizeIntegrations,
  summarizePeople,
  summarizeRiskScenarios,
  summarizeUsers,
  summarizeVendors,
} from "./summaries.js";

interface ListOpts {
  limit: number;
  all?: boolean;
  raw?: boolean;
  json?: boolean;
}

interface GetOpts {
  raw?: boolean;
  json?: boolean;
}

function limitOption(cmd: Command): Command {
  return cmd.option(
    "--limit <n>",
    "Maximum rows to return for this invocation (default 100).",
    (value: string) => parsePositiveInteger(value, "--limit"),
    100,
  );
}

function pagingOptions(cmd: Command): Command {
  return limitOption(cmd)
    .option("--all", "Walk every page instead of stopping at --limit.")
    .option("--raw", "Skip summarization and print the upstream rows as-is.")
    .option("--json", "Print machine-readable JSON output.");
}

function getOptions(cmd: Command): Command {
  return cmd
    .option("--raw", "Skip summarization and print the upstream row as-is.")
    .option("--json", "Print machine-readable JSON output.");
}

/**
 * Wraps a single detail-shaped object as the one-element list a
 * `summaries.ts` list-summarizer expects, then unwraps its sole result.
 * Mirrors `reads-a.ts`'s helper of the same name; kept as a local copy
 * here since `reads-a.ts` does not export it.
 */
function summarizeOne(raw: unknown, summarizeMany: (rows: unknown[]) => unknown[]): unknown {
  return summarizeMany([raw])[0];
}

function validateEnum(
  value: string | undefined,
  allowed: readonly string[],
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw codeError("VALIDATION", `${label} must be one of: ${allowed.join(", ")}. Got "${value}".`);
  }
  return value;
}

// --- people (endpoint reference lines 137-144) ------------------------------

const PEOPLE_TASK_STATUS_VALUES = [
  "COMPLETE",
  "DUE_SOON",
  "NONE",
  "OFFBOARDING_COMPLETE",
  "OFFBOARDING_DUE_SOON",
  "OFFBOARDING_OVERDUE",
  "OVERDUE",
  "PAUSED",
] as const;

const PEOPLE_TASK_TYPE_VALUES = [
  "COMPLETE_TRAININGS",
  "ACCEPT_POLICIES",
  "COMPLETE_CUSTOM_TASKS",
  "COMPLETE_CUSTOM_OFFBOARDING_TASKS",
  "INSTALL_DEVICE_MONITORING",
  "COMPLETE_BACKGROUND_CHECKS",
] as const;

const PEOPLE_EMPLOYMENT_STATUS_VALUES = [
  "UPCOMING",
  "CURRENT",
  "ON_LEAVE",
  "INACTIVE",
  "FORMER",
] as const;

export function registerPeopleCommand(program: Command): Command {
  const cmd = program.command("people").description("Read Vanta people.");

  pagingOptions(
    cmd
      .command("list")
      .description("List people.")
      .option(
        "--task-status <status>",
        `Filter by tasks summary status (${PEOPLE_TASK_STATUS_VALUES.join("|")}).`,
      )
      .option("--task-type <type>", `Filter by task type (${PEOPLE_TASK_TYPE_VALUES.join("|")}).`)
      .option(
        "--employment-status <status>",
        `Filter by employment status (${PEOPLE_EMPLOYMENT_STATUS_VALUES.join("|")}).`,
      ),
  ).action(
    async (
      opts: ListOpts & { taskStatus?: string; taskType?: string; employmentStatus?: string },
    ) => {
      await runJsonAction(async () => {
        validateEnum(opts.taskStatus, PEOPLE_TASK_STATUS_VALUES, "--task-status");
        validateEnum(opts.taskType, PEOPLE_TASK_TYPE_VALUES, "--task-type");
        validateEnum(opts.employmentStatus, PEOPLE_EMPLOYMENT_STATUS_VALUES, "--employment-status");
        const client = await clientFor([SCOPE_READ]);
        const result = await client.paginate(
          "people",
          {
            tasksSummaryStatusMatchesAny: opts.taskStatus ? [opts.taskStatus] : undefined,
            taskTypeMatchesAny: opts.taskType ? [opts.taskType] : undefined,
            employmentStatus: opts.employmentStatus,
          },
          { all: opts.all, limit: opts.limit },
        );
        const rows = unwrapPaginated(result, "people list");
        return opts.raw ? rows : summarizePeople(rows);
      }, opts);
    },
  );

  getOptions(
    cmd.command("get <id>").description("Get a person by ID."),
  ).action(async (id: string, opts: GetOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const raw = await client.get(`people/${id}`);
      return opts.raw ? raw : summarizeOne(raw, summarizePeople);
    }, opts);
  });

  return cmd;
}

// --- users (endpoint reference lines 163-166) -------------------------------

export function registerUsersCommand(program: Command): Command {
  const cmd = program.command("users").description("Read Vanta users.");

  pagingOptions(
    cmd.command("list").description("List active users."),
  ).action(async (opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate("users", {}, { all: opts.all, limit: opts.limit });
      const rows = unwrapPaginated(result, "users list");
      return opts.raw ? rows : summarizeUsers(rows);
    }, opts);
  });

  return cmd;
}

// --- vendors (endpoint reference lines 174-181) -----------------------------

const VENDOR_STATUS_VALUES = ["MANAGED", "ARCHIVED", "IN_PROCUREMENT"] as const;

export function registerVendorsCommand(program: Command): Command {
  const cmd = program.command("vendors").description("Read Vanta vendors.");

  pagingOptions(
    cmd
      .command("list")
      .description("List vendors.")
      .option("--name <name>", "Filter by vendor name.")
      .option("--status <status>", `Filter by vendor status (${VENDOR_STATUS_VALUES.join("|")}).`),
  ).action(async (opts: ListOpts & { name?: string; status?: string }) => {
    await runJsonAction(async () => {
      validateEnum(opts.status, VENDOR_STATUS_VALUES, "--status");
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        "vendors",
        {
          name: opts.name,
          statusMatchesAny: opts.status ? [opts.status] : undefined,
        },
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "vendors list");
      return opts.raw ? rows : summarizeVendors(rows);
    }, opts);
  });

  getOptions(
    cmd.command("get <id>").description("Get a vendor by ID."),
  ).action(async (id: string, opts: GetOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const raw = await client.get(`vendors/${id}`);
      return opts.raw ? raw : summarizeOne(raw, summarizeVendors);
    }, opts);
  });

  return cmd;
}

// --- risk-scenarios (endpoint reference lines 192-195) ----------------------

const RISK_SCENARIO_TYPE_VALUES = ["Risk Scenario", "Enterprise Risk"] as const;

const RISK_SCENARIO_REVIEW_STATUS_VALUES = [
  "APPROVED",
  "DRAFT",
  "NOT_REVIEWED",
  "AWAITING_SUBMISSION",
  "PENDING_APPROVAL",
  "REQUESTED_CHANGES",
] as const;

export function registerRiskScenariosCommand(program: Command): Command {
  const cmd = program.command("risk-scenarios").description("Read Vanta risk scenarios.");

  pagingOptions(
    cmd
      .command("list")
      .description("List risk scenarios.")
      .option("--type <type>", `Filter by risk scenario type (${RISK_SCENARIO_TYPE_VALUES.join("|")}).`)
      .option(
        "--review-status <status>",
        `Filter by review status (${RISK_SCENARIO_REVIEW_STATUS_VALUES.join("|")}).`,
      ),
  ).action(async (opts: ListOpts & { type?: string; reviewStatus?: string }) => {
    await runJsonAction(async () => {
      validateEnum(opts.type, RISK_SCENARIO_TYPE_VALUES, "--type");
      validateEnum(opts.reviewStatus, RISK_SCENARIO_REVIEW_STATUS_VALUES, "--review-status");
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        "risk-scenarios",
        {
          type: opts.type,
          reviewStatusMatchesAny: opts.reviewStatus ? [opts.reviewStatus] : undefined,
        },
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "risk-scenarios list");
      return opts.raw ? rows : summarizeRiskScenarios(rows);
    }, opts);
  });

  return cmd;
}

// --- integrations (endpoint reference lines 203-206) ------------------------

export function registerIntegrationsCommand(program: Command): Command {
  const cmd = program.command("integrations").description("Read Vanta connected integrations.");

  pagingOptions(
    cmd.command("list").description("List connected integrations."),
  ).action(async (opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate("integrations", {}, { all: opts.all, limit: opts.limit });
      const rows = unwrapPaginated(result, "integrations list");
      return opts.raw ? rows : summarizeIntegrations(rows);
    }, opts);
  });

  return cmd;
}

// --- api (raw passthrough escape hatch, spec.md R3/D6) ----------------------

interface ApiGetOpts {
  query: string[];
  unsafeRaw?: boolean;
  json?: boolean;
}

export function registerApiCommand(program: Command): Command {
  const cmd = program.command("api").description("Raw passthrough to the Vanta Manage API.");

  cmd
    .command("get <path>")
    .description(
      "GET an arbitrary Manage API path. Requires --unsafe-raw. Never summarized: this " +
        "command's entire purpose is raw passthrough, gated by the flag instead of by " +
        "summarization.",
    )
    .option("--query <pair>", "A key=value query parameter (repeatable).", collect, [] as string[])
    .option(
      "--unsafe-raw",
      "Required acknowledgement that this call bypasses every typed read command's " +
        "summarization and validation.",
    )
    .option("--json", "Print machine-readable JSON output.")
    .action(async (path: string, opts: ApiGetOpts) => {
      await runJsonAction(async () => {
        if (!opts.unsafeRaw) {
          throw codeError("VALIDATION", "api get requires --unsafe-raw.");
        }
        const query = parseQueryPairs(opts.query);
        const client = await clientFor([SCOPE_READ]);
        return client.getRaw(path, query);
      }, opts);
    });

  return cmd;
}
