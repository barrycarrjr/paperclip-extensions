/**
 * Every rule the plugin enforces in code, positive and negative.
 * Rule 6 (company isolation) is in tools.test.ts and service.pg.test.ts.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { DEAL_INPUT_DEFAULTS, parseDealInputs } from "./dealInputs.js";
import type { AdjustmentApi, DealApi, PeriodApi } from "./domain.js";
import {
  ASSUMED_MULTIPLE_LABEL,
  assertNoSensitiveContent,
  checkAdjustmentStatusChange,
  checkScenarioBasis,
  findSecretField,
} from "./guards.js";
import { parseScenarioRequest, prepareScenario, scenarioContent, type ScenarioContext } from "./scenario.js";
import { createDealService, type DealDb } from "./service.js";
import { DealDeskError } from "./validate.js";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof DealDeskError ? err.code : `NOT_A_DEAL_DESK_ERROR ${(err as Error).message}`;
  }
}

const DOC = "33333333-3333-4333-8333-333333333333";
const DEAL = "11111111-1111-4111-8111-111111111111";
const BIZ = "22222222-2222-4222-8222-222222222222";

// ---- Rule 1 ----

test("rule 1: accepting an add-back without evidence is refused", () => {
  for (const evidence of [undefined, null, "", "   ", "not-a-uuid", "the seller said so"]) {
    assert.equal(
      codeOf(() => checkAdjustmentStatusChange({ status: "accepted", evidenceDocumentId: evidence as string | null | undefined, note: "looks right" })),
      "EEVIDENCE_REQUIRED",
      String(evidence),
    );
  }
});

test("rule 1: accepting with an evidence document id is allowed", () => {
  assert.equal(codeOf(() => checkAdjustmentStatusChange({ status: "accepted", evidenceDocumentId: DOC, note: null })), null);
});

test("rule 1: rejecting needs a note; unverified needs nothing", () => {
  assert.equal(codeOf(() => checkAdjustmentStatusChange({ status: "rejected", evidenceDocumentId: null, note: null })), "ENOTE_REQUIRED");
  assert.equal(codeOf(() => checkAdjustmentStatusChange({ status: "rejected", evidenceDocumentId: null, note: "  " })), "ENOTE_REQUIRED");
  assert.equal(codeOf(() => checkAdjustmentStatusChange({ status: "rejected", evidenceDocumentId: null, note: "Personal, not business" })), null);
  assert.equal(codeOf(() => checkAdjustmentStatusChange({ status: "unverified", evidenceDocumentId: null, note: null })), null);
  assert.equal(codeOf(() => checkAdjustmentStatusChange({ status: "maybe" as "accepted", evidenceDocumentId: DOC, note: null })), "EINVALID_INPUT");
});

// ---- Rule 2 ----

const basis = (over: Partial<Parameters<typeof checkScenarioBasis>[0]>) => () =>
  checkScenarioBasis({
    earningsBasis: "conservative",
    hasConservativeScenario: false,
    cashFlowCentsGiven: false,
    basisNote: null,
    periodLabel: "2025",
    ...over,
  });

test("rule 2: seller_claimed is refused until a conservative scenario exists", () => {
  assert.equal(codeOf(basis({ earningsBasis: "seller_claimed", hasConservativeScenario: false })), "ECONSERVATIVE_FIRST");
  assert.equal(codeOf(basis({ earningsBasis: "seller_claimed", hasConservativeScenario: true })), null);
});

test("rule 2: reported and conservative are always allowed", () => {
  assert.equal(codeOf(basis({ earningsBasis: "reported" })), null);
  assert.equal(codeOf(basis({ earningsBasis: "conservative" })), null);
});

test("rule 2: custom needs its cash flow and a note explaining it", () => {
  assert.equal(codeOf(basis({ earningsBasis: "custom", cashFlowCentsGiven: true, basisNote: null })), "ENOTE_REQUIRED");
  assert.equal(codeOf(basis({ earningsBasis: "custom", cashFlowCentsGiven: false, basisNote: "why" })), "EINVALID_INPUT");
  assert.equal(codeOf(basis({ earningsBasis: "custom", cashFlowCentsGiven: true, basisNote: "Average of 2024 and 2025 conservative SDE", periodLabel: null })), null);
});

test("rule 2: the basis supplies the cash flow, so cashFlowCents is refused for the other bases, and a period is required", () => {
  assert.equal(codeOf(basis({ earningsBasis: "conservative", cashFlowCentsGiven: true })), "EINVALID_INPUT");
  assert.equal(codeOf(basis({ earningsBasis: "reported", periodLabel: null })), "EINVALID_INPUT");
  assert.equal(codeOf(basis({ earningsBasis: "nonsense" as "reported" })), "EINVALID_INPUT");
});

// ---- Rule 3 (through the pure scenario step) ----

const deal: DealApi = {
  id: DEAL,
  businessId: BIZ,
  name: "Acquired Company LLC",
  stage: "screen",
  structure: "undecided",
  acquiringEntity: null,
  askingPriceCents: 100_000_000,
  currency: "USD",
  notes: null,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
};
const period: PeriodApi = {
  id: "44444444-4444-4444-8444-444444444444",
  dealId: DEAL,
  periodLabel: "2025",
  periodStart: "2025-01-01",
  periodEnd: "2025-12-31",
  sourceKind: "tax_return",
  revenueCents: 150_000_000,
  netIncomeCents: 25_000_000,
  ownerCompCents: 10_000_000,
  depreciationCents: null,
  interestCents: null,
  documentId: null,
  notes: null,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
};
const unverified: AdjustmentApi = {
  id: "55555555-5555-4555-8555-555555555555",
  dealId: DEAL,
  periodLabel: "2025",
  description: "Owner vehicle",
  amountCents: 2_000_000,
  kind: "owner_perk",
  claimedBy: "seller",
  status: "unverified",
  evidenceDocumentId: null,
  note: null,
  statusNote: null,
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
};
const CTX: ScenarioContext = { deal, hasConservativeScenario: false, periods: [period], adjustments: [unverified] };

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
  assumedExitMultiple: 3,
};

const request = (over: Record<string, unknown> = {}) =>
  parseScenarioRequest({ dealId: DEAL, name: "Base case", earningsBasis: "conservative", periodLabel: "2025", inputs: INPUTS, ...over });

test("rule 3: the exit multiple is returned as assumedExitMultiple and labelled assumed, never market", () => {
  const prepared = prepareScenario(request(), CTX);
  assert.equal(prepared.outputs.multiples.assumedExitMultiple, 3);
  assert.equal(prepared.outputs.exit.assumedExitMultiple, 3);
  assert.equal(prepared.outputs.summary.assumedExitMultiple, 3);
  const text = scenarioContent({ scenarioId: "x", name: "Base case", currency: "USD", stored: prepared.storedInputs, outputs: prepared.outputs });
  assert.ok(text.includes(ASSUMED_MULTIPLE_LABEL), text);
  assert.match(text, /an assumption, not a market figure/);
  assert.doesNotMatch(text, /market multiple|market value/i);
});

test("rule 3: a comparables note is stored but never changes a number", () => {
  const without = prepareScenario(request(), CTX);
  const withNote = prepareScenario(request({ comparablesNote: "Two similar shops sold at 4x and 5x SDE last year" }), CTX);
  assert.deepEqual(withNote.outputs, without.outputs);
  assert.equal(withNote.storedInputs.comparablesNote, "Two similar shops sold at 4x and 5x SDE last year");
  const text = scenarioContent({ scenarioId: "x", name: "n", currency: "USD", stored: withNote.storedInputs, outputs: withNote.outputs });
  assert.match(text, /does not change any number/);
});

test("rule 2 and 3 together: the basis picks the cash flow, unverified add-backs stay out of conservative", () => {
  const conservative = prepareScenario(request(), CTX);
  assert.equal(conservative.storedInputs.calculator.cashFlowCents, 35_000_000);
  assert.equal(conservative.storedInputs.askingPriceSource, "deal");
  assert.equal(conservative.storedInputs.annualRevenueSource, "period");
  const seller = prepareScenario(request({ earningsBasis: "seller_claimed" }), { ...CTX, hasConservativeScenario: true });
  assert.equal(seller.storedInputs.calculator.cashFlowCents, 37_000_000);
  const reported = prepareScenario(request({ earningsBasis: "reported" }), CTX);
  assert.equal(reported.storedInputs.calculator.cashFlowCents, 35_000_000);
  assert.equal(codeOf(() => prepareScenario(request({ earningsBasis: "seller_claimed" }), CTX)), "ECONSERVATIVE_FIRST");
});

test("a period with several sources needs sourceKind; a missing period is EPERIOD_NOT_FOUND", () => {
  const pnl = { ...period, id: "66666666-6666-4666-8666-666666666666", sourceKind: "pnl" as const };
  assert.equal(codeOf(() => prepareScenario(request(), { ...CTX, periods: [period, pnl] })), "EINVALID_INPUT");
  assert.equal(prepareScenario(request({ sourceKind: "pnl" }), { ...CTX, periods: [period, pnl] }).storedInputs.periodId, pnl.id);
  assert.equal(codeOf(() => prepareScenario(request(), { ...CTX, periods: [] })), "EPERIOD_NOT_FOUND");
});

// ---- Rule 4 ----

const REQUIRED_MONEY = ["askingPriceCents", "annualRevenueCents", "cashFlowCents", "buyerSalaryCents", "workingCapitalCents", "maintenanceCapexCents", "newCapexCents"];
const FULL = { ...INPUTS, askingPriceCents: 100_000_000, annualRevenueCents: 150_000_000, cashFlowCents: 35_000_000 };

test("rule 4: every required money input, when missing, is refused naming the field (never defaulted to zero)", () => {
  for (const field of REQUIRED_MONEY) {
    const { [field]: _gone, ...rest } = FULL as Record<string, unknown>;
    try {
      parseDealInputs(rest);
      assert.fail(`${field} should be required`);
    } catch (err) {
      assert.ok(err instanceof DealDeskError, field);
      assert.equal(err.code, "EINVALID_INPUT", field);
      assert.match(err.message, new RegExp(`inputs\\.${field} is required`), field);
    }
    assert.equal(codeOf(() => parseDealInputs({ ...FULL, [field]: 0.5 })), "EINVALID_INPUT", `${field} fraction`);
    assert.equal(codeOf(() => parseDealInputs({ ...FULL, [field]: "1000" })), "EINVALID_INPUT", `${field} text`);
  }
});

test("rule 4: required rates, term, date and exit multiple are refused when missing", () => {
  for (const field of ["equityPercent", "sellerNotePercent", "closingCostPercent", "interestRate", "loanTermYears", "closingDate", "assumedExitMultiple"]) {
    const { [field]: _gone, ...rest } = FULL as Record<string, unknown>;
    assert.equal(codeOf(() => parseDealInputs(rest)), "EINVALID_INPUT", field);
  }
});

test("rule 4: only the spreadsheet's own defaults are applied, with its values", () => {
  const { inputs, defaulted } = parseDealInputs(FULL);
  assert.deepEqual(
    defaulted.sort(),
    [
      "cashReserveRate", "exitYear", "ffeCents", "ffeIncluded", "indexReturn", "inventoryCents", "inventoryIncluded",
      "maintenanceCapexGrowthRate", "newCapexGrowthRate", "newCostsCents", "newProfitsCents", "realEstateAcquired",
      "realEstateCents", "realEstateIncluded", "rentToOwnerCents", "salaryGrowthRate", "sdeGrowthRate",
    ].sort(),
  );
  assert.equal(inputs.sdeGrowthRate, 0.05);
  assert.equal(inputs.salaryGrowthRate, 0.05);
  assert.equal(inputs.maintenanceCapexGrowthRate, 0.03);
  assert.equal(inputs.newCapexGrowthRate, 0.03);
  assert.equal(inputs.cashReserveRate, 0.03);
  assert.equal(inputs.indexReturn, 0.1);
  assert.equal(inputs.exitYear, 7);
  assert.deepEqual(inputs.newProfitsCents, Array(10).fill(0));
  assert.equal(inputs.ffeCents, 0);
  assert.equal(inputs.ffeIncluded, true, "the sheet's default is Yes");
  assert.equal(inputs.realEstateIncluded, false);
  assert.equal(inputs.realEstateAcquired, false);
  assert.equal(inputs.buyerFundsAvailableCents, null);
  assert.equal(DEAL_INPUT_DEFAULTS.indexReturn, 0.1);
});

test("rule 4: once an amount is given, its included or acquired flag is required", () => {
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, ffeCents: 1_000_000 })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, inventoryCents: 1_000_000 })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, realEstateCents: 1_000_000, realEstateIncluded: false })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, rentToOwnerCents: 500_000 })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, ffeCents: 1_000_000, ffeIncluded: false })), null);
});

test("rule 4: new costs are zero or negative, yearly lists have ten entries, unknown inputs are refused", () => {
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, newCostsCents: 1_000_000 })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, newProfitsCents: [1, 2, 3] })), "EINVALID_INPUT");
  assert.deepEqual(parseDealInputs({ ...FULL, newProfitsCents: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }).inputs.newProfitsCents, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, marketMultiple: 4 })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, loanTermYears: 31 })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseDealInputs({ ...FULL, exitYear: 11 })), "EINVALID_INPUT");
});

// ---- Rule 5 ----

test("rule 5: a field named for a credential is refused, at any depth", () => {
  for (const input of [
    { password: "x" },
    { notes: "fine", sellerPassword: "x" },
    { inputs: { posLogin: "x" } },
    { contacts: [{ username: "x" }] },
    { user_name: "x" },
  ]) {
    assert.equal(codeOf(() => assertNoSensitiveContent(input)), "ESECRET_NOT_ALLOWED", JSON.stringify(input));
  }
  assert.equal(findSecretField({ inputs: { posLogin: "x" } }), "inputs.posLogin");
});

test("rule 5: text written like a credential is refused, prose that mentions one is not", () => {
  for (const text of ["POS password: hunter2", "login=admin", "Username: owner1", "passcode : 1234"]) {
    assert.equal(codeOf(() => assertNoSensitiveContent({ notes: text })), "ESECRET_NOT_ALLOWED", text);
  }
  for (const text of ["The seller will hand over the logins at closing", "Password manager subscription add-back", "Owner's login to the bank portal is in the secrets store"]) {
    assert.equal(codeOf(() => assertNoSensitiveContent({ notes: text })), null, text);
  }
});

test("rule 5: the refusal never echoes the value and points at the secrets store", () => {
  try {
    assertNoSensitiveContent({ note: "password: hunter2" });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof DealDeskError);
    assert.match(err.message, /secrets store/);
    assert.ok(!err.message.includes("hunter2"));
  }
});

test("rule 5: full tax ids are refused with ESENSITIVE_ID", () => {
  assert.equal(codeOf(() => assertNoSensitiveContent({ notes: "EIN 12-3456789" })), "ESENSITIVE_ID");
});

test("rule 5: every writing tool refuses credentials and tax ids before touching the database", async () => {
  const calls: string[] = [];
  const db: DealDb = {
    namespace: "plugin_deal_desk_bf83b73d01",
    query: (async (sql: string) => {
      calls.push(sql);
      return [];
    }) as DealDb["query"],
    execute: async (sql: string) => {
      calls.push(sql);
      return { rowCount: 1 };
    },
  };
  const s = createDealService({ db });
  const call = { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor: {} };
  const attempts: Array<[string, Promise<unknown>]> = [
    ["deal_upsert", s.upsertDeal(call, { businessId: BIZ, name: "Acquired Company LLC", notes: "login: owner" })],
    ["deal_period_upsert", s.upsertPeriod(call, { dealId: DEAL, periodLabel: "2025", sourceKind: "pnl", notes: "SSN 123-45-6789" })],
    ["deal_adjustment_upsert", s.upsertAdjustment(call, { dealId: DEAL, periodLabel: "2025", description: "x", amountCents: 1, kind: "other", claimedBy: "seller", password: "x" })],
    ["deal_adjustment_set_status", s.setAdjustmentStatus(call, { adjustmentId: DEAL, status: "rejected", note: "password=abc" })],
    ["deal_scenario_run", s.runScenario(call, { dealId: DEAL, name: "n", earningsBasis: "conservative", periodLabel: "2025", inputs: { ...INPUTS, username: "x" } })],
  ];
  for (const [name, p] of attempts) {
    try {
      await p;
      assert.fail(`${name} should have been refused`);
    } catch (err) {
      assert.ok(err instanceof DealDeskError, name);
      assert.ok(["ESECRET_NOT_ALLOWED", "ESENSITIVE_ID"].includes(err.code), `${name}: ${err.code}`);
    }
  }
  assert.deepEqual(calls, [], "no query or write happened");
});
