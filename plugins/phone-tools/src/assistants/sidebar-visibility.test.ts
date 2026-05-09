/**
 * Unit tests for the Assistants sidebar visibility predicate.
 * These mirror the three cases the plan §8 verification asserts manually:
 *  1. Plugin uninstalled — N/A here (worker not running). The host's
 *     `usePluginSlots` filter handles that case before the worker is queried.
 *  2. Plugin installed but company NOT in any account's allowedCompanies
 *     → hidden.
 *  3. Plugin installed, company allow-listed → visible.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeSidebarVisibility } from "./sidebar-visibility.js";

test("hidden when companyId is missing", () => {
  const result = computeSidebarVisibility(null, [
    { allowedCompanies: ["company-a"] },
  ]);
  assert.deepEqual(result, { visible: false, reason: "no-company" });
});

test("hidden when no accounts are configured", () => {
  const result = computeSidebarVisibility("company-a", []);
  assert.deepEqual(result, { visible: false, reason: "no-accounts" });
});

test("hidden when current company isn't in any account's allow-list (negative)", () => {
  const result = computeSidebarVisibility("company-z", [
    { allowedCompanies: ["company-a", "company-b"] },
    { allowedCompanies: ["company-c"] },
  ]);
  assert.deepEqual(result, { visible: false, reason: "company-not-allow-listed" });
});

test("visible when current company is allow-listed in any account (positive)", () => {
  const result = computeSidebarVisibility("company-b", [
    { allowedCompanies: ["company-a"] },
    { allowedCompanies: ["company-b", "company-c"] },
  ]);
  assert.deepEqual(result, { visible: true, reason: "ok" });
});

test("visible when an account uses the portfolio-wide wildcard", () => {
  const result = computeSidebarVisibility("company-z", [
    { allowedCompanies: ["*"] },
  ]);
  assert.deepEqual(result, { visible: true, reason: "ok" });
});

test("hidden when an account has an empty allow-list (fail-safe deny)", () => {
  const result = computeSidebarVisibility("company-a", [
    { allowedCompanies: [] },
  ]);
  assert.deepEqual(result, { visible: false, reason: "company-not-allow-listed" });
});

test("hidden when an account has no allowedCompanies field at all", () => {
  const result = computeSidebarVisibility("company-a", [
    {},
  ]);
  assert.deepEqual(result, { visible: false, reason: "company-not-allow-listed" });
});
