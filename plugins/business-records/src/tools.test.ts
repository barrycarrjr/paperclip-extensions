/**
 * Handler-level tests with a fake context: company isolation runs before
 * anything else, the manifest and the registered handlers agree, and issue
 * references are checked against the calling company before any write.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { PluginApiRequestInput, ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import {
  DOC_TYPES,
  FILING_STATUSES,
  NOT_REQUIRED_SOURCE_KINDS,
  PREPARERS,
  RELATIONSHIPS,
  STATUS_FIELDS,
  STATUS_SOURCE_KINDS,
  type BusinessRow,
} from "./domain.js";
import { companyAccessError, isCompanyAllowed } from "./companyAccess.js";
import { createRecordsService, type IssueInfo, type RecordsDb, type RecordsService } from "./service.js";
import { computeSidebarVisibility } from "./sidebar-visibility.js";
import { TOOL_OPS, createToolHandlers, errorMessage, handleApiRequest, type HandlerDeps } from "./tools.js";
import { RecordsError } from "./validate.js";

const HQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BIZ = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const NS = "plugin_business_records_95a607b2ab";

function runCtx(companyId: string): ToolRunContext {
  return { agentId: "agent-1", runId: "run-1", companyId };
}

function fakeDeps(allowedCompanies: string[] | undefined, service?: RecordsService) {
  const calls = { service: 0, warn: 0, error: 0 };
  const deps: HandlerDeps = {
    getConfig: async () => ({ allowedCompanies }),
    logger: {
      warn: () => {
        calls.warn += 1;
      },
      error: () => {
        calls.error += 1;
      },
    },
    getService: () => {
      calls.service += 1;
      if (!service) throw new Error("the service must not be reached");
      return service;
    },
  };
  return { deps, calls };
}

// ---- Isolation preflight ----

test("companyAccessError: empty or missing allow-list denies, wildcard and listed ids allow", () => {
  assert.match(companyAccessError(undefined, HQ)!, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.match(companyAccessError([], HQ)!, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.match(companyAccessError([HQ], OTHER)!, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.equal(companyAccessError([HQ], HQ), null);
  assert.equal(companyAccessError(["*"], OTHER), null);
  assert.equal(isCompanyAllowed([HQ], HQ), true);
});

test("every tool refuses a company outside the allow-list before touching the database", async () => {
  const { deps, calls } = fakeDeps([HQ]);
  const handlers = createToolHandlers(deps);
  for (const name of Object.keys(TOOL_OPS)) {
    const result = await handlers[name]!({ businessId: BIZ, name: "Example Widgets LLC" }, runCtx(OTHER));
    assert.match(result.error ?? "", /^\[ECOMPANY_NOT_ALLOWED\]/, name);
    assert.equal(result.data, undefined, `${name} returned data to a disallowed company`);
    assert.equal(result.content, undefined, name);
  }
  assert.equal(calls.service, 0, "no tool may reach the service for a disallowed company");
  assert.equal(calls.warn, Object.keys(TOOL_OPS).length, "each refusal is logged");
});

test("every tool refuses when no company is configured at all", async () => {
  const { deps, calls } = fakeDeps(undefined);
  const handlers = createToolHandlers(deps);
  for (const name of Object.keys(TOOL_OPS)) {
    const result = await handlers[name]!({}, runCtx(HQ));
    assert.match(result.error ?? "", /^\[ECOMPANY_NOT_ALLOWED\]/, name);
  }
  assert.equal(calls.service, 0);
});

test("every API route refuses a company outside the allow-list with 403 and no data", async () => {
  const { deps, calls } = fakeDeps([HQ]);
  for (const route of manifest.apiRoutes ?? []) {
    const res = await handleApiRequest(deps, {
      routeKey: route.routeKey,
      companyId: OTHER,
      params: { businessId: BIZ },
      query: {},
      body: null,
      actor: { actorType: "user", userId: "user-1" },
    } as unknown as PluginApiRequestInput);
    assert.equal(res.status, 403, route.routeKey);
    assert.match(String((res.body as { error?: string }).error), /^\[ECOMPANY_NOT_ALLOWED\]/);
    assert.deepEqual(Object.keys(res.body as object), ["error"]);
  }
  assert.equal(calls.service, 0);
});

test("sidebar shows only for an allowed company with the toggle on", () => {
  assert.deepEqual(computeSidebarVisibility(HQ, { allowedCompanies: [HQ] }), { visible: true, reason: "ok" });
  assert.equal(computeSidebarVisibility(OTHER, { allowedCompanies: [HQ] }).visible, false);
  assert.equal(computeSidebarVisibility(HQ, { allowedCompanies: [] }).visible, false);
  assert.equal(computeSidebarVisibility(HQ, { allowedCompanies: [HQ], showInSidebar: false }).visible, false);
  assert.equal(computeSidebarVisibility(null, { allowedCompanies: ["*"] }).visible, false);
});

// ---- Error shape ----

test("errors keep their [ECODE] and unexpected errors never echo quoted values", () => {
  assert.deepEqual(errorMessage(new RecordsError("EPROOF_REQUIRED", "x"), "t"), { message: "[EPROOF_REQUIRED] x", code: "EPROOF_REQUIRED" });
  const leaked = errorMessage(new Error('invalid input syntax for type uuid: "12-3456789"'), "business_get");
  assert.equal(leaked.code, "EINTERNAL");
  assert.ok(!leaked.message.includes("3456789"), leaked.message);
  const detail = errorMessage(new Error("Key (company_id, lower(name))=(x, example) already exists"), "business_upsert");
  assert.ok(!detail.message.includes("example"), detail.message);
});

// ---- Manifest and worker agree ----

test("the manifest declares exactly the tools the worker has handlers for", () => {
  const declared = (manifest.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(declared, Object.keys(TOOL_OPS).sort());
  assert.equal(declared.length, 11);
});

test("the manifest enum lists match domain.ts", () => {
  const tools = Object.fromEntries((manifest.tools ?? []).map((t) => [t.name, t.parametersSchema as any]));
  assert.deepEqual(tools.business_list.properties.relationship.enum, [...RELATIONSHIPS]);
  assert.deepEqual(tools.business_set_status.properties.field.enum, [...STATUS_FIELDS]);
  assert.deepEqual(tools.business_set_status.properties.source.properties.kind.enum, [...STATUS_SOURCE_KINDS]);
  assert.deepEqual(tools.business_add_document.properties.docType.enum, [...DOC_TYPES]);
  assert.deepEqual(tools.business_filing_upsert.properties.preparer.enum, [...PREPARERS]);
  assert.deepEqual(tools.business_filing_set_status.properties.status.enum, [...FILING_STATUSES]);
  assert.deepEqual(tools.business_filing_set_status.properties.source.properties.kind.enum, [...NOT_REQUIRED_SOURCE_KINDS]);
});

test("every mutation tool accepts an idempotencyKey", () => {
  for (const name of ["business_upsert", "business_set_status", "business_link_issue", "business_add_document", "business_filing_upsert", "business_filing_set_status"]) {
    const schema = (manifest.tools ?? []).find((t) => t.name === name)!.parametersSchema as any;
    assert.ok(schema.properties.idempotencyKey, name);
  }
});

test("the manifest declares issues.read for the issue check and no core table reads", () => {
  assert.ok(manifest.capabilities.includes("issues.read"));
  assert.ok(manifest.capabilities.includes("agent.tools.register"));
  assert.equal(manifest.database?.namespaceSlug, "business_records");
  assert.equal(manifest.database?.coreReadTables, undefined);
});

// ---- Rule 4: issues must exist in the calling company ----

function businessRow(companyId: string): BusinessRow {
  return {
    id: BIZ,
    company_id: companyId,
    name: "Example Widgets LLC",
    other_names: [],
    relationship: "owned",
    legal_form: null,
    formation_state: null,
    registration_states: [],
    tax_classification: null,
    tax_classification_effective: null,
    linked_company_ids: [],
    contacts: [],
    notes: null,
    tax_id_last4: null,
    operating_status: "unknown",
    operating_status_as_of: null,
    operating_status_source: null,
    legal_status: "unknown",
    legal_status_as_of: null,
    legal_status_source: null,
    tax_account_status: "unknown",
    tax_account_status_as_of: null,
    tax_account_status_source: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

/** A database with one business in HQ. Records every write so tests can assert there were none. */
function fakeDb() {
  const writes: string[] = [];
  const db: RecordsDb = {
    namespace: NS,
    query: (async (sql: string, params?: unknown[]) => {
      if (/FROM \S+\.businesses b WHERE b\.company_id = \$1 AND b\.id = \$2/.test(sql)) {
        return params?.[0] === HQ && params?.[1] === BIZ ? [businessRow(HQ)] : [];
      }
      return [];
    }) as RecordsDb["query"],
    execute: async (sql: string) => {
      writes.push(sql);
      return { rowCount: 1 };
    },
  };
  return { db, writes };
}

