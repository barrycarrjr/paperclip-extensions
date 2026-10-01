import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { prepareRestart, executeRestart, restartStatus, reconcileRestart, postRestart } from "./restarts.js";
import type { NetworkConfig } from "./network.js";
const companyId="11111111-1111-4111-8111-111111111111",siteId="22222222-2222-4222-8222-222222222222",deviceId="33333333-3333-4333-8333-333333333333";
const initial:NetworkConfig={allowDeviceRestarts:true,accounts:[{key:"example",baseUrl:"https://controller.example.com/integration",apiKeyRef:"44444444-4444-4444-8444-444444444444",allowedCompanies:[companyId],sites:[{companyId,siteIds:[siteId]}]}]};
const run={companyId,userId:"operator",chatSessionId:"chat",userPermission:"support:repair",userConfirmed:true} as ToolRunContext;
async function fixture(){
  const db=new PGlite(),namespace="plugin_unifi_tools_206a16fd6c";await db.exec(`CREATE SCHEMA ${namespace}`);await db.exec(await readFile(new URL("../migrations/001_restart_actions.sql",import.meta.url),"utf8"));
  let cfg=initial,uptime=2000,configurationId="example-configuration",posts=0;
  let mode: "accepted" | "not_sent" | "unknown" = "accepted";
  const ctx={db:{namespace,query:async(sql:string,params:unknown[])=>(await db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await db.query(sql,params)).affectedRows})},config:{get:async()=>cfg},activity:{log:async()=>{}}} as unknown as PluginContext;
  const api=async(_ctx:PluginContext,_account:unknown,path:string)=>path.endsWith("/statistics/latest")?{uptimeSec:uptime,lastHeartbeatAt:new Date(Date.now()+1).toISOString()}:{id:deviceId,state:"ONLINE",name:"Example AP",model:"Example model",configurationId,firmwareVersion:"Example firmware",supported:true};
  const send=async()=>{posts++;if(mode==="unknown")throw new Error("Synthetic lost response after acceptance");return mode;};
  return{db,ctx,api,send,posts:()=>posts,setMode:(value:typeof mode)=>{mode=value;},setUptime:(value:number)=>{uptime=value;},setConfiguration:(value:string)=>{configurationId=value;},setConfig:(value:NetworkConfig)=>{cfg=value;}};
}
function confirmed(prepared:Awaited<ReturnType<typeof prepareRestart>>){return{actionId:prepared.actionId,planSha256:prepared.planSha256,confirmedPlan:prepared.plan,managementRecoveryConfirmed:true};}
test("restart consent binds company/person/conversation, full displayed plan, configuration and a one-shot receipt",async()=>{
  const f=await fixture();try{
    const plan=await prepareRestart(f.ctx,run,{account:"example",siteId,deviceId},f.api),input=confirmed(plan);
    await assert.rejects(executeRestart(f.ctx,{...run,userConfirmed:false},input,f.api,f.send));
    await assert.rejects(executeRestart(f.ctx,{...run,chatSessionId:"other"},input,f.api,f.send));
    await assert.rejects(executeRestart(f.ctx,run,{...input,confirmedPlan:{...plan.plan,deviceName:"Different device"}},f.api,f.send));
    await assert.rejects(executeRestart(f.ctx,run,{...input,managementRecoveryConfirmed:false},f.api,f.send));
    await Promise.all([executeRestart(f.ctx,run,input,f.api,f.send),executeRestart(f.ctx,run,input,f.api,f.send)]);
    assert.equal(f.posts(),1);await executeRestart(f.ctx,run,input,f.api,f.send);assert.equal(f.posts(),1);
    const diagnostic={...run,userPermission:"support:diagnose"} as ToolRunContext;
    assert.equal((await restartStatus(f.ctx,diagnostic,{actionId:plan.actionId},f.api)).status,"accepted");
    f.setUptime(1);
    assert.equal((await restartStatus(f.ctx,diagnostic,{actionId:plan.actionId},f.api)).status,"verified");
    assert.equal(f.posts(),1);

  }finally{await f.db.close();}
});
test("unknown restart blocks a second plan, revocation/device changes prevent writes and inspection never invents recovery",async()=>{
  const f=await fixture();try{
    const plan=await prepareRestart(f.ctx,run,{account:"example",siteId,deviceId},f.api),second=await prepareRestart(f.ctx,run,{account:"example",siteId,deviceId},f.api);
    f.setConfiguration("changed");await assert.rejects(executeRestart(f.ctx,run,confirmed(plan),f.api,f.send),/changed/);assert.equal(f.posts(),0);f.setConfiguration("example-configuration");
    f.setConfig({...initial,allowDeviceRestarts:false});await assert.rejects(executeRestart(f.ctx,run,confirmed(plan),f.api,f.send),/disabled/);f.setConfig(initial);
    f.setMode("unknown");assert.equal((await executeRestart(f.ctx,run,confirmed(plan),f.api,f.send)).status,"unknown");
    await assert.rejects(executeRestart(f.ctx,run,confirmed(second),f.api,f.send),/unsettled/);assert.equal(f.posts(),1);
    const diagnostic={...run,userPermission:"support:diagnose"} as ToolRunContext;
    const status=await restartStatus(f.ctx,diagnostic,{actionId:plan.actionId},async()=>{throw new Error("Synthetic controller down");});assert.equal(status.status,"unknown");assert.equal((status.verification as {status:string}).status,"unavailable");
    f.setUptime(1);assert.equal((await restartStatus(f.ctx,diagnostic,{actionId:plan.actionId},f.api)).status,"unknown");
    assert.equal(f.posts(),1);
    const reconciliation={...confirmed(plan),inspectionReference:"Example controller event inspection",acknowledgeUncertainDelivery:true};
    await assert.rejects(reconcileRestart(f.ctx,{...run,userConfirmed:false},reconciliation,f.api));
    await assert.rejects(reconcileRestart(f.ctx,run,reconciliation,f.api),/two minutes/);
    await f.db.query(`UPDATE plugin_unifi_tools_206a16fd6c.restart_actions SET started_at=now()-interval '3 minutes' WHERE id=$1`,[plan.actionId]);
    await assert.rejects(reconcileRestart(f.ctx,run,reconciliation,async()=>{throw new Error("Synthetic unavailable inspection");}));
    f.setUptime(100);
    assert.equal((await reconcileRestart(f.ctx,run,reconciliation,f.api)).status,"acknowledged");
    assert.equal(f.posts(),1);
    f.setUptime(2000);f.setMode("accepted");
    await executeRestart(f.ctx,run,confirmed(second),f.api,f.send);assert.equal(f.posts(),2);
  }finally{await f.db.close();}
});


test("restart HTTP acceptance, definite refusal and uncertain responses never cause a retry",async()=>{
  for(const [status,expected] of [[200,"accepted"],[403,"not_sent"],[302,"unknown"],[503,"unknown"]] as const){
    let calls=0;
    const ctx={secrets:{resolve:async()=>"synthetic-example-key"},http:{fetch:async(url:string,options:RequestInit)=>{calls++;assert.equal(url,`https://controller.example.com/integration/v1/sites/${siteId}/devices/${deviceId}/actions`);assert.equal(options.redirect,"manual");assert.equal(options.method,"POST");assert.deepEqual(JSON.parse(options.body as string),{action:"RESTART"});return new Response(null,{status});}}} as unknown as PluginContext;
    assert.equal(await postRestart(ctx,initial.accounts![0]!,siteId,deviceId),expected);assert.equal(calls,1);
  }
});
