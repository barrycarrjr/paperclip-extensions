/**
 * Calculator parity with the Acquisition Analyzer 2.0 spreadsheet.
 *
 * Every expected number below is Excel's cached value for the named cell,
 * read from "Acquisition Analyzer 2.0.xlsx" with openpyxl (data_only=True)
 * when this test was written, for the sheet's own sample deal. Money is
 * compared to 1 cent, rates and multiples to 1e-6.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { eomonth, excelPmt, runDeal, xirr, type DealInputs } from "./calculator.js";
import { parseDealInputs } from "./dealInputs.js";

const $ = (dollars: number) => Math.round(dollars * 100);

function money(actual: number, expectedDollars: number, label: string): void {
  const expected = expectedDollars * 100;
  assert.ok(Math.abs(actual - expected) <= 1, `${label}: got ${actual} cents, expected ${expected.toFixed(2)} cents`);
}

function rate(actual: number | null, expected: number, label: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= 1e-6, `${label}: got ${actual}, expected ${expected}`);
}

/** The spreadsheet's blue input cells, in the shape an agent sends them. */
const SAMPLE_RAW = {
  closingDate: "2024-06-30", // Summary D7
  askingPriceCents: $(1_000_000), // D8
  annualRevenueCents: $(1_500_000), // D9
  cashFlowCents: $(350_000), // D10
  ffeCents: $(100_000), // D11
  ffeIncluded: true, // D12
  inventoryCents: $(50_000), // D13
  inventoryIncluded: true, // D14
  realEstateCents: $(500_000), // D15
  realEstateIncluded: false, // D16
  realEstateAcquired: false, // D17
  rentToOwnerCents: $(50_000), // D18
  buyerSalaryCents: $(75_000), // D23
  workingCapitalCents: $(100_000), // D24
  maintenanceCapexCents: $(25_000), // D25
  newCapexCents: $(5_000), // D26
  equityPercent: 0.1, // H8
  sellerNotePercent: 0.1, // H19
  closingCostPercent: 0.05, // H21
  loanTermYears: 10, // G25
  interestRate: 0.1, // G26
  sdeGrowthRate: 0.05, // Projections D9
  salaryGrowthRate: 0.05, // D10
  maintenanceCapexGrowthRate: 0.03, // D16
  newCapexGrowthRate: 0.03, // D17
  cashReserveRate: 0.03, // D18
  newProfitsCents: $(20_000), // F11:O11
  newCostsCents: $(-10_000), // F12:O12
  exitYear: 7, // D27
  assumedExitMultiple: 1_000_000 / 350_000, // E34 = D8 / D10, carried to F34:O34
  indexReturn: 0.1, // D41
  buyerFundsAvailableCents: $(350_000), // Summary D38 = SUM(D31:D37)
};

const SAMPLE: DealInputs = parseDealInputs(SAMPLE_RAW).inputs;
const out = runDeal(SAMPLE);

test("sample inputs parse with nothing defaulted", () => {
  assert.deepEqual(parseDealInputs(SAMPLE_RAW).defaulted, []);
});

test("Summary: multiples (D19, D20)", () => {
  rate(out.multiples.priceToCashFlow, 2.857142857, "D19");
  rate(out.multiples.priceToRevenue, 0.6666666667, "D20");
  rate(out.multiples.assumedExitMultiple, 2.857142857, "Projections E34");
});

test("Summary: uses of funds (G15:G22)", () => {
  const u = out.sourcesAndUses.uses;
  money(u.dueToSellerBusinessCents, 1_000_000, "G15");
  money(u.dueToSellerRealEstateCents, 0, "G16");
  money(u.totalDueToSellerCents, 1_000_000, "G17");
  money(u.cashAtClosingToSellerCents, 900_000, "G18");
  money(u.sellerNoteCents, 100_000, "G19");
  money(u.workingCapitalCents, 100_000, "G20");
  money(u.closingCostsCents, 50_000, "G21");
  money(u.totalCents, 1_150_000, "G22");
});

test("Summary: sources of funds (G8:H12)", () => {
  const s = out.sourcesAndUses.sources;
  money(s.buyerEquityCents, 115_000, "G8");
  money(s.sellerNoteCents, 100_000, "G9");
  money(s.termLoanCents, 835_000, "G10");
  money(s.lineOfCreditCents, 100_000, "G11");
  money(s.totalCents, 1_150_000, "G12");
  const pct = out.sourcesAndUses.sourcePercents;
  rate(pct.buyerEquity, 0.1, "H8");
  rate(pct.sellerNote, 0.08695652174, "H9");
  rate(pct.termLoan, 0.7260869565, "H10");
  rate(pct.lineOfCredit, 0.08695652174, "H11");
  rate(pct.total, 1, "H12");
});

