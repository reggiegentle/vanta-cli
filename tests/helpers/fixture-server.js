/**
 * Synthetic Vanta Manage API fixture server (task 009a). Loopback-only,
 * no dependencies beyond node:http, node:crypto, and node:fs. Every
 * mutable route keeps its own in-memory state so a readback GET genuinely
 * observes what a preceding write just did.
 *
 * Routing: mirrors production exactly. Every Manage API route is served
 * under /v1 (`fixture.apiBaseUrl`, i.e. `${fixture.url}/v1`, is what tests
 * set VANTA_API_BASE_URL to), matching https://api.vanta.com/v1; a
 * request missing that prefix 404s, the same way a path-join regression
 * in vanta-api.ts's buildUrl would against the real host. /oauth/token is
 * the one exception, served at the origin root (`fixture.tokenUrl`),
 * matching https://api.vanta.com/oauth/token. Internally, the /v1 prefix
 * is stripped down to the bare resource path (e.g. "frameworks",
 * "documents/document-001/uploads") immediately, before any hook lookup
 * or route dispatch: every hook (forceNextResponse, forceReadbackMiss,
 * delayNextResponse, chmodBeforeResponding, forceIncompletePage,
 * forceUploadFailure, forceSubmitNoOp) is keyed by that same bare form,
 * never the /v1-prefixed wire path, and every route-matching regex in
 * computeGet/handlePost matches against it too. `fixture.requests[]` is
 * the one exception to the stripping: it records each request's `path`
 * exactly as it arrived on the wire, /v1 prefix (or its absence) and all.
 *
 * Every response body handed back by computeGet or handlePost is a fresh
 * structuredClone, never a live reference into this file's own `state`
 * (see cloneBody): a single-object detail route (documents/{id},
 * controls/{id}, ...) used to return the exact object living in `state`,
 * so a forceReadbackMiss snapshot captured from it (see hook 5 below)
 * would silently "unstale" itself the moment a later write mutated that
 * same object in place. Cloning at computeGet/handlePost's own return
 * boundary fixes this for both of computeGet's callers (the ordinary GET
 * dispatch and the readback-miss snapshot capture) in one place.
 *
 * Hook composition order, applied identically to every route including
 * /oauth/token, in this fixed order:
 *   1. chmodBeforeResponding: a synchronous fs.chmodSync call that always
 *      runs, right before this server writes anything to the socket,
 *      regardless of what status/body ends up being sent.
 *   2. delayNextResponse: wraps the eventual send in a setTimeout. Runs
 *      after chmodBeforeResponding (so the chmod happens at the moment
 *      the request landed, not after the artificial delay) and before the
 *      response body is decided.
 *   3. forceNextResponse: an explicit status/body/headers override queue.
 *      When present for a path, it wins outright: no route handler runs,
 *      no readback-miss or incomplete-page snapshot is consulted.
 *   4. Route-specific one-shot hooks (forceUploadFailure for the uploads
 *      POST route, forceSubmitNoOp for the submit POST route).
 *   5. For GET routes only: forceReadbackMiss and forceIncompletePage.
 *      forceReadbackMiss is arm-and-wait, not capture-immediately: every
 *      write in writes.ts issues exactly two GETs to the same path (its
 *      own preRead, then its own postRead), so the *first* matching GET
 *      after arming is served live and its body is captured as the
 *      snapshot in flight; the *second* matching GET (the actual
 *      postRead, made after the mutating call already ran) is served
 *      that captured, now-stale snapshot instead of live state, which is
 *      exactly the readback miss a test wants to exercise. Capturing the
 *      snapshot at arm time instead would race the write itself, since
 *      arming always happens before the command's own preRead does.
 *      forceIncompletePage forces hasNextPage:true once, then a
 *      malformed follow-up page once.
 *   6. Normal, live handler.
 * If a test sets both forceNextResponse and one of the GET-only hooks on
 * the same path, forceNextResponse wins for that one request; the other
 * hook stays queued for the request after.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";

// --- Small helpers ----------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function normalizeKey(path) {
  return String(path).replace(/^\/+/, "");
}

function envelope(rows, hasNextPage, endCursor, hasPreviousPage, startCursor) {
  return {
    results: {
      data: rows,
      pageInfo: {
        endCursor: hasNextPage ? endCursor : null,
        hasNextPage: Boolean(hasNextPage),
        hasPreviousPage: Boolean(hasPreviousPage),
        startCursor: startCursor ?? null,
      },
    },
  };
}

const MAX_PAGE_SIZE = 100;

/**
 * Real, pageSize/cursor-driven pagination: this genuinely slices
 * `allRows` at the requested `query.pageSize` (default 100, capped at 100
 * to match the real API and the CLI's own MAX_PAGE_SIZE), not a fixed
 * per-resource chunk. `resourceCap`, when given, is this fixture's own
 * additional ceiling on top of whatever the caller asked for, used only
 * for "tests" (see RESOURCE_PAGE_SIZE_CAP below) so that resource keeps
 * spanning multiple pages even though the CLI's own paginate() always
 * requests pageSize=100 and has only 2 seeded rows to walk; every other
 * resource's effective page size is exactly what the caller requested,
 * which is what makes `?pageSize=1` over a two-row resource genuinely
 * yield two pages. `cursor` is a plain array offset encoded as a decimal
 * string; `hasPreviousPage`/`startCursor` are correct on every page, not
 * just the first.
 */
function paginateRows(allRows, query, resourceCap) {
  const requested = Number(query?.pageSize);
  const requestedSize = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 100;
  const cappedRequested = Math.min(requestedSize, MAX_PAGE_SIZE);
  const pageSize = resourceCap ? Math.min(cappedRequested, resourceCap) : cappedRequested;

  const cursor = query?.pageCursor ? Number(query.pageCursor) : 0;
  const start = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
  const end = Math.min(start + pageSize, allRows.length);
  const page = allRows.slice(start, end);
  const hasNextPage = end < allRows.length;
  const hasPreviousPage = start > 0;
  const startCursor = page.length > 0 ? String(start) : null;
  const endCursor = hasNextPage ? String(end) : null;
  return envelope(page, hasNextPage, endCursor, hasPreviousPage, startCursor);
}

