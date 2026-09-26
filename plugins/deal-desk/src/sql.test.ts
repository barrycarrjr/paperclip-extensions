import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as sql from "./sql.js";
import {
  buildCountScenariosByBasis,
  buildFindAdjustmentByDescription,
  buildFindDealByBusiness,
  buildFindPeriod,
  buildFindScenarioByIdempotencyKey,
  buildGetAdjustment,
  buildGetDeal,
  buildGetScenarios,
  buildInsertAdjustment,
  buildInsertDeal,
  buildInsertHistory,
  buildInsertPeriod,
  buildInsertScenario,
  buildListAdjustments,
  buildListDeals,
  buildListHistory,
  buildListPeriods,
  buildListScenarios,
  buildSetAdjustmentStatus,
  buildTouchDeal,
  buildUpdateAdjustment,
  buildUpdateDeal,
  buildUpdatePeriod,
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

const NS = "plugin_deal_desk_bf83b73d01";
const CO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEAL = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, "..", "migrations", "001_init.sql"), "utf8");
const SQL_SOURCE = readFileSync(join(HERE, "sql.ts"), "utf8");

test("the namespace hardcoded in the migration is the one the host derives", () => {
  assert.equal(derivePluginDatabaseNamespace("deal-desk", "deal_desk"), NS);
  assert.ok(MIGRATION.includes(`${NS}.deals`));
});

test("every later migration passes the host's migration rules too", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const later = readdirSync(dir).filter((f) => f.endsWith(".sql") && f !== "001_init.sql").sort();
  assert.ok(later.includes("002_owner_claimed_by.sql"));
  for (const file of later) {
    for (const statement of splitSqlStatements(readFileSync(join(dir, file), "utf8"))) {
      assert.doesNotThrow(() => validateMigrationStatement(statement, NS), `${file}: ${statement.slice(0, 80)}`);
    }
  }
});

test("every migration statement passes the host's migration rules", () => {
  const statements = splitSqlStatements(MIGRATION);
  assert.ok(statements.length >= 12, `expected the tables and indexes, got ${statements.length}`);
  for (const statement of statements) {
    assert.doesNotThrow(() => validateMigrationStatement(statement, NS), statement.slice(0, 80));
  }
});

test("every table has company_id not null", () => {
  for (const table of ["deals", "earnings_periods", "earnings_adjustments", "scenarios", "deal_history"]) {
    const block = MIGRATION.split(`CREATE TABLE ${NS}.${table} (`)[1]!.split(");")[0]!;
    assert.match(block, /company_id uuid NOT NULL/, table);
  }
});

test("the unique keys the rules rely on are in the migration", () => {
  assert.match(MIGRATION, /CREATE UNIQUE INDEX deals_company_business_uq\s+ON \S+\.deals \(company_id, business_id\)/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX earnings_periods_label_source_uq\s+ON \S+\.earnings_periods \(deal_id, period_label, source_kind\)/);
  assert.match(MIGRATION, /CREATE UNIQUE INDEX earnings_adjustments_description_uq\s+ON \S+\.earnings_adjustments \(deal_id, period_label, lower\(description\)\)/);
  assert.match(MIGRATION, /CHECK \(status <> 'accepted' OR evidence_document_id IS NOT NULL\)/);
});

const READS: Array<{ name: string; stmt: SqlStatement }> = [
  { name: "getDeal", stmt: buildGetDeal(NS, CO, DEAL) },
  { name: "findDealByBusiness", stmt: buildFindDealByBusiness(NS, CO, ID2) },
  { name: "listDeals", stmt: buildListDeals(NS, CO) },
  { name: "listDeals (stages)", stmt: buildListDeals(NS, CO, { stages: ["screen", "offer"] }) },
  { name: "listPeriods", stmt: buildListPeriods(NS, CO, DEAL) },
  { name: "listPeriods (filtered)", stmt: buildListPeriods(NS, CO, DEAL, { periodLabel: "2025", sourceKind: "pnl" }) },
  { name: "findPeriod", stmt: buildFindPeriod(NS, CO, { dealId: DEAL, periodLabel: "2025", sourceKind: "tax_return" }) },
  { name: "getAdjustment", stmt: buildGetAdjustment(NS, CO, ID2) },
  { name: "findAdjustmentByDescription", stmt: buildFindAdjustmentByDescription(NS, CO, { dealId: DEAL, periodLabel: "2025", description: "Vehicle" }) },
  { name: "listAdjustments", stmt: buildListAdjustments(NS, CO, DEAL) },
  { name: "listAdjustments (period)", stmt: buildListAdjustments(NS, CO, DEAL, { periodLabel: "2025" }) },
  { name: "listScenarios", stmt: buildListScenarios(NS, CO, DEAL) },
  { name: "countScenariosByBasis", stmt: buildCountScenariosByBasis(NS, CO, DEAL, "conservative") },
  { name: "getScenarios", stmt: buildGetScenarios(NS, CO, [DEAL, ID2]) },
  { name: "findScenarioByIdempotencyKey", stmt: buildFindScenarioByIdempotencyKey(NS, CO, DEAL, "k") },
  { name: "listHistory", stmt: buildListHistory(NS, CO, DEAL, 5) },
];

