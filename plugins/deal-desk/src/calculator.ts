/**
 * The deal calculator. Pure functions, no database, no I/O.
 *
 * runDeal reproduces the Acquisition Analyzer 2.0 spreadsheet (Summary, Loan
 * and Projections sheets) formula for formula. The cell each figure comes
 * from is named beside it, so a difference from the sheet can be traced.
 * calculator.test.ts checks the sheet's own sample deal against Excel's
 * cached values to the cent.
 *
 * Money is integer cents in and out. Inside, figures are carried unrounded
 * (the sheet does the same), and every money output is rounded to the cent
 * once, at the end. Rates and multiples are plain decimals (0.1 = 10 percent)
 * and are never rounded.
 *
 * normalizeEarnings turns a period's reported figures and its add-back
 * schedule into the two SDE figures (conservative and seller-claimed), with
 * EBITDA and owner replacement cost kept on their own lines.
 */

import type { AdjustmentKind, AdjustmentStatus, ClaimedBy, ScenarioSummary } from "./domain.js";

export const PROJECTION_YEARS = 10;
export const MAX_LOAN_TERM_YEARS = 30;

/** Everything runDeal needs, fully resolved (defaults already applied by parseDealInputs). */
export interface DealInputs {
  /** Summary D7. Acquisition date, the first XIRR date. */
  closingDate: string;
  /** Summary D8. */
  askingPriceCents: number;
  /** Summary D9. */
  annualRevenueCents: number;
  /** Summary D10. SDE or EBITDA, whichever basis the scenario uses. */
  cashFlowCents: number;
  /** Summary D11, D12. */
  ffeCents: number;
  ffeIncluded: boolean;
  /** Summary D13, D14. */
  inventoryCents: number;
  inventoryIncluded: boolean;
  /** Summary D15, D16, D17. */
  realEstateCents: number;
  realEstateIncluded: boolean;
  realEstateAcquired: boolean;
  /** Summary D18. Rent the business pays to the owner's real estate entity. */
  rentToOwnerCents: number;
  /** Summary D23. */
  buyerSalaryCents: number;
  /** Summary D24. */
  workingCapitalCents: number;
  /** Summary D25. */
  maintenanceCapexCents: number;
  /** Summary D26. */
  newCapexCents: number;
  /** Summary H8, H19, H21. */
  equityPercent: number;
  sellerNotePercent: number;
  closingCostPercent: number;
  /** Summary G25, G26. */
  loanTermYears: number;
  interestRate: number;
  /** Projections D9, D10, D16, D17, D18. */
  sdeGrowthRate: number;
  salaryGrowthRate: number;
  maintenanceCapexGrowthRate: number;
  newCapexGrowthRate: number;
  cashReserveRate: number;
  /** Projections F11:O11 and F12:O12, one entry per year 1 to 10. New costs are zero or negative. */
  newProfitsCents: number[];
  newCostsCents: number[];
  /** Projections D27. */
  exitYear: number;
  /** Projections F34:O34. An assumption, never a market figure. */
  assumedExitMultiple: number;
  /** Projections D41. */
  indexReturn: number;
  /** Summary D38. Null when not given: the liquid-funds check is then reported as not checked. */
  buyerFundsAvailableCents: number | null;
}

export interface LoanPayment {
  n: number;
  date: string;
  paymentCents: number;
  interestCents: number;
  principalCents: number;
  balanceCents: number;
}