// "tests" is the one resource with a fixture-imposed ceiling below the
// real 100 cap, so it still spans multiple pages under the CLI's own
// hardcoded pageSize=100 request (round-1 finding 9's --all pagination
// coverage); every other resource's page size is exactly what the caller
// requested, capped only at the real 100-row maximum.
const RESOURCE_PAGE_SIZE_CAP = { tests: 1 };

function makeUploadRow({ fileName, mimeType, effectiveAtDate, description }) {
  const id = crypto.randomUUID();
  return {
    id,
    fileName,
    title: fileName,
    description: description ?? null,
    mimeType: mimeType ?? "application/octet-stream",
    uploadedBy: { type: "APPLICATION", id: "fixture-app" },
    creationDate: nowIso(),
    updatedDate: nowIso(),
    deletionDate: null,
    effectiveDate: effectiveAtDate ?? null,
    url: `https://fixture.local/uploads/${id}`,
  };
}

function makeLinkRow({ url, title, description, effectiveDate }) {
  return {
    id: crypto.randomUUID(),
    creationDate: nowIso(),
    effectiveDate: effectiveDate ?? null,
    title,
    url,
    // UploadedLink.description is a required, non-nullable string (unlike
    // UploadedFileT.description, which is nullable): default to "", never
    // null, when the caller omits it.
    description: description ?? "",
  };
}

function controlBaseShape(control) {
  const {
    id,
    externalId,
    name,
    description,
    source,
    domains,
    owner,
    role,
    customFields,
    creationDate,
    modificationDate,
    implementationDetails,
  } = control;
  return {
    id,
    externalId,
    name,
    description,
    source,
    domains,
    owner,
    role,
    customFields,
    creationDate,
    modificationDate,
    implementationDetails,
  };
}

// The base `Document` schema: exactly these 9 fields, additionalProperties
// false. Used for every list/link-table route (documents list, documents
// controls, controls documents), never for the single-object detail route.
function documentShape(document) {
  const {
    id,
    ownerId,
    category,
    description,
    isSensitive,
    title,
    uploadStatus,
    uploadStatusDate,
    url,
  } = document;
  return {
    id,
    ownerId,
    category,
    description,
    isSensitive,
    title,
    uploadStatus,
    uploadStatusDate,
    url,
  };
}

// The `DocumentDetail` schema (GET documents/{id} only): every Document
// field plus deactivatedStatus, note, nextRenewalDate, renewalCadence,
// reminderWindow, subscribers, all required (additionalProperties false).
function documentDetailShape(document) {
  return {
    ...documentShape(document),
    deactivatedStatus: document.deactivatedStatus,
    note: document.note ?? null,
    nextRenewalDate: document.nextRenewalDate ?? null,
    renewalCadence: document.renewalCadence,
    reminderWindow: document.reminderWindow ?? null,
    subscribers: document.subscribers ?? [],
  };
}

// The base `Framework` schema (GET frameworks list): exactly the 10
// numeric/string summary fields, additionalProperties false;
// `requirementCategories` belongs only to `FrameworkDetail`.
function frameworkBaseShape(framework) {
  const {
    id,
    displayName,
    shorthandName,
    description,
    numControlsCompleted,
    numControlsTotal,
    numDocumentsPassing,
    numDocumentsTotal,
    numTestsPassing,
    numTestsTotal,
  } = framework;
  return {
    id,
    displayName,
    shorthandName,
    description,
    numControlsCompleted,
    numControlsTotal,
    numDocumentsPassing,
    numDocumentsTotal,
    numTestsPassing,
    numTestsTotal,
  };
}

// --- Person schema helpers (sources, tasksSummary.details) --------------

// PersonInfoSource is anyOf VantaBasedPersonInfoSource / ScimBasedPersonInfoSource /
// IntegrationBasedPersonInfoSource; the fixture only ever needs the Vanta variant.
function personInfoSourceVanta() {
  return { type: "VANTA" };
}

function personSources() {
  return {
    employment: { endDate: personInfoSourceVanta(), startDate: personInfoSourceVanta() },
    emailAddress: personInfoSourceVanta(),
  };
}

// Every TaskSummary variant (CompleteTrainingsTaskSummary, AcceptPoliciesTaskSummary,
// ...) shares these 5 required fields; each variant then adds its own
// required list fields, which the caller below supplies as empty arrays.
function baseTaskSummary(taskType, status) {
  return { taskType, status, dueDate: null, completionDate: null, disabled: null };
}

function makeTaskSummaryDetails({
  trainingsStatus,
  policiesStatus,
  customTasksStatus,
  offboardingTasksStatus,
  deviceMonitoringStatus,
  backgroundChecksStatus,
}) {
  return {
    completeTrainings: {
      ...baseTaskSummary("COMPLETE_TRAININGS", trainingsStatus),
      incompleteTrainings: [],
      completedTrainings: [],
    },
    acceptPolicies: {
      ...baseTaskSummary("ACCEPT_POLICIES", policiesStatus),
      unacceptedPolicies: [],
      acceptedPolicies: [],
    },
    completeCustomTasks: {
      ...baseTaskSummary("COMPLETE_CUSTOM_TASKS", customTasksStatus),
      incompleteCustomTasks: [],
      completedCustomTasks: [],
    },
    completeOffboardingCustomTasks: {
      ...baseTaskSummary("COMPLETE_CUSTOM_OFFBOARDING_TASKS", offboardingTasksStatus),
      incompleteCustomOffboardingTasks: [],
      completedCustomOffboardingTasks: [],
    },
    installDeviceMonitoring: baseTaskSummary("INSTALL_DEVICE_MONITORING", deviceMonitoringStatus),
    completeBackgroundChecks: baseTaskSummary("COMPLETE_BACKGROUND_CHECKS", backgroundChecksStatus),
  };
}

// --- Multipart/form-data parsing (documents upload) --------------------

function extractBoundary(contentType) {
  if (typeof contentType !== "string") return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return null;
  return (match[1] ?? match[2]).trim();
}

/**
 * Minimal multipart/form-data parser, enough for this fixture's needs:
 * one file part (field "file", carrying a filename and, usually, its own
 * Content-Type) plus a small number of plain text fields. Returns
 * { fields: Record<string,string>, file: {fileName, mimeType, bytes}|null }.
 */