test("Summary: lender analysis (G27:H35)", () => {
  const l = out.lender;
  money(l.totalBorrowingsCents, 935_000, "G27");
  money(l.yearly.cashFlowCents, 350_000, "G28");
  money(l.yearly.buyerSalaryCents, -75_000, "G29");
  money(l.yearly.capexCents, -30_000, "G30");
  money(l.yearly.rentToOwnerAddBackCents, 0, "G31");
  money(l.yearly.lendableCashFlowCents, 245_000, "G32");
  money(l.yearly.debtServiceCents, 148_273.1268, "-G33");
  money(l.yearly.netCashFlowCents, 96_726.87322, "G34");
  money(l.monthly.cashFlowCents, 29_166.66667, "H28");
  money(l.monthly.buyerSalaryCents, -6_250, "H29");
  money(l.monthly.capexCents, -2_500, "H30");
  money(l.monthly.lendableCashFlowCents, 20_416.66667, "H32");
  money(l.monthly.paymentCents, 12_356.0939, "-H33");
  money(l.monthly.netCashFlowCents, 8_060.572768, "H34");
  rate(l.dscr, 1.652356063, "G35 and H35");
});

test("Summary: the four formula checks (D41:D44) are all TRUE", () => {
  assert.deepEqual(out.checks, {
    sourcesEqualUses: true,
    fundingIs100Percent: true,
    buyerHasEnoughLiquidFunds: true,
    dscrAtLeast125: true,
  });
});

test("Loan: terms and totals (D6:D12)", () => {
  const loan = out.loan;
  money(loan.initialBalanceCents, 935_000, "D6");
  money(loan.monthlyPaymentCents, 12_356.0939, "D7");
  assert.equal(loan.numberOfPayments, 120, "D8");
  rate(loan.annualInterestRate, 0.1, "D9");
  money(loan.totalPaymentsCents, 1_482_731.268, "D10");
  money(loan.totalPrincipalCents, 935_000, "D11");
  money(loan.totalInterestCents, 547_731.2678, "D12");
  assert.equal(loan.schedule.length, 120);
});

test("Loan: first, second and last rows of the schedule", () => {
  const [first, second] = out.loan.schedule;
  const last = out.loan.schedule[119]!;
  assert.equal(first!.date, "2024-07-31", "C16");
  money(first!.interestCents, 7_791.666667, "E16");
  money(first!.principalCents, 4_564.427232, "F16");
  money(first!.balanceCents, 930_435.5728, "G16");
  money(second!.interestCents, 7_753.629773, "E17");
  money(second!.balanceCents, 925_833.1086, "G17");
  assert.equal(last.date, "2034-06-30", "C135");
  money(last.interestCents, 102.1164785, "E135");
  money(last.principalCents, 12_253.97742, "F135");
  money(last.balanceCents, 0, "G135 (-5.4e-9)");
});

test("Loan: balance by year (K16:K26)", () => {
  const expected = [
    935_000, 877_645.3788, 814_284.9793, 744_289.918, 666_965.4592, 581_544.119, 487_178.0483, 382_930.6169, 267_767.1172,
    140_544.4941, 0,
  ];
  expected.forEach((v, y) => money(out.loan.balanceByYearCents[y]!, v, `K${16 + y}`));
});

