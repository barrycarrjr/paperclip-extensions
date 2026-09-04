/**
 * Unit tests for the shared-account scope disclosure.
 *
 * The behaviour under test is a promise to the operator: if the page they are
 * looking at is fed by an account that also serves other companies, say so.
 * Getting it wrong in the quiet direction (calling a shared account private)
 * is the failure that matters, so most of these check that direction.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { describeAccountReach, describeAccountScope } from "./accountScope.js";

const THIS_COMPANY = "company-a";

test("says nothing when there is no company or no accounts", () => {
  assert.deepEqual(describeAccountScope(null, [{ key: "main", allowedCompanies: ["*"] }]), {
    accounts: [],
    anyShared: false,
  });
  assert.deepEqual(describeAccountScope(THIS_COMPANY, []), { accounts: [], anyShared: false });
  assert.deepEqual(describeAccountScope(THIS_COMPANY, null), { accounts: [], anyShared: false });
});

test("a wildcard account is reported as reaching every company", () => {
  const summary = describeAccountScope(THIS_COMPANY, [
    { key: "main", allowedCompanies: ["*"] },
  ]);
  assert.equal(summary.accounts.length, 1);
  assert.equal(summary.accounts[0].reach, "all-companies");
  assert.equal(summary.anyShared, true);
});

test("an account named to several companies is reported as shared", () => {
  const summary = describeAccountScope(THIS_COMPANY, [
    { key: "main", allowedCompanies: [THIS_COMPANY, "company-b"] },
  ]);
  assert.equal(summary.accounts[0].reach, "several-companies");
  assert.equal(summary.accounts[0].namedCompanyCount, 2);
  assert.equal(summary.anyShared, true);
});

test("an account named only to this company is not reported as shared", () => {
  const summary = describeAccountScope(THIS_COMPANY, [
    { key: "main", allowedCompanies: [THIS_COMPANY] },
  ]);
  assert.equal(summary.accounts[0].reach, "this-company-only");
  assert.equal(summary.anyShared, false);
});

test("accounts this company cannot use are left out", () => {
  // They produce none of the data on screen, so they are not part of the
  // disclosure. Whether the company MAY use them is assertCompanyAccess's
  // job, and this must not become a second, weaker copy of that rule.
  const summary = describeAccountScope(THIS_COMPANY, [
    { key: "ours", allowedCompanies: [THIS_COMPANY] },
    { key: "theirs", allowedCompanies: ["company-b"] },
    { key: "unconfigured", allowedCompanies: [] },
  ]);
  assert.deepEqual(summary.accounts.map((a) => a.key), ["ours"]);
});

test("one shared account among several is enough to warrant saying so", () => {
  const summary = describeAccountScope(THIS_COMPANY, [
    { key: "private", allowedCompanies: [THIS_COMPANY] },
    { key: "shared", allowedCompanies: ["*"] },
  ]);
  assert.equal(summary.anyShared, true);
  assert.deepEqual(summary.accounts.map((a) => a.reach), [
    "this-company-only",
    "all-companies",
  ]);
});

test("falls back to a readable key when an account has no key", () => {
  const summary = describeAccountScope(THIS_COMPANY, [
    { name: "Front desk", allowedCompanies: ["*"] },
  ]);
  assert.equal(summary.accounts[0].key, "Front desk");

  const nameless = describeAccountScope(THIS_COMPANY, [{ allowedCompanies: ["*"] }]);
  assert.equal(nameless.accounts[0].key, "(default)");
});

test("does not invent a company count for a wildcard account", () => {
  // The wildcard names nobody, so any number would be a guess. The reach
  // already carries the meaning.
  const summary = describeAccountScope(THIS_COMPANY, [
    { key: "main", allowedCompanies: ["*", "company-b"] },
  ]);
  assert.equal(summary.accounts[0].reach, "all-companies");
  assert.equal(summary.accounts[0].namedCompanyCount, 0);
});

test("the sentence says shared, in words an operator would use", () => {
  assert.match(
    describeAccountReach({ key: "m", name: null, reach: "all-companies", namedCompanyCount: 0 }),
    /every company/i,
  );
  assert.match(
    describeAccountReach({ key: "m", name: null, reach: "several-companies", namedCompanyCount: 3 }),
    /Shared with 3 companies/i,
  );
  assert.match(
    describeAccountReach({ key: "m", name: null, reach: "this-company-only", namedCompanyCount: 1 }),
    /only by this company/i,
  );
});
