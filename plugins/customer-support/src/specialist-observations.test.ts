import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { saveDirectory } from "./support-directory.js";
import { requestSpecialistObservation, getSpecialistObservation, recordSpecialistObservation } from "./specialist-observations.js";
import type { ObservationRequest } from "../../../lib/support-observations.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const cfg = { discoveryNetworks: [{ id: "example", companyId, cidr: "10.99.0.0/24" }] };
const run = { companyId, userId: "operator", chatSessionId: "chat", userPermission: "support:diagnose" } as ToolRunContext;
test("specialist receipts bind provider/company/hash/conversation/profile and redact string values safely", async () => {
  const db = new PGlite(), namespace = "plugin_customer_support_0c69412611";
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    let request: ObservationRequest | undefined;
    const ctx = { db: { namespace, query: async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows, execute: async (sql: string, params: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows }) }, events: { emit: async (_name: string, _company: string, payload: ObservationRequest) => { request = payload; } }, activity: { log: async () => {} } } as unknown as PluginContext;
    const profile = await saveDirectory(ctx, cfg, companyId, "operator", { kind: "connection", name: "Example help desk", details: { pluginKey: "help-scout", accountKey: "example", area: "email" } });
    const pending = await requestSpecialistObservation(ctx, cfg, run, { profileId: profile.id, operation: "conversation", resourceId: "100" });
    assert.equal((await getSpecialistObservation(ctx, cfg, run, pending.requestId)).status, "pending");
    const event = { eventType: "plugin.help-scout.support-observation-receipt", actorType: "plugin", actorId: "help-scout", companyId, payload: { version: 1, companyId, requestId: pending.requestId, requestSha256: request!.requestSha256, status: "available", findings: { subject: 'Example password="synthetic-test-value"' }, observedAtUtc: new Date().toISOString() } };
    await recordSpecialistObservation(ctx, { ...event, actorId: "3cx-tools" });
    assert.equal((await getSpecialistObservation(ctx, cfg, run, pending.requestId)).status, "pending");
    await recordSpecialistObservation(ctx, event);
    const result = await getSpecialistObservation(ctx, cfg, run, pending.requestId);
    assert.equal(result.status, "available"); assert.doesNotMatch(JSON.stringify(result.findings), /synthetic-test-value/);
    await assert.rejects(getSpecialistObservation(ctx, cfg, { ...run, chatSessionId: "other" }, pending.requestId));
    await assert.rejects(getSpecialistObservation(ctx, cfg, { ...run, companyId: "22222222-2222-4222-8222-222222222222" }, pending.requestId));
    const cloud = await saveDirectory(ctx,cfg,companyId,"operator",{kind:"connection",name:"Example cloud backup",details:{pluginKey:"google-workspace",accountKey:"example",area:"automations"}});
    await assert.rejects(requestSpecialistObservation(ctx,cfg,run,{profileId:cloud.id,operation:"backup_verify",resourceId:"../not-saved"}));
    const check=await requestSpecialistObservation(ctx,cfg,run,{profileId:cloud.id,operation:"backup_verify",resourceId:"skills"});
    assert.equal(request!.provider,"google-workspace");
    await recordSpecialistObservation(ctx,{eventType:"plugin.google-workspace.support-observation-receipt",actorType:"plugin",actorId:"google-workspace",companyId,payload:{version:1,companyId,requestId:check.requestId,requestSha256:request!.requestSha256,status:"available",findings:{status:"matched_and_restore_tested",restoreTestedFiles:1,temporaryFilesRemoved:true},observedAtUtc:new Date().toISOString()}});
    assert.equal((await getSpecialistObservation(ctx,cfg,run,check.requestId)).status,"available");
    await saveDirectory(ctx, cfg, companyId, "operator", { id: profile.id, expectedVersion: 1, kind: "connection", name: "Updated", details: { pluginKey: "help-scout", accountKey: "example", area: "email" } });
    await assert.rejects(getSpecialistObservation(ctx, cfg, run, pending.requestId), /profile changed/);
  } finally { await db.close(); }
});