/** An issue that exists only in the OTHER company. */
const issueOnlyInOther = async (issueId: string, companyId: string): Promise<IssueInfo | null> =>
  issueId === ISSUE && companyId === OTHER ? { id: ISSUE, title: "Elsewhere", status: "todo", identifier: null, dueDate: null } : null;

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof RecordsError ? err.code : `UNEXPECTED ${(err as Error).message}`;
  }
}

const HQ_CALL = { companyId: HQ, actor: { agentId: "agent-1" } };

test("a document pointing at an issue in another company is refused before any write", async () => {
  const { db, writes } = fakeDb();
  const service = createRecordsService({ db, getIssue: issueOnlyInOther });
  const code = await codeOf(
    service.addDocument(HQ_CALL, { businessId: BIZ, docType: "other", title: "Letter", issueId: ISSUE }),
  );
  assert.equal(code, "EISSUE_NOT_FOUND");
  assert.deepEqual(writes, []);
});

test("linking an issue from another company is refused before any write", async () => {
  const { db, writes } = fakeDb();
  const service = createRecordsService({ db, getIssue: issueOnlyInOther });
  assert.equal(await codeOf(service.linkIssue(HQ_CALL, { businessId: BIZ, issueId: ISSUE, role: "case:notice" })), "EISSUE_NOT_FOUND");
  assert.deepEqual(writes, []);
});

