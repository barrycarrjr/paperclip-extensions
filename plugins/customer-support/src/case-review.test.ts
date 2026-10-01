import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reviewCase, type CaseReviewInput } from "./case-review.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const caseId = "44444444-4444-4444-8444-444444444444";

test("reviewed service routing is company-scoped, versioned, and keeps non-software work out of bug routing", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const name of ["001_init.sql", "002_issue_links.sql", "003_thread_context.sql", "004_case_review.sql", "005_nonsoftware_work.sql", "006_issue_assignee.sql", "007_software_escalation.sql", "008_target_access.sql", "014_symptom_outcomes.sql"]) {
      await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
    await db.query(
      `INSERT INTO ${namespace}.support_cases
        (id, company_id, connection_id, source, external_route_id, external_conversation_id,
         title, first_message_at, last_message_at)
       VALUES ($1,$2,'example-workspace','slack','C-ALPHA','thread-1','Prepress computer',now(),now())`,
      [caseId, companyId],
    );
    const activity: unknown[] = [];
    const ctx = {
      db: {
        namespace,
        query: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
        execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows }),
      },
      activity: { log: async (entry: unknown) => { activity.push(entry); } },
    } as unknown as PluginContext;
    const input: CaseReviewInput = {
      companyId, caseId, actorUserId: "board-user", expectedVersion: 0,
      serviceDomain: "it", workKind: "incident", status: "triage",
      assetRef: "Prepress WS02", targetAddress: "prepress-ws02", accessMethod: "unknown",
      orderRef: null, vendorRef: null, resolutionSummary: null,
    };
    await assert.rejects(reviewCase(ctx, { ...input, companyId: otherCompanyId }),
      (error: { status?: number }) => error.status === 404);
    await assert.rejects(reviewCase(ctx, { ...input, workKind: "bug" }),
      (error: { status?: number }) => error.status === 422);
    await assert.rejects(reviewCase(ctx, { ...input, status: "resolved" }),
      (error: { status?: number }) => error.status === 422);
    await assert.rejects(reviewCase(ctx, { ...input, targetAddress: "https://example.com/path" }),
      (error: { status?: number }) => error.status === 422);
    assert.deepEqual(await reviewCase(ctx, input), { reviewVersion: 1 });
    await assert.rejects(reviewCase(ctx, input),
      (error: { status?: number }) => error.status === 409);
    assert.deepEqual(await reviewCase(ctx, { ...input, expectedVersion: 1, status: "resolved", resolutionSummary: "Display cable reseated" }),
      { reviewVersion: 2 });
    const row = await db.query<{ service_domain: string; work_kind: string; status: string; asset_ref: string; target_address: string; access_method: string; review_version: number }>(
      `SELECT service_domain, work_kind, status, asset_ref, target_address, access_method, review_version FROM ${namespace}.support_cases WHERE id=$1`, [caseId],
    );
    assert.deepEqual(row.rows[0], {
      service_domain: "it", work_kind: "incident", status: "resolved", asset_ref: "Prepress WS02",
      target_address: "prepress-ws02", access_method: "unknown", review_version: 2,
    });
    assert.equal(activity.length, 2);
  } finally {
    await db.close();
  }
});
