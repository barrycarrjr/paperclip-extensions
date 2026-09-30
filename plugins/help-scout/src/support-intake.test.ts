import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { InstanceConfig,ResolvedAccount } from "./helpScoutClient.js";
import { intakeEndpoint,selectIntakeRoute,pollSupportIntake,type IntakeRoute } from "./support-intake.js";
import { storeMessage } from "../../customer-support/src/worker.js";
import { parseMessage,resolveConnection,type Config } from "../../customer-support/src/routing.js";
const companyId="11111111-1111-4111-8111-111111111111",agentRef="22222222-2222-4222-8222-222222222222";
const route:IntakeRoute={key:"example",companyId,mailboxId:"10",connectionId:"example",externalAccountId:"example-account",paperclipBaseUrl:"https://paperclip.example.com",apiKeyRef:agentRef,startAt:new Date(Date.now()-3600000).toISOString(),enabled:true};
const initial:InstanceConfig={accounts:[{key:"example",allowedCompanies:[companyId],supportReadEnabled:true,supportMailboxes:[{companyId,mailboxIds:["10"]}],supportIntakeRoutes:[route]}]};
async function fixture(){
 const db=new PGlite(),namespace="plugin_help_scout_dcee45a1d3";await db.exec(`CREATE SCHEMA ${namespace}`);await db.exec(await readFile(new URL("../migrations/003_support_intake.sql",import.meta.url),"utf8"));
 let cfg=structuredClone(initial),mailbox=10,body="Example password=synthetic-test-value",loseResponse=false,partial=false,readRevokes=false,conversations=[20],scanQueries:string[]=[];
 const createdAt=new Date(Date.now()-600000).toISOString(),modifiedAt=new Date(Date.now()-60000).toISOString();
 const secrets=new Map<string,string>(),received=new Map<string,Record<string,unknown>>(),attempts:string[]=[];
 const ctx={config:{get:async()=>cfg},db:{namespace,query:async(sql:string,params:unknown[])=>(await db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await db.query(sql,params)).affectedRows})},secrets:{store:async(_company:string,_key:string,value:string)=>{const ref=randomUUID();secrets.set(ref,value);return{secretRef:ref};},resolve:async(ref:string,company?:string)=>{if(ref===agentRef)return"synthetic-intake-agent-key";assert.equal(company,companyId);assert.ok(secrets.has(ref));return secrets.get(ref)!;}},activity:{log:async(input:unknown)=>{assert.ok(!JSON.stringify(input).includes(body));}},http:{fetch:async(url:string,options:RequestInit)=>{assert.equal(url,"https://paperclip.example.com/api/plugins/customer-support/api/messages");assert.equal(options.redirect,"manual");assert.equal(options.method,"POST");const message=JSON.parse(options.body as string) as Record<string,unknown>,key=`${message.externalConversationId}:${message.externalMessageId}`,created=!received.has(key);received.set(key,message);attempts.push(key);if(loseResponse){loseResponse=false;throw new Error("Synthetic lost receipt after case storage");}return Response.json({caseId:"33333333-3333-4333-8333-333333333333",created},{status:created?201:200});}}} as unknown as PluginContext;
 const resolve=async()=>({account:cfg.accounts![0]!,accountKey:"example",apiKey:"synthetic-provider-key"}) as ResolvedAccount;
 const read=async(_ctx:PluginContext,_account:ResolvedAccount,path:string):Promise<Record<string,unknown>>=>{
   if(readRevokes)cfg={};
   if(path.startsWith("/conversations?")){const query=new URLSearchParams(path.split("?")[1]),expression=query.get("query")!;scanQueries.push(expression);assert.equal(query.get("page"),"1");assert.equal(query.get("status"),"all");const remaining=conversations.filter(value=>!expression.includes(`id:${value}`)),ids=remaining.slice(0,partial?1:100);return{_embedded:{conversations:ids.map(value=>({id:value,mailboxId:10,modifiedAt}))},page:{totalPages:partial&&remaining.length>1?2:1}};}
   if(path.includes("/threads"))return{_embedded:{threads:[{id:40,type:"customer",state:"published",body,createdAt,createdBy:{id:50,type:"customer"},_embedded:{attachments:[{id:60,filename:"example.pdf",mimeType:"application/pdf",state:"valid"}]}},{id:41,type:"message",state:"draft",body:"Never import this draft"}]},page:{totalPages:1}};
   return{id:Number(path.split("/")[2]),mailboxId:mailbox,subject:"Example request"};
 };
 return{db,ctx,read,resolve,secrets,received,attempts,scanQueries,edit:()=>{body="Example updated report";},lose:()=>{loseResponse=true;},move:()=>{mailbox=11;},revoke:()=>{readRevokes=true;},many:()=>{conversations=[20,21,22,23];partial=true;}};
}
test("native intake encrypts originals, deduplicates unchanged threads and retains provider edits as revisions",async()=>{
 const f=await fixture();try{
  const result=await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve);assert.equal(result.status,"complete");assert.equal(result.newMessages,1);assert.equal(f.received.size,1);
  const stored=JSON.stringify((await f.db.query(`SELECT * FROM plugin_help_scout_dcee45a1d3.support_intake_threads`)).rows);assert.ok(!stored.includes("synthetic-test-value"));assert.ok(!stored.includes("example.pdf"));assert.ok(f.secrets.size>0);
  assert.equal((await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve)).newMessages,0);assert.equal(f.attempts.length,1);
  f.edit();assert.equal((await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve)).newMessages,1);assert.equal(f.received.size,2);assert.match(String([...f.received.values()][1]!.body),/Provider edit revision 2/);
 }finally{await f.db.close();}
});
test("lost intake acknowledgements hold the cursor and replay only the same deduplicable revision",async()=>{
 const f=await fixture();try{
  f.lose();const first=await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve);assert.equal(first.status,"incomplete");assert.equal(first.cursorAdvanced,false);assert.equal(f.received.size,1);
  const second=await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve);assert.equal(second.status,"complete");assert.equal(second.newMessages,0);assert.equal(f.attempts[0],f.attempts[1]);assert.equal(f.received.size,1);
 }finally{await f.db.close();}
});
test("company ownership, moved mailboxes and revocation prevent imports; safe origins cannot redirect credentials",async()=>{
 assert.equal(intakeEndpoint("http://localhost:3100"),"http://localhost:3100/api/plugins/customer-support/api/messages");
 for(const value of ["http://paperclip.example.com","https://user:synthetic-value@example.com/","https://example.com/?key=synthetic-test","https://example.com/nested/"])assert.throws(()=>intakeEndpoint(value));
 assert.throws(()=>selectIntakeRoute(initial,"44444444-4444-4444-8444-444444444444","example","example"));
 const rotated=structuredClone(initial);rotated.accounts![0]!.supportIntakeRoutes![0]!.apiKeyRef="55555555-5555-4555-8555-555555555555";
 assert.equal(selectIntakeRoute(rotated,companyId,"example","example").routeHash,selectIntakeRoute(initial,companyId,"example","example").routeHash);
 assert.notEqual(selectIntakeRoute(rotated,companyId,"example","example").configHash,selectIntakeRoute(initial,companyId,"example","example").configHash);
 const f=await fixture();try{f.move();assert.equal((await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve)).status,"incomplete");assert.equal(f.received.size,0);f.revoke();assert.equal((await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve)).status,"incomplete");assert.equal(f.received.size,0);}finally{await f.db.close();}
});
test("first-page exclusion scanning retains a durable backlog across three-conversation batches without moving the cursor early",async()=>{
 const f=await fixture();try{f.many();const result=await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve);assert.equal(result.status,"pending");assert.equal(result.cursorAdvanced,false);assert.equal(result.pendingConversations,1);assert.equal(f.received.size,3);assert.ok(f.scanQueries[1]!.includes("NOT (id:20)"));const next=await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve);assert.equal(next.status,"complete");assert.equal(f.received.size,4);}finally{await f.db.close();}
});
test("native connector reaches actual Support Desk encrypted storage and does not activate a Slack-only policy",async()=>{
 const f=await fixture(),namespace="plugin_customer_support_0c69412611";
 const cfg:Config={connections:[{id:"example",source:"helpscout",externalAccountId:"example-account",ingestAgentId:"44444444-4444-4444-8444-444444444444",allowedCompanies:[companyId],routes:[{externalRouteId:"10",companyId}]}],ticketPolicies:[{companyId,agentId:"44444444-4444-4444-8444-444444444444",enabled:true,diagnostics:["health"],allowThreadUpdates:false}]};
 const immutable=new Map<string,{secretRef:string;value:string}>();
 try{
  await f.db.exec(`CREATE SCHEMA ${namespace}`);for(const file of (await readdir(new URL("../../customer-support/migrations/",import.meta.url))).filter(n=>n.endsWith(".sql")).sort())await f.db.exec(await readFile(new URL(`../../customer-support/migrations/${file}`,import.meta.url),"utf8"));
  const support={db:{namespace,query:async(sql:string,params:unknown[])=>(await f.db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await f.db.query(sql,params)).affectedRows})},config:{get:async()=>cfg},activity:{log:async()=>{}},secrets:{store:async(company:string,key:string,value:string)=>{assert.equal(company,companyId);const existing=immutable.get(key);if(existing){assert.equal(existing.value,value);return{secretRef:existing.secretRef};}const secretRef=randomUUID();immutable.set(key,{secretRef,value});return{secretRef};}}} as unknown as PluginContext;
  f.ctx.http.fetch=async(_url,options)=>{const message=parseMessage(JSON.parse(options!.body as string));const connection=resolveConnection(cfg,message);const result=await storeMessage(support,message,connection);return Response.json(result,{status:result.created?201:200});};
  const result=await pollSupportIntake(f.ctx,companyId,"example","example",f.read,f.resolve);assert.equal(result.status,"complete");assert.equal(result.newMessages,1);
  const records=(await f.db.query<{body:string;source_protection_version:number}>(`SELECT body,source_protection_version FROM ${namespace}.support_messages`)).rows;assert.equal(records.length,1);assert.ok(!records[0]!.body.includes("synthetic-test-value"));assert.equal(records[0]!.source_protection_version,1);assert.ok([...immutable.values()][0]!.value.includes("synthetic-test-value"));
  assert.equal((await f.db.query(`SELECT * FROM ${namespace}.support_ticket_jobs`)).rows.length,0);
 }finally{await f.db.close();}
});