function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;

  let searchFrom = 0;
  const partStarts = [];
  for (;;) {
    const idx = buffer.indexOf(delimiter, searchFrom);
    if (idx === -1) break;
    partStarts.push(idx);
    searchFrom = idx + delimiter.length;
  }

  for (let i = 0; i < partStarts.length - 1; i += 1) {
    let partStart = partStarts[i] + delimiter.length;
    const partEnd = partStarts[i + 1];
    // Skip the CRLF (or trailing "--" for the closing boundary) right
    // after the boundary marker itself.
    if (buffer[partStart] === 0x2d && buffer[partStart + 1] === 0x2d) continue; // "--" closing boundary
    if (buffer[partStart] === 0x0d && buffer[partStart + 1] === 0x0a) partStart += 2;

    const headerEnd = buffer.indexOf("\r\n\r\n", partStart);
    if (headerEnd === -1 || headerEnd > partEnd) continue;
    const headerText = buffer.slice(partStart, headerEnd).toString("utf8");
    // Body runs to just before the trailing "\r\n" that precedes the next
    // boundary delimiter.
    let bodyEnd = partEnd;
    if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const bodyBuffer = buffer.slice(headerEnd + 4, bodyEnd);

    const dispositionMatch = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
    if (!dispositionMatch) continue;
    const fieldName = dispositionMatch[1];
    const fileName = dispositionMatch[2];
    const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const partMimeType = contentTypeMatch ? contentTypeMatch[1].trim() : undefined;

    if (fileName !== undefined) {
      file = { fileName, mimeType: partMimeType, bytes: bodyBuffer.length };
    } else {
      fields[fieldName] = bodyBuffer.toString("utf8");
    }
  }

  return { fields, file };
}

// --- Seed data -----------------------------------------------------------

