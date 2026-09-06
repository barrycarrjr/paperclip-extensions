/**
 * Tests for the two company-scoping rules that used to guess.
 *
 * Both used to fail open: an empty allow-list let every company use a Google
 * account, and an unmatched review email was filed under the first location
 * regardless of how many there were. The dangerous direction in both is
 * saying yes when the answer should be no, so that is what most of these
 * check.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isCompanyAllowedForAccount } from "./companyAccess.js";
import { resolveEmailLocation } from "./locationScope.js";

test("an empty or missing allow-list denies everyone", () => {
  // The README always promised this; the code used to do the opposite.
  assert.equal(isCompanyAllowedForAccount([], "company-a"), false);
  assert.equal(isCompanyAllowedForAccount(undefined, "company-a"), false);
  assert.equal(isCompanyAllowedForAccount(null, "company-a"), false);
});

test("a named company is allowed, an unnamed one is not", () => {
  assert.equal(isCompanyAllowedForAccount(["company-a"], "company-a"), true);
  assert.equal(isCompanyAllowedForAccount(["company-a"], "company-b"), false);
});

test("the wildcard is the one explicit way to allow every company", () => {
  assert.equal(isCompanyAllowedForAccount(["*"], "anyone"), true);
  assert.equal(isCompanyAllowedForAccount(["company-a", "*"], "company-b"), true);
});

test("no company in context is never allowed", () => {
  assert.equal(isCompanyAllowedForAccount(["*"], null), false);
  assert.equal(isCompanyAllowedForAccount(["*"], ""), false);
});

const LOCATIONS = [
  { key: "acme", displayName: "Acme Main St" },
  { key: "beta", displayName: "Beta Corner" },
];

test("a review email matches a location by display name, ignoring case and spacing", () => {
  assert.equal(resolveEmailLocation(LOCATIONS, "acme main st")?.key, "acme");
  assert.equal(resolveEmailLocation(LOCATIONS, "  BETA CORNER ")?.key, "beta");
});

test("with several locations, an unmatched name is skipped rather than guessed", () => {
  // Guessing decided which company saw a customer's words.
  assert.equal(resolveEmailLocation(LOCATIONS, "Somewhere Else"), null);
  assert.equal(resolveEmailLocation(LOCATIONS, ""), null);
  assert.equal(resolveEmailLocation(LOCATIONS, null), null);
});

test("with exactly one location, the fallback is the only possible answer and is kept", () => {
  const only = [{ key: "solo", displayName: "Solo Shop" }];
  assert.equal(resolveEmailLocation(only, "Name That Does Not Match")?.key, "solo");
  assert.equal(resolveEmailLocation(only, null)?.key, "solo");
});

test("no locations means nothing to resolve", () => {
  assert.equal(resolveEmailLocation([], "Acme Main St"), null);
  assert.equal(resolveEmailLocation(null, "Acme Main St"), null);
});
