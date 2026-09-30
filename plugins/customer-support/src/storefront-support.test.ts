import assert from "node:assert/strict";
import test from "node:test";
import { readdir,readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import { checkStorefront,storefrontHistory } from "./storefront-support.js";
import { saveDirectory,validateDirectory } from "./support-directory.js";
const companyId="11111111-1111-4111-8111-111111111111";
const cfg={discoveryNetworks:[{id:"example",companyId,cidr:"192.0.2.0/24"}]};
const run={companyId,userId:"operator",chatSessionId:"chat",userPermission:"support:diagnose"} as ToolRunContext;
test("saved storefront checks enforce scope, refuse unsafe endpoints and preserve redirect/failure evidence without claiming checkout",async()=>{
  const db=new PGlite(),namespace="plugin_customer_support_0c69412611";let calls=0,status=200,revoke=false;
  try{
    await db.exec(`CREATE SCHEMA ${namespace}`);for(const file of (await readdir(new URL("../migrations/",import.meta.url))).filter(n=>n.endsWith(".sql")).sort())await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),"utf8"));
    const ctx={db:{namespace,query:async(sql:string,params:unknown[])=>(await db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await db.query(sql,params)).affectedRows})},config:{get:async()=>revoke?{}:cfg},activity:{log:async()=>{}},http:{fetch:async(url:string,options:RequestInit)=>{calls++;assert.equal(options.redirect,"manual");assert.equal(options.method,"GET");assert.ok(url.startsWith("https://example.com/"));return new Response("Synthetic private body is never read",{status});}}} as unknown as PluginContext;
    const details={website:"https://example.com/shop",statusUrl:"https://example.com/status",adminRules:"Only the order owner may change orders"};
    for(const website of ["https://localhost/","https://192.0.2.1/","https://example.com:8443/","https://example.com/?token=synthetic-test","https://example.com/#admin"])assert.throws(()=>validateDirectory({kind:"storefront",name:"Example",details:{website}}));
    const profile=await saveDirectory(ctx,cfg,companyId,"operator",{kind:"storefront",name:"Example shop",details});
    const publicDns=async()=>[{address:"8.8.8.8",family:4}];
    const result=await checkStorefront(ctx,cfg,run,{profileId:profile.id},publicDns);
    assert.equal(result.observations[0]!.status,"http_success");assert.match(result.instruction,/does not prove checkout/);assert.equal(calls,2);
    await assert.rejects(checkStorefront(ctx,cfg,{...run,companyId:"22222222-2222-4222-8222-222222222222"},{profileId:profile.id},publicDns));assert.equal(calls,2);
    const privateDns=async()=>[{address:"127.0.0.1",family:4}];
    const blocked=await checkStorefront(ctx,cfg,run,{profileId:profile.id},privateDns);assert.equal(blocked.observations[0]!.status,"unavailable");assert.equal(calls,2);
    status=302;assert.equal((await checkStorefront(ctx,cfg,run,{profileId:profile.id},publicDns)).observations[0]!.status,"redirect_not_followed");
    status=503;assert.equal((await checkStorefront(ctx,cfg,run,{profileId:profile.id},publicDns)).observations[0]!.status,"http_failure");
    assert.equal((await storefrontHistory(ctx,cfg,run,{profileId:profile.id})).observations.length,4);
    revoke=true;await assert.rejects(checkStorefront(ctx,cfg,run,{profileId:profile.id},publicDns));
  }finally{await db.close();}
});
