import assert from "node:assert/strict";
import test from "node:test";
import { readFile,readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import { storeMessage } from "./worker.js";
import { dispatchTickets,authorizedTicket,getTicket,diagnoseTicket,readTicketJob,recordTicketRunEnd,resumeTicket } from "./ticket-investigation.js";
import { reportTicket,sendTicketReply } from "./ticket-replies.js";
import { reconcilePendingDeliveries } from "./support-outbound.js";
import { withRemoteSlot } from "./remote-task-queue.js";
import type { Config,IncomingMessage } from "./routing.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "77777777-7777-4777-8777-777777777777";
const run: ToolRunContext = { companyId,agentId,runId: "88888888-8888-4888-8888-888888888888" };
const baseConfig: Config = { connections: [{ id: "example",source: "slack",externalAccountId: "TEXAMPLE01",ingestAgentId: agentId,
  botTokenRef: "33333333-3333-4333-8333-333333333333",allowedCompanies: [companyId],routes: [{ externalRouteId: "CEXAMPLE01:alpha",companyId }] }],
  remoteAccessProfiles: [{ id: "example",companyId,credentialUser: "EXAMPLE\\support",passwordRef: "33333333-3333-4333-8333-333333333333",
    scopes: [{ kind: "dns_suffix",value: "example.local",transport: "Wmi" }] }],
  ticketPolicies: [{ companyId,agentId,enabled: true,diagnostics: ["inventory","health","printers"],allowThreadUpdates: true }] };
const message: IncomingMessage = { companyId,connectionId: "example",externalAccountId: "TEXAMPLE01",externalRouteId: "CEXAMPLE01:alpha",
  externalConversationId: "1700000000.000100",externalMessageId: "1700000000.000100",title: "Computer issue",body: "PC01 is slow\nPassword: synthetic-source-value",authorKind: "staff",occurredAt: "2026-09-30T12:00:00Z" };
async function fixture() {
  const db = new PGlite(); await db.exec(`CREATE SCHEMA ${namespace}`);
  for (const name of (await readdir(new URL("../migrations/",import.meta.url))).filter(n => n.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),"utf8"));
  let cfg = structuredClone(baseConfig); const issues = new Map<string,any>(); const wakeups = new Map<string,string>();
  const activity: unknown[] = []; const posts: unknown[] = []; let owns = true; let failSend = false; let onAuth: (() => void) | null = null;
  const ctx = { db: { namespace,query: async (sql: string,params?: unknown[]) => { assert.match(sql.trim(),/^SELECT\b/i); return (await db.query(sql,params)).rows; },
    execute: async (sql: string,params?: unknown[]) => { assert.match(sql.trim(),/^(INSERT|UPDATE|DELETE)\b/i); return { rowCount: (await db.query(sql,params)).affectedRows }; } },
    config: { get: async () => cfg },activity: { log: async (value: unknown) => activity.push(value) },
    secrets: { store: async () => ({ secretRef: "44444444-4444-4444-8444-444444444444" }),resolve: async () => "synthetic-test-token" },
    agents: { get: async (id: string,company: string) => id === agentId && company === companyId ? { id,companyId,status: "idle" } : null },
    issues: {
      create: async (input: any) => { const issue = { ...input,id: randomUUID() }; issues.set(issue.id,issue); return issue; },
      list: async (input: any) => [...issues.values()].filter(issue => issue.companyId === input.companyId && issue.originKind === input.originKind && issue.originId === input.originId),
      get: async (id: string,company: string) => issues.get(id)?.companyId === company ? issues.get(id) : null,
      assertCheckoutOwner: async (input: any) => { if (!owns || input.actorAgentId !== agentId || input.actorRunId !== run.runId || input.companyId !== companyId) throw new Error("Checkout denied"); },
      requestWakeup: async (_issue: string,_company: string,input: any) => {
        const existing = wakeups.get(input.idempotencyKey); if (existing) return { queued: false,runId: existing };
        const id = randomUUID(); wakeups.set(input.idempotencyKey,id); return { queued: true,runId: id };
      },
    },
    http: { fetch: async (url: string,init?: RequestInit) => {
      if (url.includes("auth.test")) { onAuth?.(); return Response.json({ ok: true,team_id: "TEXAMPLE01" }); }
      if (url.endsWith("chat.postMessage")) { posts.push(JSON.parse(init!.body as string)); if (failSend) throw new Error("Lost response"); return Response.json({ ok: true,channel: "CEXAMPLE01",ts: "1700000001.000200" }); }
      throw new Error("Unexpected HTTP request");
    } },events: { emit: async () => { throw new Error("Policy updates cannot use the human connector bridge"); } },
  } as unknown as PluginContext;
  const opened = await storeMessage(ctx,message,cfg.connections![0]!);
  return { db,ctx,caseId: opened.caseId,getConfig: async () => cfg,setConfig: (next: Config) => { cfg = next; },config: () => cfg,
    issues,wakeups,activity,posts,setOwns: (value: boolean) => { owns = value; },setFailSend: () => { failSend = true; },onAuth: (callback: () => void) => { onAuth = callback; } };
}
test("policy-enabled intake creates durable investigation work once, preserves sanitized evidence and does not authorize a repair",async () => {
  const f = await fixture();
  try {
    await Promise.all([dispatchTickets(f.ctx,f.getConfig),dispatchTickets(f.ctx,f.getConfig)]);
    assert.equal(f.issues.size,1); assert.equal(f.wakeups.size,1);
    await storeMessage(f.ctx,message,f.config().connections![0]!); await dispatchTickets(f.ctx,f.getConfig);
    assert.equal(f.wakeups.size,1);
    const ticket = await getTicket(f.ctx,f.config(),run,{ caseId: f.caseId });
    assert.ok(!JSON.stringify(ticket).includes("synthetic-source-value"));
    assert.ok(!JSON.stringify([...f.issues.values()]).includes("synthetic-source-value"));
    assert.equal(ticket.actions.length,0); assert.equal(f.posts.length,0);
    assert.equal((await f.db.query(`SELECT * FROM ${namespace}.support_actions`)).rows.length,0);
  } finally { await f.db.close(); }
});
test("current policy, company, assigned agent and issue checkout are enforced independently of spoofed human consent",async () => {
  const f = await fixture();
  try {
    await dispatchTickets(f.ctx,f.getConfig);
    await assert.rejects(authorizedTicket(f.ctx,f.config(),{ ...run,companyId: otherCompanyId },f.caseId));
    await assert.rejects(authorizedTicket(f.ctx,f.config(),{ ...run,agentId: randomUUID(),userConfirmed: true },f.caseId));
    await assert.rejects(authorizedTicket(f.ctx,f.config(),{ ...run,userId: "operator",chatSessionId: "chat",userPermission: "support:repair" },f.caseId));
    f.setOwns(false); await assert.rejects(authorizedTicket(f.ctx,f.config(),run,f.caseId)); f.setOwns(true);
    f.setConfig({ ...f.config(),ticketPolicies: [{ ...f.config().ticketPolicies![0]!,enabled: false }] });
    await assert.rejects(authorizedTicket(f.ctx,f.config(),run,f.caseId));
    assert.equal(f.posts.length,0);
  } finally { await f.db.close(); }
});
test("only catalog diagnostics in saved company access execute and results stay bound to the ticket",async () => {
  const f = await fixture(); let calls = 0;
  try {
    await dispatchTickets(f.ctx,f.getConfig);
    const runner = async () => { calls++; return { runId: "check",status: "succeeded",exitCode: 0,output: JSON.stringify({ printers: [],spooler: { status: "Running" } }) }; };
    await assert.rejects(diagnoseTicket(f.ctx,f.getConfig,run,{ caseId: f.caseId,target: "pc01",check: "services" },runner));
    await assert.rejects(diagnoseTicket(f.ctx,f.getConfig,run,{ caseId: f.caseId,target: "outside.other.local",check: "printers" },runner));
    await assert.rejects(diagnoseTicket(f.ctx,f.getConfig,run,{ caseId: f.caseId,target: "pc01",check: "printers",options: { command: "arbitrary" } },runner));
    const result = await diagnoseTicket(f.ctx,f.getConfig,run,{ caseId: f.caseId,target: "pc01",check: "printers" },runner);
    assert.equal(result.target,"pc01.example.local"); assert.equal(calls,1);
    await assert.rejects(diagnoseTicket(f.ctx,f.getConfig,run,{ caseId: f.caseId,target: "pc02",check: "printers" },runner));
    assert.equal((await f.db.query(`SELECT * FROM ${namespace}.support_diagnostics`)).rows.length,1);
    assert.equal((await f.db.query(`SELECT * FROM ${namespace}.support_actions`)).rows.length,0);
  } finally { await f.db.close(); }
});
test("policy revocation while waiting for a computer prevents the diagnostic from starting",async () => {
  const f = await fixture(); let calls = 0; let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  try {
    await dispatchTickets(f.ctx,f.getConfig);
    const held = withRemoteSlot("pc01.example.local",async () => { await gate; });
    const task = diagnoseTicket(f.ctx,f.getConfig,run,{ caseId: f.caseId,target: "pc01",check: "printers" },async () => { calls++; return { runId: "bad",status: "succeeded",exitCode: 0,output: "{}" }; });
    const rejected = assert.rejects(task);
    for (let i=0;i<100;i++) { if ((await readTicketJob(f.ctx,companyId,f.caseId)).target_address) break; await new Promise(done => setTimeout(done,5)); }
    f.setConfig({ ...f.config(),ticketPolicies: [] }); release(); await held; await rejected; assert.equal(calls,0);
  } finally { release?.(); await f.db.close(); }
});
test("clarifications post only to the pinned thread, human replies resume work and bot replies do not create a feedback loop",async () => {
  const f = await fixture();
  try {
    await dispatchTickets(f.ctx,f.getConfig);
    const report = await reportTicket(f.ctx,f.getConfig,run,{ caseId: f.caseId,body: "What computer is affected, and when did the slowdown begin?",status: "waiting_requester" });
    assert.equal(report.status,"sent"); assert.equal(f.posts.length,1);
    assert.equal((f.posts[0] as any).thread_ts,message.externalConversationId);
    await storeMessage(f.ctx,{ ...message,authorKind: "bot",externalMessageId: "1700000002.000100",body: "Bot update",occurredAt: "2026-09-30T12:01:00Z" },f.config().connections![0]!);
    assert.equal((await readTicketJob(f.ctx,companyId,f.caseId)).status,"waiting_requester");
    await storeMessage(f.ctx,{ ...message,externalMessageId: "1700000003.000100",body: "The affected computer is PC01",occurredAt: "2026-09-30T12:02:00Z" },f.config().connections![0]!);
    await dispatchTickets(f.ctx,f.getConfig);
    assert.equal(f.issues.size,1); assert.equal(f.wakeups.size,2);
  } finally { await f.db.close(); }
});
test("lost automatic Slack receipts never replay through the agent or human connector reconciliation",async () => {
  const f = await fixture();
  try {
    await dispatchTickets(f.ctx,f.getConfig); f.setFailSend();
    const input = { companyId,caseId: f.caseId,actorAgentId: agentId,body: "Investigation found an unavailable diagnostic; an operator will review it." };
    assert.equal((await sendTicketReply(f.ctx,f.getConfig,input)).status,"unknown");
    assert.equal((await sendTicketReply(f.ctx,f.getConfig,input)).status,"unknown");
    await reconcilePendingDeliveries(f.ctx); assert.equal(f.posts.length,1);
    const [row] = (await f.db.query<any>(`SELECT * FROM ${namespace}.support_outbound`)).rows;
    assert.equal(row.approved_by_user_id,null); assert.equal(row.policy_authorization.agentId,agentId);
  } finally { await f.db.close(); }
});
test("thread-update permission and changes during preflight prevent posting, and access information is rejected",async () => {
  const f = await fixture();
  try {
    await dispatchTickets(f.ctx,f.getConfig);
    const input = { companyId,caseId: f.caseId,actorAgentId: agentId,body: "Checking the computer." };
    await assert.rejects(sendTicketReply(f.ctx,f.getConfig,{ ...input,body: "Password: synthetic-test-value" }));
    f.onAuth(() => f.setConfig({ ...f.config(),ticketPolicies: [{ ...f.config().ticketPolicies![0]!,allowThreadUpdates: false }] }));
    await assert.rejects(sendTicketReply(f.ctx,f.getConfig,input)); assert.equal(f.posts.length,0);
  } finally { await f.db.close(); }
});

