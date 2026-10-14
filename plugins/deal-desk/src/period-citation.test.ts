import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createDealService, type DealDb } from "./service.js";
import { DealDeskError } from "./validate.js";
import type { PeriodRow, PeriodSourceKind } from "./domain.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEAL = "11111111-1111-4111-8111-111111111111";
const DOCUMENT = "33333333-3333-4333-8333-333333333333";
const OTHER_DOCUMENT = "44444444-4444-4444-8444-444444444444";
const call = { companyId: COMPANY, actor: { agentId: "agent", runId: "run" } };
const values = { dealId: DEAL, periodLabel: "2025", periodStart: "2025-01-01", periodEnd: "2025-12-31", revenueCents: 10000, netIncomeCents: 2000, ownerCompCents: 3000 };

function fixture(sourceKind: PeriodSourceKind, options: { existing?: boolean; documentId?: string | null } = {}) {
  let row: Record<string, unknown> | null = options.existing ? {
    id: "22222222-2222-4222-8222-222222222222", company_id: COMPANY, deal_id: DEAL, period_label: "2025", source_kind: sourceKind,
    period_start: "2025-01-01", period_end: "2025-12-31", revenue_cents: "10000", net_income_cents: "2000", owner_comp_cents: "3000", depreciation_cents: "50", interest_cents: "60",
    document_id: options.documentId ?? null, notes: null, created_at: "2026-01-01", updated_at: "2026-01-01",
  } satisfies PeriodRow : null;
  const writes: string[] = [];
  const db: DealDb = {
    namespace: "plugin_test",
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      assert.equal(params[0], COMPANY);
      if (sql.includes("FROM plugin_test.deals")) return [{ id: DEAL, company_id: COMPANY, business_id: OTHER_DOCUMENT, name: "Target", stage: "diligence", structure: "asset", acquiring_entity: null, asking_price_cents: null, currency: "USD", notes: null, created_at: "2026-01-01", updated_at: "2026-01-01" }] as T[];
      if (sql.includes("FROM plugin_test.earnings_periods")) return row ? [{ ...row }] as T[] : [];
      return [];
    },
    async execute(sql, params = []) {
      writes.push(sql);
      if (sql.startsWith("INSERT INTO plugin_test.earnings_periods")) {
        const columns = /earnings_periods \(([^)]+)\)/.exec(sql)![1]!.split(",").map(column => column.trim());
        const bindings = /VALUES \((.*?)\) ON CONFLICT/.exec(sql)![1]!.split(",").map(value => Number(/\$(\d+)/.exec(value)![1]) - 1);
        row = Object.fromEntries(columns.map((column, i) => [column, params[bindings[i]!] ]));
        row.created_at = "2026-01-01"; row.updated_at = "2026-01-01";
      } else if (sql.startsWith("UPDATE plugin_test.earnings_periods")) {
        for (const match of sql.split("WHERE")[0]!.matchAll(/([a-z_]+)\s*=\s*\$(\d+)/g)) row![match[1]!] = params[Number(match[2]) - 1];
      }
      return { rowCount: 1 };
    },
  };
  return { service: createDealService({ db }), writes, readRow: () => row };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => error instanceof DealDeskError && error.code === code);
}

for (const sourceKind of ["tax_return", "pnl", "bank"] as const) {
  test(`${sourceKind}: creation requires a citation before any write`, async () => {
    for (const documentId of [undefined, null, "", "not-a-document", 42]) {
      const f = fixture(sourceKind);
      await rejectsCode(f.service.upsertPeriod(call, { ...values, sourceKind, documentId }), documentId === undefined || documentId === null || documentId === "" ? "EEVIDENCE_REQUIRED" : "EINVALID_INPUT");
      assert.deepEqual(f.writes, []);
    }
    const f = fixture(sourceKind); const result = await f.service.upsertPeriod(call, { ...values, sourceKind, documentId: DOCUMENT });
    assert.equal(result.data.period.documentId, DOCUMENT); assert.equal(result.data.created, true);
  });
  test(`${sourceKind}: changed facts on a legacy row require a citation, including nullable facts`, async () => {
    const changes = [{ revenueCents: 10001 }, { netIncomeCents: 2001 }, { ownerCompCents: 3001 }, { depreciationCents: null }, { interestCents: null }, { periodStart: "2025-01-02" }, { periodEnd: "2025-12-30" }];
    for (const change of changes) {
      const f = fixture(sourceKind, { existing: true });
      await rejectsCode(f.service.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind, ...change }), "EEVIDENCE_REQUIRED");
      assert.deepEqual(f.writes, []);
    }
  });
  test(`${sourceKind}: notes-only edits, legacy reads and unchanged facts remain available`, async () => {
    const f = fixture(sourceKind, { existing: true });
    const note = await f.service.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind, notes: "Awaiting source upload", revenueCents: 10000, documentId: null });
    assert.deepEqual(note.data.changed, ["notes"]); assert.equal(note.data.period.documentId, null);
    const before = f.writes.length; const noChange = await f.service.upsertPeriod(call, { ...values, sourceKind });
    assert.equal(noChange.data.created, false); assert.deepEqual(noChange.data.changed, []); assert.equal(f.writes.length, before);
    const read = await f.service.getDeal(call, { dealId: DEAL }); assert.ok(read.data);
  });
  test(`${sourceKind}: persisted citation is retained, replacement works, and removal is blocked`, async () => {
    const f = fixture(sourceKind, { existing: true, documentId: DOCUMENT });
    const updated = await f.service.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind, revenueCents: 10001 });
    assert.equal(updated.data.period.documentId, DOCUMENT); assert.equal(updated.data.period.revenueCents, 10001);
    for (const documentId of [null, ""]) {
      const before = f.writes.length; await rejectsCode(f.service.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind, documentId, notes: "clear citation" }), "EEVIDENCE_REQUIRED"); assert.equal(f.writes.length, before);
    }
    const repaired = await f.service.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind, documentId: OTHER_DOCUMENT, interestCents: null });
    assert.equal(repaired.data.period.documentId, OTHER_DOCUMENT); assert.equal(repaired.data.period.interestCents, null);
  });
}
test("an invalid persisted citation cannot authorize new financial facts", async () => {
  const f = fixture("tax_return", { existing: true, documentId: "invalid-legacy-id" });
  await rejectsCode(f.service.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind: "tax_return", netIncomeCents: 1 }), "EEVIDENCE_REQUIRED"); assert.deepEqual(f.writes, []);
});
for (const sourceKind of ["seller_stated", "other"] as const) test(`${sourceKind} keeps its existing citation-optional behavior`, async () => {
  const f = fixture(sourceKind); const created = await f.service.upsertPeriod(call, { ...values, sourceKind }); assert.equal(created.data.period.documentId, null);
  const updated = await f.service.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind, netIncomeCents: 1 }); assert.equal(updated.data.period.netIncomeCents, 1);
});
