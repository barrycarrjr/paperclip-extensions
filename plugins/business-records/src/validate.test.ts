import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  RecordsError,
  assertNoSensitiveIds,
  canonicalContacts,
  findSensitiveField,
  isDateOnly,
  looksLikeFullTaxId,
  parseContacts,
  parseDate,
  parseOptionalDate,
  parseRole,
  parseStatusSource,
  parseTaxIdLast4,
  parseTimestamp,
  todayLocal,
} from "./validate.js";

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RecordsError ? err.code : "NOT_A_RECORDS_ERROR";
  }
}

// ---- Sensitive ids: positives ----

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

// ---- Sensitive ids: negatives ----

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
  ["plain prose", "Example Widgets LLC, formed in an example state"],
];

for (const [label, text] of NEGATIVES) {
  test(`not treated as a sensitive id: ${label}`, () => {
    assert.equal(looksLikeFullTaxId(text), false, text);
  });
}

test("findSensitiveField names the nested field, not the value", () => {
  const input = { name: "Example Widgets LLC", contacts: [{ role: "cpa", notes: "client SSN 123-45-6789" }] };
  assert.equal(findSensitiveField(input), "contacts[0].notes");
  try {
    assertNoSensitiveIds(input);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof RecordsError);
    assert.equal(err.code, "ESENSITIVE_ID");
    assert.match(err.message, /contacts\[0\]\.notes/);
    assert.match(err.message, /last four digits/);
    assert.ok(!err.message.includes("6789"), "the refused value is never echoed back");
  }
});

test("findSensitiveField checks other names, titles and sources", () => {
  assert.equal(findSensitiveField({ otherNames: ["DBA", "12-3456789"] }), "otherNames[1]");
  assert.equal(findSensitiveField({ title: "EIN letter 12-3456789" }), "title");
  assert.equal(findSensitiveField({ source: { kind: "user_reported", note: "123456789" } }), "source.note");
  assert.equal(findSensitiveField({ reason: "no revenue", notes: null }), null);
});

test("findSensitiveField skips id and date fields", () => {
  assert.equal(
    findSensitiveField({
      businessId: "0b6f1a2c-1234-4abc-8def-123456789012",
      dueDate: "2026-04-15",
      taxIdLast4: "0000",
    }),
    null,
  );
});

test("taxIdLast4 must be exactly four digits", () => {
  assert.equal(parseTaxIdLast4("0000"), "0000");
  assert.equal(parseTaxIdLast4(undefined), undefined);
  assert.equal(parseTaxIdLast4(null), null);
  for (const bad of ["000", "00000", "12-3456789", "123456789", "abcd", 1234, "00 0"]) {
    assert.equal(codeOf(() => parseTaxIdLast4(bad)), "ESENSITIVE_ID", String(bad));
  }
});

// ---- Dates ----

test("date-only values must be real calendar dates in YYYY-MM-DD", () => {
  for (const good of ["2026-01-01", "2024-02-29", "2026-12-31"]) assert.equal(isDateOnly(good), true, good);
  for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-1-01", "26-01-01", "2026/01/01", "2026-01-01T00:00:00Z", "", null, 20260101]) {
    assert.equal(isDateOnly(bad), false, String(bad));
  }
  assert.equal(parseDate("2026-04-15", "dueDate"), "2026-04-15");
  assert.equal(codeOf(() => parseDate("April 15", "dueDate")), "EINVALID_INPUT");
});

test("optional dates: undefined is not given, null or empty clears", () => {
  assert.equal(parseOptionalDate(undefined, "x"), undefined);
  assert.equal(parseOptionalDate(null, "x"), null);
  assert.equal(parseOptionalDate("", "x"), null);
  assert.equal(parseOptionalDate("2026-03-01", "x"), "2026-03-01");
  assert.equal(codeOf(() => parseOptionalDate("2026-02-31", "x")), "EINVALID_INPUT");
});

test("timestamps are normalised to UTC ISO and junk is refused", () => {
  assert.equal(parseTimestamp("2026-09-01T00:00:00Z", "since"), "2026-09-01T00:00:00.000Z");
  assert.equal(parseTimestamp("2026-09-01", "since"), "2026-09-01T00:00:00.000Z");
  assert.equal(parseTimestamp("2026-09-01T04:00:00-04:00", "since"), "2026-09-01T08:00:00.000Z");
  for (const bad of ["yesterday", "2026-99-01T00:00:00Z", "", 123]) {
    assert.equal(codeOf(() => parseTimestamp(bad, "since")), "EINVALID_INPUT", String(bad));
  }
});

test("todayLocal formats the local date", () => {
  assert.equal(todayLocal(new Date(2026, 0, 5, 12)), "2026-01-05");
});

// ---- Structured values ----

test("contacts are stored in a fixed shape so a repeat call compares equal", () => {
  const parsed = parseContacts([{ phone: " 215-555-0123 ", role: "cpa", name: "Pat Example", email: "" }]);
  assert.deepEqual(parsed, [{ role: "cpa", name: "Pat Example", phone: "215-555-0123" }]);
  // jsonb returns keys in its own order; canonicalContacts puts them back.
  const fromDb = [{ name: "Pat Example", phone: "215-555-0123", role: "cpa" }];
  assert.equal(JSON.stringify(canonicalContacts(fromDb)), JSON.stringify(parsed));
  assert.equal(codeOf(() => parseContacts([{ name: "No role" }])), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseContacts([{ role: "cpa", ssn: "x" }])), "EINVALID_INPUT");
});

test("status source kinds are limited to the four known kinds", () => {
  assert.deepEqual(parseStatusSource({ kind: "user_reported", note: "Owner said so" }), {
    kind: "user_reported",
    note: "Owner said so",
  });
  assert.equal(codeOf(() => parseStatusSource({ kind: "gut_feeling" })), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseStatusSource("document")), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseStatusSource({ kind: "document", documentId: "not-a-uuid" })), "EINVALID_INPUT");
});

test("link roles are short slugs", () => {
  assert.equal(parseRole("case:notice"), "case:notice");
  assert.equal(parseRole("Records"), "records");
  assert.equal(parseRole("case:wind-down"), "case:wind-down");
  assert.equal(codeOf(() => parseRole("a role with spaces")), "EINVALID_INPUT");
  assert.equal(codeOf(() => parseRole("")), "EINVALID_INPUT");
});
