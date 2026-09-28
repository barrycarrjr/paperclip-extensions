import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { decideSupportAction, executeSupportAction, listSupportActions, proposeSupportAction } from "./support-actions.js";
import type { Config } from "./routing.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const caseId = "44444444-4444-4444-8444-444444444444";
const target = "workstation.example.local";
const config: Config = { connections: [], remoteAccessProfiles: [{
  id: "windows-1", companyId, credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333",
  targets: [{ address: target, transport: "Wmi" }],
}] };

test("a company-scoped proposed repair needs a fresh board decision and runs once with verification", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const name of ["001_init.sql", "002_issue_links.sql", "003_thread_context.sql", "004_case_review.sql",
      "005_nonsoftware_work.sql", "006_issue_assignee.sql", "007_software_escalation.sql", "008_target_access.sql",
      "009_connection_methods.sql", "010_email_source.sql", "011_support_actions.sql"]) {
      await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    await db.query(`INSERT INTO ${namespace}.support_cases
      (id, company_id, connection_id, source, external_route_id, external_conversation_id, title,
       first_message_at, last_message_at, service_domain, target_address, review_version)
      VALUES ($1,$2,'example','email','inbox','thread','Printer is stuck',now(),now(),'it',$3,1)`,
    [caseId, companyId, target]);
    const activity: unknown[] = [];
    const ctx = {
      db: { namespace, query: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows },
      activity: { log: async (entry: unknown) => { activity.push(entry); } },
    } as unknown as PluginContext;
    const proposal = { companyId, caseId, actorUserId: "operator", expectedReviewVersion: 1,
      script: "Restart-Service Spooler", verificationScript: "if ((Get-Service Spooler).Status -ne 'Running') { throw 'Still stopped' }",
      expectedEffect: "Print service runs", recoveryNotes: "Check queue and escalate if the service remains stopped" };
    await assert.rejects(proposeSupportAction(ctx, config, { ...proposal, companyId: otherCompanyId }),
      (error: { status?: number }) => error.status === 404);
    const action = await proposeSupportAction(ctx, config, proposal);
    assert.equal(action.status, "proposed");
    assert.equal((await listSupportActions(ctx, companyId, caseId)).length, 1);
    assert.equal((await listSupportActions(ctx, otherCompanyId, caseId)).length, 0);
    const scope = { companyId, caseId, actionId: action.id, actorUserId: "operator" };
    let calls = 0;
    const runner = async () => { calls++; return { runId: `run-${calls}`, status: "succeeded", exitCode: 0 }; };
    await assert.rejects(executeSupportAction(ctx, config, scope, runner),
      (error: { status?: number }) => error.status === 409);
    await assert.rejects(decideSupportAction(ctx, { ...scope, companyId: otherCompanyId, decision: "approved" }),
      (error: { status?: number }) => error.status === 409);
    assert.equal((await decideSupportAction(ctx, { ...scope, decision: "approved" })).status, "approved");
    assert.equal((await executeSupportAction(ctx, config, scope, runner)).status, "verified");
    assert.equal(calls, 2);
    await assert.rejects(executeSupportAction(ctx, config, scope, runner),
      (error: { status?: number }) => error.status === 409);
    assert.equal(calls, 2);
    const uncertain = await proposeSupportAction(ctx, config, proposal);
    await decideSupportAction(ctx, { ...scope, actionId: uncertain.id, decision: "approved" });
    const unknown = await executeSupportAction(ctx, config, { ...scope, actionId: uncertain.id }, async () => {
      throw new Error("Lost remote response after launch");
    });
    assert.equal(unknown.status, "unknown");
    await assert.rejects(executeSupportAction(ctx, config, { ...scope, actionId: uncertain.id }, runner),
      (error: { status?: number }) => error.status === 409);
    assert.equal(calls, 2);
    assert.equal(activity.length, 8);
  } finally {
    await db.close();
  }
});
