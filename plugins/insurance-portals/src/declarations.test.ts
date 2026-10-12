/**
 * Key figures from declarations pages. Each sample copies the layout of a
 * real carrier form (the order the PDF's text comes out in), with made-up
 * names, addresses, amounts and loan numbers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasKeyFigures, readKeyFigures } from "./declarations.js";

test("Foremost dwelling fire: dwelling, premises liability, annual premium, name after the start time; blank lienholder", () => {
  const t = `FOREMOST BASICS DECLARATIONS PAGE 381 0000000001 03 09/05/26 09/05/27 12:01 A.M. STANDARD TIME SAMPLE HOLDINGS LLC 12 TEST RD ANYTOWN PA 00000
    YOU AS NAMED INSURED AND YOUR ADDRESS A. DWELLING $ 150,000 $ 700.00 SECTION I COVERAGES C. PERSONAL PROPERTY $ 1,000 $ 17.00
    F. PREMISES LIABILITY $ 300,000 EA ACCIDENT $ 237.00 1 $ 1,200.00 LOCATION # Annual Premium $ 1,200.00 TOTAL ANNUAL POLICY PREMIUM
    TRANS TYPE: LIENHOLDER NO.: ATTENTION -- SEND PAYMENT TO`;
  const f = readKeyFigures(t);
  assert.equal(f.premium, 1200);
  assert.equal(f.dwelling, 150000);
  assert.equal(f.liability, 300000);
  assert.equal(f.namedInsured, "SAMPLE HOLDINGS LLC");
  assert.equal(f.lender, null);
  assert.equal(f.policyType, "property");
  assert.deepEqual(f.notFound, ["mortgagee"]);
  assert.ok(hasKeyFigures(f));
});

test("Liberty Mutual / Safeco basic form: insured, 1st mortgagee with loan last 4 only, dwelling fire, liability per occurrence", () => {
  const t = `LANDLORD PROTECTION POLICY DECLARATIONS - BASIC FORM INSURED: JANE SAMPLE SAMPLE HOLDINGS LLC 12 TEST RD ANYTOWN PA 00000 AGENT: EXAMPLE AGENCY
    DESCRIBED LOCATION: 34 SAMPLE ST ANYTOWN PA 00000 POLICY PERIOD FROM: TO: MAR. 30 2026 MAR. 30 2027
    MORTGAGE SERVICING AGENCY: EXAMPLE SERVICING ISAOA / ATIMA PO BOX 1 ANYTOWN 1ST MORTGAGEE: EXAMPLE BANK, N.A. OCCUPANCY: TENANT LOAN NO.: 9000001234
    COVERAGES FOR THIS LOCATION LIMITS DEDUCTIBLE PREMIUM A DWELLING FIRE $ 250,000 $ 700.00 B OTHER STRUCTURES FIRE $ 25,000 INCL
    OPTIONS: H-PREMISES LIABILITY (EACH OCCURRENCE) PERS. INJURY, WRONGFUL EVICTION, PRIVACY INVASION MEDICAL PAYMENTS (EACH PERSON) $ 100,000 $ 1,000 $ 66.00
    DEDUCTIBLES: $ 2,500 DWELLING ANNUAL PREMIUM $ 755.00`;
  const f = readKeyFigures(t);
  assert.equal(f.premium, 755);
  assert.equal(f.dwelling, 250000);
  assert.equal(f.liability, 100000);
  assert.deepEqual(f.lender, { role: "mortgagee", name: "EXAMPLE BANK, N.A", loanLast4: "1234", loanNote: null });
  assert.equal(f.namedInsured, "JANE SAMPLE SAMPLE HOLDINGS LLC");
  assert.equal(JSON.stringify(f).includes("9000001234"), false, "the full loan number is never kept");
});

test("a loan number not yet issued (TBD) is noted, and '1ST MORTGAGEE: NONE' means no mortgagee", () => {
  const tbd = readKeyFigures(
    "INSURED: JANE SAMPLE 12 TEST RD 1ST MORTGAGEE: EXAMPLE BANK OCCUPANCY: TENANT LOAN NO.: TBD A DWELLING FIRE $ 250,000 ANNUAL PREMIUM $ 700.00",
  );
  assert.deepEqual(tbd.lender, { role: "mortgagee", name: "EXAMPLE BANK", loanLast4: null, loanNote: "TBD" });
  const none = readKeyFigures("INSURED: JANE SAMPLE 12 TEST RD 1ST MORTGAGEE: NONE OCCUPANCY: TENANT A DWELLING FIRE $ 250,000 ANNUAL PREMIUM $ 700.00");
  assert.equal(none.lender, null);
});

test("Liberty Mutual / Safeco special form: six limits in a row, servicing mortgagee, name after the service details", () => {
  const t = `LANDLORD PROTECTION POLICY DECLARATIONS - SPECIAL FORM POLICY NUMBER: OK0000001 NAMED INSURED AND MAILING ADDRESS: Valued Landlord Customer Since: MAR. 30, 2024
    POLICY SERVICE INFORMATION: TELEPHONE: (555) 555-0100 E-MAIL: WEBSITE: SAMPLE HOLDINGS LLC 12 TEST RD ANYTOWN PA 00000 - Your new policy is effective March 31, 2026.
    (Policy Section I - Property Coverages and Section II - Liability Coverages) $300,000 $30,000 $0 $20,000 $500,000 $1,000 The following deductibles apply
    Included Servicing Mortgagee You may pay your premium in full TOTAL POLICY PREMIUM: $ 1,300.00 Premium Payer:
    CONTINUED Servicing Mortgagee EXAMPLE MORTGAGE LLC ISAOA / ATIMA PO BOX 2 ANYTOWN LOAN NUMBER: 77005678 Roof Replacement Cost`;
  const f = readKeyFigures(t);
  assert.equal(f.premium, 1300);
  assert.equal(f.dwelling, 300000);
  assert.equal(f.liability, 500000);
  assert.deepEqual(f.lender, { role: "mortgagee", name: "EXAMPLE MORTGAGE LLC", loanLast4: "5678", loanNote: null });
  assert.equal(f.namedInsured, "SAMPLE HOLDINGS LLC");
  // A row whose second amount is not a usual share of the first is not trusted.
  const odd = readKeyFigures(t.replace("$300,000 $30,000", "$300,000 $290,000"));
  assert.equal(odd.dwelling, null);
});

test("Selective homeowners: header names, dwelling, personal liability, combined premium, numbered mortgagee", () => {
  const t = `SELECTIVE INSURANCE COMPANY OF THE SOUTHEAST 1 EXAMPLE WAY ANYTOWN, N.C. 00000 JANE SAMPLE JOHN SAMPLE 12 TEST RD ANYTOWN, PA 00000--0000
    H 0000001 03A PA 00-00000-00000 03/30/2026 03/30/2027 AGENT: BILL ACCT. NO.: 000000001 HOMEOWNERS CONTINUOUS RENEWAL CERTIFICATE
    SECTION I COVERAGES LIMIT OF LIABILITY PREMIUM A. DWELLING $ 900,000 B. OTHER STRUCTURES $ 90,000 E. PERSONAL LIABILITY $ 500,000 EACH OCCURRENCE INCLUDED
    TOTAL COMBINED PREMIUM $ 2,500.00 MORTGAGEE(S): 1. EXAMPLE BANK ISAOA ATIMA PO BOX 3 ANYTOWN LOAN NO. 12344321`;
  const f = readKeyFigures(t);
  assert.equal(f.premium, 2500);
  assert.equal(f.dwelling, 900000);
  assert.equal(f.liability, 500000);
  assert.deepEqual(f.lender, { role: "mortgagee", name: "EXAMPLE BANK", loanLast4: "4321", loanNote: null });
  assert.equal(f.namedInsured, "JANE SAMPLE JOHN SAMPLE");
});

test("Selective businessowners: building limit, liability and medical expenses limit, total policy premium", () => {
  const t = `COMMERCIAL POLICY COMMON DECLARATION Named Insured and Address SAMPLE HOLDINGS LLC 12 TEST RD ANYTOWN, PA 00000 Policy Period From: MARCH 30, 2026
    Total Policy Premium $3,700.00 D/B - 1 COVERAGE SCHEDULE 1 1 BUILDING $1,000,000 BLDG $5,000 RC TOTAL BLANKET BUILDING $1,000,000
    LIABILITY AND MEDICAL PAYMENTS Liability and Medical Expenses Limit $1,000,000 General Aggregate Limit $3,000,000 Newly Acquired - Building $250,000`;
  const f = readKeyFigures(t);
  assert.equal(f.premium, 3700);
  assert.equal(f.dwelling, 1000000);
  assert.equal(f.dwellingKind, "building");
  assert.equal(f.liability, 1000000);
  assert.equal(f.namedInsured, "SAMPLE HOLDINGS LLC");
  assert.equal(f.policyType, "commercial");
});

test("Selective umbrella and auto: no dwelling to read, and the fields that do not apply are said so", () => {
  const umbrella = readKeyFigures(`ANYTOWN, N.C. 00000 JANE SAMPLE 12 TEST RD ANYTOWN, PA 00000 PCL0000001 03A PA 00-00000-00000 03/30/2026 03/30/2027 AGENT:
    PERSONAL UMBRELLA POLICY LIMIT OF LIABILITY: $ 2,000,000 PER OCCURRENCE TOTAL ANNUAL POLICY PREMIUM: $ 600.00`);
  assert.equal(umbrella.policyType, "umbrella");
  assert.equal(umbrella.liability, 2000000);
  assert.equal(umbrella.premium, 600);
  assert.deepEqual(umbrella.notFound, []);
  assert.deepEqual(umbrella.notApplicable, ["dwelling", "mortgagee"]);

  const auto = readKeyFigures(`ANYTOWN, N.C. 00000 JANE SAMPLE 12 TEST RD ANYTOWN, PA 00000 F 0000001 - 03A PA 00-00000-00000 03/30/2026 03/30/2027 AGENT:
    BODILY INJURY LIABILITY 01 $250,000 EACH PERSON $500,000 EACH ACCIDENT 300.00 AUTO 01 SUBTOTAL $ 1,500.00 FULL TERM POLICY PREMIUM $ 2,900.00
    ADDITIONAL INTERESTS LOSS PAYEE: 02 EXAMPLE AUTO FINANCE 1 EXAMPLE LN ANYTOWN`);
  assert.equal(auto.policyType, "auto");
  assert.equal(auto.premium, 2900);
  assert.equal(auto.liability, 250000);
  assert.equal(auto.liabilityText, "$250,000 each person / $500,000 each accident");
  assert.deepEqual(auto.lender, { role: "loss payee", name: "EXAMPLE AUTO FINANCE", loanLast4: null, loanNote: null });
  assert.deepEqual(auto.notApplicable, ["dwelling"]);
  assert.ok(hasKeyFigures(auto));
});

test("a page with no declarations (a coverage booklet) gives nothing and no summary", () => {
  const f = readKeyFigures("SERVICE LINE COVERAGE This endorsement adds coverage for service lines. We will pay up to the limit shown in the Declarations.");
  assert.equal(hasKeyFigures(f), false);
  assert.equal(f.policyType, null);
});
