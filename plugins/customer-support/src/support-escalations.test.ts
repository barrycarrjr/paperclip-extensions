import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createEscalationDraft, markEscalationSubmitted } from "./support-escalations.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const caseId = "44444444-4444-4444-8444-444444444444";

test("software reports draft an external support request without creating a Paperclip issue", async () => {
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
       VALUES ($1,$2,'example-workspace','slack','C-ALPHA','thread-1','Private source title',now(),now(),'software','bug')`,
      [caseId, companyId],
    );
    const activity: unknown[] = [];
    const ctx = {
      db: { namespace, query: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
        execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows }) },
      activity: { log: async (entry: unknown) => { activity.push(entry); } },
      issues: { create: async () => { throw new Error("must not create a local issue"); } },
    } as unknown as PluginContext;
    const config = { softwareRoutes: [{ id: "example-product-email", reportingCompanyId: companyId,
      productName: "Example Product", destinationKind: "email" as const, destination: "support@example.com" }] };
    const input = { companyId, caseId, routeId: "example-product-email", title: "Checkout fails",
      evidence: "Reproduced when submitting an order", actorUserId: "board-user" };

    await assert.rejects(createEscalationDraft(ctx, { ...input, companyId: "22222222-2222-4222-8222-222222222222" }, config),
      (error: { status?: number }) => error.status === 409);
    await assert.rejects(createEscalationDraft(ctx, { ...input, routeId: "unknown" }, config),
      (error: { status?: number }) => error.status === 409);
    const created = await createEscalationDraft(ctx, input, config);
    assert.equal(created.created, true);
    assert.deepEqual(await createEscalationDraft(ctx, input, config), { id: created.id, created: false });
    assert.equal(activity.length, 1);
    await assert.rejects(createEscalationDraft(ctx, { ...input, evidence: "Changed" }, config),
      (error: { status?: number }) => error.status === 409);
    const rows = await db.query<{ destination: string; title: string; evidence: string; status: string }>(
      `SELECT destination, title, evidence, status FROM ${namespace}.support_escalations WHERE company_id=$1 AND case_id=$2`,
      [companyId, caseId],
    );
    assert.deepEqual(rows.rows[0], { destination: "support@example.com", title: "Checkout fails",
      evidence: "Reproduced when submitting an order", status: "draft" });
    assert.deepEqual(await markEscalationSubmitted(ctx, { companyId, caseId, externalTicketRef: "Sent email 123",
      actorUserId: "board-user" }), { status: "submitted" });
    assert.equal(activity.length, 2);
    await assert.rejects(markEscalationSubmitted(ctx, { companyId, caseId, externalTicketRef: "Different",
      actorUserId: "board-user" }), (error: { status?: number }) => error.status === 409);
  } finally {
    await db.close();
  }
});
