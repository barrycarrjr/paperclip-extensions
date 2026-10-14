import { test } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createRecordsService, type RecordsDb } from "./service.js";
import { filingToApi, type DocumentRow, type FilingRow } from "./domain.js";
import { createToolHandlers, handleApiRequest, type HandlerDeps } from "./tools.js";
import { RecordsError } from "./validate.js";
import manifest from "./manifest.js";

const company = randomUUID(), business = randomUUID(), otherBusiness = randomUUID();
const filingId = randomUUID(), proofId = randomUUID(), sourceId = randomUUID();
const call = { companyId: company, actor: {} };
const filing = {
  id: filingId, company_id: company, business_id: business, filing: "Annual filing", authority: "Example authority", period_label: "2026",
  period_start: null, period_end: null, due_date: "2026-10-01", due_date_kind: "unknown", due_date_source_document_id: null,
  extended_due_date: null, extended_due_date_kind: "unknown", extended_due_date_source_document_id: null,
  preparer: null, status: "upcoming", proof_document_id: null, not_required_reason: null, not_required_source: null, issue_id: null, notes: null,
  created_at: "2026-01-01", updated_at: "2026-01-01",
} satisfies FilingRow;
const doc = (id: string, extra: Partial<DocumentRow> = {}) => ({ id, company_id: company, business_id: business, replaced_by: null, removed_at: null, ...extra });

function setup(existing: FilingRow | null = null, documents: ReturnType<typeof doc>[] = []) {
  const mutations: string[] = [];
  const db: RecordsDb = {
    namespace: "plugin_business_records_95a607b2ab",
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes("FROM plugin_business_records_95a607b2ab.business_documents")) {
        const match = documents.find((d) => d.company_id === params?.[0] && d.id === params?.[1] && !d.removed_at);
        return (match ? [match] : []) as T[];
      }
      if (sql.includes("FROM plugin_business_records_95a607b2ab.business_filings")) {
        const naturalKey = sql.includes("lower(f.filing)");
        return (existing && !naturalKey ? [existing] : []) as T[];
      }
      return [{ id: business, company_id: company, name: "Example business" }] as T[];
    },
    execute: async (sql) => { mutations.push(sql); throw new Error("A refused request must never mutate"); },
  };
  return { service: createRecordsService({ db, getIssue: async () => null }), mutations };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => error instanceof RecordsError && error.code === code);
}
const newFiling = { businessId: business, filing: "Annual filing", authority: "Example authority", periodLabel: "2027", dueDate: "2027-10-01" };

test("a new date needs explicit classification, and statutory notes or a filename do not supply evidence", async () => {
  for (const params of [newFiling, { ...newFiling, dueDateKind: "unknown" }, { ...newFiling, dueDateKind: "statutory", notes: "See instructions.pdf" }]) {
    const { service, mutations } = setup();
    await rejectsCode(service.upsertFiling(call, params), "dueDateKind" in params && params.dueDateKind === "statutory" ? "EDEADLINE_SOURCE_REQUIRED" : "EINVALID_INPUT");
    assert.deepEqual(mutations, []);
  }
});

for (const [name, source] of [
  ["missing", null], ["another company", doc(sourceId, { company_id: randomUUID() })],
  ["another business", doc(sourceId, { business_id: otherBusiness })],
  ["replaced", doc(sourceId, { replaced_by: randomUUID() })], ["removed", doc(sourceId, { removed_at: "2026-01-01" })],
] as const) {
  test(`a statutory citation that is ${name} is refused before any mutation`, async () => {
    const { service, mutations } = setup(null, source ? [source] : []);
    await rejectsCode(service.upsertFiling(call, { ...newFiling, dueDateKind: "statutory", dueDateSourceDocumentId: sourceId }), "EDEADLINE_SOURCE_REQUIRED");
    assert.deepEqual(mutations, []);
  });
}

