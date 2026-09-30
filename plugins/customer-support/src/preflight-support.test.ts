import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { preparePreflight, recordPreflightResult, preflightHistory } from "./preflight-support.js";
import { createEscalationDraft, resolveSoftwareRoute, markEscalationSubmitted } from "./support-escalations.js";
import { saveDirectory } from "./support-directory.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const cfg = { discoveryNetworks: [{ id: "example", companyId, cidr: "192.0.2.0/24" }], softwareRoutes: [{ id: "example-product", reportingCompanyId: companyId, productName: "Example production app", destinationKind: "built_in" as const, destination: "https://example.com/support", reportingInstructions: "Open Help, then Report a problem; copy the provider reference." }] };
const run = { companyId, userId: "operator", chatSessionId: "chat", userPermission: "support:repair", userConfirmed: true } as ToolRunContext;
test("preflight handoffs preserve real software evidence and built-in reporting stays an external draft until a reference is attested", async () => {
  const db = new PGlite(), namespace = "plugin_customer_support_0c69412611";
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const ctx = { db: { namespace, query: async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows, execute: async (sql: string, params: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows }) }, activity: { log: async () => {} }, http: { fetch: async () => { throw new Error("No document download or submission in a handoff"); } } } as unknown as PluginContext;
    const saved = await saveDirectory(ctx, cfg, companyId, "operator", { kind: "preflight", name: "Example check", details: { softwareName: "Example production app", procedure: "Run the existing job preflight and retain its report" } });
    const diagnostic = { ...run, userPermission: "support:diagnose" } as ToolRunContext;
    const prepared = await preparePreflight(ctx, cfg, diagnostic, { profileId: saved.id, fileReference: "Example job / file revision 2" });
    assert.equal(prepared.status, "handoff_required");
    const input = { profileId: saved.id, profileVersion: 1, resultId: randomUUID(), fileReference: prepared.fileReference, reportReference: "Example software report 12", checkedAt: new Date().toISOString(), findings: [{ check: "bleed", status: "fail", evidence: "Software reports missing bleed" }, { check: "resolution", status: "unavailable", evidence: "Not supplied by this report" }] };
    await assert.rejects(recordPreflightResult(ctx, cfg, { ...run, userConfirmed: false }, input));
    await assert.rejects(recordPreflightResult(ctx, cfg, { ...run, companyId: "22222222-2222-4222-8222-222222222222" }, input));
    await recordPreflightResult(ctx, cfg, run, input); await recordPreflightResult(ctx, cfg, run, input);
    await assert.rejects(recordPreflightResult(ctx, cfg, run, { ...input, reportReference: "Different report" }), /different evidence/);
    assert.equal((await preflightHistory(ctx, cfg, diagnostic, input)).results.length, 1);
    await saveDirectory(ctx, cfg, companyId, "operator", { id: saved.id, expectedVersion: 1, kind: "preflight", name: "Updated", details: { softwareName: "New example software", procedure: "Updated procedure" } });
    await assert.rejects(recordPreflightResult(ctx, cfg, run, { ...input, resultId: randomUUID() }), /version/);
    const caseId = randomUUID();
    await db.query(`INSERT INTO ${namespace}.support_cases(id,company_id,connection_id,source,external_route_id,external_conversation_id,title,first_message_at,last_message_at,service_domain,work_kind) VALUES($1,$2,'example','slack','example','example','Example bug',now(),now(),'software','bug')`, [caseId, companyId]);
    await createEscalationDraft(ctx, { companyId, caseId, routeId: "example-product", title: "Example bug", evidence: "Reproduced in a test job", actorUserId: "operator" }, cfg);
    assert.equal((await db.query<{ status: string }>(`SELECT status FROM ${namespace}.support_escalations`)).rows[0]!.status, "draft");
    await markEscalationSubmitted(ctx, { companyId, caseId, actorUserId: "operator", externalTicketRef: "Example built-in report 7" });
    assert.throws(() => resolveSoftwareRoute({ softwareRoutes: [{ ...cfg.softwareRoutes[0]!, destination: "https://example.com/support?token=synthetic-test" }] }, companyId, "example-product"));
  } finally { await db.close(); }
});
