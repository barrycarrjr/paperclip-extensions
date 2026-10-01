import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import type { InstanceConfig,ResolvedAccount } from "./helpScoutClient.js";
import { prepareSupportAction,runSupportAction,supportActionStatus,acknowledgeSupportAction,sendSupportAction } from "./reviewed-support.js";
const companyId="11111111-1111-4111-8111-111111111111";
const initial:InstanceConfig={allowMutations:true,accounts:[{key:"example",clientIdRef:"example-app-id",clientSecretRef:"example-app-secret",allowedCompanies:[companyId],supportReadEnabled:true,supportActionsEnabled:true,supportMailboxes:[{companyId,mailboxIds:["10"]}],supportBrands:[{companyId,mailboxId:"10",name:"Example brand",replyEmail:"support@example.com",signature:"Example support team"}]}]};
const run={companyId,userId:"operator",chatSessionId:"chat",userPermission:"support:respond",userConfirmed:true} as ToolRunContext;
async function fixture(){
 const db=new PGlite(),namespace="plugin_help_scout_dcee45a1d3";await db.exec(`CREATE SCHEMA ${namespace}`);await db.exec(await readFile(new URL("../migrations/002_reviewed_support_actions.sql",import.meta.url),"utf8"));
 let cfg=structuredClone(initial),modifiedAt="2026-01-01T00:00:00Z",mailboxId=10,calls=0,mode="accepted";
 const ctx={config:{get:async()=>cfg},db:{namespace,query:async(sql:string,params:unknown[])=>(await db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await db.query(sql,params)).affectedRows})},activity:{log:async()=>{}}} as unknown as PluginContext;
 const resolve=async()=>({account:cfg.accounts![0]!,accountKey:"example",apiKey:"synthetic-example-key"}) as ResolvedAccount;
 const read=async(_ctx:PluginContext,_account:ResolvedAccount,path:string):Promise<Record<string,unknown>>=>path.startsWith("/mailboxes/")?{id:10,name:"Example inbox",email:"support@example.com"}:path.startsWith("/users/")?{id:30,type:"team",name:"Example team"}:path.endsWith("/threads")?{_embedded:{threads:[{id:99,type:"message",state:"published"}]}}:{id:20,mailboxId,modifiedAt,status:"active",primaryCustomer:{id:40,email:"customer@example.com"},assignee:{id:50,type:"user"},tags:[{tag:"existing"}]};
 const send=async()=>{calls++;if(mode==="unknown")throw new Error("Synthetic lost response");return{status:mode,reference:"99"};};
 return{db,ctx,read,resolve,send,calls:()=>calls,setModified:()=>{modifiedAt="2026-01-02T00:00:00Z";},setMailbox:()=>{mailboxId=11;},setConfig:(v:InstanceConfig)=>{cfg=v;},uncertain:()=>{mode="unknown";}};
}
const confirm=(p:Awaited<ReturnType<typeof prepareSupportAction>>)=>({actionId:p.actionId,planSha256:p.planSha256,confirmedPlan:p.plan});
test("brand reply consent binds the exact sender, recipient, signature, actor and live conversation; journal sends once",async()=>{
 const f=await fixture();try{
  const plan=await prepareSupportAction(f.ctx,run,{kind:"reply",account:"example",conversationId:"20",body:"Example answer"},f.read,f.resolve);
  assert.equal((plan.plan.change as {text:string}).text,"Example answer\n\nExample support team");
  await assert.rejects(runSupportAction(f.ctx,{...run,userConfirmed:false},confirm(plan),"reply",f.read,f.resolve,f.send));
  await assert.rejects(runSupportAction(f.ctx,{...run,chatSessionId:"other"},confirm(plan),"reply",f.read,f.resolve,f.send));
  await assert.rejects(runSupportAction(f.ctx,run,{...confirm(plan),confirmedPlan:{...plan.plan,mailboxId:"11"}},"reply",f.read,f.resolve,f.send));
  await Promise.all([runSupportAction(f.ctx,run,confirm(plan),"reply",f.read,f.resolve,f.send),runSupportAction(f.ctx,run,confirm(plan),"reply",f.read,f.resolve,f.send)]);assert.equal(f.calls(),1);
  await runSupportAction(f.ctx,run,confirm(plan),"reply",f.read,f.resolve,f.send);assert.equal(f.calls(),1);
  const result=await supportActionStatus(f.ctx,{...run,userPermission:"support:diagnose"},{actionId:plan.actionId},f.read,f.resolve);assert.equal((result.verification as {expectedStateObserved:boolean}).expectedStateObserved,true);assert.equal(result.status,"accepted");
  await assert.rejects(prepareSupportAction(f.ctx,{...run,companyId:"22222222-2222-4222-8222-222222222222"},{kind:"reply",account:"example",conversationId:"20",body:"Example"},f.read,f.resolve));
 }finally{await f.db.close();}
});
test("tag union, assignee identity, access revocation and changed mailbox/conversation fail closed",async()=>{
 const f=await fixture(),repair={...run,userPermission:"support:repair"} as ToolRunContext;try{
  const tagPlan=await prepareSupportAction(f.ctx,repair,{kind:"tags",account:"example",conversationId:"20",addTags:["new"]},f.read,f.resolve);assert.deepEqual(tagPlan.plan.change,{before:["existing"],after:["existing","new"]});
  await assert.rejects(prepareSupportAction(f.ctx,repair,{kind:"assign",account:"example",conversationId:"20",assigneeId:"30",assigneeType:"user"},f.read,f.resolve));
  const owner=await prepareSupportAction(f.ctx,repair,{kind:"assign",account:"example",conversationId:"20",assigneeId:"30",assigneeType:"team"},f.read,f.resolve);assert.equal((owner.plan.change as {assigneeName:string}).assigneeName,"Example team");
  f.setConfig({...initial,allowMutations:false});await assert.rejects(runSupportAction(f.ctx,repair,confirm(tagPlan),"change",f.read,f.resolve,f.send));f.setConfig(initial);
  f.setModified();await assert.rejects(runSupportAction(f.ctx,repair,confirm(tagPlan),"change",f.read,f.resolve,f.send),/changed/);assert.equal(f.calls(),0);
  f.setMailbox();await assert.rejects(prepareSupportAction(f.ctx,repair,{kind:"tags",account:"example",conversationId:"20",addTags:["new"]},f.read,f.resolve));
 }finally{await f.db.close();}
});
test("uncertain actions block another write and can only be explicitly acknowledged after provider inspection",async()=>{
 const f=await fixture();try{
  const p=await prepareSupportAction(f.ctx,run,{kind:"reply",account:"example",conversationId:"20",body:"Example"},f.read,f.resolve),second=await prepareSupportAction(f.ctx,run,{kind:"reply",account:"example",conversationId:"20",body:"Another example"},f.read,f.resolve);
  f.uncertain();assert.equal((await runSupportAction(f.ctx,run,confirm(p),"reply",f.read,f.resolve,f.send)).status,"unknown");
  await assert.rejects(runSupportAction(f.ctx,run,confirm(second),"reply",f.read,f.resolve,f.send),/uncertain/);assert.equal(f.calls(),1);
  const ack={...confirm(p),inspectionReference:"Example provider log inspection",acknowledgeUncertainDelivery:true};
  await assert.rejects(acknowledgeSupportAction(f.ctx,run,ack,f.read,f.resolve),/two minutes/);
  await f.db.query(`UPDATE plugin_help_scout_dcee45a1d3.reviewed_support_actions SET started_at=now()-interval '3 minutes' WHERE id=$1`,[p.actionId]);
  await assert.rejects(acknowledgeSupportAction(f.ctx,{...run,userConfirmed:false},ack,f.read,f.resolve));
  assert.equal((await acknowledgeSupportAction(f.ctx,run,ack,f.read,f.resolve)).status,"acknowledged");assert.equal(f.calls(),1);
 }finally{await f.db.close();}
});
test("actual reply request uses the exact customer, no extra recipients and Resource-ID acceptance without retries",async()=>{
 let calls=0;const ctx={http:{fetch:async(url:string,options:RequestInit)=>{calls++;assert.equal(url,"https://api.helpscout.net/v2/conversations/20/reply");assert.equal(options.redirect,"manual");assert.deepEqual(JSON.parse(options.body as string),{customer:{id:40},text:"Example text",draft:false});return new Response(null,{status:201,headers:{"Resource-ID":"99"}});}}} as unknown as PluginContext;
 assert.deepEqual(await sendSupportAction(ctx,{apiKey:"synthetic-example-key"} as ResolvedAccount,{kind:"reply",conversationId:"20",change:{recipientId:"40",text:"Example text"}}),{status:"accepted",reference:"99"});assert.equal(calls,1);
});