test("unchanged legacy reads remain unknown, but changing the date cannot create new unknown provenance", async () => {
  const { service, mutations } = setup(filing);
  const repeat = await service.upsertFiling(call, { filingId, dueDate: filing.due_date });
  assert.equal(repeat.data.filing.dueDateKind, "unknown");
  assert.equal(repeat.data.filing.dueDateSourceDocumentId, null);
  await rejectsCode(service.upsertFiling(call, { filingId, dueDate: "2026-11-01" }), "EINVALID_INPUT");
  assert.deepEqual(mutations, []);
});

test("an actual statutory date change must explicitly cite its source again", async () => {
  const statutory: FilingRow = { ...filing, due_date_kind: "statutory", due_date_source_document_id: sourceId };
  const { service, mutations } = setup(statutory, [doc(sourceId)]);
  await rejectsCode(service.upsertFiling(call, { filingId, dueDate: "2026-11-01" }), "EDEADLINE_SOURCE_REQUIRED");
  assert.deepEqual(mutations, []);
});

test("invalid next-period provenance cannot partially change the current status or history", async () => {
  for (const nextPeriod of [
    { periodLabel: "2027", dueDate: "2027-10-01" },
    { periodLabel: "2027", dueDate: "2027-10-01", dueDateKind: "statutory", dueDateSourceDocumentId: sourceId },
  ]) {
    const { service, mutations } = setup(filing, [doc(proofId)]);
    await rejectsCode(service.setFilingStatus(call, { filingId, status: "filed", proofDocumentId: proofId, nextPeriod }), "dueDateKind" in nextPeriod ? "EDEADLINE_SOURCE_REQUIRED" : "EINVALID_INPUT");
    assert.deepEqual(mutations, []);
  }
});

test("extension proof does not automatically prove the new statutory deadline", async () => {
  const { service, mutations } = setup(filing, [doc(proofId)]);
  await rejectsCode(service.setFilingStatus(call, { filingId, status: "extension_filed", proofDocumentId: proofId, extendedDueDate: "2027-01-01", extendedDueDateKind: "statutory" }), "EDEADLINE_SOURCE_REQUIRED");
  assert.deepEqual(mutations, []);
});

test("both the agent tool and board API enforce the deadline contract", async () => {
  const { service, mutations } = setup();
  const deps: HandlerDeps = { getService: () => service, getConfig: async () => ({ allowedCompanies: [company] }), logger: { warn: () => {}, error: () => {} } };
  const params = { ...newFiling, dueDateKind: "statutory" };
  const tool = await createToolHandlers(deps).business_filing_upsert(params, { agentId: "a", runId: "r", companyId: company });
  assert.match(tool.error!, /^\[EDEADLINE_SOURCE_REQUIRED\]/);
  const response = await handleApiRequest(deps, { routeKey: "filings.create", companyId: company, body: params, actor: { actorType: "user", userId: "u" } } as Parameters<typeof handleApiRequest>[1]);
  assert.equal(response.status, 400);
  assert.match((response.body as { error: string }).error, /^\[EDEADLINE_SOURCE_REQUIRED\]/);
  assert.deepEqual(mutations, []);
});

test("domain mapping never guesses source metadata for a legacy row, and manifests expose all write paths", () => {
  const legacy = { ...filing } as Partial<FilingRow>;
  delete legacy.due_date_kind; delete legacy.due_date_source_document_id;
  const api = filingToApi(legacy as FilingRow);
  assert.equal(api.dueDateKind, "unknown"); assert.equal(api.dueDateSourceDocumentId, null);
  const upsert = manifest.tools!.find((tool) => tool.name === "business_filing_upsert")!;
  const status = manifest.tools!.find((tool) => tool.name === "business_filing_set_status")!;
  assert.deepEqual((upsert.parametersSchema as any).properties.dueDateKind.enum, ["statutory", "internal_planned"]);
  assert.ok((status.parametersSchema as any).properties.extendedDueDateSourceDocumentId);
  assert.ok((status.parametersSchema as any).properties.nextPeriod.properties.dueDateSourceDocumentId);
});