function buildInitialState() {
  const state = {
    frameworks: [
      {
        id: "framework-soc2",
        // Deliberately email-shaped: the aggregate report gate
        // (assertSafeAggregateReport) must never let this leak into
        // soc2 report output, and a test proves exactly that.
        displayName: "compliance-lead@acme.test",
        shorthandName: "SOC 2",
        description: "SOC 2 Type II framework for the fixture tenant.",
        numControlsCompleted: 1,
        numControlsTotal: 2,
        numDocumentsPassing: 1,
        numDocumentsTotal: 2,
        numTestsPassing: 1,
        numTestsTotal: 2,
        requirementCategories: [
          {
            id: "req-cat-001",
            name: "Access Control",
            shorthand: "AC",
            requirements: [],
          },
        ],
      },
    ],
    controls: [
      {
        id: "control-001",
        externalId: "EXT-001",
        name: "Access reviews are performed quarterly",
        description: "Quarterly review of access to production systems.",
        source: "Vanta",
        // ControlDomain enum value (round-1 gate finding: "ACCESS_CONTROL"
        // is not a member of that enum).
        domains: ["IDENTIFICATION_&_AUTHENTICATION"],
        owner: { id: "user-001", emailAddress: "alice@acme.test", displayName: "Alice Rivera" },
        role: null,
        customFields: [],
        creationDate: "2026-01-05T00:00:00.000Z",
        modificationDate: "2026-01-05T00:00:00.000Z",
        implementationDetails: "Reviewed via quarterly access audit.",
        status: "COMPLETED",
        numDocumentsPassing: 1,
        numDocumentsTotal: 1,
        numTestsPassing: 1,
        numTestsTotal: 1,
        note: null,
      },
      {
        id: "control-002",
        externalId: "EXT-002",
        name: "Production backups are encrypted at rest",
        description: "Backups of production data are encrypted at rest.",
        source: "Vanta",
        domains: ["CLOUD_SECURITY"],
        owner: { id: "user-002", emailAddress: "bao@acme.test", displayName: "Bao Tran" },
        role: null,
        customFields: [],
        creationDate: "2026-01-05T00:00:00.000Z",
        modificationDate: "2026-01-05T00:00:00.000Z",
        implementationDetails: "Encryption verified via cloud provider console.",
        status: "NOT_STARTED",
        numDocumentsPassing: 0,
        numDocumentsTotal: 1,
        numTestsPassing: 0,
        numTestsTotal: 1,
        note: null,
      },
    ],
    tests: [
      {
        id: "test-001",
        name: "MFA is enforced for all admin accounts",
        lastTestRunDate: "2026-09-01T00:00:00.000Z",
        latestFlipDate: "2026-08-01T00:00:00.000Z",
        description: "Checks that every admin account requires MFA.",
        // Test.failureDescription/remediationDescription are non-nullable
        // strings (round-1 gate audit); "" for a currently-passing test,
        // never null.
        failureDescription: "",
        remediationDescription: "",
        version: { major: 1, minor: 0 },
        category: "Account security",
        integrations: [],
        status: "OK",
        deactivatedStatusInfo: { isDeactivated: false, deactivatedReason: null, lastUpdatedDate: null },
        remediationStatusInfo: { status: "NA", soonestRemediateByDate: null, itemCount: 0 },
        owner: { id: "user-001", emailAddress: "alice@acme.test", displayName: "Alice Rivera" },
      },
      {
        id: "test-002",
        name: "Production database backups run daily",
        lastTestRunDate: "2026-09-01T00:00:00.000Z",
        latestFlipDate: "2026-07-15T00:00:00.000Z",
        description: "Checks that a backup job ran within the last 24 hours.",
        failureDescription: "No backup job recorded in the last 24 hours.",
        remediationDescription: "Investigate the backup scheduler.",
        version: { major: 1, minor: 0 },
        category: "Data storage",
        integrations: [],
        status: "NEEDS_ATTENTION",
        deactivatedStatusInfo: { isDeactivated: false, deactivatedReason: null, lastUpdatedDate: null },
        remediationStatusInfo: { status: "OVERDUE", soonestRemediateByDate: "2026-09-10T00:00:00.000Z", itemCount: 1 },
        owner: { id: "user-002", emailAddress: "bao@acme.test", displayName: "Bao Tran" },
      },
    ],
    testEntities: new Map([
      [
        "test-001",
        [
          {
            id: "entity-001",
            entityStatus: "FAILING",
            displayName: "jane@acme.test",
            responseType: "USER",
            deactivatedReason: null,
            lastUpdatedDate: "2026-09-01T00:00:00.000Z",
            createdDate: "2026-01-05T00:00:00.000Z",
          },
        ],
      ],
    ]),
    // Every document carries its DocumentDetail-only fields (deactivatedStatus,
    // note, nextRenewalDate, renewalCadence, reminderWindow, subscribers)
    // directly, even though the base Document shape (list/link-table routes)
    // strips them via documentShape(); only documentDetailShape() (GET
    // documents/{id}) reads them.
    documents: [
      {
        id: "document-001",
        ownerId: "user-001",
        category: "Account security",
        description: "The tenant's written access control policy.",
        isSensitive: false,
        title: "Access Control Policy",
        uploadStatus: "OK",
        uploadStatusDate: "2026-01-06T00:00:00.000Z",
        url: null,
        deactivatedStatus: { creationDate: "2026-01-06T00:00:00.000Z", expiration: null, reason: null, isDeactivated: false },
        note: null,
        nextRenewalDate: "2027-01-06T00:00:00.000Z",
        renewalCadence: "P1Y",
        reminderWindow: "P1M",
        subscribers: ["alice@acme.test"],
      },
      {
        id: "document-002",
        ownerId: "user-002",
        category: "Data storage",
        description: "Evidence that backups are encrypted at rest.",
        isSensitive: false,
        title: "Backup Encryption Evidence",
        uploadStatus: "Needs document",
        uploadStatusDate: null,
        url: null,
        deactivatedStatus: { creationDate: "2026-01-06T00:00:00.000Z", expiration: null, reason: null, isDeactivated: false },
        note: null,
        nextRenewalDate: null,
        renewalCadence: "P3M",
        reminderWindow: null,
        subscribers: [],
      },
    ],
    documentUploads: new Map([["document-001", []], ["document-002", []]]),
    documentLinks: new Map([["document-001", []], ["document-002", []]]),
    // Sets of documentId, keyed by controlId, and vice versa; both
    // directions are materialized from the same link state so `documents
    // controls` (Control-shaped) and `controls documents` (Document-shaped)
    // can never drift apart from each other.
    controlToDocumentIds: new Map([["control-001", new Set(["document-001"])], ["control-002", new Set()]]),
    documentToControlIds: new Map([["document-001", new Set(["control-001"])], ["document-002", new Set()]]),
    policies: [
      {
        id: "policy-001",
        name: "Acme Information Security Policy",
        description: "The tenant's top-level information security policy.",
        status: "OK",
        approvedAtDate: "2026-02-01T00:00:00.000Z",
        latestVersion: { status: "APPROVED" },
        // PolicyLatestApprovedVersion schema: {versionId, documents:[{language,slugId,url}]},
        // never an arbitrary {versionNumber} (round-1 gate finding).
        latestApprovedVersion: {
          versionId: "policy-001-v3",
          documents: [{ language: "EN", slugId: "acme-information-security-policy-v3", url: "https://fixture.local/policies/policy-001/v3" }],
        },
      },
    ],
    people: [
      {
        id: "person-001",
        userId: "user-001",
        emailAddress: "alice@acme.test",
        employment: { status: "CURRENT", startDate: "2024-03-01T00:00:00.000Z", jobTitle: "Security Engineer", endDate: null },
        leaveInfo: null,
        groupIds: [],
        name: { first: "Alice", last: "Rivera", display: "Alice Rivera" },
        sources: personSources(),
        tasksSummary: {
          status: "COMPLETE",
          dueDate: null,
          completionDate: "2026-01-15T00:00:00.000Z",
          details: makeTaskSummaryDetails({
            trainingsStatus: "COMPLETE",
            policiesStatus: "COMPLETE",
            customTasksStatus: "COMPLETE",
            offboardingTasksStatus: "NONE",
            deviceMonitoringStatus: "COMPLETE",
            backgroundChecksStatus: "COMPLETE",
          }),
        },
      },
      {
        id: "person-002",
        userId: "user-002",
        emailAddress: "bao@acme.test",
        employment: { status: "CURRENT", startDate: "2025-06-01T00:00:00.000Z", jobTitle: "Platform Engineer", endDate: null },
        leaveInfo: null,
        groupIds: [],
        name: { first: "Bao", last: "Tran", display: "Bao Tran" },
        sources: personSources(),
        tasksSummary: {
          status: "OVERDUE",
          dueDate: "2026-08-01T00:00:00.000Z",
          completionDate: null,
          details: makeTaskSummaryDetails({
            trainingsStatus: "OVERDUE",
            policiesStatus: "COMPLETE",
            customTasksStatus: "COMPLETE",
            offboardingTasksStatus: "NONE",
            deviceMonitoringStatus: "COMPLETE",
            backgroundChecksStatus: "COMPLETE",
          }),
        },
      },
    ],
    users: [
      { id: "user-001", email: "alice@acme.test", displayName: "Alice Rivera", isActive: true },
      { id: "user-002", email: "bao@acme.test", displayName: "Bao Tran", isActive: true },
    ],
    vendors: [
      {
        id: "vendor-001",
        name: "Acme Cloud Hosting",
        websiteUrl: "https://acme-cloud-hosting.test",
        accountManagerName: "Sam Okafor",
        accountManagerEmail: "sam@acme-cloud-hosting.test",
        servicesProvided: "Infrastructure hosting.",
        additionalNotes: null,
        securityOwnerUserId: "user-001",
        businessOwnerUserId: "user-002",
        contractStartDate: "2025-01-01T00:00:00.000Z",
        contractRenewalDate: "2027-01-01T00:00:00.000Z",
        contractTerminationDate: null,
        nextSecurityReviewDueDate: "2026-12-01T00:00:00.000Z",
        lastSecurityReviewCompletionDate: "2026-01-01T00:00:00.000Z",
        isVisibleToAuditors: true,
        isRiskAutoScored: false,
        riskAttributeIds: [],
        category: { displayName: "Infrastructure" },
        // Vendor.authDetails requires all 5 fields by name (round-1 gate
        // audit), each individually nullable but the key itself mandatory.
        authDetails: {
          passwordMinimumLength: 12,
          passwordRequiresSymbol: true,
          passwordRequiresNumber: true,
          passwordMFA: true,
          method: "SSO",
        },
        status: "MANAGED",
        inherentRiskLevel: "MEDIUM",
        residualRiskLevel: "LOW",
        vendorHeadquarters: "USA",
        contractAmount: { amount: 12000, currency: "USD" },
        customFields: [],
        latestDecision: null,
        linkedTaskTrackerTaskProcurementRequest: null,
      },
    ],
    riskScenarios: [
      {
        riskId: "risk-001",
        description: "Unauthorized access to production data.",
        detailedDescription: "An attacker gains access to production data through a compromised credential.",
        isSensitive: false,
        likelihood: 2,
        impact: 4,
        residualLikelihood: 1,
        residualImpact: 3,
        categories: ["Data security"],
        ciaCategories: ["Confidentiality"],
        treatment: "Mitigate",
        owner: "user-001",
        note: null,
        riskRegister: "primary",
        customFields: [],
        isArchived: false,
        reviewStatus: "APPROVED",
        requiredApprovers: [],
        type: "Risk Scenario",
        identificationDate: "2026-01-10T00:00:00.000Z",
        scoreBreakdown: [],
      },
    ],
    integrations: [
      {
        integrationId: "integration-001",
        displayName: "Acme Identity Provider",
        resourceKinds: ["USER"],
        // Connection schema: {connectionId, isDisabled, connectionErrorMessage}
        // (round-1 gate audit; this was previously {id, status}, which is
        // not the Connection shape at all).
        connections: [{ connectionId: "connection-001", isDisabled: false, connectionErrorMessage: null }],
      },
    ],
    tokenMintCount: 0,
    // Grows by one entry (the request body's client_id, or null when the
    // request had no parseable client_id) on every single hit to
    // /oauth/token, in lockstep with tokenMintCount, regardless of any
    // hook or override applied to that request's response.
    mintedClientIds: [],
  };
  return state;
}

