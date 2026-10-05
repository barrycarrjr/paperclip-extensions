/**
 * Tests for reading the host-stamped scope.
 *
 * The dangerous direction is accepting something the browser could have
 * written. The host overwrites `params.hostScope`, so the only way a bad
 * value gets here is a host that did not stamp it (older host, or a global
 * admin call). Both must read as "no scope", never as "any company".
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ESCOPE_MESSAGE, readHostScope, requireCompanyScope } from "./hostScope.js";

test("returns null when hostScope is missing", () => {
  assert.equal(readHostScope(undefined), null);
  assert.equal(readHostScope(null), null);
  assert.equal(readHostScope({}), null);
  assert.equal(readHostScope({ companyId: "company-a" }), null);
});

test("returns null when hostScope is not an object", () => {
  for (const hostScope of ["company-a", 42, true, null, undefined, ["company-a", "user-1"]]) {
    assert.equal(readHostScope({ hostScope }), null, `hostScope=${JSON.stringify(hostScope)}`);
  }
});

test("returns null when hostScope has the wrong shape", () => {
  assert.equal(readHostScope({ hostScope: {} }), null);
  assert.equal(readHostScope({ hostScope: { companyId: "company-a" } }), null);
  assert.equal(readHostScope({ hostScope: { userId: "user-1" } }), null);
  assert.equal(readHostScope({ hostScope: { companyId: 7, userId: "user-1" } }), null);
  assert.equal(readHostScope({ hostScope: { companyId: "company-a", userId: {} } }), null);
  assert.equal(readHostScope({ hostScope: { companyId: undefined, userId: "user-1" } }), null);
});

test("returns the scope when both fields are a string or null", () => {
  assert.deepEqual(readHostScope({ hostScope: { companyId: "company-a", userId: "user-1" } }), {
    companyId: "company-a",
    userId: "user-1",
  });
  assert.deepEqual(readHostScope({ hostScope: { companyId: null, userId: "admin-1" } }), {
    companyId: null,
    userId: "admin-1",
  });
  assert.deepEqual(readHostScope({ hostScope: { companyId: "company-a", userId: null } }), {
    companyId: "company-a",
    userId: null,
  });
});

test("ignores extra keys and anything outside hostScope", () => {
  const scope = readHostScope({
    companyId: "company-b",
    hostScope: { companyId: "company-a", userId: "user-1", extra: "ignored" },
  });
  assert.deepEqual(scope, { companyId: "company-a", userId: "user-1" });
});

test("requireCompanyScope throws [ESCOPE] for a null companyId", () => {
  assert.throws(
    () => requireCompanyScope({ hostScope: { companyId: null, userId: "admin-1" } }),
    (err: unknown) => err instanceof Error && err.message === ESCOPE_MESSAGE,
  );
});

test("requireCompanyScope throws [ESCOPE] for a missing or malformed scope", () => {
  for (const params of [undefined, {}, { companyId: "company-a" }, { hostScope: "company-a" }, { hostScope: { companyId: "" , userId: "u" } }]) {
    assert.throws(
      () => requireCompanyScope(params),
      (err: unknown) => err instanceof Error && err.message.startsWith("[ESCOPE]"),
      `params=${JSON.stringify(params)}`,
    );
  }
});

test("requireCompanyScope returns the scope when a company is present", () => {
  assert.deepEqual(requireCompanyScope({ hostScope: { companyId: "company-a", userId: "user-1" } }), {
    companyId: "company-a",
    userId: "user-1",
  });
  assert.deepEqual(requireCompanyScope({ hostScope: { companyId: "company-a", userId: null } }), {
    companyId: "company-a",
    userId: null,
  });
});

test("the [ESCOPE] sentence has no long dashes", () => {
  // en-dash and em-dash, built from code points so this file carries neither.
  assert.doesNotMatch(ESCOPE_MESSAGE, new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
});
