/**
 * Typed read commands, group A: `frameworks`, `controls`, `tests`,
 * `documents`, `policies` (spec.md D5). Each `register*Command(program)`
 * function creates its own `program.command("<name>")`, which attaches it
 * to `program` immediately, and returns that same, already-attached
 * `Command` instance; there is no separate `program.addCommand` step
 * anywhere in this file, since that would attach the command a second
 * time. Task 008b extends the returned `controls`/`documents` instances
 * (held by whoever called the register function, or re-derived via
 * `program.commands.find(c => c.name() === "controls")`) to add write
 * subcommands later; this file adds read subcommands only.
 */

import { Command } from "commander";
import { SCOPE_READ } from "./config.js";
import { codeError } from "./output.js";
import { clientFor, parsePositiveInteger, runJsonAction, unwrapPaginated } from "./cli-runtime.js";
import { fetchControlsWithStatus } from "./report-helpers.js";
import { safeRowMeta } from "./safety.js";
import {
  summarizeControls,
  summarizeDocumentLinks,
  summarizeDocumentUploads,
  summarizeDocuments,
  summarizeFrameworkDetail,
  summarizeFrameworks,
  summarizePolicies,
  summarizeTestEntities,
  summarizeTests,
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
 * `summaries.ts` (task 004) exports one `summarize<Resource>(rows: T[])`
 * function per list resource, plus one detail-shaped exception
 * (`summarizeFrameworkDetail`); this is how every other single-object
 * `get` command in this file reuses its resource's list summarizer
 * instead of a detail summarizer that does not exist.
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

// --- frameworks (endpoint reference lines 8-20) -----------------------------

export function registerFrameworksCommand(program: Command): Command {
  const cmd = program.command("frameworks").description("Read Vanta compliance frameworks.");

  pagingOptions(
    cmd.command("list").description("List available frameworks."),
  ).action(async (opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate("frameworks", {}, { all: opts.all, limit: opts.limit });
      const rows = unwrapPaginated(result, "frameworks list");
      return opts.raw ? rows : summarizeFrameworks(rows);
    }, opts);
  });

  getOptions(
    cmd.command("get <id>").description("Get a framework by ID."),
  ).action(async (id: string, opts: GetOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const raw = await client.get(`frameworks/${id}`);
      return opts.raw ? raw : summarizeFrameworkDetail(raw);
    }, opts);
  });

  pagingOptions(
    cmd
      .command("controls <id>")
      .description("List a framework's controls (base shape, no status)."),
  ).action(async (id: string, opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        `frameworks/${id}/controls`,
        {},
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "frameworks controls");
      return opts.raw ? rows : summarizeControls(rows);
    }, opts);
  });

  return cmd;
}

// --- controls (endpoint reference lines 28-54) ------------------------------