test("interrupted or incomplete runs require operator review and an explicit resume gets a new wake generation",async () => {
  const f = await fixture();
  try {
    await dispatchTickets(f.ctx,f.getConfig);
    const [job] = (await f.db.query<any>(`SELECT * FROM ${namespace}.support_ticket_jobs`)).rows;
    await recordTicketRunEnd(f.ctx,{ companyId: otherCompanyId,eventType: "agent.run.failed",entityId: job.run_id,payload: {} } as any);
    assert.equal((await readTicketJob(f.ctx,companyId,f.caseId)).status,"investigating");
    await recordTicketRunEnd(f.ctx,{ companyId,eventType: "agent.run.failed",entityId: job.run_id,payload: { error: "synthetic private failure" } } as any);
    assert.equal((await readTicketJob(f.ctx,companyId,f.caseId)).status,"needs_operator");
    await dispatchTickets(f.ctx,f.getConfig); assert.equal(f.wakeups.size,1);
    await assert.rejects(resumeTicket(f.ctx,f.config(),{ companyId,caseId: f.caseId,userId: "" }));
    await resumeTicket(f.ctx,f.config(),{ companyId,caseId: f.caseId,userId: "operator" });
    await dispatchTickets(f.ctx,f.getConfig); assert.equal(f.wakeups.size,2);
    assert.ok(!JSON.stringify(f.activity).includes("synthetic private failure"));
  } finally { await f.db.close(); }
});