/** Projections rows E:O (year 0 to 10), Excel's cached values. */
const PROJ = {
  date: ["2024-06-30", "2025-06-30", "2026-06-30", "2027-06-30", "2028-06-30", "2029-06-30", "2030-06-30", "2031-06-30", "2032-06-30", "2033-06-30", "2034-06-30"],
  sde: [0, 350000, 367500, 385875, 405168.75, 425427.1875, 446698.5469, 469033.4742, 492485.1479, 517109.4053, 542964.8756], // row 9
  salary: [0, -75000, -78750, -82687.5, -86821.875, -91162.96875, -95721.11719, -100507.173, -105532.5317, -110809.1583, -116349.6162], // row 10
  totalOperating: [0, 285000, 298750, 313187.5, 328346.875, 344264.2188, 360977.4297, 378526.3012, 396952.6162, 416300.247, 436615.2594], // row 13
  maint: [0, -25750, -26522.5, -27318.175, -28137.72025, -28981.85186, -29851.30741, -30746.84664, -31669.25203, -32619.3296, -33597.90948], // row 16
  newCapex: [0, -5150, -5304.5, -5463.635, -5627.54405, -5796.370372, -5970.261483, -6149.369327, -6333.850407, -6523.865919, -6719.581897], // row 17
  reserves: [0, -8550, -8962.5, -9395.625, -9850.40625, -10327.92656, -10829.32289, -11355.78904, -11908.57849, -12489.00741, -13098.45778], // row 18
  totalInvesting: [0, -39450, -40789.5, -42177.435, -43615.67055, -45106.14879, -46650.89179, -48252.005, -49911.68093, -51632.20293, -53415.94916], // row 19
  totalFinancing: [-115000, ...Array(10).fill(-148273.1268)], // row 24
  netSale: [0, 0, 0, 0, 0, 0, 0, 985736.4523, 0, 0, 0], // row 29
  cashFlowToEquity: [-115000, 97276.87322, 109687.3732, 122736.9382, 136458.0777, 150884.9432, 166053.4111, 1167737.622, 198767.8085, 216394.9173, 234926.1835], // row 31
  valuation: [1000000, 1028571.429, 1078571.429, 1131071.429, 1186196.429, 1244077.679, 1304852.991, 1368667.069, 1435671.851, 1506026.872, 1579899.645], // row 35
  loanBalance: [-935000, -877645.3788137514, -814284.9793111573, -744289.9180223403, -666965.4591602298, -581544.1190224292, -487178.0483338531, -382930.616921094, -267767.11719222856, -140544.4941494787, 0], // row 36
  netWorth: [65000, 150926.0498, 264286.4493, 386781.5105, 519230.9694, 662533.5595, 817674.9427, 985736.4523, 1167904.734, 1365482.378, 1579899.645], // row 37
  irr: [null, -0.1541141459, 0.4872191905, 0.7438206895, 0.8554235267, 0.9081501591, 0.9344795162, 1.009294047, 1.01453778, 1.017305595, 1.018773716], // row 38 (E38 is 0 in the sheet: XIRR of one flow is an error there)
  index: [115000, 126500, 139150, 153065, 168371.5, 185208.65, 203729.515, 224102.4665, 246512.7132, 271163.9845, 298280.3829], // row 41
  vsIndex: [-50000, 24426.04976, 125136.4493, 233716.5105, 350859.4694, 477324.9095, 613945.4277, 761633.9858, 921392.0209, 1094318.394, 1281619.262], // row 42
};

test("Projections: every row, every year (E:O)", () => {
  assert.equal(out.projections.length, 11);
  out.projections.forEach((y, i) => {
    const col = "EFGHIJKLMNO"[i];
    assert.equal(y.date, PROJ.date[i], `${col}6`);
    money(y.sdeCents, PROJ.sde[i]!, `${col}9`);
    money(y.ownerSalaryCents, PROJ.salary[i]!, `${col}10`);
    money(y.newProfitsCents, i === 0 ? 0 : 20000, `${col}11`);
    money(y.newCostsCents, i === 0 ? 0 : -10000, `${col}12`);
    money(y.totalOperatingCents, PROJ.totalOperating[i]!, `${col}13`);
    money(y.maintenanceCapexCents, PROJ.maint[i]!, `${col}16`);
    money(y.newCapexCents, PROJ.newCapex[i]!, `${col}17`);
    money(y.cashReservesCents, PROJ.reserves[i]!, `${col}18`);
    money(y.totalInvestingCents, PROJ.totalInvesting[i]!, `${col}19`);
    money(y.equityDownPaymentCents, i === 0 ? -115000 : 0, `${col}22`);
    money(y.debtPaymentsCents, i === 0 ? 0 : -148273.1268, `${col}23`);
    money(y.totalFinancingCents, PROJ.totalFinancing[i]!, `${col}24`);
    money(y.netSaleProceedsCents, PROJ.netSale[i]!, `${col}29`);
    money(y.cashFlowToEquityCents, PROJ.cashFlowToEquity[i]!, `${col}31`);
    rate(y.valuationMultiple, 2.857142857, `${col}34`);
    money(y.valuationCents, PROJ.valuation[i]!, `${col}35`);
    money(y.loanBalanceCents, PROJ.loanBalance[i]!, `${col}36`);
    money(y.netWorthCents, PROJ.netWorth[i]!, `${col}37`);
    const irr = PROJ.irr[i];
    if (irr === null) assert.equal(y.equityIrr, null, `${col}38`);
    else rate(y.equityIrr, irr!, `${col}38`);
    money(y.indexValueCents, PROJ.index[i]!, `${col}41`);
    money(y.netWorthVsIndexCents, PROJ.vsIndex[i]!, `${col}42`);
  });
});

