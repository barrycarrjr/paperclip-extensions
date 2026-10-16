import assert from "node:assert/strict";
import test from "node:test";
import { assertCompanyAllowed, isCompanyAllowed } from "./company-access.js";

test("company access denies an empty allow-list and isolates named companies", () => {
  assert.equal(isCompanyAllowed(undefined, "company-a"), false);
  assert.equal(isCompanyAllowed([], "company-a"), false);
  assert.equal(isCompanyAllowed(["company-a"], "company-a"), true);
  assert.equal(isCompanyAllowed(["company-a"], "company-b"), false);
  assert.equal(isCompanyAllowed(["*"], "company-b"), true);
});

test("company access logs and refuses denied requests", () => {
  const warnings: unknown[] = [];
  assert.throws(
    () => assertCompanyAllowed(
      { logger: { warn: (...args: unknown[]) => { warnings.push(args); } } } as never,
      "handoff.summary",
      ["company-a"],
      "company-b",
    ),
    /ECOMPANY_NOT_ALLOWED/,
  );
  assert.equal(warnings.length, 1);
});
