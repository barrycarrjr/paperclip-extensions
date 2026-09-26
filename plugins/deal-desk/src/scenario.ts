/**
 * Preparing a scenario: pick the cash flow from the chosen earnings basis,
 * fill the asking price and revenue from the deal and period when they are
 * not given, run the calculator, and write the tool text. Pure, no database:
 * the service loads the deal, periods and add-backs and passes them in.
 */

import { normalizeEarnings, runDeal, type DealInputs, type DealOutputs, type Normalization } from "./calculator.js";
import { parseDealInputs } from "./dealInputs.js";
import type { AdjustmentApi, DealApi, EarningsBasis, PeriodApi, PeriodSourceKind } from "./domain.js";
import { EARNINGS_BASES, PERIOD_SOURCE_KINDS } from "./domain.js";
import { formatCents, formatMultiple, formatPercent, formatRatio, table, yesNo } from "./format.js";
import { ASSUMED_MULTIPLE_LABEL, assertNoSensitiveContent, checkScenarioBasis } from "./guards.js";
import {
  DealDeskError,
  invalid,
  parseCents,
  parseEnum,
  parseOptionalEnum,
  parseOptionalText,
  parseText,
  parseUuid,
  readParams,
} from "./validate.js";

export interface ScenarioRequest {
  dealId: string;
  name: string;
  earningsBasis: EarningsBasis;
  periodLabel: string | null;
  sourceKind: PeriodSourceKind | null;
  cashFlowCents: number | null;
  basisNote: string | null;
  comparablesNote: string | null;
  inputs: Record<string, unknown>;
  idempotencyKey: string | null;
}

/** Parse a deal_scenario_run call. Refuses credentials and full tax ids anywhere in it first. */
export function parseScenarioRequest(raw: unknown): ScenarioRequest {
  const p = readParams(raw);
  assertNoSensitiveContent(p);
  if (p.inputs !== undefined && (typeof p.inputs !== "object" || p.inputs === null || Array.isArray(p.inputs))) {
    throw invalid("inputs must be an object of calculator inputs.");
  }
  const cashFlow = p.cashFlowCents;
  return {
    dealId: parseUuid(p.dealId, "dealId"),
    name: parseText(p.name, "name", 200),
    earningsBasis: parseEnum(p.earningsBasis, EARNINGS_BASES, "earningsBasis"),
    periodLabel: parseOptionalText(p.periodLabel, "periodLabel", 100) ?? null,
    sourceKind: parseOptionalEnum(p.sourceKind, PERIOD_SOURCE_KINDS, "sourceKind") ?? null,
    cashFlowCents: cashFlow === undefined || cashFlow === null ? null : parseCents(cashFlow, "cashFlowCents"),
    basisNote: parseOptionalText(p.basisNote, "basisNote", 4000) ?? null,
    comparablesNote: parseOptionalText(p.comparablesNote, "comparablesNote", 4000) ?? null,
    inputs: readParams(p.inputs),
    idempotencyKey: parseOptionalText(p.idempotencyKey, "idempotencyKey", 200) ?? null,
  };
}

export interface ScenarioContext {
  deal: DealApi;
  hasConservativeScenario: boolean;
  /** The deal's earnings periods with the requested label (all source kinds). */
  periods: PeriodApi[];
  /** The deal's add-backs for the requested label. */
  adjustments: AdjustmentApi[];
}

export interface StoredScenarioInputs {
  calculator: DealInputs;
  defaulted: string[];
  earningsBasis: EarningsBasis;
  periodLabel: string | null;
  sourceKind: PeriodSourceKind | null;
  periodId: string | null;
  cashFlowSource: string;
  askingPriceSource: "inputs" | "deal";
  annualRevenueSource: "inputs" | "period";
  normalization: Normalization | null;
  basisNote: string | null;
  comparablesNote: string | null;
}

export interface PreparedScenario {
  request: ScenarioRequest;
  storedInputs: StoredScenarioInputs;
  outputs: DealOutputs;
}

const BASIS_WORDS: Record<EarningsBasis, string> = {
  reported: "reported SDE (net income plus owner compensation, no add-backs)",
  conservative: "conservative SDE (accepted add-backs only)",
  seller_claimed: "seller-claimed SDE (every add-back not rejected, including unverified ones)",
  custom: "custom cash flow",
};