export interface ProjectionYear {
  /** 0 is the acquisition column. */
  year: number;
  date: string;
  sdeCents: number;
  ownerSalaryCents: number;
  newProfitsCents: number;
  newCostsCents: number;
  totalOperatingCents: number;
  maintenanceCapexCents: number;
  newCapexCents: number;
  cashReservesCents: number;
  totalInvestingCents: number;
  equityDownPaymentCents: number;
  debtPaymentsCents: number;
  totalFinancingCents: number;
  saleProceedsCents: number;
  loanPayoffCents: number;
  netSaleProceedsCents: number;
  cashFlowToEquityCents: number;
  valuationMultiple: number | null;
  valuationCents: number;
  /** Negative while a balance is owed, as in the sheet. */
  loanBalanceCents: number;
  netWorthCents: number;
  /** Null for the acquisition column and whenever XIRR has no answer (the sheet shows 0 there). */
  equityIrr: number | null;
  indexValueCents: number;
  netWorthVsIndexCents: number;
}

export interface DealChecks {
  sourcesEqualUses: boolean;
  fundingIs100Percent: boolean;
  /** Null when buyerFundsAvailableCents was not given. */
  buyerHasEnoughLiquidFunds: boolean | null;
  /** Null when there is no debt to service. */
  dscrAtLeast125: boolean | null;
}

export interface DealOutputs {
  multiples: {
    priceToCashFlow: number | null;
    priceToRevenue: number | null;
    /** The valuation multiple used in the projection. An assumption, labelled as one everywhere. */
    assumedExitMultiple: number;
  };
  sourcesAndUses: {
    uses: {
      dueToSellerBusinessCents: number;
      dueToSellerRealEstateCents: number;
      totalDueToSellerCents: number;
      cashAtClosingToSellerCents: number;
      sellerNoteCents: number;
      workingCapitalCents: number;
      closingCostsCents: number;
      totalCents: number;
    };
    sources: {
      buyerEquityCents: number;
      sellerNoteCents: number;
      termLoanCents: number;
      lineOfCreditCents: number;
      totalCents: number;
    };
    /** Summary H8:H12. Equity is the input percentage, the rest are shares of total sources, as in the sheet. */
    sourcePercents: {
      buyerEquity: number;
      sellerNote: number | null;
      termLoan: number | null;
      lineOfCredit: number | null;
      total: number | null;
    };
  };
  lender: {
    totalBorrowingsCents: number;
    yearly: {
      cashFlowCents: number;
      buyerSalaryCents: number;
      capexCents: number;
      rentToOwnerAddBackCents: number;
      lendableCashFlowCents: number;
      debtServiceCents: number;
      netCashFlowCents: number;
    };
    monthly: {
      cashFlowCents: number;
      buyerSalaryCents: number;
      capexCents: number;
      rentToOwnerAddBackCents: number;
      lendableCashFlowCents: number;
      paymentCents: number;
      netCashFlowCents: number;
    };
    dscr: number | null;
  };
  loan: {
    initialBalanceCents: number;
    monthlyPaymentCents: number;
    numberOfPayments: number;
    annualInterestRate: number;
    totalPaymentsCents: number;
    totalPrincipalCents: number;
    totalInterestCents: number;
    /** Balance at the end of each year, index 0 = closing. Positive, 0 once paid off. */
    balanceByYearCents: number[];
    schedule: LoanPayment[];
  };
  projections: ProjectionYear[];
  exit: {
    exitYear: number;
    assumedExitMultiple: number;
    saleProceedsCents: number;
    loanPayoffCents: number;
    netSaleProceedsCents: number;
    equityIrr: number | null;
    netWorthCents: number;
  };
  checks: DealChecks;
  /** Plain-words notes on spreadsheet conventions that affect these particular numbers. */
  notes: string[];
  summary: ScenarioSummary;
}

// ---- Small helpers ----

/** Round to a whole number of cents, half away from zero, never -0. */
export function roundCents(value: number): number {
  const r = Math.sign(value) * Math.round(Math.abs(value));
  return r === 0 ? 0 : r;
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Excel EOMONTH: the last day of the month `months` after the month of `date`. */
export function eomonth(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0));
  return last.toISOString().slice(0, 10);
}

/**
 * Excel PMT(rate, nper, pv) with fv 0 and payments at period end. Negative
 * for a positive loan amount, as in Excel.
 */
