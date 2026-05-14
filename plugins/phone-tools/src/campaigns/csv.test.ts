/**
 * Unit tests for the CSV parser + lead extractor (pure).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { autoDetectMapping, normalizeToE164, parseCsv, rowToLead } from "./csv.js";

test("parseCsv: basic header + 2 rows", () => {
  const r = parseCsv("name,phone\nAlice,5551234567\nBob,5559876543");
  assert.deepEqual(r.headers, ["name", "phone"]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].name, "Alice");
  assert.equal(r.rows[1].phone, "5559876543");
});

test("parseCsv: BOM stripped", () => {
  const r = parseCsv("﻿a,b\n1,2");
  assert.deepEqual(r.headers, ["a", "b"]);
  assert.equal(r.rows[0].a, "1");
});

test("parseCsv: quoted field with comma", () => {
  const r = parseCsv('name,note\n"Doe, John","says ""hi"""');
  assert.equal(r.rows[0].name, "Doe, John");
  assert.equal(r.rows[0].note, 'says "hi"');
});

test("parseCsv: CRLF line endings", () => {
  const r = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].a, "3");
});

test("parseCsv: trailing blank line skipped", () => {
  const r = parseCsv("a\n1\n\n");
  assert.equal(r.rows.length, 1);
});

test("parseCsv: empty input", () => {
  const r = parseCsv("");
  assert.deepEqual(r.headers, []);
  assert.deepEqual(r.rows, []);
});

test("normalizeToE164: already E.164", () => {
  assert.equal(normalizeToE164("+15551234567"), "+15551234567");
});

test("normalizeToE164: 10-digit US/CA local", () => {
  assert.equal(normalizeToE164("5551234567"), "+15551234567");
});

test("normalizeToE164: 11-digit with leading 1", () => {
  assert.equal(normalizeToE164("15551234567"), "+15551234567");
});

test("normalizeToE164: parens + dashes + spaces stripped", () => {
  assert.equal(normalizeToE164("(555) 123-4567"), "+15551234567");
  assert.equal(normalizeToE164("555.123.4567"), "+15551234567");
});

test("normalizeToE164: international with +", () => {
  assert.equal(normalizeToE164("+44 20 1234 5678"), "+442012345678");
});

test("normalizeToE164: blank → null", () => {
  assert.equal(normalizeToE164(""), null);
  assert.equal(normalizeToE164("   "), null);
});

test("normalizeToE164: too short → null", () => {
  assert.equal(normalizeToE164("12345"), null);
});

test("normalizeToE164: too long → null", () => {
  assert.equal(normalizeToE164("+1234567890123456"), null);
});

test("rowToLead: happy path", () => {
  const result = rowToLead(
    "c_abc",
    { phone: "5551234567", name: "Alice", biz: "Acme" },
    { phone: "phone", name: "name", businessName: "biz" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.lead?.phoneE164, "+15551234567");
  assert.equal(result.lead?.name, "Alice");
  assert.equal(result.lead?.businessName, "Acme");
  assert.equal(result.lead?.status, "pending");
  assert.equal(result.lead?.attempts, 0);
});

test("rowToLead: missing phone → reject", () => {
  const result = rowToLead("c_abc", { name: "Alice" }, { phone: "phone" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-phone");
});

test("rowToLead: invalid phone → reject", () => {
  const result = rowToLead("c_abc", { phone: "abc" }, { phone: "phone" });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /invalid-phone/);
});

test("rowToLead: optional columns absent → undefined fields", () => {
  const result = rowToLead("c_abc", { phone: "5551234567" }, { phone: "phone" });
  assert.equal(result.ok, true);
  assert.equal(result.lead?.name, undefined);
  assert.equal(result.lead?.businessName, undefined);
  assert.equal(result.lead?.timezoneHint, undefined);
});

// ─── autoDetectMapping (v0.5.4) ────────────────────────────────────────

test("autoDetectMapping: header-named phone column wins", () => {
  const parsed = parseCsv("name,phone\nAlice,5551234567\nBob,5559876543");
  const r = autoDetectMapping(parsed);
  assert.equal(r.mapping.phone, "phone");
  assert.equal(r.confidence.phone, "high");
});

test("autoDetectMapping: data-shape inference when no header keyword matches", () => {
  const parsed = parseCsv("col_a,col_b\nAlice,5551234567\nBob,5559876543\nCarol,5557777777");
  const r = autoDetectMapping(parsed);
  assert.equal(r.mapping.phone, "col_b");
  // No name match → score is low/medium, depending on the validity share.
  assert.ok(r.confidence.phone === "medium" || r.confidence.phone === "low");
});

test("autoDetectMapping: also picks name + business + website columns", () => {
  const parsed = parseCsv("phone,fullname,Company,website\n5551234567,Alice,Acme,acme.com");
  const r = autoDetectMapping(parsed);
  assert.equal(r.mapping.phone, "phone");
  assert.equal(r.mapping.name, "fullname");
  assert.equal(r.mapping.businessName, "Company");
  assert.equal(r.mapping.website, "website");
});

test("autoDetectMapping: claims each header at most once (business-before-name priority)", () => {
  // 'businessName' contains both 'business' and 'name'. Business wins
  // (we match business keywords first), name should fall through.
  const parsed = parseCsv("phone,businessName,contactName\n5551234567,Acme,Alice");
  const r = autoDetectMapping(parsed);
  assert.equal(r.mapping.businessName, "businessName");
  assert.equal(r.mapping.name, "contactName");
});

test("autoDetectMapping: gives up on phone if nothing matches", () => {
  const parsed = parseCsv("a,b\nfoo,bar\nbaz,qux");
  const r = autoDetectMapping(parsed);
  assert.equal(r.mapping.phone, "");
  assert.equal(r.confidence.phone, "none");
  assert.ok(r.rationale.some((line) => line.includes("phone → none")));
});