// --- Server ---------------------------------------------------------------

export async function startFixtureServer(overrides = {}) {
  const state = buildInitialState();
  const requests = [];

  const tokenResponseQueue = Array.isArray(overrides.tokenResponses) ? [...overrides.tokenResponses] : null;
  const tokenResponseSingle =
    !Array.isArray(overrides.tokenResponses) && overrides.tokenResponses ? overrides.tokenResponses : null;

  const hooks = {
    forceNextResponse: new Map(), // key -> [{status, body, headers}]
    delayNextResponse: new Map(), // key -> [ms]
    chmodBeforeResponding: new Map(), // key -> [{targetPath, mode}]
    readbackMiss: new Map(), // key -> [snapshot bodies]
    incompletePage: new Map(), // key -> "armed" | "followup-pending"
    uploadFailures: new Set(), // fileNames
    submitNoOp: new Map(), // key -> remaining count
  };

  function shiftHook(map, key) {
    const queue = map.get(key);
    if (!queue || queue.length === 0) return undefined;
    const value = queue.shift();
    if (queue.length === 0) map.delete(key);
    return value;
  }

  // Every response body is a fresh, independent copy, never a live
  // reference into `state` (009d finding, round-2 fix): computeGet is
  // called from two places, the ordinary GET dispatch below and
  // applyReadbackMissIfArmed's own "capture the live body as tomorrow's
  // stale snapshot" step, and that snapshot must survive any later
  // mutation to the same underlying object untouched. structuredClone at
  // this single boundary covers both call sites and every route (list
  // rows built by paginateRows/documentShape/controlBaseShape are already
  // fresh top-level objects, but single-object detail routes like
  // controls/{id} previously returned the exact object living in
  // `state.controls`, so an in-place mutation from a later write, e.g.
  // controls set-owner reassigning `control.owner`, silently changed an
  // already-stashed "stale" snapshot too).
  function cloneBody(body) {
    return body === undefined ? undefined : structuredClone(body);
  }

  // --- Pure GET computation, reused for both real requests and the
  // readback-miss hook's own "serve live, then stash it" first step -----

  function computeGet(pathname, query) {
    const result = computeGetLive(pathname, query);
    return { status: result.status, body: cloneBody(result.body) };
  }

  function computeGetLive(pathname, query) {
    let match;

    if (pathname === "frameworks") {
      // Framework schema (list), not FrameworkDetail: no requirementCategories.
      const rows = state.frameworks.map(frameworkBaseShape);
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP.frameworks) };
    }
    if ((match = /^frameworks\/([^/]+)$/.exec(pathname))) {
      const fw = state.frameworks.find((f) => f.id === match[1]);
      if (!fw) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: fw };
    }
    if ((match = /^frameworks\/([^/]+)\/controls$/.exec(pathname))) {
      const rows = state.controls.map(controlBaseShape);
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP["frameworks/controls"]) };
    }
    if (pathname === "controls") {
      const rows = state.controls.map(controlBaseShape);
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP.controls) };
    }
    if ((match = /^controls\/([^/]+)$/.exec(pathname))) {
      const control = state.controls.find((c) => c.id === match[1]);
      if (!control) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: control };
    }
    if ((match = /^controls\/([^/]+)\/tests$/.exec(pathname))) {
      return { status: 200, body: paginateRows(state.tests, query, RESOURCE_PAGE_SIZE_CAP["controls/tests"]) };
    }
    if ((match = /^controls\/([^/]+)\/documents$/.exec(pathname))) {
      const controlId = match[1];
      const documentIds = state.controlToDocumentIds.get(controlId) ?? new Set();
      const rows = state.documents.filter((d) => documentIds.has(d.id)).map(documentShape);
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP["controls/documents"]) };
    }
    if (pathname === "tests") {
      return { status: 200, body: paginateRows(state.tests, query, RESOURCE_PAGE_SIZE_CAP.tests) };
    }
    if ((match = /^tests\/([^/]+)\/entities$/.exec(pathname))) {
      const rows = state.testEntities.get(match[1]) ?? [];
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP["tests/entities"]) };
    }
    if ((match = /^tests\/([^/]+)$/.exec(pathname))) {
      const test = state.tests.find((t) => t.id === match[1]);
      if (!test) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: test };
    }
    if (pathname === "documents") {
      const rows = state.documents.map(documentShape);
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP.documents) };
    }
    if ((match = /^documents\/([^/]+)\/uploads$/.exec(pathname))) {
      const rows = state.documentUploads.get(match[1]) ?? [];
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP["documents/uploads"]) };
    }
    if ((match = /^documents\/([^/]+)\/links$/.exec(pathname))) {
      const rows = state.documentLinks.get(match[1]) ?? [];
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP["documents/links"]) };
    }
    if ((match = /^documents\/([^/]+)\/controls$/.exec(pathname))) {
      const documentId = match[1];
      const controlIds = state.documentToControlIds.get(documentId) ?? new Set();
      const rows = state.controls.filter((c) => controlIds.has(c.id)).map(controlBaseShape);
      return { status: 200, body: paginateRows(rows, query, RESOURCE_PAGE_SIZE_CAP["documents/controls"]) };
    }
    if ((match = /^documents\/([^/]+)$/.exec(pathname))) {
      const document = state.documents.find((d) => d.id === match[1]);
      if (!document) return { status: 404, body: { error: "not_found" } };
      // DocumentDetail schema, not the base Document shape (round-1 gate
      // finding: every required DocumentDetail field, by name).
      return { status: 200, body: documentDetailShape(document) };
    }
    if (pathname === "policies") {
      return { status: 200, body: paginateRows(state.policies, query, RESOURCE_PAGE_SIZE_CAP.policies) };
    }
    if ((match = /^policies\/([^/]+)$/.exec(pathname))) {
      const policy = state.policies.find((p) => p.id === match[1]);
      if (!policy) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: policy };
    }
    if (pathname === "people") {
      return { status: 200, body: paginateRows(state.people, query, RESOURCE_PAGE_SIZE_CAP.people) };
    }
    if ((match = /^people\/([^/]+)$/.exec(pathname))) {
      const person = state.people.find((p) => p.id === match[1]);
      if (!person) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: person };
    }
    if (pathname === "users") {
      return { status: 200, body: paginateRows(state.users, query, RESOURCE_PAGE_SIZE_CAP.users) };
    }
    if (pathname === "vendors") {
      return { status: 200, body: paginateRows(state.vendors, query, RESOURCE_PAGE_SIZE_CAP.vendors) };
    }
    if ((match = /^vendors\/([^/]+)$/.exec(pathname))) {
      const vendor = state.vendors.find((v) => v.id === match[1]);
      if (!vendor) return { status: 404, body: { error: "not_found" } };
      return { status: 200, body: vendor };
    }
    if (pathname === "risk-scenarios") {
      return { status: 200, body: paginateRows(state.riskScenarios, query, RESOURCE_PAGE_SIZE_CAP["risk-scenarios"]) };
    }
    if (pathname === "integrations") {
      return { status: 200, body: paginateRows(state.integrations, query, RESOURCE_PAGE_SIZE_CAP.integrations) };
    }

    return { status: 404, body: { error: "not_found" } };
  }

  function applyIncompletePageIfArmed(key, query, liveResult) {
    const armState = hooks.incompletePage.get(key);
    if (!armState) return liveResult;

    if (armState === "armed" && !query.pageCursor) {
      hooks.incompletePage.set(key, "followup-pending");
      const rows = liveResult.body?.results?.data ?? [];
      return { status: 200, body: envelope(rows, true, "__FORCED_INCOMPLETE__") };
    }
    if (armState === "followup-pending" && query.pageCursor === "__FORCED_INCOMPLETE__") {
      hooks.incompletePage.delete(key);
      // A malformed page: no `data` array at all, so the CLI's own
      // assertValidPage (src/paginate.ts) throws CHECK_FAILED and the
      // pagination result comes back incomplete with an error attached.
      return { status: 200, body: { results: { pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    return liveResult;
  }

  /**
   * Arm-and-wait readback miss (see the module comment for why capture
   * happens on the first matching GET, not at arm time): the queue entry
   * at the front of `hooks.readbackMiss` for this key starts in phase
   * "await-first". The first matching GET after arming (the write's own
   * preRead) is served live, and that live body is stashed as the
   * entry's snapshot while its phase flips to "serve-stale". The second
   * matching GET (the write's own postRead, made after the mutating call
   * already ran) consumes the entry and is served that stale snapshot
   * instead of live state.
   */
  function applyReadbackMissIfArmed(key, pathname, query) {
    const queue = hooks.readbackMiss.get(key);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue[0];
    if (entry.phase === "await-first") {
      const live = computeGet(pathname, query);
      entry.snapshot = live.body;
      entry.phase = "serve-stale";
      return live;
    }
    queue.shift();
    if (queue.length === 0) hooks.readbackMiss.delete(key);
    return { status: 200, body: entry.snapshot };
  }

  function handleGet(pathname, query, key) {
    const missResult = applyReadbackMissIfArmed(key, pathname, query);
    if (missResult !== undefined) {
      return applyIncompletePageIfArmed(key, query, missResult);
    }
    const live = computeGet(pathname, query);
    return applyIncompletePageIfArmed(key, query, live);
  }

  // --- POST/write handlers -----------------------------------------------

  // Pure: computes the /oauth/token response body only. tokenMintCount and
  // the recorded client id list are both incremented/grown unconditionally
  // in handleRequest, before this (or a forceNextResponse override) ever
  // runs, so a forced failure on this route still counts as a mint attempt
  // (round-1 gate finding).
  function computeOauthTokenResponse() {
    if (tokenResponseQueue && tokenResponseQueue.length > 0) {
      const forced = tokenResponseQueue.shift();
      return { status: forced.status, body: cloneBody(forced.body) };
    }
    if (tokenResponseSingle) {
      // tokenResponseSingle is reused across every call (it is not a
      // queue), so it especially must never hand back the same object
      // reference twice.
      return { status: tokenResponseSingle.status, body: cloneBody(tokenResponseSingle.body) };
    }
    return {
      status: 200,
      body: {
        access_token: "vanta-test-token-" + crypto.randomUUID(),
        expires_in: 3600,
        token_type: "Bearer",
      },
    };
  }

  function handlePost(pathname, body, rawBuffer, contentType) {
    const result = handlePostLive(pathname, body, rawBuffer, contentType);
    return { status: result.status, body: cloneBody(result.body) };
  }

  function handlePostLive(pathname, body, rawBuffer, contentType) {
    let match;

    if ((match = /^documents\/([^/]+)\/uploads$/.exec(pathname))) {
      const documentId = match[1];
      const boundary = extractBoundary(contentType);
      if (!boundary) {
        return { status: 400, body: { error: "missing_boundary" } };
      }
      const parsed = parseMultipart(rawBuffer, boundary);
      if (!parsed.file) {
        return { status: 400, body: { error: "missing_file_part" } };
      }
      if (hooks.uploadFailures.has(parsed.file.fileName)) {
        hooks.uploadFailures.delete(parsed.file.fileName);
        return { status: 500, body: { error: "forced_upload_failure" } };
      }
      const row = makeUploadRow({
        fileName: parsed.file.fileName,
        mimeType: parsed.file.mimeType,
        effectiveAtDate: parsed.fields.effectiveAtDate,
        description: parsed.fields.description,
      });
      const list = state.documentUploads.get(documentId) ?? [];
      list.push(row);
      state.documentUploads.set(documentId, list);
      // POST documents/{id}/uploads is a creation write: OpenAPI declares
      // 201, not 200.
      return { status: 201, body: row };
    }

    if ((match = /^documents\/([^/]+)\/links$/.exec(pathname))) {
      const documentId = match[1];
      const row = makeLinkRow({
        url: body?.url,
        title: body?.title,
        description: body?.description,
        effectiveDate: body?.effectiveDate,
      });
      const list = state.documentLinks.get(documentId) ?? [];
      list.push(row);
      state.documentLinks.set(documentId, list);
      // POST documents/{id}/links is a creation write: OpenAPI declares
      // 201, not 200.
      return { status: 201, body: row };
    }

    if ((match = /^documents\/([^/]+)\/set-owner$/.exec(pathname))) {
      const documentId = match[1];
      const document = state.documents.find((d) => d.id === documentId);
      if (!document) return { status: 404, body: { error: "not_found" } };
      document.ownerId = body?.userId;
      // OpenAPI response schema for this route is Document (base shape),
      // never DocumentDetail.
      return { status: 200, body: documentShape(document) };
    }

    if ((match = /^documents\/([^/]+)\/submit$/.exec(pathname))) {
      const documentId = match[1];
      const document = state.documents.find((d) => d.id === documentId);
      if (!document) return { status: 404, body: { error: "not_found" } };
      const key = normalizeKey(pathname);
      const noOpRemaining = hooks.submitNoOp.get(key) ?? 0;
      if (noOpRemaining > 0) {
        hooks.submitNoOp.set(key, noOpRemaining - 1);
        if (noOpRemaining - 1 <= 0) hooks.submitNoOp.delete(key);
      } else {
        document.uploadStatus = "OK";
        document.uploadStatusDate = nowIso();
      }
      return { status: 204, body: undefined };
    }

    if ((match = /^controls\/([^/]+)\/set-owner$/.exec(pathname))) {
      const controlId = match[1];
      const control = state.controls.find((c) => c.id === controlId);
      if (!control) return { status: 404, body: { error: "not_found" } };
      const userId = body?.userId;
      control.owner = { id: userId, emailAddress: `${userId}@acme.test`, displayName: `User ${userId}` };
      // OpenAPI response schema for this route is Control (base shape,
      // no status/numDocumentsPassing/etc.), never ControlDetail.
      return { status: 200, body: controlBaseShape(control) };
    }

    if ((match = /^controls\/([^/]+)\/add-document-to-control$/.exec(pathname))) {
      const controlId = match[1];
      const documentId = body?.documentId;
      const control = state.controls.find((c) => c.id === controlId);
      const document = state.documents.find((d) => d.id === documentId);
      if (!control || !document) return { status: 404, body: { error: "not_found" } };

      const docIds = state.controlToDocumentIds.get(controlId) ?? new Set();
      docIds.add(documentId);
      state.controlToDocumentIds.set(controlId, docIds);
      const controlIds = state.documentToControlIds.get(documentId) ?? new Set();
      controlIds.add(controlId);
      state.documentToControlIds.set(documentId, controlIds);

      return {
        status: 200,
        body: { document: documentShape(document), control: controlBaseShape(control) },
      };
    }

    return { status: 404, body: { error: "not_found" } };
  }

  // --- HTTP wiring ----------------------------------------------------

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      try {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "fixture_internal_error", message: String(err && err.message ? err.message : err) }));
      } catch {
        // Socket already gone; nothing more to do.
      }
    });
  });

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function handleRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    const rawPathname = normalizeKey(parsedUrl.pathname);
    const query = Object.fromEntries(parsedUrl.searchParams);
    const method = req.method ?? "GET";

    const rawBuffer = await readBody(req);
    const contentType = req.headers["content-type"];
    let parsedBody;
    if (rawBuffer.length === 0) {
      parsedBody = undefined;
    } else if (typeof contentType === "string" && contentType.includes("application/json")) {
      try {
        parsedBody = JSON.parse(rawBuffer.toString("utf8"));
      } catch {
        parsedBody = rawBuffer.toString("utf8");
      }
    } else if (typeof contentType === "string" && contentType.includes("multipart/form-data")) {
      const boundary = extractBoundary(contentType);
      parsedBody = boundary ? parseMultipart(rawBuffer, boundary) : undefined;
    } else {
      parsedBody = rawBuffer.toString("utf8");
    }

    // requests[] always records the exact pathname as received on the
    // wire, /v1 prefix and all (or its absence), before any stripping
    // below; this is the one place in this file that ever sees the raw,
    // unstripped path.
    requests.push({ method, path: req.url, headers: { ...req.headers }, body: parsedBody });

    // /v1 routing (matches production: apiBaseUrl is always
    // https://api.vanta.com/v1, oauth/token is always at the origin
    // root). Every Manage API route must be requested under /v1; a
    // request missing that prefix is exactly what a path-join regression
    // in vanta-api.ts's buildUrl would produce, and must 404 here the same
    // way it would against the real host. `key`, once computed below, is
    // the bare resource path with /v1 already stripped: every hook map
    // (forceNextResponse, forceReadbackMiss, delayNextResponse,
    // chmodBeforeResponding) is keyed this way, and every route-matching
    // regex in computeGet/handlePost matches against this same bare form,
    // never the /v1-prefixed wire path.
    // `isOauthTokenRoute` is computed from `rawPathname` directly, never
    // from `key` below: /oauth/token is real only at the exact root path.
    // A request to /v1/oauth/token is not this route (it does not exist
    // in production either) even though stripping /v1 from it happens to
    // produce the same bare string "oauth/token"; without this separate
    // flag that collision would wrongly let /v1/oauth/token mint a token.
    const isOauthTokenRoute = rawPathname === "oauth/token";
    let key;
    if (isOauthTokenRoute) {
      key = "oauth/token";
    } else if (rawPathname === "v1" || rawPathname.startsWith("v1/")) {
      key = rawPathname.slice(3); // "v1/frameworks" -> "frameworks"; "v1" -> ""
    } else {
      key = null;
    }
    if (key === null || key === "") {
      send(res, 404, { error: "not_found" });
      return;
    }
    // Round-2 gate finding T009a-5: "/v1/oauth/token" strips down to the
    // same bare key ("oauth/token") that the real, root-only token route
    // uses for every hook map, but it is not that route. Reject it here,
    // before any hook lookup at all (chmodBeforeResponding, then
    // forceNextResponse further below), so an armed hook meant for the
    // real /oauth/token can never be consumed or otherwise affected by a
    // request to this reserved, always-404 collision path.
    if (key === "oauth/token" && !isOauthTokenRoute) {
      send(res, 404, { error: "not_found" });
      return;
    }
    const pathname = key;

    // Hook 1: chmodBeforeResponding, applied unconditionally, before any
    // response is decided.
    const chmodHook = shiftHook(hooks.chmodBeforeResponding, key);
    if (chmodHook) {
      fs.chmodSync(chmodHook.targetPath, chmodHook.mode);
    }

    // tokenMintCount and mintedClientIds both count every single hit to
    // /oauth/token, unconditionally, before forceNextResponse or anything
    // else gets a chance to short-circuit the response (round-1 gate
    // finding: a forced failure on this route is still a mint attempt and
    // must still be counted, so an auth-failure test can't observe a false
    // mint count).
    if (isOauthTokenRoute && method === "POST") {
      state.tokenMintCount += 1;
      const clientId =
        parsedBody && typeof parsedBody === "object" && typeof parsedBody.client_id === "string"
          ? parsedBody.client_id
          : null;
      state.mintedClientIds.push(clientId);
    }

    // Hook 3 takes precedence over any route handler when present.
    const forced = shiftHook(hooks.forceNextResponse, key);

    let result;
    if (forced) {
      result = { status: forced.status, body: cloneBody(forced.body), headers: forced.headers };
    } else if (isOauthTokenRoute && method === "POST") {
      result = computeOauthTokenResponse();
    } else if (method === "GET") {
      result = handleGet(pathname, query, key);
    } else if (method === "POST") {
      result = handlePost(pathname, parsedBody, rawBuffer, contentType);
    } else {
      result = { status: 405, body: { error: "method_not_allowed" } };
    }

    // Hook 2: delayNextResponse, applied last, right before the socket
    // write, so it delays the already-decided response rather than
    // changing what gets decided.
    const delayMs = shiftHook(hooks.delayNextResponse, key);
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    send(res, result.status, result.body, result.headers);
  }

  function send(res, status, body, headers = {}) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      res.setHeader(name, value);
    }
    if (body === undefined || status === 204) {
      res.statusCode = status;
      res.end();
      return;
    }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  // Every Manage API route lives under /v1, mirroring
  // https://api.vanta.com/v1; oauth/token stays at the origin root,
  // mirroring https://api.vanta.com/oauth/token. Tests set
  // VANTA_API_BASE_URL to `apiBaseUrl`, not `url`.
  const apiBaseUrl = `${url}/v1`;
  const tokenUrl = `${url}/oauth/token`;

  let closed = false;

  const fixture = {
    url,
    apiBaseUrl,
    tokenUrl,
    requests,
    get tokenMintCount() {
      return state.tokenMintCount;
    },
    // One entry per /oauth/token hit, in the same order and the same
    // unconditional lockstep as tokenMintCount (see handleRequest); each
    // entry is that request's client_id, or null if it had none.
    get mintedClientIds() {
      return [...state.mintedClientIds];
    },

    forceNextResponse(path, response, times = 1) {
      const key = normalizeKey(path);
      const queue = hooks.forceNextResponse.get(key) ?? [];
      for (let i = 0; i < times; i += 1) queue.push(response);
      hooks.forceNextResponse.set(key, queue);
    },

    forceReadbackMiss(path) {
      const key = normalizeKey(path);
      const queue = hooks.readbackMiss.get(key) ?? [];
      queue.push({ phase: "await-first", snapshot: undefined });
      hooks.readbackMiss.set(key, queue);
    },

    forceIncompletePage(path) {
      const key = normalizeKey(path);
      hooks.incompletePage.set(key, "armed");
    },

    forceUploadFailure(fileName) {
      hooks.uploadFailures.add(fileName);
    },

    forceSubmitNoOp(path, times = 1) {
      const key = normalizeKey(path);
      hooks.submitNoOp.set(key, (hooks.submitNoOp.get(key) ?? 0) + times);
    },

    chmodBeforeResponding(path, { targetPath, mode }) {
      const key = normalizeKey(path);
      const queue = hooks.chmodBeforeResponding.get(key) ?? [];
      queue.push({ targetPath, mode });
      hooks.chmodBeforeResponding.set(key, queue);
    },

    delayNextResponse(path, ms) {
      const key = normalizeKey(path);
      const queue = hooks.delayNextResponse.get(key) ?? [];
      queue.push(ms);
      hooks.delayNextResponse.set(key, queue);
    },

    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };

  return fixture;
}