export function registerControlsCommand(program: Command): Command {
  const cmd = program.command("controls").description("Read Vanta controls.");

  pagingOptions(
    cmd
      .command("list")
      .description(
        "List controls. Without --with-status: base rows, no status field. " +
          "With --with-status: detail-fetches status per control, sequentially, " +
          "through the throttled client (45 requests/minute); at that rate, " +
          "detail-fetching roughly 75 controls costs about two minutes of wall time.",
      )
      .option("--framework <id>", "Restrict to this framework id.")
      .option(
        "--with-status",
        "Detail-fetch status/numDocumentsPassing/numTestsPassing per control " +
          "(rate cost: about two minutes for ~75 controls at 45 requests/minute).",
      ),
  ).action(async (opts: ListOpts & { framework?: string; withStatus?: boolean }) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);

      if (!opts.withStatus) {
        const result = await client.paginate(
          "controls",
          { frameworkMatchesAny: opts.framework ? [opts.framework] : undefined },
          { all: opts.all, limit: opts.limit },
        );
        const rows = unwrapPaginated(result, "controls list");
        return opts.raw ? rows : summarizeControls(rows);
      }

      let frameworkId = opts.framework;
      if (!frameworkId) {
        const frameworksResult = await client.paginate("frameworks", {}, { all: true, limit: 1000 });
        const frameworks = unwrapPaginated(frameworksResult, "controls list (resolving --framework)");
        if (frameworks.length !== 1) {
          throw codeError(
            "VALIDATION",
            "controls list --with-status requires --framework unless the tenant has exactly one framework.",
          );
        }
        frameworkId = (frameworks[0] as { id: string }).id;
      }

      const detail = await fetchControlsWithStatus(client, frameworkId, {
        all: opts.all,
        limit: opts.limit,
      });

      // fetchControlsWithStatus (src/report-helpers.ts:266-300) records a
      // per-control detail-fetch failure in `detail.errors` rather than
      // stopping the loop; mirror that here instead of recomputing it, so
      // a failed fetch is never presented as a successfully enriched row.
      const failedCodeByControlId = new Map(detail.errors.map((e) => [e.controlId, e.code]));
      const completenessErrors = detail.errors.map((e) => {
        const index = detail.controls.findIndex((c) => c.id === e.controlId);
        const ref = index >= 0 ? String(safeRowMeta("control", index, detail.controls[index]).ref) : null;
        return { ref, code: e.code };
      });
      const completeness = {
        controlDetailTotal: detail.controlDetailTotal,
        controlDetailFetched: detail.controlDetailFetched,
        complete: detail.errors.length === 0,
        errors: completenessErrors,
      };

      if (detail.controlDetailTotal > 0 && detail.controlDetailFetched === 0) {
        throw codeError(
          "CHECK_FAILED",
          "controls list --with-status: every control's detail fetch failed.",
          { detail: completeness },
        );
      }

      const rows: Record<string, unknown>[] = opts.raw
        ? detail.controls.map((c) => ({ ...c }))
        : (summarizeControls(detail.controls) as Record<string, unknown>[]);
      detail.controls.forEach((control, index) => {
        const code = failedCodeByControlId.get(control.id);
        if (code !== undefined) {
          rows[index].status = null;
          rows[index].detailError = code;
        }
      });

      return { rows, completeness };
    }, opts);
  });

  getOptions(
    cmd.command("get <id>").description("Get a control by ID (already has status)."),
  ).action(async (id: string, opts: GetOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const raw = await client.get(`controls/${id}`);
      return opts.raw ? raw : summarizeOne(raw, summarizeControls);
    }, opts);
  });

  pagingOptions(
    cmd.command("tests <id>").description("List a control's tests."),
  ).action(async (id: string, opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(`controls/${id}/tests`, {}, { all: opts.all, limit: opts.limit });
      const rows = unwrapPaginated(result, "controls tests");
      return opts.raw ? rows : summarizeTests(rows);
    }, opts);
  });

  pagingOptions(
    cmd
      .command("documents <id>")
      .description("List a control's documents (response rows are Document-shaped)."),
  ).action(async (id: string, opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        `controls/${id}/documents`,
        {},
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "controls documents");
      return opts.raw ? rows : summarizeDocuments(rows);
    }, opts);
  });

  return cmd;
}

// --- tests (endpoint reference lines 68-80) ---------------------------------

const TEST_STATUS_VALUES = [
  "OK",
  "DEACTIVATED",
  "NEEDS_ATTENTION",
  "IN_PROGRESS",
  "INVALID",
  "NOT_APPLICABLE",
] as const;

const TEST_CATEGORY_FILTER_VALUES = [
  "ACCOUNTS_ACCESS",
  "ACCOUNT_SECURITY",
  "ACCOUNT_SETUP",
  "COMPUTERS",
  "CUSTOM",
  "DATA_STORAGE",
  "EMPLOYEES",
  "INFRASTRUCTURE",
  "IT",
  "LOGGING",
  "MONITORING_ALERTS",
  "PEOPLE",
  "POLICIES",
  "RISK_ANALYSIS",
  "SECURITY_ALERT_MANAGEMENT",
  "SOFTWARE_DEVELOPMENT",
  "VENDORS",
  "VULNERABILITY_MANAGEMENT",
] as const;

const TEST_ENTITY_STATUS_VALUES = ["FAILING", "DEACTIVATED"] as const;