function pickPeriod(req: ScenarioRequest, periods: PeriodApi[]): PeriodApi | null {
  if (!req.periodLabel) return null;
  const matches = req.sourceKind ? periods.filter((p) => p.sourceKind === req.sourceKind) : periods;
  if (matches.length === 0) {
    throw new DealDeskError(
      "EPERIOD_NOT_FOUND",
      `no earnings period ${req.periodLabel}${req.sourceKind ? ` from ${req.sourceKind}` : ""} on this deal. Add it with deal_period_upsert first.`,
    );
  }
  if (matches.length > 1) {
    throw invalid(
      `period ${req.periodLabel} has figures from several sources (${matches.map((m) => m.sourceKind).join(", ")}). Pass sourceKind to choose one.`,
    );
  }
  return matches[0]!;
}

export function prepareScenario(req: ScenarioRequest, ctx: ScenarioContext): PreparedScenario {
  checkScenarioBasis({
    earningsBasis: req.earningsBasis,
    hasConservativeScenario: ctx.hasConservativeScenario,
    cashFlowCentsGiven: req.cashFlowCents !== null,
    basisNote: req.basisNote,
    periodLabel: req.periodLabel,
  });
  if (req.inputs.cashFlowCents !== undefined) {
    throw invalid("inputs.cashFlowCents is not accepted: the cash flow comes from earningsBasis (or cashFlowCents at the top level for custom).");
  }

  const period = pickPeriod(req, ctx.periods);
  let normalization: Normalization | null = null;
  let cashFlowCents: number;
  let cashFlowSource: string;
  if (period) {
    normalization = normalizeEarnings({
      reportedNetIncomeCents: period.netIncomeCents,
      ownerCompCents: period.ownerCompCents,
      interestCents: period.interestCents,
      depreciationCents: period.depreciationCents,
      adjustments: ctx.adjustments.map((a) => ({
        id: a.id,
        description: a.description,
        amountCents: a.amountCents,
        kind: a.kind,
        status: a.status,
        claimedBy: a.claimedBy,
        evidenceDocumentId: a.evidenceDocumentId,
      })),
    });
  }
  if (req.earningsBasis === "custom") {
    cashFlowCents = req.cashFlowCents!;
    cashFlowSource = `custom figure: ${req.basisNote}`;
  } else {
    const n = normalization!;
    cashFlowCents =
      req.earningsBasis === "reported"
        ? n.reportedSdeCents
        : req.earningsBasis === "conservative"
          ? n.conservativeSdeCents
          : n.sellerClaimedSdeCents;
    cashFlowSource = `${BASIS_WORDS[req.earningsBasis]} for ${period!.periodLabel} (${period!.sourceKind})`;
  }

  const merged: Record<string, unknown> = { ...req.inputs, cashFlowCents };
  let askingPriceSource: "inputs" | "deal" = "inputs";
  if (merged.askingPriceCents === undefined || merged.askingPriceCents === null) {
    if (ctx.deal.askingPriceCents === null) {
      throw invalid("inputs.askingPriceCents is required: the deal has no asking price on record (set it with deal_upsert or pass it here).");
    }
    merged.askingPriceCents = ctx.deal.askingPriceCents;
    askingPriceSource = "deal";
  }
  let annualRevenueSource: "inputs" | "period" = "inputs";
  if (merged.annualRevenueCents === undefined || merged.annualRevenueCents === null) {
    if (!period) {
      throw invalid("inputs.annualRevenueCents is required: pass it, or pass periodLabel so the period's revenue is used.");
    }
    merged.annualRevenueCents = period.revenueCents;
    annualRevenueSource = "period";
  }

  const { inputs, defaulted } = parseDealInputs(merged);
  const outputs = runDeal(inputs);
  return {
    request: req,
    storedInputs: {
      calculator: inputs,
      defaulted,
      earningsBasis: req.earningsBasis,
      periodLabel: period?.periodLabel ?? req.periodLabel,
      sourceKind: period?.sourceKind ?? req.sourceKind,
      periodId: period?.id ?? null,
      cashFlowSource,
      askingPriceSource,
      annualRevenueSource,
      normalization,
      basisNote: req.basisNote,
      comparablesNote: req.comparablesNote,
    },
    outputs,
  };
}

