import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createReviewedIssue, type ReviewedIssueInput } from "./support-issues.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const caseId = "44444444-4444-4444-8444-444444444444";
const agentId = "77777777-7777-4777-8777-777777777777";

test("local incidents are assigned and recovered without duplicate issues; software cannot create a local fix", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const name of ["001_init.sql", "002_issue_links.sql", "003_thread_context.sql", "004_case_review.sql", "005_nonsoftware_work.sql", "006_issue_assignee.sql", "007_software_escalation.sql", "008_target_access.sql"]) {
      await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    await db.query(
      `INSERT INTO ${namespace}.support_cases
       (id, company_id, connection_id, source, external_route_id, external_conversation_id,
        title, first_message_at, last_message_at, service_domain, work_kind)
       VALUES ($1,$2,'example-workspace','slack','C-ALPHA','thread-1','Access code: example-only',
         now(),now(),'it','incident')`, [caseId, companyId],
    );
    const issues: { id: string; companyId: string; projectId: string | null; assigneeAgentId?: string; originKind: string; originId: string }[] = [];
    const descriptions: string[] = [];
    const activity: unknown[] = [];
    let failLinkOnce = true;
    const ctx = {
      db: {
        namespace,
        query: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
        execute: async (sql: string, params?: unknown[]) => {
          if (failLinkOnce && sql.includes("SET issue_id=$3")) {
            failLinkOnce = false;
            throw new Error("simulated link failure");
          }
          return { rowCount: (await db.query(sql, params)).affectedRows };
        },
      },
      agents: { get: async (id: string, company: string) => id === agentId && company === companyId
        ? { id, companyId: company } : null },
      issues: {
        list: async (filter: { companyId: string; originKind: string; originId: string }) =>
          issues.filter((issue) => issue.companyId === filter.companyId &&
            issue.originKind === filter.originKind && issue.originId === filter.originId),
        create: async (input: { companyId: string; assigneeAgentId?: string; originKind: string; originId: string; description: string }) => {
          descriptions.push(input.description);
          const issue = { ...input, id: "55555555-5555-4555-8555-555555555555", projectId: null };
          issues.push(issue);
          return issue;
        },
      },
      activity: { log: async (entry: unknown) => { activity.push(entry); } },
    } as unknown as PluginContext;
    const input: ReviewedIssueInput = {
      companyId, caseId, projectId: null, assigneeAgentId: agentId, kind: "followup",
      title: "Investigate prepress computer", evidence: "Display failed repeatedly", actorUserId: "board-user",
    };

    await assert.rejects(createReviewedIssue(ctx, { ...input, companyId: "22222222-2222-4222-8222-222222222222" }),
      (error: { status?: number }) => error.status === 404);
    await assert.rejects(createReviewedIssue(ctx, { ...input, projectId: caseId }),
      (error: { status?: number }) => error.status === 422);
    await assert.rejects(createReviewedIssue(ctx, { ...input, assigneeAgentId: caseId }),
      (error: { status?: number }) => error.status === 404);
    await assert.rejects(createReviewedIssue(ctx, input), /simulated link failure/);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.companyId, companyId);
    assert.equal(issues[0]?.assigneeAgentId, agentId);
    assert.equal(descriptions[0]?.includes("example-only"), false);
    issues[0]!.assigneeAgentId = undefined;
    await assert.rejects(createReviewedIssue(ctx, input), (error: { status?: number }) => error.status === 409);
    issues[0]!.assigneeAgentId = agentId;
    assert.deepEqual(await createReviewedIssue(ctx, input), { issueId: issues[0]!.id, created: false });
    assert.equal(activity.length, 1);
    assert.deepEqual(await createReviewedIssue(ctx, input), { issueId: issues[0]!.id, created: false });
    assert.equal(issues.length, 1);

    await db.query(`UPDATE ${namespace}.support_cases SET service_domain='software', work_kind='bug' WHERE id=$1`, [caseId]);
    await assert.rejects(createReviewedIssue(ctx, { ...input, kind: "bug" }),
      (error: { status?: number }) => error.status === 409);
  } finally {
    await db.close();
  }
});