test("Projections: exit in year 7 (L27, L28, L29)", () => {
  money(out.exit.saleProceedsCents, 1_368_667.069, "L27");
  money(out.exit.loanPayoffCents, -382_930.6169, "L28");
  money(out.exit.netSaleProceedsCents, 985_736.4523, "L29");
  rate(out.exit.equityIrr, 1.009294047, "L38");
  money(out.exit.netWorthCents, 985_736.4523, "L37");
  const y7 = out.projections[7]!;
  money(y7.saleProceedsCents, 1_368_667.069, "L27");
  money(y7.loanPayoffCents, -382_930.6169, "L28");
  for (const y of out.projections.filter((p) => p.year !== 7)) {
    assert.equal(y.saleProceedsCents, 0, `sale proceeds only in the exit year (year ${y.year})`);
    assert.equal(y.loanPayoffCents, 0, `loan payoff only in the exit year (year ${y.year})`);
  }
});

test("the summary carries the key figures", () => {
  const s = out.summary;
  money(s.buyerEquityCents, 115_000, "G8");
  money(s.netCashFlowCents, 96_726.87322, "G34");
  rate(s.dscr, 1.652356063, "G35");
  rate(s.equityIrrAtExit, 1.009294047, "L38");
  assert.equal(s.exitYear, 7);
});

// ---- Edge cases from the design ----

test("edge: acquiring the real estate adds it to uses and the rent to lendable cash flow", () => {
  const o = runDeal(parseDealInputs({ ...SAMPLE_RAW, realEstateAcquired: true }).inputs);
  money(o.sourcesAndUses.uses.dueToSellerRealEstateCents, 500_000, "G16");
  money(o.sourcesAndUses.uses.totalDueToSellerCents, 1_500_000, "G17");
  money(o.sourcesAndUses.uses.sellerNoteCents, 150_000, "G19");
  money(o.sourcesAndUses.uses.closingCostsCents, 75_000, "G21");
  money(o.sourcesAndUses.uses.totalCents, 1_675_000, "G22");
  money(o.sourcesAndUses.sources.buyerEquityCents, 167_500, "G8");
  money(o.sourcesAndUses.sources.termLoanCents, 1_257_500, "G10");
  money(o.lender.yearly.rentToOwnerAddBackCents, 50_000, "G31");
  money(o.lender.yearly.lendableCashFlowCents, 295_000, "G32");
  assert.equal(o.checks.sourcesEqualUses, true);
  assert.equal(o.checks.fundingIs100Percent, true);
});

test("edge: real estate included in the asking price adds nothing to uses, but acquiring it still adds the rent", () => {
  const o = runDeal(parseDealInputs({ ...SAMPLE_RAW, realEstateIncluded: true, realEstateAcquired: true }).inputs);
  money(o.sourcesAndUses.uses.dueToSellerRealEstateCents, 0, "G16 (IFS: included first)");
  money(o.lender.yearly.lendableCashFlowCents, 295_000, "G32");
});

test("edge: FF&E not included in the asking price is added to what is due to the seller", () => {
  const o = runDeal(parseDealInputs({ ...SAMPLE_RAW, ffeIncluded: false }).inputs);
  money(o.sourcesAndUses.uses.dueToSellerBusinessCents, 1_100_000, "G15");
  money(o.sourcesAndUses.uses.sellerNoteCents, 110_000, "G19");
  money(o.sourcesAndUses.uses.closingCostsCents, 55_000, "G21");
  money(o.sourcesAndUses.uses.totalCents, 1_255_000, "G22");
  money(o.sourcesAndUses.sources.buyerEquityCents, 125_500, "G8");
  money(o.sourcesAndUses.sources.termLoanCents, 919_500, "G10");
  assert.equal(o.checks.sourcesEqualUses, true);
});

