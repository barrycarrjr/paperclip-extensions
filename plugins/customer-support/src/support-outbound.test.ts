import assert from "node:assert/strict";
import test from "node:test";
import { readFile,readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext,PluginEvent,ToolRunContext } from "@paperclipai/plugin-sdk";
import { consumeDelivery,deliveryHash,parseDeliveryRequest,selectSupportAccount,type BridgeEvent,type DeliveryRequest } from "../../../lib/support-delivery.js";
import { listOutbound,prepareOutbound,recordDeliveryReceipt,reconcilePendingDeliveries,retryNotSent,sendOutbound } from "./support-outbound.js";
import { handleOutboundTool } from "./outbound-tools.js";
import { pinSourceAccount } from "./source-origin.js";
import type { Config } from "./routing.js";
const namespace = "plugin_customer_support_0c69412611";
const connector = "plugin_slack_tools_92b3e80d25";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const caseId = "44444444-4444-4444-8444-444444444444";
const cfg: Config = { connections: [{ id: "support",source: "slack",externalAccountId: "T123456789",deliveryPluginId: "slack-tools",outboundAccount: "example-workspace",ingestAgentId: "agent",allowedCompanies: [companyId],routes: [{ externalRouteId: "C123456789:Example",companyId }] }],softwareRoutes: [{ id: "product",productName: "Example app",reportingCompanyId: companyId,destinationKind: "email",destination: "support@example.com",outboundAccount: "example-mailbox" }] };
const scope = { companyId,caseId,actorUserId: "operator" };
const run = { companyId,userId: "operator",chatSessionId: "chat",agentId: "",runId: "run",userPermission: "support:respond",userConfirmed: true } as ToolRunContext;
async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA ${namespace}; CREATE SCHEMA ${connector}`);
  for (const name of (await readdir(new URL("../migrations/",import.meta.url))).filter(n => n.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),"utf8"));
  await db.exec(await readFile(new URL("../../slack-tools/migrations/001_support_delivery.sql",import.meta.url),"utf8"));
  await db.query(`INSERT INTO ${namespace}.support_cases(id,company_id,connection_id,source,source_account_id,external_route_id,external_conversation_id,title,first_message_at,last_message_at,review_version,service_domain,work_kind) VALUES($1,$2,'support','slack','T123456789','C123456789:Example','1790000000.123456','Example case',now(),now(),1,'software','bug')`,[caseId,companyId]);
  const emitted: BridgeEvent[] = [];
  const port = (ns: string,actorId: string) => ({ db: { namespace: ns,
    query: async (sql: string,params?: unknown[]) => { assert.match(sql.trim(),/^SELECT\b/i); return (await db.query(sql,params)).rows; },
    execute: async (sql: string,params?: unknown[]) => { assert.match(sql.trim(),/^(INSERT|UPDATE|DELETE)\b/i); return { rowCount: (await db.query(sql,params)).affectedRows }; },
  },events: { emit: async (name: string,company: string,payload: unknown) => { emitted.push({ eventType: `plugin.${actorId}.${name}`,actorType: "plugin",actorId,companyId: company,payload }); } },activity: { log: async () => {} } } as unknown as PluginContext);
  return { db,ctx: port(namespace,"customer-support"),channel: port(connector,"slack-tools"),emitted };
}
const draftInput = { ...scope,kind: "slack_reply",body: "We are investigating the reported issue.",expectedReviewVersion: 1 };
test("both connector policies require enabled sending, unique company account and exact opted-in destination",() => {
  const request = { provider: "slack-tools",account: "example",companyId,destination: { channelId: "C123456789" } } as DeliveryRequest;
  const account = { key: "example",allowedCompanies: [companyId],supportChannels: ["C123456789"],supportRecipients: ["support@example.com"] };
  assert.equal(selectSupportAccount("slack-tools",true,[account],request),account);
  assert.throws(() => selectSupportAccount("slack-tools",false,[account],request));
  assert.throws(() => selectSupportAccount("slack-tools",true,[account,account],request));
  assert.throws(() => selectSupportAccount("slack-tools",true,[account],{ ...request,companyId: otherCompanyId }));
  assert.throws(() => selectSupportAccount("slack-tools",true,[account],{ ...request,destination: { channelId: "C987654321" } }));
  assert.throws(() => selectSupportAccount("slack-tools",true,[{ ...account,supportChannels: [] }],request));
  const email = { ...request,provider: "email-tools" as const,destination: { to: "SUPPORT@example.com" } };
  assert.equal(selectSupportAccount("email-tools",true,[account],email),account);
  assert.throws(() => selectSupportAccount("email-tools",true,[account],{ ...email,destination: { to: "other@example.com" } }));
  assert.throws(() => selectSupportAccount("email-tools",true,[{ ...account,allowedCompanies: [] }],email));
  assert.equal(selectSupportAccount("email-tools",true,[{ ...account,allowedCompanies: ["*"] }],{ ...email,companyId: otherCompanyId }).key,"example");
});
test("immutable scoped draft, permission and exact displayed message confirmation",async () => {
  const { db,ctx,emitted } = await fixture();
  try {
    const draft = await prepareOutbound(ctx,cfg,draftInput);
    assert.equal((await prepareOutbound(ctx,cfg,draftInput)).id,draft.id);
    assert.equal(emitted.length,0);
    assert.equal((await listOutbound(ctx,otherCompanyId,caseId)).length,0);
    await assert.rejects(prepareOutbound(ctx,cfg,{ ...draftInput,companyId: otherCompanyId }));
    await assert.rejects(prepareOutbound(ctx,cfg,{ ...draftInput,body: "password: secret" }));
    const params = { caseId,deliveryId: draft.id,contentSha256: draft.content_sha256,body: draft.body,destination: draft.destination };
    await assert.rejects(handleOutboundTool(ctx,cfg,"support_send_message",params,{ ...run,userConfirmed: false }));
    await assert.rejects(handleOutboundTool(ctx,cfg,"support_send_message",params,{ ...run,userPermission: "support:repair" }));
    await assert.rejects(handleOutboundTool(ctx,cfg,"support_send_message",{ ...params,body: "Substituted content" },run));
    assert.equal(emitted.length,0);
    assert.equal((await handleOutboundTool(ctx,cfg,"support_send_message",params,run) as { status: string }).status,"pending");
    await handleOutboundTool(ctx,cfg,"support_send_message",params,run);
    assert.equal(emitted.length,1);
    await assert.rejects(retryNotSent(ctx,{ ...scope,deliveryId: draft.id }));
  } finally { await db.close(); }
});
test("source account is pinned, review and route changes invalidate saved draft",async () => {
  const { db,ctx } = await fixture();
  try {
    await pinSourceAccount(ctx,companyId,caseId,"T123456789");
    await assert.rejects(pinSourceAccount(ctx,companyId,caseId,"T987654321"));
    await assert.rejects(pinSourceAccount(ctx,otherCompanyId,caseId,"T123456789"));
    const draft = await prepareOutbound(ctx,cfg,draftInput);
    const send = { ...scope,deliveryId: draft.id,contentSha256: draft.content_sha256 };
    await assert.rejects(sendOutbound(ctx,{ ...cfg,connections: [{ ...cfg.connections![0]!,outboundAccount: "another-workspace" }] },send));
    await db.query(`UPDATE ${namespace}.support_cases SET review_version=2 WHERE id=$1`,[caseId]);
    await assert.rejects(sendOutbound(ctx,cfg,send));
    await db.query(`UPDATE ${namespace}.support_cases SET source_account_id=NULL WHERE id=$1`,[caseId]);
    await assert.rejects(prepareOutbound(ctx,cfg,{ ...draftInput,expectedReviewVersion: 2 }));
  } finally { await db.close(); }
});
test("duplicate events and reconciliation repeat only the receipt, including after restart",async () => {
  const { db,ctx,channel,emitted } = await fixture();
  try {
    const draft = await prepareOutbound(ctx,cfg,draftInput);
    await sendOutbound(ctx,cfg,{ ...scope,deliveryId: draft.id,contentSha256: draft.content_sha256 });
    const event = emitted.shift()!;
    let calls = 0;
    const prepare = async () => async () => { calls++; return "C123456789:1790000001.1"; };
    await Promise.all([consumeDelivery(channel,"slack-tools",event,prepare),consumeDelivery(channel,"slack-tools",event,prepare)]);
    for (const receipt of emitted.splice(0)) await recordDeliveryReceipt(ctx,receipt as PluginEvent);
    assert.equal(calls,1);
    assert.equal((await listOutbound(ctx,companyId,caseId))[0]!.status,"sent");
    await consumeDelivery({ ...channel },"slack-tools",event,prepare);
    assert.equal(calls,1);
    await assert.rejects(retryNotSent(ctx,{ ...scope,deliveryId: draft.id }));
  } finally { await db.close(); }
});
test("lost provider response is unknown and cannot be replayed",async () => {
  const { db,ctx,channel,emitted } = await fixture();
  try {
    const draft = await prepareOutbound(ctx,cfg,draftInput);
    await sendOutbound(ctx,cfg,{ ...scope,deliveryId: draft.id,contentSha256: draft.content_sha256 });
    const event = emitted.shift()!;
    let calls = 0;
    const prepare = async () => async () => { calls++; throw new Error("Provider accepted, reply lost"); };
    await consumeDelivery(channel,"slack-tools",event,prepare);
    await recordDeliveryReceipt(ctx,emitted.shift()! as PluginEvent);
    assert.equal((await listOutbound(ctx,companyId,caseId))[0]!.status,"unknown");
    await consumeDelivery(channel,"slack-tools",event,prepare);
    await assert.rejects(retryNotSent(ctx,{ ...scope,deliveryId: draft.id }));
    assert.equal(calls,1);
  } finally { await db.close(); }
});
test("preflight rejection permits one newly confirmed retry draft, expired approval never sends",async () => {
  const { db,ctx,channel,emitted } = await fixture();
  try {
    const draft = await prepareOutbound(ctx,cfg,draftInput);
    await sendOutbound(ctx,cfg,{ ...scope,deliveryId: draft.id,contentSha256: draft.content_sha256 });
    await consumeDelivery(channel,"slack-tools",emitted.shift()!,async () => { throw new Error("Company or channel not allowed"); });
    await recordDeliveryReceipt(ctx,emitted.shift()! as PluginEvent);
    const retry = await retryNotSent(ctx,{ ...scope,deliveryId: draft.id });
    assert.notEqual(retry.id,draft.id);
    assert.equal((await retryNotSent(ctx,{ ...scope,deliveryId: draft.id })).id,retry.id);
    assert.equal(retry.status,"draft");
    await sendOutbound(ctx,cfg,{ ...scope,deliveryId: retry.id,contentSha256: retry.content_sha256 });
    const expired = emitted.shift()!;
    (expired.payload as DeliveryRequest).expiresAt = new Date(0).toISOString();
    let calls = 0;
    await consumeDelivery(channel,"slack-tools",expired,async () => { calls++; return async () => "receipt"; });
    assert.equal(calls,0);
    assert.equal((emitted[0]!.payload as { status: string }).status,"not_sent");
  } finally { await db.close(); }
});
test("missing receipt recovery never sends twice; missing provider becomes unknown",async () => {
  const { db,ctx,channel,emitted } = await fixture();
  try {
    const draft = await prepareOutbound(ctx,cfg,draftInput);
    await sendOutbound(ctx,cfg,{ ...scope,deliveryId: draft.id,contentSha256: draft.content_sha256 });
    let calls = 0;
    const prepare = async () => async () => { calls++; return "receipt"; };
    await consumeDelivery(channel,"slack-tools",emitted.shift()!,prepare);
    emitted.length = 0; // lost emitted receipt
    await reconcilePendingDeliveries(ctx);
    await consumeDelivery(channel,"slack-tools",emitted.shift()!,prepare);
    await recordDeliveryReceipt(ctx,emitted.shift()! as PluginEvent);
    assert.equal(calls,1);
    assert.equal((await listOutbound(ctx,companyId,caseId))[0]!.status,"sent");
    const missing = await prepareOutbound(ctx,cfg,{ ...draftInput,body: "Another reviewed message" });
    await sendOutbound(ctx,cfg,{ ...scope,deliveryId: missing.id,contentSha256: missing.content_sha256 });
    await db.query(`UPDATE ${namespace}.support_outbound SET expires_at=now()-interval '1 minute' WHERE id=$1`,[missing.id]);
    await reconcilePendingDeliveries(ctx);
    assert.equal((await listOutbound(ctx,companyId,caseId)).find(row => row.id === missing.id)!.status,"unknown");
  } finally { await db.close(); }
});
test("vendor destination is configured and request/receipt forgery is rejected",async () => {
  const { db,ctx,emitted } = await fixture();
  try {
    const draft = await prepareOutbound(ctx,cfg,{ ...draftInput,kind: "vendor_email",routeId: "product",subject: "Reviewed incident" });
    assert.equal(draft.destination.to,"support@example.com");
    await sendOutbound(ctx,cfg,{ ...scope,deliveryId: draft.id,contentSha256: draft.content_sha256 });
    const event = emitted.shift()!;
    assert.ok(parseDeliveryRequest(event,"email-tools"));
    for (const altered of [{ ...event,actorId: "other-plugin" },{ ...event,companyId: otherCompanyId },{ ...event,payload: { ...(event.payload as object),body: "Changed content" } }]) assert.equal(parseDeliveryRequest(altered,"email-tools"),null);
    const receipt = { eventId: randomUUID(),occurredAt: new Date().toISOString(),eventType: "plugin.email-tools.support-delivery-receipt",actorType: "plugin",actorId: "email-tools",companyId,payload: { version: 1,companyId,deliveryId: draft.id,contentSha256: draft.content_sha256,status: "sent",code: "accepted",reference: "<receipt@example.com>" } } as PluginEvent;
    await recordDeliveryReceipt(ctx,{ ...receipt,actorId: "slack-tools" });
    await recordDeliveryReceipt(ctx,{ ...receipt,companyId: otherCompanyId });
    assert.equal((await listOutbound(ctx,companyId,caseId))[0]!.status,"pending");
    await recordDeliveryReceipt(ctx,receipt);
    assert.equal((await listOutbound(ctx,companyId,caseId))[0]!.status,"sent");
    const altered = { ...(event.payload as DeliveryRequest),deliveryId: randomUUID(),destination: { to: "other@example.com",subject: "Changed" } };
    assert.notEqual(deliveryHash(altered),draft.content_sha256);
  } finally { await db.close(); }
});
