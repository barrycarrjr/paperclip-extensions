/**
 * The deal-desk service against a real Postgres, not a stub.
 *
 * The unique keys (one deal per business, one period per source, one add-back
 * per description), the evidence check on accepted add-backs, insert-only
 * scenarios, append-only history and the company filter only really exist in
 * the database, so they are exercised here end to end, through the same
 * service the tools call.
 *
 * Runs only when DEAL_DESK_TEST_DATABASE_URL names a database, and prints why
 * it skipped when it does not. It creates its own randomly named schema from
 * the plugin's migration file (rewriting the namespace name) and drops it at
 * the end, so it touches nothing else in that database.
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
import { createDealService, type DealDb, type DealService } from "./service.js";
import { DealDeskError } from "./validate.js";
import { assertPlaceholdersMatch, validateRuntimeExecute, validateRuntimeQuery } from "./hostSqlRules.testutil.js";

const DATABASE_URL = process.env.DEAL_DESK_TEST_DATABASE_URL ?? "";
const SKIP_REASON =
  "DEAL_DESK_TEST_DATABASE_URL is not set, so the real Postgres tests were not run. Set it to a Postgres connection string to run them.";

const MIGRATION_SCHEMA = "plugin_deal_desk_bf83b73d01";

const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const EVIDENCE = randomUUID();

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof DealDeskError ? err.code : `UNEXPECTED ${(err as Error).message}`;
  }
}

const INPUTS = {
  closingDate: "2024-06-30",
  buyerSalaryCents: 7_500_000,
  workingCapitalCents: 10_000_000,
  maintenanceCapexCents: 2_500_000,
  newCapexCents: 500_000,
  equityPercent: 0.1,
  sellerNotePercent: 0.1,
  closingCostPercent: 0.05,
  loanTermYears: 10,
  interestRate: 0.1,
  assumedExitMultiple: 1_000_000 / 350_000,
  ffeCents: 10_000_000,
  ffeIncluded: true,
  inventoryCents: 5_000_000,
  inventoryIncluded: true,
  newProfitsCents: 2_000_000,
  newCostsCents: -1_000_000,
  buyerFundsAvailableCents: 35_000_000,
};

if (!DATABASE_URL) {
  console.log(`Skipping the deal-desk Postgres tests: ${SKIP_REASON}`);
  test("deal-desk rules that live in the database", { skip: SKIP_REASON }, () => {});
} else {
  const schema = `deal_desk_pg_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let pool: import("pg").Pool;
  let service: DealService;
  const sent: string[] = [];
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
    const db: DealDb = {
      namespace: schema,
      query: (async (text: string, params?: unknown[]) => {
        validateRuntimeQuery(text, schema);
        assertPlaceholdersMatch(text, params ?? []);
        sent.push(text);
        return (await pool.query(text, params as unknown[])).rows;
      }) as DealDb["query"],
      execute: async (text: string, params?: unknown[]) => {
        validateRuntimeExecute(text, schema);
        assertPlaceholdersMatch(text, params ?? []);
        sent.push(text);
        return { rowCount: (await pool.query(text, params as unknown[])).rowCount ?? 0 };
      },
    };
    service = createDealService({ db });
  });

  after(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });

  async function newDeal(call: typeof A, name = "Acquired Company LLC") {
    const r = await service.upsertDeal(call, { businessId: randomUUID(), name, askingPriceCents: 100_000_000 });
    return r.data.deal;
  }

  async function addPeriod(call: typeof A, dealId: string, extra: Record<string, unknown> = {}) {
    return (
      await service.upsertPeriod(call, {
        dealId,
        periodLabel: "2025",
        sourceKind: "tax_return",
        periodStart: "2025-01-01",
        periodEnd: "2025-12-31",
        revenueCents: 150_000_000,
        netIncomeCents: 25_000_000,
        ownerCompCents: 10_000_000,
        ...extra,
      })
    ).data.period;
  }

  test("one deal per business per company; a repeat upsert changes nothing and writes no history", async () => {
    const businessId = randomUUID();
    const first = await service.upsertDeal(A, { businessId, name: "Acquired Company LLC", askingPriceCents: 100_000_000 });
    assert.equal(first.data.created, true);
    const again = await service.upsertDeal(A, { businessId, name: "Acquired Company LLC", askingPriceCents: 100_000_000 });
    assert.equal(again.data.created, false);
    assert.deepEqual(again.data.changed, []);
    assert.equal(await count("deals", "company_id = $1 AND business_id = $2", [COMPANY_A, businessId]), 1);
    assert.equal(await count("deal_history", "deal_id = $1", [first.data.deal.id]), 1, "only deal_created");

    await assert.rejects(
      pool.query(`INSERT INTO ${schema}.deals (company_id, business_id, name) VALUES ($1, $2, 'Dup')`, [COMPANY_A, businessId]),
      /duplicate key/,
      "the unique index itself refuses a second deal for the business",
    );

    const staged = await service.upsertDeal(A, { dealId: first.data.deal.id, stage: "diligence" });
    assert.deepEqual(staged.data.changed, ["stage"]);
    const rows = await pool.query(`SELECT kind, field, old_value, new_value, actor FROM ${schema}.deal_history WHERE deal_id = $1 AND kind = 'stage_change'`, [first.data.deal.id]);
    assert.equal(rows.rows.length, 1);
    assert.deepEqual([rows.rows[0].old_value, rows.rows[0].new_value], ["screen", "diligence"]);
    assert.equal(rows.rows[0].actor.agentId, "agent-a");
  });

  test("one period per label and source; a tax return and a P&L for the same year sit side by side", async () => {
    const deal = await newDeal(A, "Example Periods LLC");
    const tax = await addPeriod(A, deal.id);
    const pnl = await addPeriod(A, deal.id, { sourceKind: "pnl", netIncomeCents: 27_000_000 });
    assert.notEqual(tax.id, pnl.id);
    const again = await service.upsertPeriod(A, { dealId: deal.id, periodLabel: "2025", sourceKind: "tax_return", netIncomeCents: 25_000_000 });
    assert.equal(again.data.created, false);
    assert.deepEqual(again.data.changed, []);
    assert.equal(await count("earnings_periods", "deal_id = $1", [deal.id]), 2);
    await assert.rejects(
      pool.query(
        `INSERT INTO ${schema}.earnings_periods (company_id, deal_id, period_label, period_start, period_end, source_kind, revenue_cents, net_income_cents, owner_comp_cents) VALUES ($1, $2, '2025', '2025-01-01', '2025-12-31', 'pnl', 1, 1, 1)`,
        [COMPANY_A, deal.id],
      ),
      /duplicate key/,
    );
    assert.equal(await codeOf(service.upsertPeriod(A, { dealId: deal.id, periodLabel: "2024", sourceKind: "pnl", periodStart: "2024-01-01", periodEnd: "2024-12-31" })), "EINVALID_INPUT", "missing money is refused, not zero");
  });

  test("the same add-back cannot be counted twice: service pre-check and the unique key itself", async () => {
    const deal = await newDeal(A, "Example Duplicates LLC");
    await addPeriod(A, deal.id);
    const first = await service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2025", description: "Owner vehicle lease", amountCents: 1_200_000, kind: "owner_perk", claimedBy: "seller" });
    assert.equal(first.data.adjustment.status, "unverified");
    assert.equal(
      await codeOf(service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2025", description: "OWNER VEHICLE LEASE", amountCents: 1, kind: "owner_perk", claimedBy: "agent" })),
      "EDUPLICATE_ADJUSTMENT",
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ${schema}.earnings_adjustments (company_id, deal_id, period_label, description, amount_cents, kind, claimed_by) VALUES ($1, $2, '2025', 'owner vehicle lease', 1, 'owner_perk', 'seller')`,
        [COMPANY_A, deal.id],
      ),
      /duplicate key/,
      "the unique index on lower(description) refuses it too",
    );
    assert.equal(await count("earnings_adjustments", "deal_id = $1", [deal.id]), 1);
    assert.equal(
      await codeOf(service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2019", description: "x", amountCents: 1, kind: "other", claimedBy: "seller" })),
      "EPERIOD_NOT_FOUND",
    );
  });

  test("accepting needs evidence (in code and in the database); rejecting needs a note; each change writes history", async () => {
    const deal = await newDeal(A, "Example Evidence LLC");
    await addPeriod(A, deal.id);
    const adj = (await service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2025", description: "Owner phone", amountCents: 240_000, kind: "owner_perk", claimedBy: "seller" })).data.adjustment;
    const other = (await service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2025", description: "Family trip", amountCents: 800_000, kind: "owner_perk", claimedBy: "seller" })).data.adjustment;

    assert.equal(await codeOf(service.setAdjustmentStatus(A, { adjustmentId: adj.id, status: "accepted" })), "EEVIDENCE_REQUIRED");
    assert.equal(await codeOf(service.setAdjustmentStatus(A, { adjustmentId: other.id, status: "rejected" })), "ENOTE_REQUIRED");
    await assert.rejects(
      pool.query(`UPDATE ${schema}.earnings_adjustments SET status = 'accepted' WHERE id = $1`, [adj.id]),
      /check constraint/,
      "the database refuses an accepted row without evidence too",
    );
    assert.equal(await count("deal_history", "subject_id = $1 AND kind = 'adjustment_status_change'", [adj.id]), 0, "refusals write nothing");

    const ok = await service.setAdjustmentStatus(A, { adjustmentId: adj.id, status: "accepted", evidenceDocumentId: EVIDENCE });
    assert.equal(ok.data.adjustment.status, "accepted");
    assert.equal(ok.data.adjustment.evidenceDocumentId, EVIDENCE);
    await service.setAdjustmentStatus(A, { adjustmentId: other.id, status: "rejected", note: "Personal travel, not a business cost" });
    assert.equal(await count("deal_history", "subject_id = $1 AND kind = 'adjustment_status_change'", [adj.id]), 1);

    // Changing what was checked puts it back to unverified.
    const changed = await service.upsertAdjustment(A, { adjustmentId: adj.id, amountCents: 300_000 });
    assert.equal(changed.data.statusReset, true);
    assert.equal(changed.data.adjustment.status, "unverified");
    // A note-only change keeps the status.
    await service.setAdjustmentStatus(A, { adjustmentId: adj.id, status: "accepted", evidenceDocumentId: EVIDENCE });
    const noted = await service.upsertAdjustment(A, { adjustmentId: adj.id, note: "Checked against the phone bills" });
    assert.equal(noted.data.adjustment.status, "accepted");

    const n = (await service.normalize(A, { dealId: deal.id, periodLabel: "2025" })).data.normalizations[0]!.normalization;
    assert.equal(n.conservativeSdeCents, 35_000_000 + 300_000);
    assert.equal(n.sellerClaimedSdeCents, 35_000_000 + 300_000, "the rejected add-back counts in neither");
  });

  test("scenarios: conservative first, saved once, never updated, compared side by side", async () => {
    const deal = await newDeal(A, "Example Scenarios LLC");
    await addPeriod(A, deal.id);
    await service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2025", description: "Seller says one-time repair", amountCents: 2_000_000, kind: "one_time", claimedBy: "seller" });

    assert.equal(
      await codeOf(service.runScenario(A, { dealId: deal.id, name: "Seller view", earningsBasis: "seller_claimed", periodLabel: "2025", inputs: INPUTS })),
      "ECONSERVATIVE_FIRST",
    );
    assert.equal(await count("scenarios", "deal_id = $1", [deal.id]), 0);

    const conservative = await service.runScenario(A, {
      dealId: deal.id,
      name: "Base case, conservative",
      earningsBasis: "conservative",
      periodLabel: "2025",
      inputs: INPUTS,
      comparablesNote: "Assumed; no comparables gathered yet",
      idempotencyKey: "base-1",
    });
    // This deal's conservative SDE is 350,000 and the inputs are the spreadsheet's sample, so the numbers match it.
    assert.equal(conservative.data.outputs.sourcesAndUses.sources.termLoanCents, 83_500_000);
    assert.ok(Math.abs(conservative.data.outputs.lender.dscr! - 1.652356063) < 1e-6);
    assert.match(conservative.summary, /assumed exit multiple/);

    const repeat = await service.runScenario(A, { dealId: deal.id, name: "Base case, conservative", earningsBasis: "conservative", periodLabel: "2025", inputs: INPUTS, idempotencyKey: "base-1" });
    assert.equal(repeat.data.reused, true);
    assert.equal(repeat.data.scenario.id, conservative.data.scenario.id);
    assert.equal(await count("scenarios", "deal_id = $1", [deal.id]), 1);

    const seller = await service.runScenario(A, { dealId: deal.id, name: "Seller view", earningsBasis: "seller_claimed", periodLabel: "2025", inputs: INPUTS });
    assert.equal(seller.data.inputs.calculator.cashFlowCents, 37_000_000);

    const stored = await pool.query(`SELECT inputs, outputs FROM ${schema}.scenarios WHERE id = $1`, [conservative.data.scenario.id]);
    assert.equal(stored.rows[0].inputs.comparablesNote, "Assumed; no comparables gathered yet");
    assert.equal(stored.rows[0].outputs.summary.cashFlowCents, 35_000_000);

    const cmp = await service.compareScenarios(A, { scenarioIds: [conservative.data.scenario.id, seller.data.scenario.id] });
    assert.equal(cmp.data.scenarios.length, 2);
    assert.match(cmp.summary, /Assumed exit multiple/);
    assert.match(cmp.summary, /\$350,000\.00/);
    assert.match(cmp.summary, /\$370,000\.00/);

    assert.equal(await count("deal_history", "deal_id = $1 AND kind = 'scenario_saved'", [deal.id]), 2);
    assert.ok(!sent.some((s) => /^UPDATE \S+\.scenarios/.test(s) || /^DELETE/.test(s)), "no statement ever updated or deleted a scenario");
  });

  test("company B cannot see or change company A's deals", async () => {
    const deal = await newDeal(A, "Example Isolation LLC");
    await addPeriod(A, deal.id);
    const adj = (await service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2025", description: "Owner meals", amountCents: 100_000, kind: "owner_perk", claimedBy: "seller" })).data.adjustment;
    const scenario = (await service.runScenario(A, { dealId: deal.id, name: "A only", earningsBasis: "conservative", periodLabel: "2025", inputs: INPUTS })).data.scenario;
    const other = (await service.runScenario(A, { dealId: deal.id, name: "A only 2", earningsBasis: "reported", periodLabel: "2025", inputs: INPUTS })).data.scenario;

    assert.equal((await service.listDeals(B, {})).data.deals.some((d) => d.id === deal.id), false);
    assert.equal(await codeOf(service.getDeal(B, { dealId: deal.id })), "EDEAL_NOT_FOUND");
    assert.equal(await codeOf(service.upsertDeal(B, { dealId: deal.id, stage: "passed" })), "EDEAL_NOT_FOUND");
    assert.equal(await codeOf(service.upsertPeriod(B, { dealId: deal.id, periodLabel: "2025", sourceKind: "tax_return", netIncomeCents: 1 })), "EDEAL_NOT_FOUND");
    assert.equal(await codeOf(service.upsertAdjustment(B, { adjustmentId: adj.id, amountCents: 1 })), "EADJUSTMENT_NOT_FOUND");
    assert.equal(await codeOf(service.setAdjustmentStatus(B, { adjustmentId: adj.id, status: "accepted", evidenceDocumentId: EVIDENCE })), "EADJUSTMENT_NOT_FOUND");
    assert.equal(await codeOf(service.normalize(B, { dealId: deal.id })), "EDEAL_NOT_FOUND");
    assert.equal(await codeOf(service.runScenario(B, { dealId: deal.id, name: "x", earningsBasis: "conservative", periodLabel: "2025", inputs: INPUTS })), "EDEAL_NOT_FOUND");
    assert.equal(await codeOf(service.compareScenarios(B, { scenarioIds: [scenario.id, other.id] })), "ESCENARIO_NOT_FOUND");
    assert.equal(await codeOf(service.dealDetail(B, deal.id)), "EDEAL_NOT_FOUND");

    // Nothing B tried changed anything of A's.
    const after = (await service.getDeal(A, { dealId: deal.id })).data;
    assert.equal(after.deal.stage, "screen");
    assert.equal(after.adjustments[0]!.amountCents, 100_000);
    assert.equal(after.adjustments[0]!.status, "unverified");
    assert.equal(await count("deal_history", "company_id = $1", [COMPANY_B]), 0);

    // The same business id may have a deal in B as well; each company sees only its own.
    const inB = await service.upsertDeal(B, { businessId: deal.businessId, name: "Acquired Company LLC" });
    assert.notEqual(inB.data.deal.id, deal.id);
  });

  test("history is written for every kind of change and is newest first in deal_get", async () => {
    const deal = await newDeal(A, "Example History LLC");
    const period = await addPeriod(A, deal.id);
    await service.upsertPeriod(A, { dealId: deal.id, periodLabel: "2025", sourceKind: "tax_return", notes: "From the filed return" });
    const adj = (await service.upsertAdjustment(A, { dealId: deal.id, periodLabel: "2025", description: "Owner insurance", amountCents: 500_000, kind: "owner_perk", claimedBy: "seller" })).data.adjustment;
    await service.setAdjustmentStatus(A, { adjustmentId: adj.id, status: "accepted", evidenceDocumentId: EVIDENCE });
    await service.runScenario(A, { dealId: deal.id, name: "H", earningsBasis: "conservative", periodLabel: "2025", inputs: INPUTS });
    const kinds = (await pool.query(`SELECT kind FROM ${schema}.deal_history WHERE deal_id = $1 ORDER BY created_at`, [deal.id])).rows.map((r) => r.kind);
    assert.deepEqual(kinds, ["deal_created", "period_added", "period_updated", "adjustment_added", "adjustment_status_change", "adjustment_updated", "scenario_saved"]);
    const got = (await service.getDeal(A, { dealId: deal.id })).data;
    assert.equal(got.history[0]!.kind, "scenario_saved");
    assert.equal(got.periods[0]!.id, period.id);
    assert.equal(got.scenarios.length, 1);
    assert.equal(got.scenarios[0]!.summary?.cashFlowCents, 35_500_000);
  });
}
