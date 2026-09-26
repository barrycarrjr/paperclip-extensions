import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  addDays,
  buildFindBusinessByName,
  buildFindDuplicateDocument,
  buildFindFilingByKey,
  buildGetBusiness,
  buildGetDocument,
  buildGetFiling,
  buildGetLink,
  buildInsertBusiness,
  buildInsertDocument,
  buildInsertFiling,
  buildInsertHistory,
  buildInsertLink,
  buildListBusinesses,
  buildListDocuments,
  buildListFilings,
  buildListHistory,
  buildListLinks,
  buildMarkReplaced,
  buildSetFilingStatus,
  buildSetStatus,
  buildUpdateBusiness,
  buildUpdateFiling,
  buildUpdateLinkRole,
  escapeLike,
  type SqlStatement,
} from "./sql.js";
import {
  assertPlaceholdersMatch,
  derivePluginDatabaseNamespace,
  splitSqlStatements,
  validateMigrationStatement,
  validateRuntimeExecute,
  validateRuntimeQuery,
} from "./hostSqlRules.testutil.js";

const NS = "plugin_business_records_95a607b2ab";
const CO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BIZ = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

const MIGRATION = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "001_init.sql"), "utf8");

test("the namespace hardcoded in the migration is the one the host derives", () => {
  assert.equal(derivePluginDatabaseNamespace("business-records", "business_records"), NS);
  assert.ok(MIGRATION.includes(`${NS}.businesses`));
});

test("every later migration passes the host's migration rules too", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const later = readdirSync(dir).filter((f) => f.endsWith(".sql") && f !== "001_init.sql").sort();
  assert.ok(later.includes("002_owner_preparer.sql"));
  for (const file of later) {
    for (const statement of splitSqlStatements(readFileSync(join(dir, file), "utf8"))) {
      assert.doesNotThrow(() => validateMigrationStatement(statement, NS), `${file}: ${statement.slice(0, 80)}`);
    }
  }
});

test("every migration statement passes the host's migration rules", () => {
  const statements = splitSqlStatements(MIGRATION);
  assert.ok(statements.length >= 10, `expected the tables and indexes, got ${statements.length}`);
  for (const statement of statements) {
    assert.doesNotThrow(() => validateMigrationStatement(statement, NS), statement.slice(0, 80));
  }
});

const READS: Array<{ name: string; stmt: SqlStatement }> = [
  { name: "getBusiness", stmt: buildGetBusiness(NS, CO, BIZ) },
  { name: "findBusinessByName", stmt: buildFindBusinessByName(NS, CO, "Example Widgets LLC") },
  { name: "listBusinesses", stmt: buildListBusinesses(NS, CO) },
  { name: "listBusinesses (filtered)", stmt: buildListBusinesses(NS, CO, { relationship: "owned", query: "widget" }) },
  { name: "getDocument", stmt: buildGetDocument(NS, CO, ID2) },
  {
    name: "findDuplicateDocument (attachment)",
    stmt: buildFindDuplicateDocument(NS, CO, { businessId: BIZ, issueId: ID2, docType: "other", attachmentRef: "a.pdf", title: "T", documentDate: null, idempotencyKey: "k" }),
  },
  {
    name: "findDuplicateDocument (no attachment)",
    stmt: buildFindDuplicateDocument(NS, CO, { businessId: BIZ, issueId: ID2, docType: "other", attachmentRef: null, title: "T", documentDate: "2026-01-01", idempotencyKey: null }),
  },
  { name: "listDocuments", stmt: buildListDocuments(NS, CO) },
  { name: "listDocuments (filtered)", stmt: buildListDocuments(NS, CO, { businessId: BIZ, docType: "bylaws", renewalOnOrBefore: "2026-12-01", includeReplaced: true }) },
  { name: "getFiling", stmt: buildGetFiling(NS, CO, ID2) },
  { name: "findFilingByKey", stmt: buildFindFilingByKey(NS, CO, { businessId: BIZ, filing: "F", authority: "IRS", periodLabel: "2026" }) },
  { name: "listFilings", stmt: buildListFilings(NS, CO) },
  {
    name: "listFilings (all filters)",
    stmt: buildListFilings(NS, CO, { businessId: BIZ, statuses: ["upcoming", "filed"], today: "2026-01-01", dueOnOrBefore: "2026-02-01", overdueBefore: "2026-01-01", openOnly: true }),
  },
  { name: "getLink", stmt: buildGetLink(NS, CO, BIZ, ID2) },
  { name: "listLinks", stmt: buildListLinks(NS, CO, BIZ) },
  { name: "listHistory", stmt: buildListHistory(NS, CO) },
  { name: "listHistory (filtered)", stmt: buildListHistory(NS, CO, { businessId: BIZ, since: "2026-01-01T00:00:00.000Z", limit: 5 }) },
];

