import assert from "node:assert/strict";
import test from "node:test";
import { validateRemoteActionReceipt } from "./remote-action.js";

test("a remote repair receipt must match the reviewed company, target, case, and script hash", () => {
  const expected = { companyId: "11111111-1111-4111-8111-111111111111", target: "workstation.example.local",
    caseReference: "44444444-4444-4444-8444-444444444444", scriptSha256: "a".repeat(64) };
  const receipt = { company: expected.companyId, target: expected.target, caseReference: expected.caseReference,
    scriptSha256: expected.scriptSha256.toUpperCase(), runId: "run-1", status: "succeeded", exitCode: 0 };
  assert.deepEqual(validateRemoteActionReceipt(receipt, 0, expected), { runId: "run-1", status: "succeeded", exitCode: 0 });
  for (const mismatch of [
    { company: "22222222-2222-4222-8222-222222222222" },
    { target: "another.example.local" },
    { caseReference: "different" },
    { scriptSha256: "b".repeat(64) },
  ]) {
    assert.throws(() => validateRemoteActionReceipt({ ...receipt, ...mismatch }, 0, expected));
  }
  assert.throws(() => validateRemoteActionReceipt(receipt, 1, expected));
});
