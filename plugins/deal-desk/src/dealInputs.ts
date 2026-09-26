/**
 * Parsing the calculator's inputs. Pure, no I/O.
 *
 * Rule 4, enforced here: money is a whole number of cents, and a missing
 * required input is refused with [EINVALID_INPUT] naming the field. It is
 * never defaulted to zero. Only the fields the spreadsheet itself defaults
 * may be left out, and they take the spreadsheet's values:
 *
 *   ffeCents, inventoryCents, realEstateCents, rentToOwnerCents   0
 *   sdeGrowthRate, salaryGrowthRate                               0.05
 *   maintenanceCapexGrowthRate, newCapexGrowthRate, cashReserveRate 0.03
 *   indexReturn                                                   0.10
 *   exitYear                                                      7
 *   newProfitsCents, newCostsCents                                0 each year
 *
 * The included/acquired flags default to the sheet's values (FF&E and
 * inventory included, real estate not included and not acquired) only while
 * the matching amount is 0. Once an amount is given, its flag is required,
 * because the flag changes what is due to the seller.
 */

import { MAX_LOAN_TERM_YEARS, PROJECTION_YEARS, type DealInputs } from "./calculator.js";
import { invalid, parseCents, parseDate, readParams } from "./validate.js";

export const DEAL_INPUT_DEFAULTS = {
  ffeCents: 0,
  inventoryCents: 0,
  realEstateCents: 0,
  rentToOwnerCents: 0,
  sdeGrowthRate: 0.05,
  salaryGrowthRate: 0.05,
  maintenanceCapexGrowthRate: 0.03,
  newCapexGrowthRate: 0.03,
  cashReserveRate: 0.03,
  indexReturn: 0.1,
  exitYear: 7,
  newProfitsCents: 0,
  newCostsCents: 0,
} as const;

/** Every key a caller may send in `inputs`. */
export const DEAL_INPUT_KEYS = [
  "closingDate",
  "askingPriceCents",
  "annualRevenueCents",
  "cashFlowCents",
  "ffeCents",
  "ffeIncluded",
  "inventoryCents",
  "inventoryIncluded",
  "realEstateCents",
  "realEstateIncluded",
  "realEstateAcquired",
  "rentToOwnerCents",
  "buyerSalaryCents",
  "workingCapitalCents",
  "maintenanceCapexCents",
  "newCapexCents",
  "equityPercent",
  "sellerNotePercent",
  "closingCostPercent",
  "loanTermYears",
  "interestRate",
  "sdeGrowthRate",
  "salaryGrowthRate",
  "maintenanceCapexGrowthRate",
  "newCapexGrowthRate",
  "cashReserveRate",
  "newProfitsCents",
  "newCostsCents",
  "exitYear",
  "assumedExitMultiple",
  "indexReturn",
  "buyerFundsAvailableCents",
] as const;

export interface ParsedDealInputs {
  inputs: DealInputs;
  /** The fields that were left out and took the spreadsheet's default. */
  defaulted: string[];
}

function parseRate(raw: unknown, field: string, min: number, max: number): number {
  if (raw === undefined || raw === null) {
    throw invalid(`${field} is required: a decimal rate (0.1 means 10 percent).`);
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw invalid(`${field} must be a decimal number (0.1 means 10 percent).`);
  }
  if (raw < min || raw > max) {
    throw invalid(`${field} must be between ${min} and ${max} (a decimal: 0.1 means 10 percent).`);
  }
  return raw;
}

function parseFlag(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") throw invalid(`${field} must be true or false.`);
  return raw;
}

function parseInteger(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw invalid(`${field} must be a whole number from ${min} to ${max}.`);
  }
  return raw;
}

/** One amount for every year, or a list of exactly ten, one per projection year. */
function parseYearly(raw: unknown, field: string, opts: { max?: number }): number[] {
  if (Array.isArray(raw)) {
    if (raw.length !== PROJECTION_YEARS) {
      throw invalid(`${field} must be one whole number of cents for every year, or a list of exactly ${PROJECTION_YEARS} (years 1 to ${PROJECTION_YEARS}).`);
    }
    return raw.map((v, idx) => parseCents(v, `${field}[${idx}]`, opts));
  }
  const each = parseCents(raw, field, opts);
  return Array.from({ length: PROJECTION_YEARS }, () => each);
}

