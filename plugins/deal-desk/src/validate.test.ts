import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  DealDeskError,
  assertNoSensitiveIds,
  findSensitiveField,
  isDateOnly,
  looksLikeFullTaxId,
  parseCents,
  parseCurrency,
  parseDate,
  parseOptionalCents,
} from "./validate.js";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof DealDeskError ? err.code : "NOT_A_DEAL_DESK_ERROR";
  }
}

// ---- Sensitive ids: positives (copied from business-records) ----

const POSITIVES: Array<[string, string]> = [
  ["dashed SSN", "SSN 123-45-6789 on file"],
  ["spaced SSN", "ssn 123 45 6789"],
  ["dashed EIN", "EIN 12-3456789"],
  ["bare nine digits", "tax id 123456789"],
  ["EIN after punctuation", "EIN:12-3456789."],
  ["SSN in parentheses", "(123-45-6789)"],
  ["nine digits at the start", "123456789 is the number"],
];

for (const [label, text] of POSITIVES) {
  test(`sensitive id detected: ${label}`, () => {
    assert.equal(looksLikeFullTaxId(text), true, text);
  });
}

// ---- Sensitive ids: negatives (copied from business-records) ----

const NEGATIVES: Array<[string, string]> = [
  ["dashed phone number", "call 215-555-0123"],
  ["dotted phone number", "215.555.0123"],
  ["spaced phone number", "215 555 0123"],
  ["phone with area code in brackets", "(215) 555-0123"],
  ["ten-digit phone", "2155550123"],
  ["international phone", "+1 215 555 0123"],
  ["ISO date", "due 2026-09-26"],
  ["US date", "09/26/2026"],
  ["ZIP+4 postcode", "Anytown, PA 19103-1234"],
  ["five-digit ZIP", "19103"],
  ["last four only", "tax id ending 0000"],
  ["money with separators", "$123,456,789.00"],
  ["small amount", "penalty of $1,234.56"],
  ["form number", "Form 1120-S"],
  ["eight digits", "entity number 12345678"],
  ["ten digits", "reference 1234567890"],
  ["SSN-like with a long last group", "123-45-67890"],
  ["digits glued to letters", "INV123456789"],
  ["UUID", "0b6f1a2c-1234-4abc-8def-123456789012"],
  ["plain prose", "Acquired Company LLC, formed in an example state"],
];

for (const [label, text] of NEGATIVES) {
  test(`not treated as a sensitive id: ${label}`, () => {
    assert.equal(looksLikeFullTaxId(text), false, text);
  });
}

test("findSensitiveField names the nested field, not the value", () => {
  const input = { name: "Acquired Company LLC", inputs: { notes: ["fine", "seller SSN 123-45-6789"] } };
  assert.equal(findSensitiveField(input), "inputs.notes[1]");
  try {
    assertNoSensitiveIds(input);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof DealDeskError);
    assert.equal(err.code, "ESENSITIVE_ID");
    assert.match(err.message, /inputs\.notes\[1\]/);
    assert.ok(!err.message.includes("6789"), "the refused value is never echoed back");
  }
});

test("findSensitiveField skips id and date fields and ignores numbers", () => {
  assert.equal(
    findSensitiveField({
      dealId: "0b6f1a2c-1234-4abc-8def-123456789012",
      evidenceDocumentId: "0b6f1a2c-1234-4abc-8def-123456789012",
      periodStart: "2025-01-01",
      closingDate: "2024-06-30",
      askingPriceCents: 123456789,
    }),
    null,
  );
});

// ---- Dates ----

test("date-only values must be real calendar dates in YYYY-MM-DD", () => {
  for (const good of ["2026-01-01", "2024-02-29", "2026-12-31"]) assert.equal(isDateOnly(good), true, good);
  for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-1-01", "2026/01/01", "", null, 20260101]) {
    assert.equal(isDateOnly(bad), false, String(bad));
  }
  assert.equal(codeOf(() => parseDate("June 30", "closingDate")), "EINVALID_INPUT");
});

// ---- Money ----

test("money is whole cents and a missing amount is refused, never zero", () => {
  assert.equal(parseCents(100000000, "askingPriceCents"), 100000000);
  assert.equal(parseCents(-500, "netIncomeCents"), -500);
  for (const bad of [undefined, null, 1.5, "100", Number.NaN, 1e20]) {
    assert.equal(codeOf(() => parseCents(bad, "askingPriceCents")), "EINVALID_INPUT", String(bad));
  }
  try {
    parseCents(undefined, "askingPriceCents");
  } catch (err) {
    assert.match((err as Error).message, /askingPriceCents is required/);
  }
  assert.equal(codeOf(() => parseCents(-1, "revenueCents", { min: 0 })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseCents(1, "newCostsCents", { max: 0 })), "EINVALID_INPUT");
});

test("optional money: undefined is not given, null clears", () => {
  assert.equal(parseOptionalCents(undefined, "x"), undefined);
  assert.equal(parseOptionalCents(null, "x"), null);
  assert.equal(parseOptionalCents(0, "x"), 0);
});

test("currency is a three-letter code", () => {
  assert.equal(parseCurrency("usd"), "USD");
  assert.equal(codeOf(() => parseCurrency("dollars")), "EINVALID_INPUT");
});
