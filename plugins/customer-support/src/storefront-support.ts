import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { PluginContext,ToolRunContext,PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { ns,person } from "./interactive-support.js";
import { companyHasSupport,IntakeError,type Config } from "./routing.js";
import type { DirectoryRecord } from "./directory-schema.js";
import { validPublicCheckUrl } from "./storefront-schema.js";
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function publicAddress(address:string){
  if(address.includes(":"))return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
  const v=address.split(".").map(Number);if(v.length!==4 || v.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  return ![0,10,127].includes(v[0]!) && v[0]!<224 && !(v[0]===169&&v[1]===254) && !(v[0]===172&&v[1]!>=16&&v[1]!<=31) && !(v[0]===192&&[0,168].includes(v[1]!)) && !(v[0]===198&&[18,19,51].includes(v[1]!)) && !(v[0]===203&&v[1]===0) && !(v[0]===100&&v[1]!>=64&&v[1]!<=127);
}
async function profile(ctx:PluginContext,cfg:Config,run:ToolRunContext,id:unknown){
  const actor=person(run);
  if(run.userPermission!=="support:diagnose"||!companyHasSupport(cfg,actor.companyId)||typeof id!=="string"||!uuid.test(id))throw new IntakeError(403,"Choose a saved storefront in this company with diagnostic permission");
  const [record]=await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2 AND kind='storefront'`,[actor.companyId,id]);
  if(!record)throw new IntakeError(404,"Storefront not found in this company");return{actor,record};
}
export async function checkStorefront(ctx:PluginContext,cfg:Config,run:ToolRunContext,input:Record<string,unknown>,resolve:(host:string,options:{all:true})=>Promise<{address:string;family:number}[]>=lookup){
  const {actor,record}=await profile(ctx,cfg,run,input.profileId);
  const observations=[];
  for(const [kind,url] of [["storefront",record.details.website],["vendor_status",record.details.statusUrl]] as const){
    if(!url)continue;
    const started=Date.now();let statusCode:number|null=null,status="unavailable";
    try{
      if(!validPublicCheckUrl(url))throw new Error("Invalid saved URL");
      const addresses=await Promise.race([resolve(new URL(url).hostname,{all:true}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error("DNS timeout")),3000);timer.unref();})]);
      if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new Error("Public DNS required");
      const response=await ctx.http.fetch(url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(10000),headers:{Accept:"text/html,application/json", "Cache-Control":"no-cache"}});
      statusCode=response.status;await response.body?.cancel();status=response.status>=300&&response.status<400?"redirect_not_followed":response.ok?"http_success":"http_failure";
    }catch{/* Do not persist request errors, credentials or response bodies. */}
    observations.push({kind,url,status,statusCode,durationMs:Date.now()-started});
  }
  const latest=await profile(ctx,await ctx.config.get() as Config,run,record.id);
  if(latest.record.version!==record.version)throw new IntakeError(409,"Storefront profile changed during the check; inspect the new URL before checking again");
  const id=randomUUID();await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_storefront_checks(company_id,id,profile_id,profile_version,observations) VALUES($1,$2,$3,$4,$5::jsonb)`,[actor.companyId,id,record.id,record.version,JSON.stringify(observations)]);
  await ctx.activity.log({companyId:actor.companyId,message:"Saved storefront HTTP endpoints observed",entityType:"support_storefront_check",entityId:id,metadata:{userId:actor.userId,profileId:record.id,profileVersion:record.version}});
  return{id,profileId:record.id,observedAtUtc:new Date().toISOString(),observations,adminRules:record.details.adminRules??null,instruction:"HTTP success only means the saved URL responded successfully; it does not prove checkout, orders, payment, fulfillment or vendor systems are healthy. Response bodies are not inspected. A vendor status URL HTTP 200 does not mean its reported incidents are clear. No login, order query, change or credential use occurred. Redirects need operator review and a saved exact destination. Saved admin rules do not grant access. DNS is checked before fetching; the worker must enforce outbound network policy against DNS rebinding."};
}
export async function storefrontHistory(ctx:PluginContext,cfg:Config,run:ToolRunContext,input:Record<string,unknown>){
  const {actor,record}=await profile(ctx,cfg,run,input.profileId);
  const rows=await ctx.db.query(`SELECT id,profile_version,observations,observed_at FROM ${ns(ctx)}.support_storefront_checks WHERE company_id=$1 AND profile_id=$2 ORDER BY observed_at DESC,id LIMIT 21`,[actor.companyId,record.id]);
  return{observations:rows.slice(0,20),truncated:rows.length>20,instruction:"Point-in-time saved endpoint HTTP observations, not continuous uptime monitoring or order/checkout health."};
}
export const storefrontTools:NonNullable<PaperclipPluginManifestV1["tools"]>=[
  {name:"support_check_storefront",displayName:"Check saved storefront and status URLs",requiredUserPermission:"support:diagnose",executionTimeoutMs:45000,description:"Check only operator-saved company storefront/vendor-status public HTTPS URLs. Reports HTTP code/time or unavailable; no body analysis, redirect, login, orders or changes. HTTP 200 proves neither checkout nor absence of vendor incidents. DNS checks refuse local/private addresses; outbound policy must also protect against rebinding.",parametersSchema:{type:"object",additionalProperties:false,properties:{profileId:{type:"string"}},required:["profileId"]}},
  {name:"support_storefront_history",displayName:"Read saved storefront check history",requiredUserPermission:"support:diagnose",description:"Read twenty company-scoped saved endpoint observations with check times and profile versions. Does not claim continuous uptime or order health.",parametersSchema:{type:"object",additionalProperties:false,properties:{profileId:{type:"string"}},required:["profileId"]}},
];
export function registerStorefrontTools(ctx:PluginContext,getConfig:()=>Promise<Config>){for(const tool of storefrontTools)ctx.tools.register(tool.name,tool,async(params,run)=>{try{return{data:tool.name==="support_check_storefront"?await checkStorefront(ctx,await getConfig(),run,params as Record<string,unknown>):await storefrontHistory(ctx,await getConfig(),run,params as Record<string,unknown>) };}catch(error){return{error:error instanceof IntakeError?error.message:"Storefront check unavailable; no admin action occurred"};}});}
