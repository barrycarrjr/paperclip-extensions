import { createHash,randomUUID } from "node:crypto";
import type { PluginContext,ToolRunContext,PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { getHelpScoutAccount,type InstanceConfig,type ConfigAccount,type ResolvedAccount } from "./helpScoutClient.js";
import { companySupportMailboxes } from "./support-observations.js";
import { supportRead } from "./reviewed-support.js";
export interface IntakeRoute { key:string;companyId:string;mailboxId:string;connectionId:string;externalAccountId:string;paperclipBaseUrl:string;apiKeyRef:string;startAt:string;enabled:boolean }
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,providerId=/^[1-9][0-9]{0,14}$/;
function ns(ctx:PluginContext){if(!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace))throw new Error("Invalid namespace");return ctx.db.namespace;}
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function intakeEndpoint(base:string){const url=new URL(base);if(url.username||url.password||url.search||url.hash||url.pathname!=="/"||(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname))))throw new Error("Use an exact HTTPS Paperclip origin or HTTP loopback origin, without credentials or paths");return `${url.origin}/api/plugins/customer-support/api/messages`;}
export function selectIntakeRoute(cfg:InstanceConfig,companyId:string,accountKey:string,routeKey:string,requireEnabled=true){
 const matches=(cfg.accounts??[]).filter(a=>a.key===accountKey),account=matches[0];
 if(matches.length!==1||!account||!account.allowedCompanies?.includes(companyId))throw new Error("Exact company account required");
 const routes=account.supportIntakeRoutes??[],selected=routes.filter(r=>r.companyId===companyId&&r.key===routeKey),route=selected[0];
 if(selected.length!==1||(!route || (requireEnabled&&!route.enabled))||!uuid.test(companyId)||!providerId.test(route.mailboxId)||!uuid.test(route.apiKeyRef)||!route.connectionId||!route.externalAccountId||!Number.isFinite(Date.parse(route.startAt))||Date.parse(route.startAt)>Date.now()||!companySupportMailboxes(cfg,companyId,accountKey).includes(route.mailboxId))throw new Error("Unique enabled company mailbox intake route required");
 if(routes.some(r=>r.enabled&&r!==route&&r.mailboxId===route.mailboxId))throw new Error("Mailbox intake routes must be unique");
 intakeEndpoint(route.paperclipBaseUrl);
 return{account,route,routeHash:digest([accountKey,route.key,route.companyId,route.mailboxId,route.connectionId,route.externalAccountId,intakeEndpoint(route.paperclipBaseUrl)]),configHash:digest([account,route])};
}
interface Cursor{route_sha256:string;cursor_at:string;pending_until:string|null;pending_conversations:string[];pending_offset:number;last_error:string|null;last_completed_at:string|null}
interface Thread{delivered_version:number;delivered_secret_ref:string|null;pending_version:number|null;pending_secret_ref:string|null}
interface Source{companyId:string;connectionId:string;externalAccountId:string;externalRouteId:string;externalConversationId:string;title:string;body:string;authorKind:"customer"|"staff";occurredAt:string;authorExternalId?:string;attachments:{id:string;name:string;mimeType?:string}[]}
function source(route:IntakeRoute,conversation:Record<string,unknown>,thread:Record<string,unknown>):Source|null{
 if(thread.state!=="published"||!["customer","message","note","chat","beaconchat","phone"].includes(String(thread.type)))return null;
 if(!providerId.test(String(thread.id))||typeof thread.body!=="string"||!thread.body.trim()||thread.body.length>50000||typeof thread.createdAt!=="string"||!Number.isFinite(Date.parse(thread.createdAt)))throw new Error("Thread body/identity/time unavailable or exceeds bound");
 const createdBy=thread.createdBy as {id?:unknown;type?:unknown}|undefined;
 if(!createdBy||!["customer","user"].includes(String(createdBy.type)))throw new Error("Thread author unavailable");
 const raw=(thread._embedded as {attachments?:Record<string,unknown>[]}|undefined)?.attachments??[];
 if(!Array.isArray(raw)||raw.length>20)throw new Error("Attachment metadata exceeds bound");
 const attachments=raw.map(file=>{if(!providerId.test(String(file.id))||typeof file.filename!=="string"||!file.filename||file.filename.length>500||file.state!=="valid")throw new Error("Attachment metadata unavailable or quarantined");return{id:String(file.id),name:file.filename,...(typeof file.mimeType==="string"?{mimeType:file.mimeType}:{})};});
 return{companyId:route.companyId,connectionId:route.connectionId,externalAccountId:route.externalAccountId,externalRouteId:route.mailboxId,externalConversationId:String(conversation.id),title:String(conversation.subject??"Help Scout request").slice(0,300),body:thread.body,authorKind:createdBy.type==="customer"?"customer":"staff",occurredAt:thread.createdAt,...(createdBy.id?{authorExternalId:String(createdBy.id)}:{}),attachments};
}
type Read=typeof supportRead;
async function assertCurrent(ctx:PluginContext,companyId:string,key:string,routeKey:string,hash:string){if(selectIntakeRoute(await ctx.config.get() as InstanceConfig,companyId,key,routeKey).configHash!==hash)throw new Error("Intake configuration changed");}
/** Connector originals and comparison snapshots remain encrypted. The only raw
 * content transfer is the authenticated intake API; event/ordinary state is metadata. */