/** The readable result of a scenario run: a few lines and a compact year table. */
export function scenarioContent(args: {
  scenarioId: string;
  name: string;
  currency: string;
  stored: StoredScenarioInputs;
  outputs: DealOutputs;
  reused?: boolean;
}): string {
  const { stored, outputs: o, currency } = args;
  const m = (c: number | null | undefined) => formatCents(c, currency);
  const su = o.sourcesAndUses;
  const n = stored.normalization;
  const lines: string[] = [];
  lines.push(
    `${args.reused ? "Scenario already saved with this idempotencyKey" : "Scenario saved"}: "${args.name}" [id ${args.scenarioId}].`,
  );
  let basisLine = `Cash flow used: ${m(stored.calculator.cashFlowCents)}, ${stored.cashFlowSource}.`;
  if (n && stored.earningsBasis !== "custom") {
    basisLine += ` Conservative SDE ${m(n.conservativeSdeCents)}, seller-claimed SDE ${m(n.sellerClaimedSdeCents)}`;
    basisLine += n.unverified.count > 0 ? `; ${n.unverified.count} unverified add-back(s) totalling ${m(n.unverified.totalCents)}.` : ".";
  }
  lines.push(basisLine);
  lines.push(
    `Price ${m(stored.calculator.askingPriceCents)} (${stored.askingPriceSource === "deal" ? "from the deal" : "given"}) is ${formatMultiple(o.multiples.priceToCashFlow)} cash flow and ${formatMultiple(o.multiples.priceToRevenue)} revenue.`,
  );
  lines.push(
    `Sources: buyer equity ${m(su.sources.buyerEquityCents)} (${formatPercent(su.sourcePercents.buyerEquity)}), seller note ${m(su.sources.sellerNoteCents)}, term loan ${m(su.sources.termLoanCents)}, line of credit ${m(su.sources.lineOfCreditCents)}; total ${m(su.sources.totalCents)}.`,
  );
  lines.push(
    `Uses: cash to seller at closing ${m(su.uses.cashAtClosingToSellerCents)}, seller note ${m(su.uses.sellerNoteCents)}, working capital ${m(su.uses.workingCapitalCents)}, closing costs ${m(su.uses.closingCostsCents)}; total ${m(su.uses.totalCents)}.`,
  );
  lines.push(
    `Lendable cash flow ${m(o.lender.yearly.lendableCashFlowCents)}, debt service ${m(o.lender.yearly.debtServiceCents)} a year (${m(o.lender.monthly.paymentCents)} a month), net cash flow ${m(o.lender.yearly.netCashFlowCents)}, DSCR ${formatRatio(o.lender.dscr)}.`,
  );
  lines.push(
    `Exit in year ${o.exit.exitYear} at an ${ASSUMED_MULTIPLE_LABEL} of ${formatMultiple(o.exit.assumedExitMultiple)} (an assumption, not a market figure): sale ${m(o.exit.saleProceedsCents)}, loan payoff ${m(o.exit.loanPayoffCents)}, equity IRR ${formatPercent(o.exit.equityIrr)}.`,
  );
  if (stored.comparablesNote) {
    lines.push(`Comparables note (stored with the scenario; it does not change any number): ${stored.comparablesNote}`);
  }
  lines.push(
    `Checks: sources equal uses ${yesNo(o.checks.sourcesEqualUses)}; funding 100% ${yesNo(o.checks.fundingIs100Percent)}; buyer has enough liquid funds ${yesNo(o.checks.buyerHasEnoughLiquidFunds)}; DSCR at least 1.25 ${yesNo(o.checks.dscrAtLeast125)}.`,
  );
  if (stored.defaulted.length > 0) lines.push(`Spreadsheet defaults used for: ${stored.defaulted.join(", ")}.`);
  for (const note of o.notes) lines.push(`Note: ${note}`);
  lines.push("");
  lines.push(
    table(
      ["Year", "Cash flow to equity", "Valuation", "Loan balance", "Net worth", "Equity IRR", "Net worth vs index"],
      o.projections.map((y) => [
        y.year === 0 ? "0 (closing)" : y.year === o.exit.exitYear ? `${y.year} (exit)` : String(y.year),
        m(y.cashFlowToEquityCents),
        m(y.valuationCents),
        m(y.loanBalanceCents),
        m(y.netWorthCents),
        formatPercent(y.equityIrr),
        m(y.netWorthVsIndexCents),
      ]),
    ),
  );
  return lines.join("\n");
}
