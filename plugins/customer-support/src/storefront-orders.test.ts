import assert from "node:assert/strict";
import test from "node:test";
import { readFile,readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Config } from "./routing.js";
import { saveDirectory } from "./support-directory.js";
import { inspectStorefrontOrder } from "./storefront-orders.js";
const companyId="11111111-1111-4111-8111-111111111111",otherCompany="22222222-2222-4222-8222-222222222222";
const run={companyId,userId:"operator",chatSessionId:"chat",userPermission:"support:diagnose"} as ToolRunContext;
async function fixture(){
  const db=new PGlite(),namespace="plugin_customer_support_0c69412611";await db.exec(`CREATE SCHEMA ${namespace}`);for(const file of(await readdir(new URL("../migrations/",import.meta.url))).filter(n=>n.endsWith(".sql")).sort())await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),"utf8"));
  const cfg:Config={storefrontOrderAccounts:[{id:"example",allowedCompanies:[companyId],siteOrigin:"https://example.com",keyRef:"33333333-3333-4333-8333-333333333333",secretRef:"44444444-4444-4444-8444-444444444444",enabled:true}]};const audit:any[]=[],requests:any[]=[];let secrets=0,status=200;let value:Record<string,unknown>={id:100,status:"failed",date_created_gmt:"2026-01-01T10:00:00",date_modified_gmt:"2026-01-01T11:00:00",date_paid_gmt:null,payment_method:"example_gateway",billing:{email:"PRIVATE CUSTOMER EMAIL"},shipping:{address_1:"PRIVATE ADDRESS"},order_key:"PRIVATE ORDER KEY",total:"PRIVATE FINANCIAL TOTAL"};let revoke=false;
  const ctx={config:{get:async()=>cfg},db:{namespace,query:async(sql:string,params:unknown[])=>(await db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await db.query(sql,params)).affectedRows})},activity:{log:async(entry:any)=>audit.push(entry)},secrets:{resolve:async()=>{secrets++;return"synthetic-example-value";}},http:{fetch:async(url:string,init:RequestInit)=>{requests.push({url,init});if(revoke)cfg.storefrontOrderAccounts![0]!.enabled=false;return Response.json(value,{status});}}} as unknown as PluginContext;
  const profile=await saveDirectory(ctx,cfg,companyId,"operator",{kind:"storefront",name:"Example shop",details:{website:"https://example.com/shop",adminRules:"Read reported orders only"}});audit.length=0;
  return{db,cfg,ctx,profile,audit,requests,secrets:()=>secrets,setStatus:(code:number)=>{status=code;},setValue:(next:Record<string,unknown>)=>{value=next;},revoke:()=>{revoke=true;},getConfig:async()=>cfg,input:{profileId:profile.id,accountId:"example",orderId:100}};
}
test("reported order reads pin the company storefront/account and omit customer, payment and financial data",async()=>{
  const f=await fixture();try{const result=await inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input);assert.equal(result.status,"failed");assert.equal(result.recordedPaymentAtUtc,null);assert.equal(result.createdAtUtc,"2026-01-01T10:00:00Z");assert.equal(f.requests.length,1);const request=f.requests[0];assert.equal(request.init.method,"GET");assert.equal(request.init.redirect,"manual");assert.equal(new URL(request.url).pathname,"/wp-json/wc/v3/orders/100");assert.equal(new URL(request.url).searchParams.get("consumer_secret"),null);assert.match(request.init.headers.Authorization,/^Basic /);assert.doesNotMatch(JSON.stringify([result,f.audit]),/PRIVATE|synthetic-example-value|Basic /);assert.equal(f.audit[0].companyId,companyId);}finally{await f.db.close();}
});
test("cross-company, permissions, opt-out, mismatched sites and invalid order IDs fail before Secrets or requests",async()=>{
  const f=await fixture();try{
    await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,{...run,companyId:otherCompany},f.input));await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,{...run,userId:undefined},f.input));await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,{...run,userPermission:"support:respond"},f.input));
    f.cfg.storefrontOrderAccounts![0]!.siteOrigin="https://other.example.com";await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input));f.cfg.storefrontOrderAccounts![0]!.siteOrigin="https://example.com";
    for(const orderId of [0,-1,1.5,Number.MAX_SAFE_INTEGER,"100/../other"])await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,run,{...f.input,orderId}));
    f.cfg.storefrontOrderAccounts![0]!.enabled=false;await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input));assert.equal(f.secrets(),0);assert.equal(f.requests.length,0);
  }finally{await f.db.close();}
});
test("redirects, provider refusals, identity mismatch, oversized response and mid-read revocation never yield order findings",async()=>{
  const f=await fixture();try{
    for(const status of [302,401,403,404,500]){f.setStatus(status);await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input));}
    f.setStatus(200);f.setValue({id:101,status:"processing"});await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input));
    f.setValue({id:100,status:"processing",unexpected:"x".repeat(100001)});await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input));
    f.setValue({id:100,status:"PRIVATE STATUS",payment_method:"PRIVATE GATEWAY"});const sanitized=await inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input);assert.equal(sanitized.status,"unrecognized_custom_status");assert.equal(sanitized.paymentMethod,"other_gateway");assert.doesNotMatch(JSON.stringify(sanitized),/PRIVATE/);f.audit.length=0;
    f.setValue({id:100,status:"processing"});f.revoke();await assert.rejects(inspectStorefrontOrder(f.ctx,f.getConfig,run,f.input));assert.equal(f.audit.length,0);
  }finally{await f.db.close();}
});
