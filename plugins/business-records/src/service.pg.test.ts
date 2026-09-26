/**
 * The business-records service against a real Postgres, not a stub.
 *
 * The unique keys (one name per company, one filing per period), the
 * append-only history and the company filter only really exist in the
 * database, so they are exercised here end to end, through the same service
 * the tools call.
 *
 * Runs only when BUSINESS_RECORDS_TEST_DATABASE_URL names a database, and
 * prints why it skipped when it does not. It creates its own randomly named
 * schema from the plugin's migration file (rewriting the namespace name) and
 * drops it at the end, so it touches nothing else in that database.
 *
 * Every statement the service sends is also checked against a copy of the
 * host's ctx.db rules, so a query that works in Postgres but would be refused
 * by the host fails here too.
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRecordsService, type IssueInfo, type RecordsDb, type RecordsService } from "./service.js";
import { buildInsertFiling } from "./sql.js";
import { RecordsError } from "./validate.js";
import { assertPlaceholdersMatch, validateRuntimeExecute, validateRuntimeQuery } from "./hostSqlRules.testutil.js";

const DATABASE_URL = process.env.BUSINESS_RECORDS_TEST_DATABASE_URL ?? "";
const SKIP_REASON =
  "BUSINESS_RECORDS_TEST_DATABASE_URL is not set, so the real Postgres tests were not run. Set it to a Postgres connection string to run them.";

const MIGRATION_SCHEMA = "plugin_business_records_95a607b2ab";
const TODAY = "2026-09-26";

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const ISSUE_A = randomUUID();
const ISSUE_A2 = randomUUID();
const ISSUE_B = randomUUID();

const ISSUES: Record<string, { companyId: string; title: string }> = {
  [ISSUE_A]: { companyId: COMPANY_A, title: "Example Widgets LLC: records" },
  [ISSUE_A2]: { companyId: COMPANY_A, title: "Example notice case" },
  [ISSUE_B]: { companyId: COMPANY_B, title: "Company B records" },
};

async function getIssue(issueId: string, companyId: string): Promise<IssueInfo | null> {
  const issue = ISSUES[issueId];
  if (!issue || issue.companyId !== companyId) return null;
  return { id: issueId, title: issue.title, status: "todo", identifier: null, dueDate: null };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof RecordsError ? err.code : `UNEXPECTED ${(err as Error).message}`;
  }
}

if (!DATABASE_URL) {
  console.log(`Skipping the business-records Postgres tests: ${SKIP_REASON}`);
  test("business-records rules that live in the database", { skip: SKIP_REASON }, () => {});
} else {
  const schema = `business_records_pg_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let pool: import("pg").Pool;
  let db: RecordsDb;
  let service: RecordsService;
  const A = { companyId: COMPANY_A, actor: { agentId: "agent-a", runId: "run-a", userId: null } };
  const B = { companyId: COMPANY_B, actor: { agentId: "agent-b", runId: "run-b", userId: null } };

  async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE ${where}`, params);
    return r.rows[0].n as number;
  }

  before(async () => {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: DATABASE_URL, max: 2 });
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    await pool.query(`CREATE SCHEMA ${schema}`);
    // Every migration, in file-name order, the same order the host applies them.
    for (const file of (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query((await readFile(join(migrationsDir, file), "utf8")).split(MIGRATION_SCHEMA).join(schema));
    }
    db = {
      namespace: schema,
      query: (async (text: string, params?: unknown[]) => {
        validateRuntimeQuery(text, schema);
        assertPlaceholdersMatch(text, params ?? []);
        return (await pool.query(text, params as unknown[])).rows;
      }) as RecordsDb["query"],
      execute: async (text: string, params?: unknown[]) => {
        validateRuntimeExecute(text, schema);
        assertPlaceholdersMatch(text, params ?? []);
        return { rowCount: (await pool.query(text, params as unknown[])).rowCount ?? 0 };
      },
    };
    service = createRecordsService({ db, getIssue, today: () => TODAY });
  });

  after(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });

  async function createBusiness(call: typeof A, name: string, extra: Record<string, unknown> = {}) {
    const r = await service.upsertBusiness(call, { name, relationship: "owned", ...extra });
    return r.data.business;
  }

  async function addDoc(call: typeof A, businessId: string, extra: Record<string, unknown> = {}) {
    const r = await service.addDocument(call, {
      businessId,
      docType: "certificate_of_organization",
      title: "Certificate of organization",
      issueId: call === A ? ISSUE_A : ISSUE_B,
      attachmentRef: `file-${randomUUID()}.pdf`,
      ...extra,
    });
    return r.data.document;
  }

  test("one business name per company, case-insensitive, but the same name can exist in another company", async () => {
    const first = await createBusiness(A, "Example Widgets LLC");
    const again = await service.upsertBusiness(A, { name: "example widgets llc", relationship: "owned" });
    assert.equal(again.data.created, false);
    assert.equal(again.data.business.id, first.id);
    assert.equal(again.data.business.name, "Example Widgets LLC", "matching by name never renames");
    assert.equal(await count("businesses", "company_id = $1", [COMPANY_A]), 1);

    const inB = await createBusiness(B, "Example Widgets LLC");
    assert.notEqual(inB.id, first.id);

    await assert.rejects(
      pool.query(`INSERT INTO ${schema}.businesses (company_id, name, relationship) VALUES ($1, $2, 'owned')`, [COMPANY_A, "EXAMPLE WIDGETS LLC"]),
      /duplicate key/,
      "the unique index itself refuses a second row",
    );

    const other = await createBusiness(A, "Example Gadgets LLC");
    assert.equal(
      await codeOf(service.upsertBusiness(A, { id: other.id, name: "Example Widgets LLC" })),
      "EBUSINESS_NAME_TAKEN",
    );
  });

  test("a repeated upsert changes nothing and writes no history; a real change writes one row per field", async () => {
    const input = {
      name: "Example Repeat LLC",
      relationship: "owned",
      otherNames: ["Example Repeat"],
      legalForm: "LLC",
      registrationStates: ["Example State"],
      taxClassification: "partnership",
      taxClassificationEffective: "2025-01-01",
      contacts: [{ role: "cpa", name: "Pat Example", phone: "215-555-0123" }],
      notes: "Office at 1 Example Way, Anytown 19103-1234",
      taxIdLast4: "0000",
    };
    const created = await service.upsertBusiness(A, input);
    assert.equal(created.data.created, true);
    const id = created.data.business.id;
    const historyAfterCreate = await count("business_history", "business_id = $1", [id]);
    assert.equal(historyAfterCreate, 1, "one business_created row");

    const repeat = await service.upsertBusiness(A, input);
    assert.deepEqual(repeat.data.changed, []);
    assert.equal(await count("business_history", "business_id = $1", [id]), historyAfterCreate);

    const changed = await service.upsertBusiness(A, { ...input, notes: "Moved", legalForm: "LLC" });
    assert.deepEqual(changed.data.changed, ["notes"]);
    assert.equal(await count("business_history", "business_id = $1 AND kind = 'business_updated'", [id]), 1);
    assert.equal(changed.data.business.taxIdLast4, "0000");
  });

  test("closure and formation statuses need a document on file; each change writes exactly one history row", async () => {
    const biz = await createBusiness(A, "Example Closure LLC", {
      statuses: { legal: { value: "formation_filed", asOf: "2026-01-10", source: { kind: "user_reported" } } },
    });
    assert.equal(biz.statuses.legal.value, "formation_filed");
    assert.equal(biz.statuses.operating.value, "unknown", "statuses not given start unknown");
    assert.equal(await count("business_history", "business_id = $1 AND kind = 'status_change'", [biz.id]), 1);

    // A user statement cannot set dissolved, and a refusal writes nothing.
    const refused = service.setStatus(A, {
      businessId: biz.id,
      field: "legal",
      value: "dissolved",
      asOf: "2026-08-01",
      source: { kind: "user_reported", note: "Owner says it is closed" },
    });
    assert.equal(await codeOf(refused), "EPROOF_REQUIRED");
    assert.equal(await count("business_history", "business_id = $1 AND kind = 'status_change'", [biz.id]), 1);

    // Creating with a proof-only status is refused too.
    assert.equal(
      await codeOf(
        service.upsertBusiness(A, {
          name: "Example Shortcut LLC",
          relationship: "owned",
          statuses: { legal: { value: "active", asOf: "2026-01-01", source: { kind: "document", documentId: randomUUID() } } },
        }),
      ),
      "EPROOF_REQUIRED",
    );

    const approval = await addDoc(A, biz.id);
    const ok = await service.setStatus(A, {
      businessId: biz.id,
      field: "legal",
      value: "active",
      asOf: "2026-02-01",
      source: { kind: "document", documentId: approval.id },
    });
    assert.equal(ok.data.changed, true);
    assert.equal(ok.data.business.statuses.legal.value, "active");
    assert.equal(ok.data.business.statuses.legal.asOf, "2026-02-01");
    assert.equal(ok.data.business.statuses.legal.source?.documentId, approval.id);

    const rows = await pool.query(
      `SELECT field, old_value, new_value, as_of::text AS as_of, source, actor FROM ${schema}.business_history WHERE business_id = $1 AND kind = 'status_change' ORDER BY created_at`,
      [biz.id],
    );
    assert.equal(rows.rows.length, 2);
    assert.deepEqual(
      { field: rows.rows[1].field, old: rows.rows[1].old_value, new: rows.rows[1].new_value, asOf: rows.rows[1].as_of },
      { field: "legal_status", old: "formation_filed", new: "active", asOf: "2026-02-01" },
    );
    assert.equal(rows.rows[1].source.documentId, approval.id);
    assert.equal(rows.rows[1].actor.agentId, "agent-a");

    // Setting the same thing again changes nothing.
    const same = await service.setStatus(A, {
      businessId: biz.id,
      field: "legal",
      value: "active",
      asOf: "2026-02-01",
      source: { kind: "document", documentId: approval.id },
    });
    assert.equal(same.data.changed, false);
    assert.equal(await count("business_history", "business_id = $1 AND kind = 'status_change'", [biz.id]), 2);

    // A document of another business is not proof for this one.
    const otherBiz = await createBusiness(A, "Example Other LLC");
    const otherDoc = await addDoc(A, otherBiz.id, { docType: "tax_id_letter", title: "Tax id letter" });
    assert.equal(
      await codeOf(
        service.setStatus(A, { businessId: biz.id, field: "tax_account", value: "open", asOf: "2026-02-02", source: { kind: "document", documentId: otherDoc.id } }),
      ),
      "EPROOF_REQUIRED",
    );
  });

  test("a replaced document drops out of the current list, stays in history, and can no longer be cited", async () => {
    const biz = await createBusiness(A, "Example Replace LLC");
    const v1 = await addDoc(A, biz.id, { docType: "insurance_certificate", title: "Insurance 2025", renewalDate: "2026-10-15" });
    const v2r = await service.addDocument(A, {
      businessId: biz.id,
      docType: "insurance_certificate",
      title: "Insurance 2026",
      issueId: ISSUE_A,
      attachmentRef: "insurance-2026.pdf",
      renewalDate: "2027-10-15",
      replacesDocumentId: v1.id,
    });
    assert.equal(v2r.data.replaced, v1.id);

    const current = await service.listDocuments(A, { businessId: biz.id });
    assert.deepEqual(current.data.documents.map((d) => d.title), ["Insurance 2026"]);
    const all = await service.listDocuments(A, { businessId: biz.id, includeReplaced: true });
    assert.equal(all.data.documents.length, 2);
    assert.equal(await count("business_history", "business_id = $1 AND kind = 'document_replaced' AND subject_id = $2", [biz.id, v1.id]), 1);

    assert.equal(
      await codeOf(service.setStatus(A, { businessId: biz.id, field: "legal", value: "active", asOf: "2026-01-01", source: { kind: "document", documentId: v1.id } })),
      "EPROOF_REQUIRED",
    );
    assert.equal(
      await codeOf(service.addDocument(A, { businessId: biz.id, docType: "insurance_certificate", title: "Insurance 2026b", issueId: ISSUE_A, attachmentRef: "x.pdf", replacesDocumentId: v1.id })),
      "EDOCUMENT_ALREADY_REPLACED",
    );

    // Adding the same attachment again returns the existing row.
    const repeat = await service.addDocument(A, {
      businessId: biz.id,
      docType: "insurance_certificate",
      title: "Insurance 2026",
      issueId: ISSUE_A,
      attachmentRef: "insurance-2026.pdf",
      replacesDocumentId: v1.id,
    });
    assert.equal(repeat.data.created, false);
    assert.equal(repeat.data.document.id, v2r.data.document.id);
    assert.equal(await count("business_documents", "business_id = $1", [biz.id]), 2);

    // An issue from another company is refused.
    assert.equal(
      await codeOf(service.addDocument(A, { businessId: biz.id, docType: "other", title: "Stray", issueId: ISSUE_B })),
      "EISSUE_NOT_FOUND",
    );
  });

  test("the renewal filter returns only current documents renewing within the window", async () => {
    const biz = await createBusiness(A, "Example Renewals LLC");
    await addDoc(A, biz.id, { docType: "license_or_permit", title: "Permit soon", renewalDate: "2026-10-20" });
    await addDoc(A, biz.id, { docType: "license_or_permit", title: "Permit lapsed", renewalDate: "2026-09-01" });
    await addDoc(A, biz.id, { docType: "license_or_permit", title: "Permit later", renewalDate: "2027-06-01" });
    await addDoc(A, biz.id, { docType: "operating_agreement", title: "No renewal" });
    const old = await addDoc(A, biz.id, { docType: "annual_report", title: "Old report", renewalDate: "2026-10-01" });
    await addDoc(A, biz.id, { docType: "annual_report", title: "New report", renewalDate: "2027-10-01", replacesDocumentId: old.id });

    const soon = await service.listDocuments(A, { businessId: biz.id, renewalWithinDays: 60 });
    assert.deepEqual(soon.data.documents.map((d) => d.title), ["Permit lapsed", "Permit soon"]);
    const permits = await service.listDocuments(A, { businessId: biz.id, docType: "license_or_permit" });
    assert.equal(permits.data.documents.length, 3);
  });

  test("filings: one row per period, proof required, and rolling forward twice creates one next period", async () => {
    const biz = await createBusiness(A, "Example Filings LLC");
    const key = { businessId: biz.id, filing: "Federal S corporation return (Form 1120-S)", authority: "IRS", periodLabel: "2025" };
    const created = await service.upsertFiling(A, { ...key, periodStart: "2025-01-01", periodEnd: "2025-12-31", dueDate: "2026-03-16", preparer: "cpa", issueId: ISSUE_A2 });
    assert.equal(created.data.created, true);
    const again = await service.upsertFiling(A, { ...key, filing: key.filing.toUpperCase(), authority: "irs", dueDate: "2026-03-16" });
    assert.equal(again.data.created, false);
    assert.equal(again.data.filing.id, created.data.filing.id);
    assert.deepEqual(again.data.changed, []);
    assert.equal(await count("business_filings", "business_id = $1", [biz.id]), 1);

    // The raw insert builder is idempotent on the unique key.
    const next = { businessId: biz.id, filing: key.filing, authority: "IRS", periodLabel: "2099", periodStart: null, periodEnd: null, dueDate: "2100-03-15", preparer: null, issueId: null, notes: null };
    const first = buildInsertFiling(schema, COMPANY_A, { id: randomUUID(), ...next });
    const second = buildInsertFiling(schema, COMPANY_A, { id: randomUUID(), ...next });
    assert.equal((await db.execute(first.text, first.params)).rowCount, 1);
    assert.equal((await db.execute(second.text, second.params)).rowCount, 0);
    assert.equal(await count("business_filings", "business_id = $1 AND period_label = '2099'", [biz.id]), 1);

    const filingId = created.data.filing.id;
    assert.equal(await codeOf(service.setFilingStatus(A, { filingId, status: "filed" })), "EPROOF_REQUIRED");
    assert.equal(await count("business_history", "subject_id = $1 AND kind = 'filing_status_change'", [filingId]), 0);

    const proof = await addDoc(A, biz.id, { docType: "filing_confirmation", title: "2025 return e-file confirmation" });
    const nextPeriod = { periodLabel: "2026", periodStart: "2026-01-01", periodEnd: "2026-12-31", dueDate: "2027-03-15" };
    const filed = await service.setFilingStatus(A, { filingId, status: "filed", proofDocumentId: proof.id, asOf: "2026-03-10", nextPeriod });
    assert.equal(filed.data.changed, true);
    assert.equal(filed.data.filing.status, "filed");
    assert.equal(filed.data.filing.proofTitle, "2025 return e-file confirmation");
    assert.equal(filed.data.nextPeriod?.created, true);
    assert.equal(filed.data.nextPeriod?.filing.preparer, "cpa", "the next period keeps the preparer");

    const repeat = await service.setFilingStatus(A, { filingId, status: "filed", proofDocumentId: proof.id, nextPeriod });
    assert.equal(repeat.data.changed, false);
    assert.equal(repeat.data.nextPeriod?.created, false);
    assert.equal(await count("business_filings", "business_id = $1 AND period_label = '2026'", [biz.id]), 1);
    assert.equal(await count("business_history", "subject_id = $1 AND kind = 'filing_status_change'", [filingId]), 1);
  });

  test("an extension moves the due date only with its proof, and the due and overdue filters find the right filings", async () => {
    const biz = await createBusiness(A, "Example Calendar LLC");
    const mk = async (periodLabel: string, dueDate: string) =>
      (await service.upsertFiling(A, { businessId: biz.id, filing: "State annual report", authority: "Example State", periodLabel, dueDate })).data.filing;
    const overdue = await mk("2026-A", "2026-09-01");
    const soon = await mk("2026-B", "2026-10-10");
    const later = await mk("2026-C", "2026-12-31");
    const extended = await mk("2026-D", "2026-09-15");

    assert.equal(
      await codeOf(service.setFilingStatus(A, { filingId: extended.id, status: "extension_filed", extendedDueDate: "2026-10-15" })),
      "EPROOF_REQUIRED",
    );
    const ext = await addDoc(A, biz.id, { docType: "extension_confirmation", title: "Extension confirmation" });
    const moved = await service.setFilingStatus(A, { filingId: extended.id, status: "extension_filed", proofDocumentId: ext.id, extendedDueDate: "2026-10-15" });
    assert.equal(moved.data.filing.effectiveDueDate, "2026-10-15");
    assert.equal(moved.data.filing.dueDate, "2026-09-15", "the original due date is kept");

    const overdueList = await service.listFilings(A, { businessId: biz.id, overdueWithoutProof: true });
    assert.deepEqual(overdueList.data.filings.map((f) => f.id), [overdue.id]);
    const dueSoon = await service.listFilings(A, { businessId: biz.id, dueWithinDays: 30 });
    assert.deepEqual(dueSoon.data.filings.map((f) => f.id), [soon.id, extended.id]);
    const attention = await service.listFilings(A, { businessId: biz.id, dueWithinDays: 30, overdueWithoutProof: true });
    assert.deepEqual(attention.data.filings.map((f) => f.id), [overdue.id, soon.id, extended.id]);
    assert.ok(!attention.data.filings.some((f) => f.id === later.id));
    const byStatus = await service.listFilings(A, { businessId: biz.id, status: "extension_filed" });
    assert.deepEqual(byStatus.data.filings.map((f) => f.id), [extended.id]);
  });

  test("not_required needs a reason and a professional or official source", async () => {
    const biz = await createBusiness(A, "Example Exempt LLC");
    const f = (await service.upsertFiling(A, { businessId: biz.id, filing: "Local business tax return", authority: "Example City", periodLabel: "2025", dueDate: "2026-04-15" })).data.filing;
    assert.equal(
      await codeOf(service.setFilingStatus(A, { filingId: f.id, status: "not_required", reason: "Owner says not needed", source: { kind: "user_reported" } })),
      "EREASON_SOURCE_REQUIRED",
    );
    assert.equal(
      await codeOf(service.setFilingStatus(A, { filingId: f.id, status: "not_required", reason: "No revenue", source: { kind: "official_guidance", url: "https://example.gov/rule" } })),
      "EREASON_SOURCE_REQUIRED",
    );
    const ok = await service.setFilingStatus(A, {
      filingId: f.id,
      status: "not_required",
      reason: "Receipts below the city filing threshold for the year",
      source: { kind: "official_guidance", url: "https://example.gov/threshold" },
    });
    assert.equal(ok.data.filing.status, "not_required");
    assert.equal(ok.data.filing.notRequiredSource?.url, "https://example.gov/threshold");
  });

  test("history since a timestamp returns only what changed after it", async () => {
    const biz = await createBusiness(A, "Example History LLC");
    // JavaScript dates carry milliseconds and Postgres microseconds, so leave a
    // clear gap either side of the mark rather than rely on sub-millisecond order.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mark = (await pool.query("SELECT clock_timestamp() AS t")).rows[0].t as Date;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.setStatus(A, { businessId: biz.id, field: "operating", value: "operating", asOf: "2026-05-01", source: { kind: "user_reported" } });
    const since = await service.history(A, { businessId: biz.id, since: mark.toISOString() });
    assert.equal(since.data.history.length, 1);
    assert.equal(since.data.history[0]!.field, "operating_status");
    const all = await service.history(A, { businessId: biz.id });
    assert.equal(all.data.history.length, 2);
    assert.equal(all.data.history[0]!.kind, "status_change", "newest first");
  });

  test("links: the issue must be in the company, and relinking only changes the role", async () => {
    const biz = await createBusiness(A, "Example Links LLC");
    const first = await service.linkIssue(A, { businessId: biz.id, issueId: ISSUE_A2, role: "case:notice" });
    assert.equal(first.data.created, true);
    const same = await service.linkIssue(A, { businessId: biz.id, issueId: ISSUE_A2, role: "case:notice" });
    assert.equal(same.data.created || same.data.changed, false);
    const role = await service.linkIssue(A, { businessId: biz.id, issueId: ISSUE_A2, role: "records" });
    assert.equal(role.data.changed, true);
    assert.equal(await count("business_issue_links", "business_id = $1", [biz.id]), 1);
    assert.equal(await codeOf(service.linkIssue(A, { businessId: biz.id, issueId: ISSUE_B, role: "records" })), "EISSUE_NOT_FOUND");
    const got = await service.getBusiness(A, { businessId: biz.id });
    assert.equal(got.data.links[0]?.issue?.title, "Example notice case");
  });

  test("company B cannot see or use any of company A's rows", async () => {
    const aBiz = await createBusiness(A, "Example Private LLC");
    const aDoc = await addDoc(A, aBiz.id);
    const aFiling = (await service.upsertFiling(A, { businessId: aBiz.id, filing: "Annual report", authority: "Example State", periodLabel: "2026", dueDate: "2026-09-01" })).data.filing;
    await service.linkIssue(A, { businessId: aBiz.id, issueId: ISSUE_A, role: "records" });

    const listB = await service.listBusinesses(B, {});
    assert.ok(listB.data.businesses.every((b) => b.companyId === COMPANY_B));
    assert.ok(!listB.data.businesses.some((b) => b.id === aBiz.id));
    assert.equal((await service.listBusinesses(B, { query: "Private" })).data.businesses.length, 0);

    assert.equal(await codeOf(service.getBusiness(B, { businessId: aBiz.id })), "EBUSINESS_NOT_FOUND");
    assert.equal(await codeOf(service.listDocuments(B, { businessId: aBiz.id })), "EBUSINESS_NOT_FOUND");
    assert.equal(await codeOf(service.listFilings(B, { businessId: aBiz.id })), "EBUSINESS_NOT_FOUND");
    assert.equal(await codeOf(service.history(B, { businessId: aBiz.id })), "EBUSINESS_NOT_FOUND");
    assert.equal(await codeOf(service.businessDetail(B, aBiz.id)), "EBUSINESS_NOT_FOUND");
    assert.equal(
      await codeOf(service.setStatus(B, { businessId: aBiz.id, field: "operating", value: "ceased", asOf: "2026-01-01", source: { kind: "user_reported" } })),
      "EBUSINESS_NOT_FOUND",
    );
    assert.equal(await codeOf(service.setFilingStatus(B, { filingId: aFiling.id, status: "in_preparation" })), "EFILING_NOT_FOUND");
    assert.equal(await codeOf(service.upsertBusiness(B, { id: aBiz.id, notes: "hijack" })), "EBUSINESS_NOT_FOUND");

    // Company-wide reads from B return nothing of A's.
    assert.ok((await service.listDocuments(B, {})).data.documents.every((d) => d.id !== aDoc.id));
    assert.ok((await service.listFilings(B, { overdueWithoutProof: true })).data.filings.every((f) => f.id !== aFiling.id));
    assert.ok((await service.history(B, {})).data.history.every((h) => h.businessId !== aBiz.id));
    const overviewB = await service.overview(B);
    assert.ok(overviewB.overdueFilings.every((f) => f.businessId !== aBiz.id));

    // B cannot cite A's document as proof for its own business.
    const bBiz = await createBusiness(B, "Example B Holdings LLC");
    assert.equal(
      await codeOf(service.setStatus(B, { businessId: bBiz.id, field: "legal", value: "active", asOf: "2026-01-01", source: { kind: "document", documentId: aDoc.id } })),
      "EPROOF_REQUIRED",
    );

    // And A still sees its own.
    const overviewA = await service.overview(A);
    assert.ok(overviewA.overdueFilings.some((f) => f.id === aFiling.id));
    const detailA = await service.businessDetail(A, aBiz.id);
    assert.equal(detailA.business.id, aBiz.id);
    assert.equal(detailA.documents.length, 1);
    assert.equal(detailA.filings.length, 1);
    assert.equal(detailA.links.length, 1);
    assert.ok(detailA.history.length >= 2);
  });
  test("editing a document from the page cleans HTML entities, writes one history row, and is company-scoped", async () => {
    const biz = await createBusiness(A, "Example Page Edit LLC");
    const doc = await addDoc(A, biz.id, { docType: "other", title: "2025 Profit &amp; Loss (QuickBooks)" });
    assert.equal(doc.title, "2025 Profit & Loss (QuickBooks)", "entities are decoded on the way in");

    const edited = await service.updateDocument(A, { documentId: doc.id, docType: "tax_return", title: "2025 P&L", documentDate: "2025-12-31" });
    assert.deepEqual(edited.data.changed, ["type", "title", "document date"]);
    assert.equal(edited.data.document.docType, "tax_return");
    assert.equal(await count("business_history", "subject_id = $1 AND kind = 'document_updated'", [doc.id]), 1);

    const again = await service.updateDocument(A, { documentId: doc.id, docType: "tax_return", title: "2025 P&L" });
    assert.deepEqual(again.data.changed, []);
    assert.equal(await count("business_history", "subject_id = $1 AND kind = 'document_updated'", [doc.id]), 1);

    assert.equal(await codeOf(service.updateDocument(B, { documentId: doc.id, title: "Hijack" })), "EDOCUMENT_NOT_FOUND");
  });

  test("a document that proves a status or a filing cannot be removed until that changes", async () => {
    const biz = await createBusiness(A, "Example Page Proof LLC");
    const cert = await addDoc(A, biz.id);
    await service.setStatus(A, {
      businessId: biz.id,
      field: "legal",
      value: "active",
      asOf: "2026-01-10",
      source: { kind: "document", documentId: cert.id },
    });
    assert.equal(await codeOf(service.removeDocument(A, { documentId: cert.id })), "EDOCUMENT_IN_USE");

    const confirmation = await addDoc(A, biz.id, { docType: "filing_confirmation", title: "Annual report confirmation" });
    const filing = await service.upsertFiling(A, {
      businessId: biz.id,
      filing: "Annual report",
      authority: "State",
      periodLabel: "2026",
      dueDate: "2026-06-30",
    });
    await service.setFilingStatus(A, { filingId: filing.data.filing.id, status: "filed", proofDocumentId: confirmation.id });
    assert.equal(await codeOf(service.removeDocument(A, { documentId: confirmation.id })), "EDOCUMENT_IN_USE");
    assert.equal(await count("business_documents", "id = ANY($1::uuid[]) AND removed_at IS NOT NULL", [[cert.id, confirmation.id]]), 0);
  });

  test("removing a document hides it everywhere, keeps the row and history, and adding the file again brings it back", async () => {
    const biz = await createBusiness(A, "Example Page Remove LLC");
    const ref = `file-${randomUUID()}.pdf`;
    const doc = await addDoc(A, biz.id, { attachmentRef: ref, title: "Old bylaws", docType: "bylaws" });

    assert.equal(await codeOf(service.removeDocument(B, { documentId: doc.id })), "EDOCUMENT_NOT_FOUND");
    const removed = await service.removeDocument(A, { documentId: doc.id, reason: "wrong business" });
    assert.match(removed.summary, /still on its issue/);
    assert.equal(await count("business_documents", "id = $1 AND removed_at IS NOT NULL AND removed_reason = 'wrong business'", [doc.id]), 1);
    assert.equal(await count("business_history", "subject_id = $1 AND kind = 'document_removed'", [doc.id]), 1);

    const detail = await service.businessDetail(A, biz.id);
    assert.equal(detail.documents.some((d) => d.id === doc.id), false);
    assert.equal(await codeOf(service.removeDocument(A, { documentId: doc.id })), "EDOCUMENT_NOT_FOUND");
    assert.notEqual(
      await codeOf(
        service.setStatus(A, { businessId: biz.id, field: "legal", value: "active", asOf: "2026-01-10", source: { kind: "document", documentId: doc.id } }),
      ),
      null,
      "a removed document cannot be cited as proof",
    );

    const back = await service.addDocument(A, { businessId: biz.id, docType: "bylaws", title: "Bylaws", issueId: ISSUE_A, attachmentRef: ref });
    assert.equal(back.data.created, true);
    assert.equal(back.data.document.id, doc.id, "the removed row comes back rather than a second row");
    assert.equal(back.data.document.title, "Bylaws");
    assert.match(back.summary, /^Restored/);
  });

  test("removing a replacement makes the document it replaced current again", async () => {
    const biz = await createBusiness(A, "Example Page Replace LLC");
    const first = await addDoc(A, biz.id, { title: "Certificate, first copy" });
    const second = await addDoc(A, biz.id, { title: "Certificate, corrected", replacesDocumentId: first.id });
    let current = (await service.businessDetail(A, biz.id)).documents.map((d) => d.id);
    assert.deepEqual(current, [second.id]);

    const removed = await service.removeDocument(A, { documentId: second.id });
    assert.deepEqual(removed.data.restoredDocumentIds, [first.id]);
    current = (await service.businessDetail(A, biz.id)).documents.map((d) => d.id);
    assert.deepEqual(current, [first.id]);
  });
  test("adding a business from the page refuses a name already on record instead of overwriting it", async () => {
    const original = await createBusiness(A, "Example Page Name LLC", { notes: "keep me" });
    assert.equal(
      await codeOf(service.createBusiness(A, { name: "example page name llc", relationship: "prospect", notes: null })),
      "EBUSINESS_NAME_TAKEN",
    );
    const after = (await service.getBusiness(A, { businessId: original.id })).data.business;
    assert.equal(after.notes, "keep me");
    assert.equal(after.relationship, "owned");
    const fresh = await service.createBusiness(A, { name: "Example Page New LLC", relationship: "prospect" });
    assert.equal(fresh.data.created, true);
  });
}
