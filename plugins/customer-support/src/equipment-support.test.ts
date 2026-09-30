import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { recordEquipmentEvent, equipmentHistory, prepareEquipmentService } from "./equipment-support.js";
import { saveDirectory } from "./support-directory.js";
const companyId = "11111111-1111-4111-8111-111111111111", otherCompanyId = "22222222-2222-4222-8222-222222222222";
const cfg = { discoveryNetworks: [{ id: "example", companyId, cidr: "192.0.2.0/24" }, { id: "other", companyId: otherCompanyId, cidr: "198.51.100.0/24" }] };
const run = { companyId, userId: "operator", chatSessionId: "chat", userPermission: "support:repair", userConfirmed: true } as ToolRunContext;
test("equipment history is company scoped, append-only, consent gated and separates vendor drafts from service completion", async () => {
  const db = new PGlite(), namespace = "plugin_customer_support_0c69412611";
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    const ctx = { db: { namespace, query: async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows, execute: async (sql: string, params: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows }) }, activity: { log: async () => {} }, events: { emit: async () => { throw new Error("No real vendor sending in a draft"); } } } as unknown as PluginContext;
    const vendor = await saveDirectory(ctx, cfg, companyId, "operator", { kind: "vendor", name: "Example service", details: { email: "service@example.com" } });
    const asset = await saveDirectory(ctx, cfg, companyId, "operator", { kind: "equipment", name: "Example finisher", details: { model: "Example model", vendorId: vendor.id } });
    const entry = { equipmentId: asset.id, eventId: randomUUID(), kind: "fault", code: "E10", occurredAt: new Date().toISOString(), notes: "Observed feed stop; no physical intervention" };
    await assert.rejects(recordEquipmentEvent(ctx, cfg, { ...run, userConfirmed: false }, entry));
    await assert.rejects(recordEquipmentEvent(ctx, cfg, { ...run, companyId: otherCompanyId }, entry));
    await recordEquipmentEvent(ctx, cfg, run, entry); await recordEquipmentEvent(ctx, cfg, run, entry);
    await assert.rejects(recordEquipmentEvent(ctx, cfg, run, { ...entry, notes: "Changed evidence" }), /different evidence/);
    await recordEquipmentEvent(ctx, cfg, run, { ...entry, eventId: randomUUID() });
    await assert.rejects(recordEquipmentEvent(ctx, cfg, run, { ...entry, eventId: randomUUID(), kind: "service", occurredAt: "2099-01-01T00:00:00Z" }));
    const diagnostic = { ...run, userPermission: "support:diagnose" } as ToolRunContext;
    const history = await equipmentHistory(ctx, cfg, diagnostic, asset.id);
    assert.equal(history.events.length, 2); assert.equal((history.recurringFaultCodes[0] as { reports: number }).reports, 2);
    const draft = await prepareEquipmentService(ctx, cfg, diagnostic, { equipmentId: asset.id, problem: "Repeated feed stop" });
    assert.equal(draft.status, "draft_only"); assert.equal(draft.contact.id, vendor.id);
    assert.equal((await equipmentHistory(ctx, cfg, diagnostic, asset.id)).events.length, 2);
  } finally { await db.close(); }
});
