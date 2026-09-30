import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { InstanceConfig } from "./engines/types.js";
import { phoneSupportProfile,readPhoneObservation,registerPhoneObservations } from "./support-observations.js";
import { observationEvent,observationHash,type ObservationRequest } from "../../../lib/support-observations.js";
const companyId="11111111-1111-4111-8111-111111111111",assistantId="33333333-3333-4333-8333-333333333333",numberId="44444444-4444-4444-8444-444444444444";
function fixture() {
  const cfg:InstanceConfig={accounts:[{key:"example",engine:"vapi",apiKeyRef:"55555555-5555-4555-8555-555555555555",allowedCompanies:[companyId],supportProfiles:[{key:"phones",companyId,enabled:true,assistantIds:[assistantId],numberIds:[numberId]}]}]};
  const value={version:1 as const,requestId:randomUUID(),companyId,provider:"phone-tools" as const,account:"example",resourceId:"phones",operation:"assistant_routing",expiresAt:new Date(Date.now()+120000).toISOString()};const request:ObservationRequest={...value,requestSha256:observationHash(value)};
  const requests:{url:string;init:RequestInit}[]=[];let resolved=0;let response:((url:string)=>Response)|null=null;let afterRead:(()=>void)|null=null;
  const ctx={config:{get:async()=>cfg},secrets:{resolve:async()=>{resolved++;return"synthetic-example-value";}},http:{fetch:async(url:string,init:RequestInit)=>{requests.push({url,init});afterRead?.();return response?response(url):Response.json(url.includes("/assistant/")?{id:assistantId,model:{provider:"example",model:"example-model",messages:[{content:"PRIVATE PROMPT"}]},voice:{provider:"example",voiceId:"example-voice"},firstMessage:"PRIVATE GREETING",server:{secret:"synthetic-only-hidden"}}:{id:numberId,provider:"vapi",assistantId,number:"PRIVATE PHONE NUMBER",credentialId:"PRIVATE CREDENTIAL"});}}} as unknown as PluginContext;
  return{cfg,ctx,request,requests,resolved:()=>resolved,setResponse:(next:(url:string)=>Response)=>{response=next;},afterRead:(next:()=>void)=>{afterRead=next;}};
}
test("AI phone observations read only exact saved resources and omit prompts, numbers and credentials",async()=>{
  const f=fixture();const result=await readPhoneObservation(f.ctx,f.request,f.ctx.http.fetch.bind(f.ctx.http));
  assert.equal(result.status,"observed_configuration");assert.equal(f.requests.length,2);assert.equal((result.numbers![0] as any).assistantRouting,"owned_assistant_configured");
  for(const {url,init} of f.requests){assert.match(url,/^https:\/\/api\.vapi\.ai\/(assistant|phone-number)\/[a-f0-9-]{36}$/);assert.equal(init.method,"GET");assert.equal(init.redirect,"manual");assert.ok(init.signal);}
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|synthetic-only-hidden|synthetic-example-value/);assert.ok(result.componentsNotTested.includes("SBC"));
});
test("exact company, configured IDs and account allow-lists are checked before Secrets, and revocation stops follow-up reads",async()=>{
  const f=fixture();await assert.rejects(readPhoneObservation(f.ctx,{...f.request,companyId:randomUUID()},f.ctx.http.fetch.bind(f.ctx.http)));assert.equal(f.resolved(),0);
  f.cfg.accounts![0]!.allowedCompanies=["*"];assert.throws(()=>phoneSupportProfile(f.cfg,f.request));f.cfg.accounts![0]!.allowedCompanies=[companyId];
  f.cfg.accounts![0]!.allowedAssistants=[randomUUID()];assert.throws(()=>phoneSupportProfile(f.cfg,f.request));f.cfg.accounts![0]!.allowedAssistants=[];
  f.cfg.accounts![0]!.supportProfiles![0]!.assistantIds.push(assistantId);assert.throws(()=>phoneSupportProfile(f.cfg,f.request));f.cfg.accounts![0]!.supportProfiles![0]!.assistantIds.pop();
  f.afterRead(()=>{f.cfg.accounts![0]!.supportProfiles![0]!.enabled=false;});await assert.rejects(readPhoneObservation(f.ctx,f.request,f.ctx.http.fetch.bind(f.ctx.http)));assert.equal(f.requests.length,1);
});
test("redirects, forbidden resources, identity mismatch and oversized bodies are unavailable rather than healthy",async()=>{
  const f=fixture();
  for(const response of [()=>new Response(null,{status:302,headers:{Location:"https://example.com"}}),()=>Response.json({message:"PRIVATE ERROR"},{status:403}),()=>Response.json({id:randomUUID()}),()=>Response.json({id:assistantId,unexpected:"x".repeat(128001)})]){
    f.setResponse(response);const result=await readPhoneObservation(f.ctx,f.request,f.ctx.http.fetch.bind(f.ctx.http));assert.ok(result.assistants!.every((item:any)=>item.status==="unavailable"));assert.ok(result.numbers!.every((item:any)=>item.status==="unavailable"));assert.doesNotMatch(JSON.stringify(result),/PRIVATE ERROR/);
  }
  f.setResponse(url=>Response.json(url.includes("/assistant/")?{id:assistantId}:{id:numberId,assistantId:"66666666-6666-4666-8666-666666666666",squadId:"unknown-squad",server:{secret:"synthetic-example"}}));
  const result=await readPhoneObservation(f.ctx,f.request,f.ctx.http.fetch.bind(f.ctx.http));assert.equal((result.numbers![0] as any).assistantId,null);assert.equal((result.numbers![0] as any).assistantRouting,"different_or_unassigned_or_dynamic");assert.doesNotMatch(JSON.stringify(result),/66666666|unknown-squad|synthetic-example/);
});
test("DIY saved-assistant checks report unavailable without resolving credentials or making calls",async()=>{
  const f=fixture();f.cfg.accounts![0]!.engine="diy";const result=await readPhoneObservation(f.ctx,f.request,f.ctx.http.fetch.bind(f.ctx.http));assert.equal(result.status,"unavailable");assert.equal(f.resolved(),0);assert.equal(f.requests.length,0);
});
test("the bridge requires the host-stamped company/provider/hash request and receipts expose no raw errors",async()=>{
  const f=fixture(),handlers=new Map<string,Function>(),receipts:any[]=[];
  const ctx={...f.ctx,events:{on:(name:string,handler:Function)=>handlers.set(name,handler),emit:async(_name:string,_company:string,value:any)=>receipts.push(value)}} as unknown as PluginContext;
  registerPhoneObservations(ctx);const handler=handlers.get(observationEvent)!;const event={eventType:observationEvent,actorType:"plugin",actorId:"customer-support",companyId,payload:f.request};
  await handler({...event,actorId:"another-plugin"});await handler({...event,payload:{...f.request,resourceId:"../other"}});assert.equal(receipts.length,0);assert.equal(f.resolved(),0);
  f.cfg.accounts![0]!.supportProfiles![0]!.enabled=false;await handler(event);assert.equal(receipts[0].status,"unavailable");assert.equal(f.resolved(),0);
});