export function registerTestsCommand(program: Command): Command {
  const cmd = program.command("tests").description("Read Vanta tests.");

  pagingOptions(
    cmd
      .command("list")
      .description("List tests.")
      .option("--status <status>", `Filter by test status (${TEST_STATUS_VALUES.join("|")}).`)
      .option("--framework <id>", "Filter by framework id.")
      .option(
        "--category <category>",
        `Filter by test category (${TEST_CATEGORY_FILTER_VALUES.join("|")}).`,
      )
      .option("--integration <id>", "Filter by integration id."),
  ).action(
    async (
      opts: ListOpts & { status?: string; framework?: string; category?: string; integration?: string },
    ) => {
      await runJsonAction(async () => {
        validateEnum(opts.status, TEST_STATUS_VALUES, "--status");
        validateEnum(opts.category, TEST_CATEGORY_FILTER_VALUES, "--category");
        const client = await clientFor([SCOPE_READ]);
        const result = await client.paginate(
          "tests",
          {
            statusFilter: opts.status,
            frameworkFilter: opts.framework,
            categoryFilter: opts.category,
            integrationFilter: opts.integration,
          },
          { all: opts.all, limit: opts.limit },
        );
        const rows = unwrapPaginated(result, "tests list");
        return opts.raw ? rows : summarizeTests(rows);
      }, opts);
    },
  );

  getOptions(
    cmd.command("get <id>").description("Get a test by ID."),
  ).action(async (id: string, opts: GetOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const raw = await client.get(`tests/${id}`);
      return opts.raw ? raw : summarizeOne(raw, summarizeTests);
    }, opts);
  });

  pagingOptions(
    cmd
      .command("entities <id>")
      .description("Get a test's entities by test ID.")
      .option(
        "--entity-status <status>",
        `Filter by entity status (${TEST_ENTITY_STATUS_VALUES.join("|")}).`,
      ),
  ).action(async (id: string, opts: ListOpts & { entityStatus?: string }) => {
    await runJsonAction(async () => {
      validateEnum(opts.entityStatus, TEST_ENTITY_STATUS_VALUES, "--entity-status");
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        `tests/${id}/entities`,
        { entityStatus: opts.entityStatus },
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "tests entities");
      return opts.raw ? rows : summarizeTestEntities(rows);
    }, opts);
  });

  return cmd;
}

// --- documents (endpoint reference lines 88-126) ----------------------------

const DOCUMENT_STATUS_VALUES = ["Needs document", "Needs update", "Not relevant", "OK"] as const;

export function registerDocumentsCommand(program: Command): Command {
  const cmd = program.command("documents").description("Read Vanta documents.");

  pagingOptions(
    cmd
      .command("list")
      .description("List documents.")
      .option("--status <status>", `Filter by document status (${DOCUMENT_STATUS_VALUES.join("|")}).`)
      .option("--framework <id>", "Filter by framework id."),
  ).action(async (opts: ListOpts & { status?: string; framework?: string }) => {
    await runJsonAction(async () => {
      validateEnum(opts.status, DOCUMENT_STATUS_VALUES, "--status");
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        "documents",
        {
          statusMatchesAny: opts.status ? [opts.status] : undefined,
          frameworkMatchesAny: opts.framework ? [opts.framework] : undefined,
        },
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "documents list");
      return opts.raw ? rows : summarizeDocuments(rows);
    }, opts);
  });

  getOptions(
    cmd.command("get <id>").description("Get a document by ID."),
  ).action(async (id: string, opts: GetOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const raw = await client.get(`documents/${id}`);
      return opts.raw ? raw : summarizeOne(raw, summarizeDocuments);
    }, opts);
  });

  pagingOptions(
    cmd.command("uploads <id>").description("List a document's uploads."),
  ).action(async (id: string, opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        `documents/${id}/uploads`,
        {},
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "documents uploads");
      return opts.raw ? rows : summarizeDocumentUploads(rows);
    }, opts);
  });

  pagingOptions(
    cmd
      .command("controls <id>")
      .description(
        "List a document's controls (response schema is PaginatedResponse_Control_, " +
          "Control-shaped rows, not Document-shaped).",
      ),
  ).action(async (id: string, opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        `documents/${id}/controls`,
        {},
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "documents controls");
      return opts.raw ? rows : summarizeControls(rows);
    }, opts);
  });

  pagingOptions(
    cmd.command("links <id>").description("List a document's links."),
  ).action(async (id: string, opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate(
        `documents/${id}/links`,
        {},
        { all: opts.all, limit: opts.limit },
      );
      const rows = unwrapPaginated(result, "documents links");
      return opts.raw ? rows : summarizeDocumentLinks(rows);
    }, opts);
  });

  return cmd;
}

// --- policies (endpoint reference lines 128-135) ----------------------------

export function registerPoliciesCommand(program: Command): Command {
  const cmd = program.command("policies").description("Read Vanta policies.");

  pagingOptions(
    cmd.command("list").description("List policies."),
  ).action(async (opts: ListOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const result = await client.paginate("policies", {}, { all: opts.all, limit: opts.limit });
      const rows = unwrapPaginated(result, "policies list");
      return opts.raw ? rows : summarizePolicies(rows);
    }, opts);
  });

  getOptions(
    cmd.command("get <id>").description("Get a policy by ID."),
  ).action(async (id: string, opts: GetOpts) => {
    await runJsonAction(async () => {
      const client = await clientFor([SCOPE_READ]);
      const raw = await client.get(`policies/${id}`);
      return opts.raw ? raw : summarizeOne(raw, summarizePolicies);
    }, opts);
  });

  return cmd;
}