export function excelPmt(rate: number, nper: number, pv: number): number {
  if (nper <= 0) return 0;
  if (rate === 0) return -pv / nper;
  const growth = Math.pow(1 + rate, nper);
  return -(pv * rate * growth) / (growth - 1);
}

/**
 * Excel XIRR: the rate r for which the sum of cashflow_i / (1 + r)^(days_i / 365)
 * is zero, days counted from the first date. Newton's method from `guess`,
 * then from a spread of other starting points, then bisection if Newton never
 * settles. Null when there is no answer (fewer than two flows, or no sign
 * change), which is where Excel returns an error.
 */
export function xirr(cashflows: number[], dates: string[], guess = 0.1): number | null {
  if (cashflows.length !== dates.length || cashflows.length < 2) return null;
  if (!cashflows.some((c) => c > 0) || !cashflows.some((c) => c < 0)) return null;
  const d0 = dayNumber(dates[0]!);
  const t = dates.map((d) => (dayNumber(d) - d0) / 365);

  const npv = (r: number) => cashflows.reduce((sum, c, i) => sum + c / Math.pow(1 + r, t[i]!), 0);
  const dnpv = (r: number) => cashflows.reduce((sum, c, i) => sum - (t[i]! * c) / Math.pow(1 + r, t[i]! + 1), 0);
  const scale = cashflows.reduce((m, c) => Math.max(m, Math.abs(c)), 0);

  for (const start of [guess, 0, 0.5, -0.5, 1, 2, -0.9, 5, 10]) {
    let r = start;
    for (let i = 0; i < 100; i += 1) {
      const f = npv(r);
      const df = dnpv(r);
      if (!Number.isFinite(f) || !Number.isFinite(df) || df === 0) break;
      const next = r - f / df;
      if (!Number.isFinite(next) || next <= -1) break;
      if (Math.abs(next - r) <= 1e-12 * Math.max(1, Math.abs(r))) {
        if (Math.abs(npv(next)) <= 1e-7 * Math.max(1, scale)) return next;
        break;
      }
      r = next;
    }
  }

  // Bisection fallback on (-1, hi], widening hi until the sign changes.
  let lo = -0.999999999;
  let hi = 1;
  let flo = npv(lo);
  let fhi = npv(hi);
  while (Math.sign(flo) === Math.sign(fhi) && hi < 1e9) {
    hi *= 10;
    fhi = npv(hi);
  }
  if (!Number.isFinite(flo) || Math.sign(flo) === Math.sign(fhi)) return null;
  for (let i = 0; i < 300; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
    if (hi - lo <= 1e-14 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}

// ---- The deal ----

export function runDeal(inputs: DealInputs): DealOutputs {
  const i = inputs;

  // Summary D19, D20: multiples of the asking price.
  const priceToCashFlow = i.cashFlowCents !== 0 ? i.askingPriceCents / i.cashFlowCents : null;
  const priceToRevenue = i.annualRevenueCents !== 0 ? i.askingPriceCents / i.annualRevenueCents : null;

  // Uses of funds, Summary G15:G22.
  const dueToSellerBusiness =
    i.askingPriceCents + (i.ffeIncluded ? 0 : i.ffeCents) + (i.inventoryIncluded ? 0 : i.inventoryCents); // G15
  const dueToSellerRealEstate = i.realEstateIncluded ? 0 : i.realEstateAcquired ? i.realEstateCents : 0; // G16
  const totalDueToSeller = dueToSellerBusiness + dueToSellerRealEstate; // G17
  const sellerNote = i.sellerNotePercent * totalDueToSeller; // G19
  const cashAtClosing = totalDueToSeller - sellerNote; // G18
  const workingCapital = i.workingCapitalCents; // G20
  const closingCosts = i.closingCostPercent * totalDueToSeller; // G21
  const totalUses = cashAtClosing + sellerNote + workingCapital + closingCosts; // G22

  // Sources of funds, Summary G8:G12. Equity is a share of total uses (G8 = H8 * G22),
  // which does not depend on G8, so there is no circularity.
  const equity = i.equityPercent * totalUses; // G8
  const lineOfCredit = workingCapital; // G11
  const termLoanRaw = totalUses - equity - sellerNote - lineOfCredit;
  const termLoan = termLoanRaw < 0 ? 0 : termLoanRaw; // G10, floored at 0
  const totalSources = equity + sellerNote + termLoan + lineOfCredit; // G12
  const pctOf = (x: number) => (totalSources > 0 ? x / totalSources : null);
  const notePct = pctOf(sellerNote);
  const loanPct = pctOf(termLoan);
  const locPct = pctOf(lineOfCredit);
  const totalPct = notePct === null || loanPct === null || locPct === null ? null : i.equityPercent + notePct + loanPct + locPct; // H12

  // Lender analysis, Summary G25:H35.
  const borrowings = termLoan + lineOfCredit; // G27
  const numberOfPayments = i.loanTermYears * 12; // H25
  const monthlyRate = i.interestRate / 12; // H26
  const monthlyPayment = borrowings > 0 ? -excelPmt(monthlyRate, numberOfPayments, borrowings) : 0; // -H33
  const yearlyDebtService = monthlyPayment * 12; // -G33
  const capex = i.maintenanceCapexCents + i.newCapexCents; // -G30
  const rentAddBack = i.realEstateAcquired ? i.rentToOwnerCents : 0; // G31
  const lendable = i.cashFlowCents - i.buyerSalaryCents - capex + rentAddBack; // G32
  const netCashFlow = lendable - yearlyDebtService; // G34
  const dscr = yearlyDebtService > 0 ? lendable / yearlyDebtService : null; // G35

  // Loan sheet: amortization. The sheet keeps paying while the balance is above $1.
  const schedule: LoanPayment[] = [];
  // Unrounded balance after each payment number, for the year-end lookup (Loan K16:K26).
  const balances: number[] = [borrowings];
  let balance = borrowings;
  let totalInterest = 0;
  for (let n = 1; n <= numberOfPayments && balance > 100; n += 1) {
    const interest = (balance * i.interestRate) / 12; // E
    const principal = monthlyPayment - interest; // F
    balance -= principal; // G
    totalInterest += interest;
    balances.push(balance);
    schedule.push({
      n,
      date: eomonth(i.closingDate, n),
      paymentCents: roundCents(monthlyPayment),
      interestCents: roundCents(interest),
      principalCents: roundCents(principal),
      balanceCents: roundCents(balance),
    });
  }
  // After payoff the sheet's lookup finds no row; the balance is 0 from then on.
  const balanceAfter = (payments: number) => (payments < balances.length ? balances[payments]! : 0);
  const balanceByYear = Array.from({ length: PROJECTION_YEARS + 1 }, (_, y) => balanceAfter(y * 12));
  const totalPayments = monthlyPayment * numberOfPayments; // Loan D10

  // Projections sheet.
  const dates = Array.from({ length: PROJECTION_YEARS + 1 }, (_, y) => (y === 0 ? i.closingDate : eomonth(i.closingDate, 12 * y)));
  const projections: ProjectionYear[] = [];
  const flowsToEquity: number[] = [];
  let sde = i.cashFlowCents; // F9
  let salary = -i.buyerSalaryCents; // F10
  let maint = -i.maintenanceCapexCents * (1 + i.maintenanceCapexGrowthRate); // F16
  let newCapex = -i.newCapexCents * (1 + i.newCapexGrowthRate); // F17
  let index = equity; // E41
  const exitYear = i.exitYear;
  let exitValues = { sale: 0, payoff: 0, irr: null as number | null, netWorth: 0 };

  for (let y = 0; y <= PROJECTION_YEARS; y += 1) {
    if (y === 0) {
      const loanBalance = -borrowings; // E36
      const valuation = i.askingPriceCents; // E35
      const netWorth = valuation + loanBalance; // E37
      flowsToEquity.push(-equity); // E31
      projections.push({
        year: 0,
        date: dates[0]!,
        sdeCents: 0,
        ownerSalaryCents: 0,
        newProfitsCents: 0,
        newCostsCents: 0,
        totalOperatingCents: 0,
        maintenanceCapexCents: 0,
        newCapexCents: 0,
        cashReservesCents: 0,
        totalInvestingCents: 0,
        equityDownPaymentCents: roundCents(-equity),
        debtPaymentsCents: 0,
        totalFinancingCents: roundCents(-equity),
        saleProceedsCents: 0,
        loanPayoffCents: 0,
        netSaleProceedsCents: 0,
        cashFlowToEquityCents: roundCents(-equity),
        valuationMultiple: priceToCashFlow, // E34
        valuationCents: roundCents(valuation),
        loanBalanceCents: roundCents(loanBalance),
        netWorthCents: roundCents(netWorth),
        equityIrr: null, // E38 (the sheet shows 0: XIRR of one flow is an error)
        indexValueCents: roundCents(index),
        netWorthVsIndexCents: roundCents(netWorth - index), // E42
      });
      continue;
    }
    if (y > 1) {
      sde *= 1 + i.sdeGrowthRate;
      salary *= 1 + i.salaryGrowthRate;
      maint *= 1 + i.maintenanceCapexGrowthRate;
      newCapex *= 1 + i.newCapexGrowthRate;
    }
    index *= 1 + i.indexReturn; // row 41
    const newProfits = i.newProfitsCents[y - 1] ?? 0; // row 11
    const newCosts = i.newCostsCents[y - 1] ?? 0; // row 12
    const totalOperating = sde + salary + newProfits + newCosts; // row 13
    const reserves = -totalOperating * i.cashReserveRate; // row 18
    const totalInvesting = maint + newCapex + reserves; // row 19
    const debtPayments = -yearlyDebtService; // row 23, every year to year 10, as in the sheet
    const totalFinancing = debtPayments; // row 24
    const valuation = i.assumedExitMultiple * (totalOperating - salary); // row 35
    const loanBalance = -balanceByYear[y]!; // row 36
    const sale = y === exitYear ? valuation : 0; // row 27
    const payoff = y === exitYear ? loanBalance : 0; // row 28
    const netSale = sale + payoff; // row 29
    const flow = totalOperating + totalInvesting + totalFinancing + netSale; // row 31
    flowsToEquity.push(flow);
    const netWorth = valuation + loanBalance; // row 37
    const irr = xirr(flowsToEquity, dates.slice(0, y + 1)); // row 38
    if (y === exitYear) exitValues = { sale, payoff, irr, netWorth };
    projections.push({
      year: y,
      date: dates[y]!,
      sdeCents: roundCents(sde),
      ownerSalaryCents: roundCents(salary),
      newProfitsCents: roundCents(newProfits),
      newCostsCents: roundCents(newCosts),
      totalOperatingCents: roundCents(totalOperating),
      maintenanceCapexCents: roundCents(maint),
      newCapexCents: roundCents(newCapex),
      cashReservesCents: roundCents(reserves),
      totalInvestingCents: roundCents(totalInvesting),
      equityDownPaymentCents: 0,
      debtPaymentsCents: roundCents(debtPayments),
      totalFinancingCents: roundCents(totalFinancing),
      saleProceedsCents: roundCents(sale),
      loanPayoffCents: roundCents(payoff),
      netSaleProceedsCents: roundCents(netSale),
      cashFlowToEquityCents: roundCents(flow),
      valuationMultiple: i.assumedExitMultiple,
      valuationCents: roundCents(valuation),
      loanBalanceCents: roundCents(loanBalance),
      netWorthCents: roundCents(netWorth),
      equityIrr: irr,
      indexValueCents: roundCents(index),
      netWorthVsIndexCents: roundCents(netWorth - index), // row 42
    });
  }

  // Summary D41:D44.
  const checks: DealChecks = {
    sourcesEqualUses: Math.abs(totalSources - totalUses) < 0.5,
    fundingIs100Percent: totalPct !== null && Math.abs(totalPct - 1) < 1e-9,
    buyerHasEnoughLiquidFunds: i.buyerFundsAvailableCents === null ? null : i.buyerFundsAvailableCents >= equity - 1e-6,
    dscrAtLeast125: dscr === null ? null : dscr >= 1.25,
  };

  const notes: string[] = [];
  if (termLoanRaw < 0) {
    notes.push(
      "Equity, seller note and line of credit together exceed total uses, so the term loan is 0 and sources do not equal uses. Lower the equity or seller note percentage.",
    );
  }
  if (sellerNote > 0) {
    notes.push("The seller note has no payments in debt service or in the projection: the spreadsheet treats it as on standby.");
  }
  if (i.loanTermYears < PROJECTION_YEARS) {
    notes.push(
      `The loan is paid off after year ${i.loanTermYears}, but debt payments are still counted in every year to year ${PROJECTION_YEARS}, as in the spreadsheet. Cash flow to equity for later years is understated by the yearly debt service.`,
    );
  }
  if (exitYear < PROJECTION_YEARS) {
    notes.push(
      `Years after the exit year (${exitYear}) still show operating cash flows and debt payments as if the business were kept, as in the spreadsheet. The equity IRR for those years includes them; use the IRR at the exit year.`,
    );
  }
  if (i.buyerFundsAvailableCents === null) {
    notes.push("buyerFundsAvailableCents was not given, so the liquid funds check was not made.");
  }

  const r = roundCents;
  const outputs: Omit<DealOutputs, "summary"> = {
    multiples: { priceToCashFlow, priceToRevenue, assumedExitMultiple: i.assumedExitMultiple },
    sourcesAndUses: {
      uses: {
        dueToSellerBusinessCents: r(dueToSellerBusiness),
        dueToSellerRealEstateCents: r(dueToSellerRealEstate),
        totalDueToSellerCents: r(totalDueToSeller),
        cashAtClosingToSellerCents: r(cashAtClosing),
        sellerNoteCents: r(sellerNote),
        workingCapitalCents: r(workingCapital),
        closingCostsCents: r(closingCosts),
        totalCents: r(totalUses),
      },
      sources: {
        buyerEquityCents: r(equity),
        sellerNoteCents: r(sellerNote),
        termLoanCents: r(termLoan),
        lineOfCreditCents: r(lineOfCredit),
        totalCents: r(totalSources),
      },
      sourcePercents: {
        buyerEquity: i.equityPercent,
        sellerNote: notePct,
        termLoan: loanPct,
        lineOfCredit: locPct,
        total: totalPct,
      },
    },
    lender: {
      totalBorrowingsCents: r(borrowings),
      yearly: {
        cashFlowCents: r(i.cashFlowCents),
        buyerSalaryCents: r(-i.buyerSalaryCents),
        capexCents: r(-capex),
        rentToOwnerAddBackCents: r(rentAddBack),
        lendableCashFlowCents: r(lendable),
        debtServiceCents: r(yearlyDebtService),
        netCashFlowCents: r(netCashFlow),
      },
      monthly: {
        cashFlowCents: r(i.cashFlowCents / 12),
        buyerSalaryCents: r(-i.buyerSalaryCents / 12),
        capexCents: r(-capex / 12),
        rentToOwnerAddBackCents: r(rentAddBack / 12),
        lendableCashFlowCents: r(lendable / 12),
        paymentCents: r(monthlyPayment),
        netCashFlowCents: r(lendable / 12 - monthlyPayment),
      },
      dscr,
    },
    loan: {
      initialBalanceCents: r(borrowings),
      monthlyPaymentCents: r(monthlyPayment),
      numberOfPayments,
      annualInterestRate: i.interestRate,
      totalPaymentsCents: r(totalPayments),
      totalPrincipalCents: r(totalPayments - totalInterest),
      totalInterestCents: r(totalInterest),
      balanceByYearCents: balanceByYear.map(r),
      schedule,
    },
    projections,
    exit: {
      exitYear,
      assumedExitMultiple: i.assumedExitMultiple,
      saleProceedsCents: r(exitValues.sale),
      loanPayoffCents: r(exitValues.payoff),
      netSaleProceedsCents: r(exitValues.sale + exitValues.payoff),
      equityIrr: exitValues.irr,
      netWorthCents: r(exitValues.netWorth),
    },
    checks,
    notes,
  };

  const summary: ScenarioSummary = {
    cashFlowCents: i.cashFlowCents,
    askingPriceCents: i.askingPriceCents,
    priceToCashFlowMultiple: priceToCashFlow,
    priceToRevenueMultiple: priceToRevenue,
    assumedExitMultiple: i.assumedExitMultiple,
    buyerEquityCents: r(equity),
    termLoanCents: r(termLoan),
    sellerNoteCents: r(sellerNote),
    yearlyDebtServiceCents: r(yearlyDebtService),
    lendableCashFlowCents: r(lendable),
    netCashFlowCents: r(netCashFlow),
    dscr,
    exitYear,
    equityIrrAtExit: exitValues.irr,
    netWorthAtExitCents: r(exitValues.netWorth),
    checks: { ...checks },
  };

  return { ...outputs, summary };
}

// ---- Earnings normalization ----

export interface NormalizeAdjustment {
  id?: string;
  description: string;
  amountCents: number;
  kind: AdjustmentKind;
  status: AdjustmentStatus;
  claimedBy?: ClaimedBy;
  evidenceDocumentId?: string | null;
}

export interface NormalizeInput {
  reportedNetIncomeCents: number;
  ownerCompCents: number;
  interestCents?: number | null;
  depreciationCents?: number | null;
  adjustments: NormalizeAdjustment[];
}

export interface NormalizationLine {
  label: string;
  source: "reported_net_income" | "owner_comp" | "adjustment";
  amountCents: number;
  adjustmentId?: string;
  adjustmentKind?: AdjustmentKind;
  status?: AdjustmentStatus;
  claimedBy?: ClaimedBy;
  evidenceDocumentId?: string | null;
  inConservative: boolean;
  inSellerClaimed: boolean;
  unverified: boolean;
}

export interface Normalization {
  reportedNetIncomeCents: number;
  ownerCompCents: number;
  /** Reported net income plus owner compensation, no adjustments. The `reported` scenario basis. */
  reportedSdeCents: number;
  /** Reported plus owner comp plus ACCEPTED adjustments only. */
  conservativeSdeCents: number;
  /** Reported plus owner comp plus every adjustment not rejected (accepted and unverified). */
  sellerClaimedSdeCents: number;
  /** sellerClaimed minus conservative: what rests on unverified claims. */
  unverifiedGapCents: number;
  /** Every SDE line, itemised, with which figure it counts in. Replacement costs are not here. */
  lines: NormalizationLine[];
  ownerReplacement: {
    lines: NormalizationLine[];
    /** Sum of replacement costs that are not rejected. */
    totalCents: number;
    conservativeSdeAfterReplacementCents: number;
    sellerClaimedSdeAfterReplacementCents: number;
  };
  /** Kept separate from SDE and never merged with it. */
  ebitda: {
    reportedNetIncomeCents: number;
    interestCents: number | null;
    depreciationCents: number | null;
    /** Reported net income plus interest plus depreciation, without owner comp. Null when a line is missing. */
    ebitdaCents: number | null;
    missing: string[];
  };
  unverified: { count: number; totalCents: number; adjustmentIds: string[] };
  rejected: { count: number; totalCents: number };
}

/**
 * Normalize one period's earnings.
 *
 * Replacement cost adjustments (the cost of hiring someone to do the owner's
 * job) are never part of SDE. They are listed on their own and deducted to
 * give "SDE after owner replacement"; a replacement cost that is not rejected
 * is deducted from both figures, because a deduction can only make a figure
 * smaller and the estimate is the buyer's own.
 */
export function normalizeEarnings(input: NormalizeInput): Normalization {
  const reported = input.reportedNetIncomeCents;
  const ownerComp = input.ownerCompCents;
  const lines: NormalizationLine[] = [
    {
      label: "Reported net income",
      source: "reported_net_income",
      amountCents: reported,
      inConservative: true,
      inSellerClaimed: true,
      unverified: false,
    },
    {
      label: "Owner compensation",
      source: "owner_comp",
      amountCents: ownerComp,
      inConservative: true,
      inSellerClaimed: true,
      unverified: false,
    },
  ];
  const replacementLines: NormalizationLine[] = [];
  let conservative = reported + ownerComp;
  let sellerClaimed = reported + ownerComp;
  let replacementTotal = 0;
  const unverified = { count: 0, totalCents: 0, adjustmentIds: [] as string[] };
  const rejected = { count: 0, totalCents: 0 };

  for (const adj of input.adjustments) {
    const isUnverified = adj.status === "unverified";
    const line: NormalizationLine = {
      label: adj.description,
      source: "adjustment",
      amountCents: adj.amountCents,
      adjustmentKind: adj.kind,
      status: adj.status,
      inConservative: false,
      inSellerClaimed: false,
      unverified: isUnverified,
    };
    if (adj.id) line.adjustmentId = adj.id;
    if (adj.claimedBy) line.claimedBy = adj.claimedBy;
    if (adj.evidenceDocumentId !== undefined) line.evidenceDocumentId = adj.evidenceDocumentId;

    if (adj.status === "rejected") {
      rejected.count += 1;
      rejected.totalCents += adj.amountCents;
    } else if (isUnverified) {
      unverified.count += 1;
      unverified.totalCents += adj.amountCents;
      if (adj.id) unverified.adjustmentIds.push(adj.id);
    }

    if (adj.kind === "replacement_cost") {
      const counts = adj.status !== "rejected";
      line.inConservative = counts;
      line.inSellerClaimed = counts;
      if (counts) replacementTotal += Math.abs(adj.amountCents);
      replacementLines.push(line);
      continue;
    }
    if (adj.status === "accepted") {
      line.inConservative = true;
      conservative += adj.amountCents;
    }
    if (adj.status !== "rejected") {
      line.inSellerClaimed = true;
      sellerClaimed += adj.amountCents;
    }
    lines.push(line);
  }

  const interest = input.interestCents ?? null;
  const depreciation = input.depreciationCents ?? null;
  const missing: string[] = [];
  if (interest === null) missing.push("interestCents");
  if (depreciation === null) missing.push("depreciationCents");

  return {
    reportedNetIncomeCents: reported,
    ownerCompCents: ownerComp,
    reportedSdeCents: reported + ownerComp,
    conservativeSdeCents: conservative,
    sellerClaimedSdeCents: sellerClaimed,
    unverifiedGapCents: sellerClaimed - conservative,
    lines,
    ownerReplacement: {
      lines: replacementLines,
      totalCents: replacementTotal,
      conservativeSdeAfterReplacementCents: conservative - replacementTotal,
      sellerClaimedSdeAfterReplacementCents: sellerClaimed - replacementTotal,
    },
    ebitda: {
      reportedNetIncomeCents: reported,
      interestCents: interest,
      depreciationCents: depreciation,
      ebitdaCents: missing.length === 0 ? reported + interest! + depreciation! : null,
      missing,
    },
    unverified,
    rejected,
  };
}