async function deliverThread(ctx:PluginContext,route:IntakeRoute,routeHash:string,conversationId:string,threadId:string,current:Source,check:()=>Promise<void>,deadline:number){
 await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_intake_threads(route_sha256,company_id,conversation_id,thread_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[routeHash,route.companyId,conversationId,threadId]);
 const get=async()=>(await ctx.db.query<Thread>(`SELECT * FROM ${ns(ctx)}.support_intake_threads WHERE route_sha256=$1 AND company_id=$2 AND conversation_id=$3 AND thread_id=$4`,[routeHash,route.companyId,conversationId,threadId]))[0]!;
 let row=await get(),sent=0;
 // Finish an acknowledged-or-unknown previous intake attempt before staging an edit.
 for(let attempt=0;attempt<2;attempt++){
   if(!row.pending_secret_ref){
     const previous=row.delivered_secret_ref?JSON.parse(await ctx.secrets.resolve(row.delivered_secret_ref,route.companyId)) as {source:Source}:null;
     if(previous&&JSON.stringify(previous.source)===JSON.stringify(current))return sent;
     const version=row.delivered_version+1,payload={source:current,message:{...current,externalMessageId:`${threadId}:revision:${routeHash}:${version}`,body:version>1?`[Provider edit revision ${version}; original message time retained]\n${current.body}`:current.body}};
     const ref=(await ctx.secrets.store(route.companyId,digest(["help-scout-intake",randomUUID()]),JSON.stringify(payload))).secretRef;
     await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_threads SET pending_version=$5,pending_secret_ref=$6 WHERE route_sha256=$1 AND company_id=$2 AND conversation_id=$3 AND thread_id=$4 AND delivered_version=$7 AND pending_secret_ref IS NULL`,[routeHash,route.companyId,conversationId,threadId,version,ref,row.delivered_version]);row=await get();
   }
   if(Date.now()>deadline)throw new Error("Intake work budget exhausted");
   await check();const payload=JSON.parse(await ctx.secrets.resolve(row.pending_secret_ref!,route.companyId)) as {message:Record<string,unknown>};
   const key=await ctx.secrets.resolve(route.apiKeyRef);
   const response=await ctx.http.fetch(intakeEndpoint(route.paperclipBaseUrl),{method:"POST",redirect:"manual",signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(payload.message)});
   if(![200,201].includes(response.status)){await response.body?.cancel();throw new Error("Support Desk intake not acknowledged");}
   // Small acknowledgement only; never echo its body into logs or tools.
   const reader=response.body?.getReader();if(!reader)throw new Error("Missing intake acknowledgement");let ackText="",bytes=0;const decoder=new TextDecoder();
   try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2000)throw new Error("Invalid intake acknowledgement");ackText+=decoder.decode(part.value,{stream:true});}ackText+=decoder.decode();}finally{await reader.cancel();}
   const ack=JSON.parse(ackText) as {caseId?:string;created?:boolean};
   if(!uuid.test(ack.caseId??"")||typeof ack.created!=="boolean")throw new Error("Invalid intake acknowledgement");
   await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_threads SET delivered_version=pending_version,delivered_secret_ref=pending_secret_ref,pending_version=NULL,pending_secret_ref=NULL WHERE route_sha256=$1 AND company_id=$2 AND conversation_id=$3 AND thread_id=$4 AND pending_version=$5 AND pending_secret_ref=$6`,[routeHash,route.companyId,conversationId,threadId,row.pending_version,row.pending_secret_ref]);
   sent+=Number(ack.created);row=await get();
 }
 return sent;
}
export async function pollSupportIntake(ctx:PluginContext,companyId:string,accountKey:string,routeKey:string,read:Read=supportRead,resolve=getHelpScoutAccount){
 const selected=selectIntakeRoute(await ctx.config.get() as InstanceConfig,companyId,accountKey,routeKey),{route,routeHash}=selected;
 const lease=randomUUID(),deadline=Date.now()+45000,check=()=>assertCurrent(ctx,companyId,accountKey,routeKey,selected.configHash);
 const claim=await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_intake_routes(route_sha256,company_id,cursor_at,lease_id,lease_until) VALUES($1,$2,$3::timestamptz,$4,now()+interval '2 minutes') ON CONFLICT(route_sha256) DO UPDATE SET lease_id=$4,lease_until=now()+interval '2 minutes' WHERE support_intake_routes.company_id=$2 AND (support_intake_routes.lease_until IS NULL OR support_intake_routes.lease_until<now())`,[routeHash,companyId,route.startAt,lease]);
 if(claim.rowCount!==1)return{status:"busy",newMessages:0,cursorAdvanced:false};
 let count=0,completed=0;
 try{
   const account=await resolve(ctx,companyId,"support-intake",accountKey);
   const row=(await ctx.db.query<Cursor>(`SELECT * FROM ${ns(ctx)}.support_intake_routes WHERE route_sha256=$1 AND company_id=$2`,[routeHash,companyId]))[0]!;
   let queue=row.pending_conversations,offset=row.pending_offset,until=row.pending_until;
   if(!until){
     until=new Date().toISOString().replace(/\.\d{3}Z$/,"Z");queue=[];
     // Only a complete bounded provider listing creates a work queue. The
     // cursor remains behind the scan's start, catching changes during paging.
     for(let page=1;page<=10;page++){
       if(Date.now()>deadline)throw new Error("Provider scan work budget exhausted");
       // Always drain the first page with exact ID exclusions. Offset paging of
       // a mutable modified-at search can skip unchanged records when earlier
       // records move; a fixed time window plus exclusions avoids that shift.
       const since=new Date(Date.parse(row.cursor_at)-300000).toISOString().replace(/\.\d{3}Z$/,"Z");
       const query=`(modifiedAt:[${since} TO ${until}]${queue.length?` AND NOT (${queue.map(value=>`id:${value}`).join(" OR ")})`:""})`;
       if(query.length>8000)throw new Error("Provider query backlog exceeds bound");
       const params=new URLSearchParams({mailbox:route.mailboxId,status:"all",sortField:"modifiedAt",sortOrder:"asc",query,page:"1"});
       const result=await read(ctx,account,`/conversations?${params}`),items=(result._embedded as {conversations?:Record<string,unknown>[]}|undefined)?.conversations,meta=result.page as {totalPages?:unknown}|undefined;
       if(!Array.isArray(items)||items.length>100||!Number.isInteger(meta?.totalPages)||Number(meta!.totalPages)>10)throw new Error("Provider listing incomplete or backlog exceeds ten pages");
       for(const item of items){if(!providerId.test(String(item.id))||String(item.mailboxId)!==route.mailboxId||queue.includes(String(item.id))||typeof item.modifiedAt!=="string"||Date.parse(item.modifiedAt)<Date.parse(since)||Date.parse(item.modifiedAt)>Date.parse(until))throw new Error("Provider conversation outside exact mailbox");queue.push(String(item.id));}
       if(Number(meta!.totalPages)<=1)break;
       if(page===10)throw new Error("Provider listing exceeds bounded scan");
     }
     queue=[...new Set(queue)];await check();
     await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_routes SET pending_conversations=$3::jsonb,pending_until=$4::timestamptz,pending_offset=0 WHERE route_sha256=$1 AND lease_id=$2`,[routeHash,lease,JSON.stringify(queue),until]);offset=0;
   }
   while(offset<queue.length&&completed<3){
     if(Date.now()>deadline)throw new Error("Intake work budget exhausted");await check();
     const conversationId=queue[offset]!,conversation=await read(ctx,account,`/conversations/${conversationId}`);
     if(String(conversation.id)!==conversationId||String(conversation.mailboxId)!==route.mailboxId)throw new Error("Conversation moved or cannot be inspected; operator review required");
     for(let page=1;page<=5;page++){
       if(Date.now()>deadline)throw new Error("Intake work budget exhausted");
       const result=await read(ctx,account,`/conversations/${conversationId}/threads?page=${page}`),items=(result._embedded as {threads?:Record<string,unknown>[]}|undefined)?.threads,meta=result.page as {totalPages?:unknown}|undefined;
       if(!Array.isArray(items)||items.length>100||!Number.isInteger(meta?.totalPages)||Number(meta!.totalPages)>5)throw new Error("Thread listing incomplete or exceeds five pages");
       for(const thread of [...items].reverse()){const value=source(route,conversation,thread);if(value)count+=await deliverThread(ctx,route,routeHash,conversationId,String(thread.id),value,check,deadline);}
       if(page>=Number(meta!.totalPages))break;
     }
     await check();offset++;completed++;
     await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_routes SET pending_offset=$3,updated_at=now() WHERE route_sha256=$1 AND lease_id=$2`,[routeHash,lease,offset]);
   }
   const finished=offset>=queue.length;await check();
   if(finished)await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_routes SET cursor_at=GREATEST(cursor_at,pending_until),pending_until=NULL,pending_conversations='[]',pending_offset=0,last_error=NULL,last_completed_at=now(),updated_at=now() WHERE route_sha256=$1 AND lease_id=$2`,[routeHash,lease]);
   else await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_routes SET last_error=NULL WHERE route_sha256=$1 AND lease_id=$2`,[routeHash,lease]);
   await ctx.activity.log({companyId,message:"Help Scout native intake batch acknowledged",entityType:"helpscout_intake",entityId:route.key,metadata:{newMessages:count,completedConversations:completed,pendingConversations:queue.length-offset,cursorAdvanced:finished}});
   return{status:finished?"complete":"pending",newMessages:count,pendingConversations:queue.length-offset,cursorAdvanced:finished,instruction:"Imported published body-bearing threads and attachment metadata only, not files/drafts/hidden/line-item events. Provider edits become separately labelled revisions; unchanged threads are deduplicated against encrypted snapshots. Cursor advances only after every queued conversation is acknowledged. Native intake does not enable automatic repair or Help Scout ticket investigation policies."};
 }catch{
   await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_routes SET last_error='intake_incomplete',updated_at=now() WHERE route_sha256=$1 AND lease_id=$2`,[routeHash,lease]);
   return{status:"incomplete",newMessages:count,cursorAdvanced:false,instruction:"No cursor advancement. Inspect company/mailbox mappings, agent API key/ingest-agent authorization, encrypted storage, TLS/provider availability and backlog bounds. Unacknowledged intake retries with the same message revision ID; Support Desk must deduplicate it. No ticket body or credential is included in this result."};
 }finally{await ctx.db.execute(`UPDATE ${ns(ctx)}.support_intake_routes SET lease_id=NULL,lease_until=NULL WHERE route_sha256=$1 AND lease_id=$2`,[routeHash,lease]);}
}
export const intakeTools:NonNullable<PaperclipPluginManifestV1["tools"]>=[
 {name:"helpscout_poll_support_intake",displayName:"Import a saved Help Scout mailbox batch",requiredUserPermission:"support:diagnose",writes:true,executionTimeoutMs:90000,description:"Native intake through a saved company/mailbox route and authorized Paperclip ingestion-agent API key Secret. Published thread bodies/attachment metadata go only to authenticated Support Desk intake and encrypted storage; no ticket messages/changes are sent. Three conversations per batch; complete cursor acknowledgements and revision deduplication. No arbitrary URL/mailbox/since value.",parametersSchema:{type:"object",additionalProperties:false,properties:{account:{type:"string"},routeKey:{type:"string"}},required:["account","routeKey"]}},
 {name:"helpscout_support_intake_status",displayName:"Inspect native Help Scout intake progress",requiredUserPermission:"support:diagnose",description:"Company route cursor/backlog/error metadata only. Does not expose ticket bodies, credentials or encrypted references. Incomplete is not successful intake.",parametersSchema:{type:"object",additionalProperties:false,properties:{account:{type:"string"},routeKey:{type:"string"}},required:["account","routeKey"]}},
];
export function registerSupportIntake(ctx:PluginContext){
 for(const tool of intakeTools)ctx.tools.register(tool.name,tool,async(params,run:ToolRunContext)=>{try{if(!run.userId||!run.chatSessionId||run.userPermission!=="support:diagnose")throw new Error("Human company diagnostic permission required");const input=params as {account:string;routeKey:string};const selected=selectIntakeRoute(await ctx.config.get() as InstanceConfig,run.companyId,input.account,input.routeKey,tool.name!=="helpscout_support_intake_status");if(tool.name==="helpscout_poll_support_intake")return{data:await pollSupportIntake(ctx,run.companyId,input.account,input.routeKey)};const [row]=await ctx.db.query<Cursor>(`SELECT cursor_at,pending_until,pending_offset,pending_conversations,last_error,last_completed_at FROM ${ns(ctx)}.support_intake_routes WHERE route_sha256=$1 AND company_id=$2`,[selected.routeHash,run.companyId]);return{data:row?{cursorAt:row.cursor_at,pendingConversations:row.pending_conversations.length-row.pending_offset,lastError:row.last_error,lastCompletedAt:row.last_completed_at}:{status:"not_started"}};}catch{return{error:"Native intake unavailable; check this company's saved Help Scout route and diagnostic permission"};}});
 ctx.jobs.register("support-intake",async()=>{
   const cfg=await ctx.config.get() as InstanceConfig;
   const routes=(cfg.accounts??[]).flatMap(account=>(account.supportIntakeRoutes??[]).filter(route=>route.enabled).map(route=>({accountKey:account.key??"",route})));
   if(!routes.length)return;
   const state={scopeKind:"instance" as const,namespace:"support-intake",stateKey:"next-route"};
   const saved=await ctx.state.get(state),index=typeof saved==="number"&&Number.isSafeInteger(saved)&&saved>=0?saved%routes.length:0;
   await ctx.state.set(state,(index+1)%routes.length);
   const target=routes[index]!;
   try{await pollSupportIntake(ctx,target.route.companyId,target.accountKey,target.route.key);}catch{/* Other routes get later turns; no raw source/provider error logging. */}
 });
}
