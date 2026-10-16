import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { verifyCompanySkill } from "./skill-verifier.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const skillId = "33333333-3333-4333-8333-333333333333";
const skillKey = `company/${companyId}/monthly-close`;

function context(row: { id: string; company_id: string; key: string; markdown: string; updated_at: string } | undefined) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const ctx = {
    db: {
      namespace: "plugin_handoff_dcdb27ff5a",
      async query(sql: string, params: unknown[]) { calls.push({ sql, params }); return row ? [row] : []; },
    },
  } as unknown as Pick<PluginContext, "db">;
  return { ctx, calls };
}

test("company skill verification binds both skill and company IDs", async () => {
  const { ctx, calls } = context({ id: skillId, company_id: companyId, key: skillKey, markdown: "Instructions\r\n", updated_at: "2026-10-15T00:00:00Z" });
  await verifyCompanySkill(ctx, companyId, skillId, skillKey, "Instructions\n");
  assert.deepEqual(calls[0].params, [skillId, companyId]);
  assert.match(calls[0].sql, /WHERE id = \$1 AND company_id = \$2/);
});

test("company skill verification rejects missing, mismatched-key and stale-content links", async () => {
  await assert.rejects(verifyCompanySkill(context(undefined).ctx, companyId, skillId, skillKey, "Instructions"), /not found in this company/);
  await assert.rejects(verifyCompanySkill(context({ id: skillId, company_id: companyId, key: `${skillKey}-other`, markdown: "Instructions", updated_at: "2026-10-15T00:00:00Z" }).ctx, companyId, skillId, skillKey, "Instructions"), /key does not match/);
  await assert.rejects(verifyCompanySkill(context({ id: skillId, company_id: companyId, key: skillKey, markdown: "New instructions", updated_at: "2026-10-15T00:00:00Z" }).ctx, companyId, skillId, skillKey, "Old instructions"), /Save the skill first/);
});
