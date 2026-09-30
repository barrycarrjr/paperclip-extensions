import assert from "node:assert/strict";
import test from "node:test";
import { readPbxOverview, supportPbxAccount } from "./support-observations.js";
import type { InstanceConfig, ThreeCxEngine } from "./engines/types.js";
const companyId = "11111111-1111-4111-8111-111111111111";
test("PBX observation opt-in is explicit and preserves scoped reads while distinguishing untested components", async () => {
  const cfg = { accounts: [{ key: "example", supportReadEnabled: true, allowedCompanies: [companyId], mode: "manual" }] } as InstanceConfig;
  assert.ok(supportPbxAccount(cfg, companyId, "example"));
  assert.throws(() => supportPbxAccount({ accounts: [{ ...cfg.accounts![0]!, allowedCompanies: ["*"] }] }, companyId, "example"));
  assert.throws(() => supportPbxAccount({ accounts: [{ ...cfg.accounts![0]!, supportReadEnabled: false }] }, companyId, "example"));
  const filter = { mode: "manual" as const, extensions: ["100"], extensionRanges: [], queueIds: [], dids: [] };
  const engine = { listQueues: async (scope: unknown) => { assert.equal(scope, filter); throw new Error("Synthetic unavailable"); }, listExtensions: async (scope: unknown) => { assert.equal(scope, filter); return Array.from({ length: 51 }, () => ({ number: "100", displayName: "Example", type: "user", email: "private@example.test" })); }, listAgents: async () => [{ extension: "100", presence: "offline", inCall: false, caller: "Private caller" }] } as unknown as ThreeCxEngine;
  const result = await readPbxOverview(engine, filter);
  assert.equal(result.queues.status, "unavailable");
  assert.equal(result.extensions.truncated, true);
  assert.equal(result.extensions.samples?.length, 50);
  assert.ok(result.componentsNotTested.includes("SBC"));
  assert.doesNotMatch(JSON.stringify(result), /private@example|Private caller/);
});
