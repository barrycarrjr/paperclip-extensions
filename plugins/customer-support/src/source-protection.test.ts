import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { protectSource, redactSource, readProtectedSource, protectLegacySources, safeLink } from "./source-protection.js";
import { storeMessage } from "./worker.js";
import type { IncomingMessage, Connection } from "./routing.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const secretRef = "33333333-3333-4333-8333-333333333333";
const connection: Connection = { id: "example", source: "slack", externalAccountId: "TEXAMPLE01", ingestAgentId: "agent-a", allowedCompanies: [companyId], routes: [{ externalRouteId: "CEXAMPLE01:alpha", companyId }] };
const message: IncomingMessage = { companyId, connectionId: "example", externalAccountId: "TEXAMPLE01", externalRouteId: "CEXAMPLE01:alpha",
  externalConversationId: "1700000000.000100", externalMessageId: "1700000000.000100", title: "Slow computer", body: "PC01 is slow\nPassword: synthetic-test-value", authorKind: "staff", occurredAt: "2026-09-30T12:00:00Z" };
async function fixture() {
  const db = new PGlite(); const namespace = "plugin_customer_support_0c69412611";
  await db.exec(`CREATE SCHEMA ${namespace}`);
  for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(n => n.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const activity: unknown[] = []; let protectedValue = "";
  const ctx = { db: { namespace, query: async (sql: string, params?: unknown[]) => (await db.query(sql, params)).rows,
    execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows }) },
    activity: { log: async (entry: unknown) => activity.push(entry) },
    config: { get: async () => ({}) },
    secrets: { store: async (company: string, _key: string, value: string) => { assert.equal(company, companyId); protectedValue = value; return { secretRef }; },
      resolve: async (ref: string, company: string) => { assert.equal(ref, secretRef); assert.equal(company, companyId); return protectedValue; } },
  } as unknown as PluginContext;
  return { db, ctx, activity, namespace, protectedValue: () => protectedValue };
}
test("source filtering removes labeled credentials, multiline keys, bearer tokens and unsafe links while retaining symptoms", async () => {
  assert.equal(redactSource(message.body), "PC01 is slow\n[restricted access information]");
  assert.equal(redactSource("Password reset fails on PC01"), "Password reset fails on PC01");
  const key = "-----BEGIN "+"PRIVATE KEY-----\nsynthetic\n-----END "+"PRIVATE KEY-----";
  assert.ok(!redactSource(key).includes("synthetic"));
  assert.ok(!redactSource("Authorization: Bearer synthetic-value").includes("synthetic-value"));
  const ctx = { secrets: { store: async () => ({ secretRef }) } } as unknown as PluginContext;
  const result = await protectSource(ctx, { ...message, attachments: [{ id: "file", name: "Password: synthetic-file", permalink: "https://example.com/log?token=synthetic-link" }] });
  assert.equal(result.message.attachments![0]!.permalink, undefined);
  assert.equal(result.message.attachments![0]!.name, "[restricted access information]");
  assert.equal(safeLink("https://example.com/log#access_token=synthetic-link"),undefined);
  assert.equal(safeLink("javascript:alert(1)"),undefined);
  assert.equal(safeLink("https://example.com/ticket/123"),"https://example.com/ticket/123");
});
test("intake persists only filtered text and a reference, keeps originals usable behind case/company scope and audits access", async () => {
  const f = await fixture();
  try {
    const result = await storeMessage(f.ctx, message, connection);
    assert.equal((await storeMessage(f.ctx, message, connection)).created, false);
    const rows = (await f.db.query<{ id: string; body: string; protected_source_ref: string }>(`SELECT id,body,protected_source_ref FROM ${f.namespace}.support_messages`)).rows;
    assert.equal(rows.length, 1); assert.ok(!rows[0]!.body.includes("synthetic-test-value"));
    assert.equal(rows[0]!.protected_source_ref, secretRef);
    assert.ok(f.protectedValue().includes("synthetic-test-value"));
    assert.ok(!JSON.stringify(f.activity).includes("synthetic-test-value"));
    assert.equal((await readProtectedSource(f.ctx, { companyId, caseId: result.caseId, messageId: rows[0]!.id, userId: "operator" })).body, message.body);
    await assert.rejects(readProtectedSource(f.ctx, { companyId: "22222222-2222-4222-8222-222222222222", caseId: result.caseId, messageId: rows[0]!.id, userId: "operator" }));
    await assert.rejects(readProtectedSource(f.ctx, { companyId, caseId: result.caseId, messageId: rows[0]!.id, userId: "" }));
  } finally { await f.db.close(); }
});
test("unavailable encrypted storage stops intake before any ordinary persistence and returns no source material", async () => {
  const f = await fixture();
  try {
    f.ctx.secrets.store = async () => { throw new Error(message.body); };
    await assert.rejects(storeMessage(f.ctx, message, connection), error => error instanceof Error && !error.message.includes("synthetic-test-value"));
    assert.equal((await f.db.query(`SELECT * FROM ${f.namespace}.support_cases`)).rows.length, 0);
  } finally { await f.db.close(); }
});

test("legacy migration protects only the current pinned company route and keeps original access information recoverable", async () => {
  const f = await fixture();
  try {
    const opened = await storeMessage(f.ctx, message, connection);
    await f.db.query(`UPDATE ${f.namespace}.support_messages SET body=$1,source_protection_version=0,protected_source_ref=NULL`, [message.body]);
    assert.equal((await protectLegacySources(f.ctx, { connections: [{ ...connection, routes: [] }] })).migrated, 0);
    assert.equal((await protectLegacySources(f.ctx, { connections: [connection] })).migrated, 1);
    assert.equal((await protectLegacySources(f.ctx, { connections: [connection] })).migrated, 0);
    const rows = (await f.db.query<{ id: string; body: string }>(`SELECT id,body FROM ${f.namespace}.support_messages`)).rows;
    assert.ok(!rows[0]!.body.includes("synthetic-test-value"));
    assert.equal((await readProtectedSource(f.ctx, { companyId, caseId: opened.caseId, messageId: rows[0]!.id, userId: "operator" })).body, message.body);
  } finally { await f.db.close(); }
});