test("edge: inventory not included is added the same way", () => {
  const o = runDeal(parseDealInputs({ ...SAMPLE_RAW, inventoryIncluded: false }).inputs);
  money(o.sourcesAndUses.uses.dueToSellerBusinessCents, 1_050_000, "G15");
});

test("edge: when equity, seller note and line exceed uses, the term loan is 0 (never negative) and the checks fail", () => {
  const o = runDeal(parseDealInputs({ ...SAMPLE_RAW, equityPercent: 0.5, sellerNotePercent: 0.6 }).inputs);
  assert.equal(o.sourcesAndUses.sources.termLoanCents, 0);
  money(o.sourcesAndUses.uses.totalCents, 1_150_000, "G22");
  money(o.sourcesAndUses.sources.totalCents, 1_275_000, "G12");
  assert.equal(o.checks.sourcesEqualUses, false);
  assert.equal(o.checks.fundingIs100Percent, false);
  assert.ok(o.notes.some((n) => /term loan is 0/.test(n)));
  for (const y of o.projections) assert.ok(y.loanBalanceCents <= 0, "the loan balance is never a credit");
});

test("edge: a loan shorter than ten years is paid off; the balance is 0 afterwards and the quirk is noted", () => {
  const o = runDeal(parseDealInputs({ ...SAMPLE_RAW, loanTermYears: 5 }).inputs);
  assert.equal(o.loan.schedule.length, 60);
  money(o.loan.balanceByYearCents[5]!, 0, "year 5");
  money(o.loan.balanceByYearCents[8]!, 0, "year 8");
  money(o.projections[8]!.debtPaymentsCents, -o.lender.yearly.debtServiceCents / 100, "debt payments continue past payoff, as in the sheet");
  assert.ok(o.notes.some((n) => /paid off after year 5/.test(n)));
});

test("edge: no debt gives no DSCR and the DSCR check is not made", () => {
  const o = runDeal(parseDealInputs({ ...SAMPLE_RAW, equityPercent: 1, sellerNotePercent: 0, workingCapitalCents: 0 }).inputs);
  assert.equal(o.lender.totalBorrowingsCents, 0);
  assert.equal(o.lender.dscr, null);
  assert.equal(o.checks.dscrAtLeast125, null);
  assert.equal(o.loan.schedule.length, 0);
});

test("the liquid funds check is not made when funds are not given", () => {
  const { buyerFundsAvailableCents: _omit, ...rest } = SAMPLE_RAW;
  const o = runDeal(parseDealInputs(rest).inputs);
  assert.equal(o.checks.buyerHasEnoughLiquidFunds, null);
  const poor = runDeal(parseDealInputs({ ...SAMPLE_RAW, buyerFundsAvailableCents: $(100_000) }).inputs);
  assert.equal(poor.checks.buyerHasEnoughLiquidFunds, false);
});

// ---- Excel functions ----

test("excelPmt matches Excel PMT", () => {
  assert.ok(Math.abs(excelPmt(0.1 / 12, 120, 935000) - -12356.0939) < 1e-4);
  assert.equal(excelPmt(0, 10, 1000), -100);
});

test("eomonth matches Excel EOMONTH", () => {
  assert.equal(eomonth("2024-06-30", 1), "2024-07-31");
  assert.equal(eomonth("2024-01-31", 1), "2024-02-29");
  assert.equal(eomonth("2024-06-15", 12), "2025-06-30");
  assert.equal(eomonth("2025-01-31", 1), "2025-02-28");
});

test("xirr matches Excel's documented example", () => {
  // Microsoft's XIRR help page example: 0.373362535.
  const r = xirr([-10000, 2750, 4250, 3250, 2750], ["2008-01-01", "2008-03-01", "2008-10-30", "2009-02-15", "2009-04-01"]);
  rate(r, 0.373362535, "XIRR example");
});

test("xirr has no answer without a sign change or with one flow", () => {
  assert.equal(xirr([-100], ["2024-01-01"]), null);
  assert.equal(xirr([100, 100], ["2024-01-01", "2025-01-01"]), null);
  assert.equal(xirr([-100, -100], ["2024-01-01", "2025-01-01"]), null);
});

test("xirr finds a negative rate and a large one", () => {
  rate(xirr([-1000, 500], ["2023-01-01", "2024-01-01"]), 500 / 1000 - 1, "a loss of half in one year (365 days)");
  const big = xirr([-100, 1000], ["2023-01-01", "2024-01-01"]);
  rate(big, 9, "tenfold in 365 days");
});