export function parseDealInputs(raw: unknown, path = "inputs"): ParsedDealInputs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(`${path} must be an object of calculator inputs.`);
  }
  const p = readParams(raw);
  for (const key of Object.keys(p)) {
    if (!(DEAL_INPUT_KEYS as readonly string[]).includes(key)) {
      throw invalid(`${path}.${key} is not a calculator input. Allowed: ${DEAL_INPUT_KEYS.join(", ")}.`);
    }
  }
  const f = (key: string) => `${path}.${key}`;
  const defaulted: string[] = [];
  const withDefault = <K extends keyof typeof DEAL_INPUT_DEFAULTS>(key: K): unknown => {
    if (p[key] === undefined || p[key] === null) {
      defaulted.push(key);
      return DEAL_INPUT_DEFAULTS[key];
    }
    return p[key];
  };

  const ffeCents = parseCents(withDefault("ffeCents"), f("ffeCents"), { min: 0 });
  const inventoryCents = parseCents(withDefault("inventoryCents"), f("inventoryCents"), { min: 0 });
  const realEstateCents = parseCents(withDefault("realEstateCents"), f("realEstateCents"), { min: 0 });
  const rentToOwnerCents = parseCents(withDefault("rentToOwnerCents"), f("rentToOwnerCents"), { min: 0 });

  const flag = (key: string, needed: boolean, sheetDefault: boolean, why: string): boolean => {
    if (p[key] === undefined || p[key] === null) {
      if (needed) throw invalid(`${f(key)} is required (true or false) because ${why}.`);
      defaulted.push(key);
      return sheetDefault;
    }
    return parseFlag(p[key], f(key));
  };
  const ffeIncluded = flag("ffeIncluded", ffeCents > 0, true, "ffeCents is more than 0");
  const inventoryIncluded = flag("inventoryIncluded", inventoryCents > 0, true, "inventoryCents is more than 0");
  const realEstateIncluded = flag("realEstateIncluded", realEstateCents > 0, false, "realEstateCents is more than 0");
  const realEstateAcquired = flag(
    "realEstateAcquired",
    realEstateCents > 0 || rentToOwnerCents > 0,
    false,
    "realEstateCents or rentToOwnerCents is more than 0 (rent to the owner is only added back when the real estate is acquired)",
  );

  const exitYear = parseInteger(withDefault("exitYear"), f("exitYear"), 1, PROJECTION_YEARS);

  const assumedExitMultiple = p.assumedExitMultiple;
  if (assumedExitMultiple === undefined || assumedExitMultiple === null) {
    throw invalid(
      `${f("assumedExitMultiple")} is required: the valuation multiple you assume at exit. It is an assumption, not a market figure; the spreadsheet's own starting point is the purchase price divided by the cash flow.`,
    );
  }
  if (typeof assumedExitMultiple !== "number" || !Number.isFinite(assumedExitMultiple) || assumedExitMultiple <= 0 || assumedExitMultiple > 100) {
    throw invalid(`${f("assumedExitMultiple")} must be a number above 0 and at most 100.`);
  }

  const funds = p.buyerFundsAvailableCents;

  const inputs: DealInputs = {
    closingDate: parseDate(p.closingDate, f("closingDate")),
    askingPriceCents: parseCents(p.askingPriceCents, f("askingPriceCents"), { min: 1 }),
    annualRevenueCents: parseCents(p.annualRevenueCents, f("annualRevenueCents"), { min: 0 }),
    cashFlowCents: parseCents(p.cashFlowCents, f("cashFlowCents")),
    ffeCents,
    ffeIncluded,
    inventoryCents,
    inventoryIncluded,
    realEstateCents,
    realEstateIncluded,
    realEstateAcquired,
    rentToOwnerCents,
    buyerSalaryCents: parseCents(p.buyerSalaryCents, f("buyerSalaryCents"), { min: 0 }),
    workingCapitalCents: parseCents(p.workingCapitalCents, f("workingCapitalCents"), { min: 0 }),
    maintenanceCapexCents: parseCents(p.maintenanceCapexCents, f("maintenanceCapexCents"), { min: 0 }),
    newCapexCents: parseCents(p.newCapexCents, f("newCapexCents"), { min: 0 }),
    equityPercent: parseRate(p.equityPercent, f("equityPercent"), 0, 1),
    sellerNotePercent: parseRate(p.sellerNotePercent, f("sellerNotePercent"), 0, 1),
    closingCostPercent: parseRate(p.closingCostPercent, f("closingCostPercent"), 0, 1),
    loanTermYears: (() => {
      if (p.loanTermYears === undefined || p.loanTermYears === null) {
        throw invalid(`${f("loanTermYears")} is required: whole years from 1 to ${MAX_LOAN_TERM_YEARS}.`);
      }
      return parseInteger(p.loanTermYears, f("loanTermYears"), 1, MAX_LOAN_TERM_YEARS);
    })(),
    interestRate: parseRate(p.interestRate, f("interestRate"), 0, 1),
    sdeGrowthRate: parseRate(withDefault("sdeGrowthRate"), f("sdeGrowthRate"), -0.99, 1),
    salaryGrowthRate: parseRate(withDefault("salaryGrowthRate"), f("salaryGrowthRate"), -0.99, 1),
    maintenanceCapexGrowthRate: parseRate(withDefault("maintenanceCapexGrowthRate"), f("maintenanceCapexGrowthRate"), -0.99, 1),
    newCapexGrowthRate: parseRate(withDefault("newCapexGrowthRate"), f("newCapexGrowthRate"), -0.99, 1),
    cashReserveRate: parseRate(withDefault("cashReserveRate"), f("cashReserveRate"), 0, 1),
    newProfitsCents: parseYearly(withDefault("newProfitsCents"), f("newProfitsCents"), {}),
    newCostsCents: parseYearly(withDefault("newCostsCents"), f("newCostsCents"), { max: 0 }),
    exitYear,
    assumedExitMultiple,
    indexReturn: parseRate(withDefault("indexReturn"), f("indexReturn"), -0.99, 1),
    buyerFundsAvailableCents:
      funds === undefined || funds === null ? null : parseCents(funds, f("buyerFundsAvailableCents"), { min: 0 }),
  };

  return { inputs, defaulted };
}