test("a filing tracked by an issue from another company is refused before any write", async () => {
  const { db, writes } = fakeDb();
  const service = createRecordsService({ db, getIssue: issueOnlyInOther });
  const code = await codeOf(
    service.upsertFiling(HQ_CALL, { businessId: BIZ, filing: "Annual report", authority: "Example State", periodLabel: "2026", dueDate: "2026-06-30", issueId: ISSUE }),
  );
  assert.equal(code, "EISSUE_NOT_FOUND");
  assert.deepEqual(writes, []);
});

test("a lookup that throws is treated as not found, never as found", async () => {
  const { db, writes } = fakeDb();
  const service = createRecordsService({
    db,
    getIssue: async () => {
      throw new Error("host unavailable");
    },
  });
  assert.equal(await codeOf(service.linkIssue(HQ_CALL, { businessId: BIZ, issueId: ISSUE, role: "records" })), "EISSUE_NOT_FOUND");
  assert.deepEqual(writes, []);
});

test("a business id from another company is not found, exactly like a missing one", async () => {
  const { db, writes } = fakeDb();
  const service = createRecordsService({ db, getIssue: issueOnlyInOther });
  const otherCall = { companyId: OTHER, actor: {} };
  assert.equal(await codeOf(service.getBusiness(otherCall, { businessId: BIZ })), "EBUSINESS_NOT_FOUND");
  assert.equal(
    await codeOf(service.setStatus(otherCall, { businessId: BIZ, field: "operating", value: "ceased", asOf: "2026-01-01", source: { kind: "user_reported" } })),
    "EBUSINESS_NOT_FOUND",
  );
  assert.equal(await codeOf(service.history(otherCall, { businessId: BIZ })), "EBUSINESS_NOT_FOUND");
  assert.deepEqual(writes, []);
});

test("sensitive ids are refused before any read or write", async () => {
  const { db, writes } = fakeDb();
  const service = createRecordsService({ db, getIssue: issueOnlyInOther });
  assert.equal(await codeOf(service.upsertBusiness(HQ_CALL, { name: "Example Widgets LLC", relationship: "owned", notes: "EIN 12-3456789" })), "ESENSITIVE_ID");
  assert.equal(await codeOf(service.upsertBusiness(HQ_CALL, { name: "Example Widgets LLC", relationship: "owned", taxIdLast4: "123456789" })), "ESENSITIVE_ID");
  assert.deepEqual(writes, []);
});

test("a tool call from an allowed company reaches the service and returns content plus data", async () => {
  const { db } = fakeDb();
  const service = createRecordsService({ db, getIssue: issueOnlyInOther });
  const { deps } = fakeDeps([HQ], service);
  const result = await createToolHandlers(deps).business_list!({}, runCtx(HQ));
  assert.equal(result.error, undefined);
  assert.equal(result.content, "No businesses match.");
  assert.deepEqual(result.data, { businesses: [] });
});