const WRITES: Array<{ name: string; stmt: SqlStatement }> = [
  {
    name: "insertBusiness",
    stmt: buildInsertBusiness(NS, CO, {
      id: BIZ,
      name: "Example Widgets LLC",
      otherNames: ["Example Widgets"],
      relationship: "owned",
      legalForm: "LLC",
      formationState: null,
      registrationStates: [],
      taxClassification: null,
      taxClassificationEffective: null,
      linkedCompanyIds: [],
      contacts: [],
      notes: null,
      taxIdLast4: "0000",
      statuses: { operating: { value: "not_yet_operating", asOf: "2026-01-01", source: { kind: "user_reported" } } },
    }),
  },
  { name: "updateBusiness", stmt: buildUpdateBusiness(NS, CO, BIZ, { name: "X", otherNames: ["Y"], contacts: [], taxClassificationEffective: null, linkedCompanyIds: [ID2] })! },
  { name: "setStatus", stmt: buildSetStatus(NS, CO, BIZ, "legal", { value: "active", asOf: "2026-01-01", source: { kind: "document", documentId: ID2 } }, "unknown") },
  {
    name: "insertDocument",
    stmt: buildInsertDocument(NS, CO, { id: ID2, businessId: BIZ, docType: "bylaws", title: "T", issuingBody: null, documentDate: null, renewalDate: null, issueId: ID2, attachmentRef: null, idempotencyKey: null, notes: null }),
  },
  { name: "markReplaced", stmt: buildMarkReplaced(NS, CO, BIZ, ID2, BIZ) },
  {
    name: "insertFiling",
    stmt: buildInsertFiling(NS, CO, { id: ID2, businessId: BIZ, filing: "F", authority: "IRS", periodLabel: "2026", periodStart: null, periodEnd: null, dueDate: "2027-03-15", preparer: "cpa", issueId: null, notes: null }),
  },
  { name: "updateFiling", stmt: buildUpdateFiling(NS, CO, ID2, { dueDate: "2027-03-16", issueId: null, notes: "n" })! },
  { name: "setFilingStatus (filed)", stmt: buildSetFilingStatus(NS, CO, ID2, { status: "filed", proofDocumentId: BIZ, extendedDueDate: null, reason: null, source: null }, "upcoming") },
  {
    name: "setFilingStatus (not_required)",
    stmt: buildSetFilingStatus(NS, CO, ID2, { status: "not_required", proofDocumentId: null, extendedDueDate: null, reason: "r", source: { kind: "official_guidance", url: "https://example.gov" } }, "upcoming"),
  },
  { name: "insertLink", stmt: buildInsertLink(NS, CO, BIZ, ID2, "records") },
  { name: "updateLinkRole", stmt: buildUpdateLinkRole(NS, CO, BIZ, ID2, "case:notice") },
  {
    name: "insertHistory",
    stmt: buildInsertHistory(NS, CO, { id: ID2, businessId: BIZ, kind: "status_change", subjectId: null, field: "legal_status", oldValue: "unknown", newValue: "active", asOf: "2026-01-01", source: { kind: "document" }, actor: { agentId: null } }),
  },
];

