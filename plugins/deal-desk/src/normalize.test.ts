/**
 * Earnings normalization: the two SDE figures, replacement cost on its own
 * line, EBITDA kept apart, and the service refusing a duplicate add-back
 * before it reaches the database. (The database's own unique key is tested in
 * service.pg.test.ts.)
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeEarnings, type NormalizeAdjustment } from "./calculator.js";
import type { AdjustmentRow, DealRow, PeriodRow } from "./domain.js";
import { createDealService, type DealDb } from "./service.js";
import { DealDeskError } from "./validate.js";

const adj = (description: string, amountCents: number, status: NormalizeAdjustment["status"], kind: NormalizeAdjustment["kind"] = "owner_perk"): NormalizeAdjustment => ({
  id: `id-${description}`,
  description,
  amountCents,
  kind,
  status,
});

const BASE = { reportedNetIncomeCents: 20_000_000, ownerCompCents: 10_000_000 };

test("conservative SDE counts accepted add-backs only; seller-claimed counts every one not rejected", () => {
  const n = normalizeEarnings({
    ...BASE,
    adjustments: [adj("Vehicle", 1_000_000, "accepted"), adj("Family phone plan", 300_000, "unverified"), adj("Trade show trip", 500_000, "rejected", "one_time")],
  });
  assert.equal(n.reportedSdeCents, 30_000_000);
  assert.equal(n.conservativeSdeCents, 31_000_000);
  assert.equal(n.sellerClaimedSdeCents, 31_300_000);
  assert.equal(n.unverifiedGapCents, 300_000);
  assert.deepEqual(n.unverified, { count: 1, totalCents: 300_000, adjustmentIds: ["id-Family phone plan"] });
  assert.deepEqual(n.rejected, { count: 1, totalCents: 500_000 });
  const byLabel = Object.fromEntries(n.lines.map((l) => [l.label, l]));
  assert.equal(byLabel["Vehicle"]!.inConservative, true);
  assert.equal(byLabel["Family phone plan"]!.inConservative, false);
  assert.equal(byLabel["Family phone plan"]!.inSellerClaimed, true);
  assert.equal(byLabel["Family phone plan"]!.unverified, true);
  assert.equal(byLabel["Trade show trip"]!.inSellerClaimed, false);
});

test("every line is itemised, starting with reported net income and owner compensation", () => {
  const n = normalizeEarnings({ ...BASE, adjustments: [adj("Vehicle", 1_000_000, "accepted")] });
  assert.deepEqual(
    n.lines.map((l) => [l.source, l.amountCents]),
    [
      ["reported_net_income", 20_000_000],
      ["owner_comp", 10_000_000],
      ["adjustment", 1_000_000],
    ],
  );
});

test("a negative add-back (a deduction) lowers the figure it counts in", () => {
  const n = normalizeEarnings({ ...BASE, adjustments: [adj("Below-market rent", -600_000, "accepted", "rent_to_owner")] });
  assert.equal(n.conservativeSdeCents, 29_400_000);
  assert.equal(n.sellerClaimedSdeCents, 29_400_000);
});

test("owner replacement cost is its own line, never part of SDE, and is deducted for SDE after owner replacement", () => {
  const n = normalizeEarnings({
    ...BASE,
    adjustments: [adj("Vehicle", 1_000_000, "accepted"), adj("General manager salary", 8_000_000, "unverified", "replacement_cost")],
  });
  assert.equal(n.conservativeSdeCents, 31_000_000, "replacement cost does not touch SDE");
  assert.equal(n.sellerClaimedSdeCents, 31_000_000);
  assert.equal(n.lines.some((l) => l.adjustmentKind === "replacement_cost"), false);
  assert.equal(n.ownerReplacement.lines.length, 1);
  assert.equal(n.ownerReplacement.totalCents, 8_000_000);
  assert.equal(n.ownerReplacement.conservativeSdeAfterReplacementCents, 23_000_000);
  assert.equal(n.ownerReplacement.sellerClaimedSdeAfterReplacementCents, 23_000_000);
});

test("a rejected replacement cost is not deducted", () => {
  const n = normalizeEarnings({ ...BASE, adjustments: [adj("Manager", 8_000_000, "rejected", "replacement_cost")] });
  assert.equal(n.ownerReplacement.totalCents, 0);
  assert.equal(n.ownerReplacement.conservativeSdeAfterReplacementCents, 30_000_000);
});

test("SDE and EBITDA are different figures and are never merged", () => {
  const n = normalizeEarnings({ ...BASE, interestCents: 1_500_000, depreciationCents: 2_500_000, adjustments: [adj("Vehicle", 1_000_000, "accepted")] });
  assert.equal(n.ebitda.ebitdaCents, 24_000_000, "net income + interest + depreciation, no owner comp");
  assert.equal(n.conservativeSdeCents, 31_000_000, "interest and depreciation are not added to SDE automatically");
  assert.notEqual(n.ebitda.ebitdaCents, n.conservativeSdeCents);
  assert.equal(n.lines.some((l) => /interest|depreciation/i.test(l.label)), false);
});

test("EBITDA is not computed when interest or depreciation is missing", () => {
  const n = normalizeEarnings({ ...BASE, interestCents: 1_500_000, adjustments: [] });
  assert.equal(n.ebitda.ebitdaCents, null);
  assert.deepEqual(n.ebitda.missing, ["depreciationCents"]);
});

// ---- The service pre-check for duplicates ----

const CO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEAL = "11111111-1111-4111-8111-111111111111";
const EXISTING = "22222222-2222-4222-8222-222222222222";
const NS = "plugin_deal_desk_bf83b73d01";

function fakeDb() {
  const writes: string[] = [];
  const dealRow: DealRow = {
    id: DEAL, company_id: CO, business_id: EXISTING, name: "Acquired Company LLC", stage: "screen", structure: "undecided",
    acquiring_entity: null, asking_price_cents: "100000000", currency: "USD", notes: null, created_at: "2026-01-01", updated_at: "2026-01-01",
  };
  const periodRow: PeriodRow = {
    id: EXISTING, company_id: CO, deal_id: DEAL, period_label: "2025", period_start: "2025-01-01", period_end: "2025-12-31",
    source_kind: "tax_return", revenue_cents: "150000000", net_income_cents: "20000000", owner_comp_cents: "10000000",
    depreciation_cents: null, interest_cents: null, document_id: null, notes: null, created_at: "2026-01-01", updated_at: "2026-01-01",
  };
  const adjustmentRow: AdjustmentRow = {
    id: EXISTING, company_id: CO, deal_id: DEAL, period_label: "2025", description: "Owner vehicle lease", amount_cents: "1000000",
    kind: "owner_perk", claimed_by: "seller", status: "unverified", evidence_document_id: null, note: null, status_note: null,
    created_at: "2026-01-01", updated_at: "2026-01-01",
  };
  const db: DealDb = {
    namespace: NS,
    query: (async (sql: string, params?: unknown[]) => {
      if (params?.[0] !== CO) return [];
      if (/FROM \S+\.deals d WHERE d\.company_id = \$1 AND d\.id = \$2/.test(sql)) return params?.[1] === DEAL ? [dealRow] : [];
      if (/FROM \S+\.earnings_periods e/.test(sql)) return [periodRow];
      if (/lower\(a\.description\) = lower\(\$4\)/.test(sql)) {
        return String(params?.[3]).toLowerCase() === "owner vehicle lease" ? [adjustmentRow] : [];
      }
      return [];
    }) as DealDb["query"],
    execute: async (sql: string) => {
      writes.push(sql);
      return { rowCount: 1 };
    },
  };
  return { db, writes };
}

test("the service refuses a duplicate add-back description (any letter case) before any write", async () => {
  const { db, writes } = fakeDb();
  const service = createDealService({ db });
  try {
    await service.upsertAdjustment(
      { companyId: CO, actor: {} },
      { dealId: DEAL, periodLabel: "2025", description: "OWNER VEHICLE LEASE", amountCents: 1_000_000, kind: "owner_perk", claimedBy: "seller" },
    );
    assert.fail("should have been refused");
  } catch (err) {
    assert.ok(err instanceof DealDeskError);
    assert.equal(err.code, "EDUPLICATE_ADJUSTMENT");
    assert.match(err.message, new RegExp(EXISTING));
  }
  assert.deepEqual(writes, []);
});

test("a new description on the same period is accepted and starts unverified", async () => {
  const { db, writes } = fakeDb();
  const service = createDealService({ db });
  await assert.rejects(
    // The fake database cannot read the new row back, so the call ends in a not-found after writing; what matters is the write.
    service.upsertAdjustment(
      { companyId: CO, actor: {} },
      { dealId: DEAL, periodLabel: "2025", description: "Owner phone", amountCents: 120_000, kind: "owner_perk", claimedBy: "seller" },
    ),
    /EADJUSTMENT_NOT_FOUND/,
  );
  assert.match(writes[0]!, /INSERT INTO \S+\.earnings_adjustments .* 'unverified'/);
});