const WRITES: Array<{ name: string; stmt: SqlStatement }> = [
  {
    name: "insertDeal",
    stmt: buildInsertDeal(NS, CO, { id: DEAL, businessId: ID2, name: "Acquired Company LLC", stage: "screen", structure: "undecided", acquiringEntity: null, askingPriceCents: 100000000, currency: "USD", notes: null }),
  },
  { name: "updateDeal", stmt: buildUpdateDeal(NS, CO, DEAL, { name: "X", stage: "offer", askingPriceCents: 1, notes: null })! },
  { name: "touchDeal", stmt: buildTouchDeal(NS, CO, DEAL) },
  {
    name: "insertPeriod",
    stmt: buildInsertPeriod(NS, CO, { id: ID2, dealId: DEAL, periodLabel: "2025", periodStart: "2025-01-01", periodEnd: "2025-12-31", sourceKind: "tax_return", revenueCents: 1, netIncomeCents: -1, ownerCompCents: 0, depreciationCents: null, interestCents: 5, documentId: null, notes: null }),
  },
  { name: "updatePeriod", stmt: buildUpdatePeriod(NS, CO, ID2, { revenueCents: 2, documentId: ID2, periodEnd: "2025-12-31", notes: "n" })! },
  {
    name: "insertAdjustment",
    stmt: buildInsertAdjustment(NS, CO, { id: ID2, dealId: DEAL, periodLabel: "2025", description: "Vehicle", amountCents: 100, kind: "owner_perk", claimedBy: "seller", evidenceDocumentId: null, note: null }),
  },
  { name: "updateAdjustment", stmt: buildUpdateAdjustment(NS, CO, ID2, { amountCents: 5, evidenceDocumentId: ID2 }, { resetStatus: true, expectedStatus: "accepted" })! },
  { name: "setAdjustmentStatus", stmt: buildSetAdjustmentStatus(NS, CO, ID2, { status: "accepted", evidenceDocumentId: ID2, statusNote: null }, "unverified") },
  {
    name: "insertScenario",
    stmt: buildInsertScenario(NS, CO, { id: ID2, dealId: DEAL, name: "Base", earningsBasis: "conservative", basisNote: null, comparablesNote: "c", inputs: { a: 1 }, outputs: { summary: {} }, idempotencyKey: null }),
  },
  { name: "insertHistory", stmt: buildInsertHistory(NS, CO, { id: ID2, dealId: DEAL, kind: "deal_created", subjectId: null, field: null, oldValue: null, newValue: "x", actor: { agentId: "a" } }) },
];

test("every builder binds the company as $1 and filters or writes company_id with it", () => {
  for (const { name, stmt } of [...READS, ...WRITES]) {
    assert.equal(stmt.params[0], CO, `${name}: the company must be the first bound parameter`);
    assert.match(stmt.text, /company_id = \$1\b|, \$1,/, `${name}: must use $1 for company_id -> ${stmt.text}`);
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

test("every exported builder is covered by the lists above", () => {
  const exported = Object.keys(sql).filter((k) => k.startsWith("build")).sort();
  const covered = new Set(
    [...READS, ...WRITES].map((r) => `build${r.name.split(" ")[0]![0]!.toUpperCase()}${r.name.split(" ")[0]!.slice(1)}`),
  );
  assert.deepEqual(exported.filter((k) => !covered.has(k)), []);
});

test("scenarios are insert-only: no builder updates or deletes one", () => {
  assert.doesNotMatch(SQL_SOURCE, /UPDATE \$\{ns\}\.scenarios/);
  assert.doesNotMatch(SQL_SOURCE, /DELETE FROM \$\{ns\}\.scenarios/);
  for (const { name, stmt } of WRITES) {
    if (/\.scenarios\b/.test(stmt.text)) assert.match(stmt.text, /^INSERT INTO /, name);
  }
});

test("history is append-only: no builder updates or deletes a history row, and nothing deletes at all", () => {
  assert.doesNotMatch(SQL_SOURCE, /UPDATE \$\{ns\}\.deal_history/);
  assert.doesNotMatch(SQL_SOURCE, /DELETE FROM/);
});

test("no builder reads the public schema, so the manifest needs no coreReadTables", () => {
  for (const { name, stmt } of [...READS, ...WRITES]) {
    assert.ok(!/\bpublic\./.test(stmt.text), name);
  }
});

test("parameters are JSON-safe: objects are sent as JSON text", () => {
  for (const { name, stmt } of [...READS, ...WRITES]) {
    for (const p of stmt.params) {
      assert.ok(p === null || ["string", "number", "boolean"].includes(typeof p), `${name}: parameter ${JSON.stringify(p)}`);
    }
  }
});

test("new add-backs are inserted unverified, and an update that resets status says so in SQL", () => {
  assert.match(WRITES.find((w) => w.name === "insertAdjustment")!.stmt.text, /'unverified'/);
  const reset = buildUpdateAdjustment(NS, CO, ID2, { amountCents: 5 }, { resetStatus: true, expectedStatus: "accepted" })!;
  assert.match(reset.text, /status = 'unverified', status_note = NULL/);
  assert.match(reset.text, /AND status = \$\d+$/);
  const keep = buildUpdateAdjustment(NS, CO, ID2, { note: "n" }, { resetStatus: false, expectedStatus: "accepted" })!;
  assert.doesNotMatch(keep.text, /'unverified'/);
});
