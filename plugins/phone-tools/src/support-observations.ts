import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { InstanceConfig } from "./engines/types.js";
import { consumeObservation, observationEvent, type ObservationRequest } from "../../../lib/support-observations.js";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function phoneSupportProfile(cfg: InstanceConfig, request: Pick<ObservationRequest,"companyId"|"account"|"resourceId">) {
  const accounts=(cfg.accounts??[]).filter(a=>a.key?.toLowerCase()===request.account.toLowerCase());const account=accounts[0];
  if(accounts.length!==1 || !account?.allowedCompanies?.includes(request.companyId))throw new Error("Exact phone company/account required");
  const profiles=(account.supportProfiles??[]).filter(p=>p.key===request.resourceId&&p.companyId===request.companyId);const profile=profiles[0];
  if(profiles.length!==1 || !profile?.enabled || !/^[a-z0-9_-]{1,100}$/i.test(profile.key))throw new Error("Phone observations not opted in");
  for(const [ids,allowed] of [[profile.assistantIds,account.allowedAssistants],[profile.numberIds,account.allowedNumbers]] as const) {
    if(!Array.isArray(ids)||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>!uuid.test(id)||(allowed?.length&&!allowed.includes(id))))throw new Error("Exact owned assistant/number UUIDs required");
  }
  if(!profile.assistantIds.length&&!profile.numberIds.length)throw new Error("No owned resources selected");
  const fingerprint=createHash("sha256").update(JSON.stringify([profile,account.engine,account.apiKeyRef,account.allowedAssistants,account.allowedNumbers])).digest("hex");
  return{account,profile,fingerprint};
}
async function boundedJson(response: Response) {
  if(!response.ok||!response.headers.get("content-type")?.includes("application/json")||!response.body)throw new Error("Phone provider read unavailable");
  const reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  try {while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>128000)throw new Error("Phone response exceeded bound");parts.push(next.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const value=JSON.parse(Buffer.concat(parts).toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Unsupported phone metadata");return value as Record<string,unknown>;
}
function selector(value:unknown) {return typeof value==="string"&&/^[a-zA-Z0-9._:-]{1,100}$/.test(value)?value:null;}
function component(value:unknown,field:string) {const object=value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};return{provider:selector(object.provider),selection:selector(object[field])};}
export async function readPhoneObservation(ctx:PluginContext,request:ObservationRequest,fetchRead:(url:string,init?:RequestInit)=>Promise<Response>=globalThis.fetch) {
  const initial=phoneSupportProfile(await ctx.config.get() as InstanceConfig,request);
  if((initial.account.engine??"vapi")!=="vapi")return{engine:"diy",status:"unavailable",reason:"DIY assistants are call-local; this scoped saved-assistant/number check supports Vapi only. No calls or credentials were used.",componentsNotTested:["Jambonz","SIP","SBC","PBX","hypervisor","voicemail"]};
  if(!initial.account.apiKeyRef)throw new Error("API key is not configured");
  const deadline=Math.min(Date.parse(request.expiresAt),Date.now()+45000);
  const guard=async()=>{if(Date.now()>=deadline||phoneSupportProfile(await ctx.config.get() as InstanceConfig,request).fingerprint!==initial.fingerprint)throw new Error("Phone profile changed or expired");};
  await guard();const token=await ctx.secrets.resolve(initial.account.apiKeyRef);if(!token)throw new Error("Missing provider key");await guard();
  const read=async(kind:"assistant"|"phone-number",id:string)=>{
    await guard();const response=await fetchRead(`https://api.vapi.ai/${kind}/${id}`,{method:"GET",redirect:"manual",headers:{Authorization:`Bearer ${token}`,Accept:"application/json"},signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now())))});
    const value=await boundedJson(response);if(value.id!==id)throw new Error("Resource identity mismatch");await guard();return value;
  };
  const assistants:unknown[]=[];const numbers:unknown[]=[];
  for(const id of initial.profile.assistantIds) {
    try {const value=await read("assistant",id);assistants.push({id,status:"available",model:component(value.model,"model"),voice:component(value.voice,"voiceId"),transcriber:component(value.transcriber,"model"),updatedAt:typeof value.updatedAt==="string"&&Number.isFinite(Date.parse(value.updatedAt))?value.updatedAt:null});}
    catch {await guard();assistants.push({id,status:"unavailable"});}
  }
  for(const id of initial.profile.numberIds) {
    try {const value=await read("phone-number",id);numbers.push({id,status:"available",provider:selector(value.provider),assistantRouting:typeof value.assistantId==="string"&&initial.profile.assistantIds.includes(value.assistantId)?"owned_assistant_configured":"different_or_unassigned_or_dynamic",assistantId:typeof value.assistantId==="string"&&initial.profile.assistantIds.includes(value.assistantId)?value.assistantId:null,hasSquadRouting:typeof value.squadId==="string",hasDynamicServerRouting:!!value.server});}
    catch {await guard();numbers.push({id,status:"unavailable"});}
  }
  await guard();
  const unavailable=[...assistants,...numbers].filter(item=>(item as {status:string}).status==="unavailable").length;
  return{engine:"vapi",status:unavailable===assistants.length+numbers.length?"unavailable":unavailable?"partial":"observed_configuration",assistants,numbers,observedAtUtc:new Date().toISOString(),componentsNotTested:["actual inbound/outbound calls","voice/model/transcriber authentication","PSTN/SIP reachability","3CX routing","desk/softphones","SBC","PBX host/hypervisor","voicemail delivery"],limitations:"Exact company-owned saved IDs only. Provider metadata and assistant assignment are observations, not proof calls work or a root cause. Prompts, messages, phone numbers, credentials, call logs, transcripts and recordings are omitted. Dynamic/squad routing is reported separately, never inferred healthy. No changes, test calls or charges were attempted."};
}
export function registerPhoneObservations(ctx:PluginContext) {ctx.events.on(observationEvent,event=>consumeObservation(ctx,"phone-tools",event,request=>readPhoneObservation(ctx,request)));}
