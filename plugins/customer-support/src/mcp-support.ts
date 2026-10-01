import { createHash,randomUUID } from "node:crypto";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Config } from "./routing.js";
import { person } from "./interactive-support.js";
import { IntakeError } from "./routing.js";
import { mcpTools } from "./mcp-schema.js";
type FetchPort=(url:string,init?:RequestInit)=>Promise<Response>;
export function mcpProfile(cfg:Config,companyId:string,id:unknown){
  if(typeof id!=="string"||!/^[a-z0-9_-]{1,100}$/i.test(id))throw new IntakeError(422,"Choose a saved external tool connection");
  const matches=(cfg.mcpConnections??[]).filter(p=>p.id===id),profile=matches[0];
  if(matches.length!==1||!profile?.enabled||!profile.allowedCompanies?.includes(companyId))throw new IntakeError(403,"This company is not opted into the external tool connection");
  if(!["Auto","2026-07-28","2025-11-25"].includes(profile.protocol))throw new IntakeError(422,"Unsupported saved MCP protocol");
  const url=new URL(profile.endpoint);
  if(url.username||url.password||url.search||url.hash||(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname))))throw new IntakeError(422,"Use a fixed HTTPS MCP endpoint or HTTP loopback endpoint without URL credentials/query/fragment");
  if(profile.tokenRef&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(profile.tokenRef))throw new IntakeError(422,"Use a saved bearer-token Secret reference");
  return{profile,endpoint:url.href,hash:createHash("sha256").update(JSON.stringify(profile)).digest("hex")};
}
function responseValue(value:unknown,id:string){
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid MCP response");const message=value as Record<string,unknown>;
  if(message.jsonrpc!=="2.0")throw new Error("Invalid MCP envelope");
  if(message.method){if("id" in message)throw new Error("Server-to-client interactions unsupported");return null;}
  if(message.jsonrpc!=="2.0"||message.id!==id||message.error||!message.result||typeof message.result!=="object"||Array.isArray(message.result))throw new Error("MCP request unavailable");
  return message.result as Record<string,unknown>;
}
async function readRpc(response:Response,id:string){
  if(!response.ok||!response.body)throw new Error("MCP read unavailable");
  const type=response.headers.get("content-type")??"";const sse=type.includes("text/event-stream");if(!sse&&!type.includes("application/json"))throw new Error("Unsupported MCP response transport");
  const reader=response.body.getReader(),decoder=new TextDecoder();let text="",bytes=0,frames=0;
  try{
    while(true){const part=await reader.read();if(part.done){text+=decoder.decode();break;}bytes+=part.value.length;if(bytes>128000)throw new Error("MCP response exceeded bound");text+=decoder.decode(part.value,{stream:true});
      if(sse){text=text.replace(/\r\n/g,"\n");let boundary:number;
        while((boundary=text.indexOf("\n\n"))>=0){if(++frames>100)throw new Error("MCP event bound exceeded");const frame=text.slice(0,boundary);text=text.slice(boundary+2);const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).replace(/^ /,"")).join("\n");if(data){const result=responseValue(JSON.parse(data),id);if(result)return result;}}
      }
    }
    if(sse)throw new Error("No matching MCP response");return responseValue(JSON.parse(text),id)??Promise.reject(new Error("No matching MCP response"));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function checkMcpConnection(ctx:PluginContext,getConfig:()=>Promise<Config>,run:ToolRunContext,input:Record<string,unknown>,send:FetchPort=globalThis.fetch){
  const actor=person(run);if(run.userPermission!=="support:diagnose")throw new IntakeError(403,"Human diagnostic permission required");
  const initial=mcpProfile(await getConfig(),actor.companyId,input.connectionId),deadline=Date.now()+45000;
  const guard=async()=>{if(Date.now()>=deadline||mcpProfile(await getConfig(),actor.companyId,input.connectionId).hash!==initial.hash)throw new IntakeError(409,"External tool connection changed or expired");};
  const token=initial.profile.tokenRef?await ctx.secrets.resolve(initial.profile.tokenRef,actor.companyId):null;await guard();if(initial.profile.tokenRef&&!token)throw new IntakeError(422,"Saved connection token unavailable");
  let session:string|null=null,protocol=initial.profile.protocol==="2025-11-25"?"2025-11-25":"2026-07-28",cleanup="not_needed";
  const headers=()=>({Accept:"application/json, text/event-stream","Content-Type":"application/json","MCP-Protocol-Version":protocol,...(token?{Authorization:`Bearer ${token}`} : {}),...(session?{"MCP-Session-Id":session}:{})});
  const post=async(method:string,params:Record<string,unknown>,id?:string)=>{await guard();return send(initial.endpoint,{method:"POST",redirect:"manual",headers:{...headers(),...(protocol==="2026-07-28"?{"Mcp-Method":method}:{})},signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now()))),body:JSON.stringify({jsonrpc:"2.0",...(id?{id}:{}),method,params})});};
  const modernParams=(cursor?:string)=>({...cursor?{cursor}:{},_meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"paperclip-support-check",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}}});
  let tools=0,truncated=false,pages=0;const names=new Set<string>(),cursors=new Set<string>();
  const collect=(result:Record<string,unknown>)=>{if(!Array.isArray(result.tools)||result.tools.length>200||result.inputRequests)throw new Error("Unsupported MCP tool catalog");for(const item of result.tools){if(!item||typeof item!=="object"||typeof item.name!=="string"||!/^[a-z0-9_.:-]{1,120}$/i.test(item.name)||names.has(item.name)||!item.inputSchema||typeof item.inputSchema!=="object"||Array.isArray(item.inputSchema))throw new Error("Invalid or duplicate MCP tool metadata");names.add(item.name);if(++tools>200)throw new Error("MCP tool bound exceeded");}if(result.nextCursor!==undefined&&(typeof result.nextCursor!=="string"||!result.nextCursor||result.nextCursor.length>1000))throw new Error("Invalid MCP cursor");return result.nextCursor as string|undefined;};
  try{
    let first:Record<string,unknown>|null=null;
    if(protocol==="2026-07-28"){
      const id=randomUUID(),response=await post("tools/list",modernParams(),id);
      if(response.status===400&&initial.profile.protocol==="Auto"){await response.body?.cancel();protocol="2025-11-25";}
      else first=await readRpc(response,id);
    }
    if(protocol!=="2026-07-28"){
      const id=randomUUID(),response=await post("initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"paperclip-support-check",version:"1"}},id);
      session=response.headers.get("MCP-Session-Id");if(session&&!/^[\x21-\x7e]{1,200}$/.test(session))throw new Error("Invalid MCP session");
      const initialized=await readRpc(response,id);if(!["2025-03-26","2025-06-18","2025-11-25"].includes(String(initialized.protocolVersion))||!(initialized.capabilities as {tools?:unknown})?.tools)throw new Error("MCP tool capability unavailable");protocol=String(initialized.protocolVersion);
      const notification=await post("notifications/initialized",{});await notification.body?.cancel();if(notification.status!==202)throw new Error("MCP initialization not accepted");
    }
    let cursor:string|undefined;
    do{
      const id=randomUUID();const result=first??await readRpc(await post("tools/list",protocol==="2026-07-28"?modernParams(cursor):cursor?{cursor}:{},id),id);first=null;cursor=collect(result);pages++;
      if(cursor){if(cursors.has(cursor))throw new Error("MCP cursor loop");cursors.add(cursor);}
      if(cursor&&(pages>=5||tools>=200)){truncated=true;break;}
    }while(cursor);
    await guard();
  }finally{
    if(session){cleanup="unconfirmed";try{await guard();const response=await send(initial.endpoint,{method:"DELETE",redirect:"manual",headers:headers(),signal:AbortSignal.timeout(2000)});await response.body?.cancel();cleanup=[200,202,204].includes(response.status)?"terminated":response.status===405?"server_not_supported":"unconfirmed";}catch{/* No tool execution or automatic session retry. */}}
  }
  await guard();
  await ctx.activity.log({companyId:actor.companyId,message:"External tool connection catalog observed",entityType:"support_mcp_connection",entityId:initial.profile.id,metadata:{userId:actor.userId,protocol,toolCount:tools,truncated,cleanup}});
  return{connectionId:initial.profile.id,status:truncated?"partial_catalog_observed":"catalog_observed",protocol,toolCount:tools,pages,truncated,sessionCleanup:cleanup,credentialMode:token?"configured_bearer":"none",observedAtUtc:new Date().toISOString(),limitations:"The configured request reached this saved endpoint and returned a tool catalog. It does not assert an account identity, prove the server enforced authentication, test tool execution or inspect a workstation's MCP settings. No tools/call, prompts, resources, sampling or elicitation. Server instructions, tool schemas/names, tokens and session IDs remain internal. Stdio, old two-endpoint SSE and interactive OAuth are not supported; save an existing token in Secrets."};
}
export function registerMcpTools(ctx:PluginContext,getConfig:()=>Promise<Config>){for(const tool of mcpTools)ctx.tools.register(tool.name,tool,async(params,run)=>{try{return{data:await checkMcpConnection(ctx,getConfig,run,params as Record<string,unknown>)};}catch(error){return{error:error instanceof IntakeError?error.message:"External tool connection unavailable; check the saved endpoint, credentials and protocol. No external tool was executed."};}});}
