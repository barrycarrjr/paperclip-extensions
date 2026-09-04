/**
 * Tests for review location scoping.
 *
 * The bug these exist to prevent returning: the dashboard used to show every
 * configured location to every company. The dangerous direction is showing
 * too much, so most of these check that a company sees only its own.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { scopeLocationsForCompany } from "./locationScope.js";

const LOCATIONS = [
  { key: "acme-main", displayName: "Acme Main St", targetCompanyId: "company-a" },
  { key: "acme-second", displayName: "Acme Second Ave", targetCompanyId: "company-a" },
  { key: "beta-hq", displayName: "Beta HQ", targetCompanyId: "company-b" },
  { key: "orphan", displayName: "Not yet assigned" },
];

test("a company sees only its own locations", () => {
  const result = scopeLocationsForCompany({
    companyId: "company-a",
    isPortfolioRoot: false,
    locations: LOCATIONS,
  });
  assert.deepEqual(result.locations.map((l) => l.key), ["acme-main", "acme-second"]);
  assert.equal(result.isRollup, false);
});

test("another company's locations are not visible", () => {
  const result = scopeLocationsForCompany({
    companyId: "company-b",
    isPortfolioRoot: false,
    locations: LOCATIONS,
  });
  assert.deepEqual(result.locations.map((l) => l.key), ["beta-hq"]);
});

test("the portfolio root sees every location, and says it is a roll-up", () => {
  const result = scopeLocationsForCompany({
    companyId: "hq",
    isPortfolioRoot: true,
    locations: LOCATIONS,
  });
  assert.equal(result.locations.length, LOCATIONS.length);
  assert.equal(result.isRollup, true);
});

test("no company in context shows nothing, not everything", () => {
  // The old behaviour amounted to "everything" here. Absence of a company
  // means something is wrong, and the safe answer to whose data this is, is
  // nobody's.
  for (const companyId of [null, undefined, ""]) {
    const result = scopeLocationsForCompany({
      companyId,
      isPortfolioRoot: false,
      locations: LOCATIONS,
    });
    assert.deepEqual(result.locations, []);
    assert.equal(result.isRollup, false);
  }
});

test("a location with no target company is not shown to a specific company", () => {
  const result = scopeLocationsForCompany({
    companyId: "company-a",
    isPortfolioRoot: false,
    locations: LOCATIONS,
  });
  assert.equal(result.locations.some((l) => l.key === "orphan"), false);
});

test("an unassigned location still appears in the roll-up, so it can be spotted", () => {
  const result = scopeLocationsForCompany({
    companyId: "hq",
    isPortfolioRoot: true,
    locations: LOCATIONS,
  });
  assert.equal(result.locations.some((l) => l.key === "orphan"), true);
});

test("handles an empty or missing location list", () => {
  assert.deepEqual(
    scopeLocationsForCompany({ companyId: "company-a", isPortfolioRoot: false, locations: [] }),
    { locations: [], isRollup: false },
  );
  assert.deepEqual(
    scopeLocationsForCompany({ companyId: "hq", isPortfolioRoot: true, locations: null }),
    { locations: [], isRollup: false },
  );
});

test("does not hand back the caller's own array to mutate", () => {
  const original = [...LOCATIONS];
  const result = scopeLocationsForCompany({
    companyId: "hq",
    isPortfolioRoot: true,
    locations: original,
  });
  result.locations.pop();
  assert.equal(original.length, LOCATIONS.length);
});