test("every builder binds the company as $1 and filters or writes company_id with it", () => {
  for (const { name, stmt } of [...READS, ...WRITES]) {
    assert.equal(stmt.params[0], CO, `${name}: the company must be the first bound parameter`);
    assert.match(stmt.text, /company_id = \$1\b|\(\$1|, \$1,/, `${name}: must use $1 for company_id -> ${stmt.text}`);
  }
});

test("every read passes the host's ctx.db.query rules and binds every parameter", () => {
  for (const { name, stmt } of READS) {
    assert.doesNotThrow(() => validateRuntimeQuery(stmt.text, NS), name);
    assert.doesNotThrow(() => assertPlaceholdersMatch(stmt.text, stmt.params), name);
  }
});

test("every write passes the host's ctx.db.execute rules and binds every parameter", () => {
  for (const { name, stmt } of WRITES) {
    assert.doesNotThrow(() => validateRuntimeExecute(stmt.text, NS), name);
    assert.doesNotThrow(() => assertPlaceholdersMatch(stmt.text, stmt.params), name);
  }
});

test("no builder reads the public schema, so the manifest needs no coreReadTables", () => {
  for (const { name, stmt } of [...READS, ...WRITES]) {
    assert.ok(!/\bpublic\./.test(stmt.text), name);
  }
});

test("parameters are JSON-safe: arrays and objects are sent as JSON text", () => {
  for (const { name, stmt } of [...READS, ...WRITES]) {
    for (const p of stmt.params) {
      assert.ok(p === null || ["string", "number", "boolean"].includes(typeof p), `${name}: parameter ${JSON.stringify(p)}`);
    }
  }
});

test("the filing insert is idempotent: ON CONFLICT DO NOTHING against the period unique key", () => {
  const stmt = WRITES.find((w) => w.name === "insertFiling")!.stmt;
  assert.match(stmt.text, /ON CONFLICT DO NOTHING$/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX business_filings_period_uq\s+ON \S+\.business_filings \(business_id, lower\(filing\), lower\(authority\), period_label\)/);
  // Two calls for the same period differ only in the generated row id, so the
  // second one lands on the unique key and inserts nothing.
  const next = { businessId: BIZ, filing: "F", authority: "IRS", periodLabel: "2027", periodStart: null, periodEnd: null, dueDate: "2028-03-15", preparer: null, issueId: null, notes: null };
  const a = buildInsertFiling(NS, CO, { id: "x", ...next });
  const b = buildInsertFiling(NS, CO, { id: "y", ...next });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.params.slice(2), b.params.slice(2));
});

test("status updates only apply when the current value is still the one that was read", () => {
  const stmt = buildSetStatus(NS, CO, BIZ, "tax_account", { value: "open", asOf: "2026-01-01", source: null }, "not_yet_registered");
  assert.match(stmt.text, /AND tax_account_status = \$6$/);
  assert.equal(stmt.params[5], "not_yet_registered");
});

test("the business unique name index is per company and case-insensitive", () => {
  assert.match(MIGRATION, /CREATE UNIQUE INDEX businesses_company_name_uq\s+ON \S+\.businesses \(company_id, lower\(name\)\)/);
});

test("replaced documents are left out of the current list unless asked for", () => {
  assert.match(buildListDocuments(NS, CO).text, /d\.replaced_by IS NULL/);
  assert.doesNotMatch(buildListDocuments(NS, CO, { includeReplaced: true }).text, /replaced_by IS NULL/);
});

test("search terms have LIKE wildcards escaped", () => {
  assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
  const stmt = buildListBusinesses(NS, CO, { query: "50%" });
  assert.equal(stmt.params[1], "%50\\%%");
});

test("addDays does calendar arithmetic in UTC", () => {
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-09-26", 60), "2026-11-25");
});
