/**
 * Unit tests for the compliance preflight validator (pure).
 *
 * Run with: `pnpm test`.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { validatePreflight } from "./preflight.js";
import type { CompliancePreflight } from "./types.js";

const validBase: CompliancePreflight = {
  audienceKind: "b2b-businesses",
  audienceJustification: "local restaurants — public business lines, B2B carve-out applies",
  listSource: "scraped-public-business",
  listSourceNote: "google maps search 'pizza near me' filtered by has-public-phone",
  geographicScope: ["US-PA", "US-NJ"],
  callerLocalHours: { startHour: 9, endHour: 18, weekendsAllowed: false },
  openingDisclosure:
    "Hi, this is Alex from M3 Print, calling about our quarterly sample pack. Do you have 30 seconds?",
  optOutLanguage:
    "And — if you'd prefer we don't call again, just let me know and I'll take you off the list.",
  acknowledgedTcpa: true,
  acknowledgedDnc: true,
  acknowledgedAt: "2026-05-13T13:00:00Z",
  acknowledgedBy: "user_abc",
};

const validCtx = { assistantHasTransferTarget: true, leadCount: 50 };

test("happy path passes", () => {
  const r = validatePreflight(validBase, validCtx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("missing TCPA ack fails", () => {
  const r = validatePreflight({ ...validBase, acknowledgedTcpa: false }, validCtx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_NOT_ACKNOWLEDGED") && e.includes("TCPA")));
});

test("missing DNC ack fails", () => {
  const r = validatePreflight({ ...validBase, acknowledgedDnc: false }, validCtx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_NOT_ACKNOWLEDGED") && e.includes("DNC")));
});

test("consumer audience with non-first-party list is rejected", () => {
  const r = validatePreflight(
    { ...validBase, audienceKind: "consumer", listSource: "scraped-public-business" },
    validCtx,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_RISK_TOO_HIGH")));
});

test("consumer audience with first-party-customers list is allowed", () => {
  const r = validatePreflight(
    {
      ...validBase,
      audienceKind: "consumer",
      listSource: "first-party-customers",
      listSourceNote: "existing customers from print order DB, opted in at checkout",
    },
    validCtx,
  );
  assert.equal(r.ok, true);
});

test("assistant without transferTarget rejected", () => {
  const r = validatePreflight(validBase, { assistantHasTransferTarget: false, leadCount: 50 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECAMPAIGN_NO_TRANSFER")));
});

test("empty leadCount rejected", () => {
  const r = validatePreflight(validBase, { assistantHasTransferTarget: true, leadCount: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECAMPAIGN_EMPTY")));
});

test("daily window > 14h rejected", () => {
  const r = validatePreflight(
    { ...validBase, callerLocalHours: { startHour: 5, endHour: 23, weekendsAllowed: false } },
    validCtx,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_BAD_HOURS")));
});

test("inverted hour window rejected", () => {
  const r = validatePreflight(
    { ...validBase, callerLocalHours: { startHour: 18, endHour: 9, weekendsAllowed: false } },
    validCtx,
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_BAD_HOURS")));
});

test("opening disclosure < 20 chars rejected", () => {
  const r = validatePreflight({ ...validBase, openingDisclosure: "hi" }, validCtx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_OPENING_DISCLOSURE")));
});

test("missing opt-out language rejected", () => {
  const r = validatePreflight({ ...validBase, optOutLanguage: "" }, validCtx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_OPT_OUT_LANGUAGE")));
});

test("empty geographic scope rejected", () => {
  const r = validatePreflight({ ...validBase, geographicScope: [] }, validCtx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_NO_GEOGRAPHIC_SCOPE")));
});

test("purchased list without sourceNote rejected", () => {
  const r = validatePreflight({ ...validBase, listSource: "purchased", listSourceNote: "" }, validCtx);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("ECOMPLIANCE_LIST_SOURCE_NOTE")));
});

test("rented list with sourceNote allowed", () => {
  const r = validatePreflight(
    {
      ...validBase,
      listSource: "rented",
      listSourceNote: "leadgen co X, B2B opt-in collected via web form 2025",
    },
    validCtx,
  );
  assert.equal(r.ok, true);
});
