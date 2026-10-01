import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { startSupportWork } from "./support-work.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const caseId = "44444444-4444-4444-8444-444444444444";
const issueId = "55555555-5555-4555-8555-555555555555";
const agentId = "77777777-7777-4777-8777-777777777777";

test("board-started support work only wakes the linked company issue with its reviewed assignee", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const name of ["001_init.sql", "002_issue_links.sql", "003_thread_context.sql", "004_case_review.sql", "005_nonsoftware_work.sql", "006_issue_assignee.sql", "007_software_escalation.sql", "008_target_access.sql"]) {
      await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    await db.query(
      `INSERT INTO ${namespace}.support_cases
       (id, company_id, connection_id, source, external_route_id, external_conversation_id,
        title, first_message_at, last_message_at)
       VALUES ($1,$2,'example-workspace','slack','C-ALPHA','thread-1','Computer issue',now(),now())`,
      [caseId, companyId],
    );
    await db.query(
      `INSERT INTO ${namespace}.support_issue_links
       (company_id, case_id, project_id, assignee_agent_id, issue_kind, title, evidence, issue_id)
       VALUES ($1,$2,NULL,$3,'followup','Fix computer','Reviewed',$4)`,
      [companyId, caseId, agentId, issueId],
    );
    let currentAssignee: string | null = agentId;
    let currentStatus = "todo";
    const wakeups: unknown[][] = [];
    const ctx = {
      db: { namespace, query: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows },
      issues: {
        get: async (id: string, company: string) => id === issueId && company === companyId
          ? { id, companyId: company, assigneeAgentId: currentAssignee, status: currentStatus } : null,
        requestWakeup: async (...args: unknown[]) => { wakeups.push(args); return { queued: true, runId: "run-1" }; },
      },
    } as unknown as PluginContext;
    const input = { companyId, caseId, actorUserId: "board-user" };

    await assert.rejects(startSupportWork(ctx, { ...input, companyId: "22222222-2222-4222-8222-222222222222" }),
      (error: { status?: number }) => error.status === 404);
    currentAssignee = null;
    await assert.rejects(startSupportWork(ctx, input), (error: { status?: number }) => error.status === 409);
    currentAssignee = agentId;
    currentStatus = "done";
    await assert.rejects(startSupportWork(ctx, input), (error: { status?: number }) => error.status === 409);
    assert.equal(wakeups.length, 0);

    currentStatus = "todo";
    assert.deepEqual(await startSupportWork(ctx, input), { queued: true, runId: "run-1" });
    assert.equal(wakeups.length, 1);
    assert.equal(wakeups[0]?.[0], issueId);
    assert.equal(wakeups[0]?.[1], companyId);
    assert.deepEqual(wakeups[0]?.[2], {
      reason: "support_case_reviewed_work", contextSource: "customer-support.case",
      idempotencyKey: `customer-support:${caseId}:start`, actorUserId: "board-user",
    });
  } finally {
    await db.close();
  }
});
