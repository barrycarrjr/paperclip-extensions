/**
 * Unit tests for the sidebar visibility predicate.
 *
 * The allow-list decides whether the plugin is switched on for the company on
 * screen. It never decides which items are visible: that is the owner check in
 * todos.ts. These tests only cover the former.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeSidebarVisibility } from "./sidebar-visibility.js";

test("hidden when there is no company on screen", () => {
  assert.deepEqual(computeSidebarVisibility(null, { allowedCompanies: ["*"] }), {
    visible: false,
    capture: false,
    reason: "no-company",
  });
});

test("hidden when the allow-list is empty (fail-safe deny)", () => {
  assert.deepEqual(computeSidebarVisibility("company-a", { allowedCompanies: [] }), {
    visible: false,
    capture: false,
    reason: "company-not-allow-listed",
  });
});

test("hidden when allowedCompanies is missing entirely", () => {
  assert.deepEqual(computeSidebarVisibility("company-a", {}), {
    visible: false,
    capture: false,
    reason: "company-not-allow-listed",
  });
});

test("hidden when this company is not on the allow-list", () => {
  assert.deepEqual(
    computeSidebarVisibility("company-z", { allowedCompanies: ["company-a", "company-b"] }),
    { visible: false, capture: false, reason: "company-not-allow-listed" },
  );
});

test("visible when this company is on the allow-list", () => {
  assert.deepEqual(
    computeSidebarVisibility("company-b", { allowedCompanies: ["company-a", "company-b"] }),
    { visible: true, capture: true, reason: "ok" },
  );
});

test("visible everywhere under the portfolio-wide wildcard, which is the recommended setting", () => {
  assert.deepEqual(computeSidebarVisibility("company-z", { allowedCompanies: ["*"] }), {
    visible: true,
    capture: true,
    reason: "ok",
  });
});

test("showInSidebar false hides the entry even for an allow-listed company", () => {
  assert.deepEqual(
    computeSidebarVisibility("company-a", { allowedCompanies: ["*"], showInSidebar: false }),
    { visible: false, capture: false, reason: "hidden-by-config" },
  );
});

test("the capture box can be turned off on its own, leaving the nav link", () => {
  assert.deepEqual(
    computeSidebarVisibility("company-a", { allowedCompanies: ["*"], showCaptureBox: false }),
    { visible: true, capture: false, reason: "ok" },
  );
});

test("the capture box never shows while the entry itself is hidden", () => {
  const hidden = computeSidebarVisibility("company-a", {
    allowedCompanies: ["*"],
    showInSidebar: false,
    showCaptureBox: true,
  });
  assert.equal(hidden.visible, false);
  assert.equal(hidden.capture, false);
});

test("both toggles default to on when unset", () => {
  const result = computeSidebarVisibility("company-a", { allowedCompanies: ["*"] });
  assert.equal(result.visible, true);
  assert.equal(result.capture, true);
});
