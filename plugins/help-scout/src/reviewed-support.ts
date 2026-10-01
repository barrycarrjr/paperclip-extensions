import { createHash,randomUUID } from "node:crypto";
import type { PluginContext,ToolRunContext,PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { getHelpScoutAccount,type InstanceConfig,type ResolvedAccount,type ConfigAccount } from "./helpScoutClient.js";
import { companySupportMailboxes } from "./support-observations.js";
import { containsCredential } from "../../../lib/support-delivery.js";
class SupportActionError extends Error {}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,id=/^[1-9][0-9]{0,14}$/;
function hash(value:unknown){const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):v;return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");}
function ns(ctx:PluginContext){if(!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace))throw new SupportActionError("Invalid namespace");return ctx.db.namespace;}
function person(run:ToolRunContext,permission:string){if(!run.userId||!run.chatSessionId||!uuid.test(run.companyId)||run.userPermission!==permission)throw new SupportActionError("Use an authorized human company support conversation");}
function text(value:unknown,max=10000){if(typeof value!=="string"||!value.trim()||value.length>max||containsCredential(value)||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw new SupportActionError("Use plain reviewed text without credentials");return value.trim();}
async function configuration(ctx:PluginContext,run:ToolRunContext,key:unknown){
 const cfg=await ctx.config.get() as InstanceConfig;
 if(!cfg.allowMutations||typeof key!=="string")throw new SupportActionError("Help Scout changes disabled; choose a saved account");
 companySupportMailboxes(cfg,run.companyId,key);
 const account=cfg.accounts!.find(a=>a.key?.toLowerCase()===key.toLowerCase())!;
 if(!account.supportActionsEnabled)throw new SupportActionError("Reviewed support actions are disabled for this account");
 return{account,cfg,configHash:hash([account,cfg.allowMutations])};
}
export async function supportRead(ctx:PluginContext,account:ResolvedAccount,path:string){
 const response=await ctx.http.fetch(`https://api.helpscout.net/v2${path}`,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${account.apiKey}`,Accept:"application/json"}});
 if(!response.ok){await response.body?.cancel();throw new SupportActionError("Help Scout read unavailable; inspect access/API status. Moved conversations require separate review.");}
 const reader=response.body?.getReader();if(!reader)throw new SupportActionError("Help Scout returned no body");const decoder=new TextDecoder();let value="",size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1000000)throw new SupportActionError("Help Scout response exceeded bound");value+=decoder.decode(part.value,{stream:true});}value+=decoder.decode();}finally{await reader.cancel();}
 return JSON.parse(value) as Record<string,unknown>;
}
type Read=typeof supportRead;
function tags(conversation:Record<string,unknown>){if(!Array.isArray(conversation.tags)||conversation.tags.length>100)throw new SupportActionError("Conversation tag list unavailable or too large");return conversation.tags.map(t=>text((t as {tag?:unknown}).tag,80).toLowerCase()).sort();}
async function observe(ctx:PluginContext,run:ToolRunContext,key:string,conversationId:string,read:Read,resolve= getHelpScoutAccount){
 const scope=await configuration(ctx,run,key),account=await resolve(ctx,run.companyId,"reviewed-support",key);
 const conversation=await read(ctx,account,`/conversations/${conversationId}`);
 if(String(conversation.id)!==conversationId||!companySupportMailboxes(scope.cfg,run.companyId,key).includes(String(conversation.mailboxId))||typeof conversation.modifiedAt!=="string"||!Number.isFinite(Date.parse(conversation.modifiedAt)))throw new SupportActionError("Exact conversation identity/company mailbox or modification time unavailable");
 const mailbox=await read(ctx,account,`/mailboxes/${conversation.mailboxId}`);
 if(String(mailbox.id)!==String(conversation.mailboxId))throw new SupportActionError("Mailbox identity mismatch");
 const baseline={id:conversationId,mailboxId:String(conversation.mailboxId),modifiedAt:conversation.modifiedAt,status:conversation.status,customer:conversation.primaryCustomer,assignee:conversation.assignee,tags:tags(conversation),mailboxEmail:mailbox.email};
 if((await configuration(ctx,run,key)).configHash!==scope.configHash)throw new SupportActionError("Help Scout access changed during inspection");
 return{...scope,account,conversation,mailbox,baseline};
}
interface ActionRow{id:string;company_id:string;account_key:string;conversation_id:string;kind:string;status:string;config_sha256:string;baseline_sha256:string;plan_sha256:string;plan:Record<string,unknown>;expires_at:string;started_at:string|null;reference:string|null;verification:unknown}
async function owned(ctx:PluginContext,run:ToolRunContext,actionId:unknown){if(typeof actionId!=="string"||!uuid.test(actionId))throw new SupportActionError("Use a prepared action UUID");const [row]=await ctx.db.query<ActionRow>(`SELECT * FROM ${ns(ctx)}.reviewed_support_actions WHERE company_id=$1 AND id=$2 AND user_id=$3 AND chat_session_id=$4`,[run.companyId,actionId,run.userId,run.chatSessionId]);if(!row)throw new SupportActionError("Action not found in this company/person/conversation");return row;}
export async function prepareSupportAction(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,read:Read=supportRead,resolve=getHelpScoutAccount){
 const kind=input.kind;person(run,kind==="reply"?"support:respond":"support:repair");
 if(!["reply","tags","assign"].includes(String(kind))||typeof input.account!=="string"||typeof input.conversationId!=="string"||!id.test(input.conversationId))throw new SupportActionError("Choose reply, tags or assign on an exact saved-account conversation");
 const observed=await observe(ctx,run,input.account,input.conversationId,read,resolve);
 let change:Record<string,unknown>,effect:string;
 if(kind==="reply"){
   const customer=observed.conversation.primaryCustomer as {id?:unknown;email?:unknown}|undefined;
   if(!customer||!id.test(String(customer.id))||typeof customer.email!=="string"||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email))throw new SupportActionError("Actual conversation customer/recipient is unavailable");
   const brands=observed.account.account.supportBrands??[];
   const matches=brands.filter(b=>b.companyId===run.companyId&&b.mailboxId===String(observed.conversation.mailboxId));
   if(matches.length!==1||matches[0]!.replyEmail.toLowerCase()!==String(observed.mailbox.email).toLowerCase())throw new SupportActionError("Save one exact brand/mailbox reply address matching the actual mailbox before replying");
   const brand=matches[0]!;const body=text(input.body),signature=brand.signature?text(brand.signature,2000):"";
   change={recipientId:String(customer.id),recipientEmail:text(customer.email,255),fromEmail:text(brand.replyEmail,255),brand:text(brand.name,150),text:signature?`${body}\n\n${signature}`:body};
   effect="Send this exact text to the conversation's primary customer from its saved brand mailbox. No CC/BCC or attachment. Help Scout normally reactivates the conversation when replying; provider acceptance does not prove customer email delivery. Sent email cannot be rolled back.";
 }else if(kind==="tags"){
   if(!Array.isArray(input.addTags)||!input.addTags.length||input.addTags.length>10)throw new SupportActionError("Choose one to ten plain tag names");
   const requested=input.addTags.map(t=>text(t,80).toLowerCase());change={before:observed.baseline.tags,after:[...new Set([...observed.baseline.tags,...requested])].sort()};
   effect="Add these tags while preserving the displayed existing set. Help Scout may create a missing tag and run configured workflows. Concurrent provider edits remain possible; verify afterwards. Restoration requires a new reviewed action.";
 }else{
   if(typeof input.assigneeId!=="string"||!id.test(input.assigneeId))throw new SupportActionError("Choose an exact Help Scout user/team ID");
   const assignee=await read(ctx,observed.account,`/users/${input.assigneeId}`);
   if(!["user","team"].includes(String(input.assigneeType))||String(assignee.id)!==input.assigneeId||assignee.type!==input.assigneeType)throw new SupportActionError("Actual Help Scout assignee identity unavailable");
   change={before:observed.conversation.assignee??null,assigneeId:input.assigneeId,assigneeType:input.assigneeType,assigneeName:assignee.name??[assignee.firstName,assignee.lastName].filter(Boolean).join(" ")};
   effect="Replace this exact conversation's owner with the displayed Help Scout user/team. This can trigger configured workflows and notifications. Reverting needs a separately reviewed action using the recorded previous owner.";
 }
 if((await configuration(ctx,run,input.account)).configHash!==observed.configHash)throw new SupportActionError("Help Scout access changed during preparation");
 const actionId=randomUUID(),expiresAt=new Date(Date.now()+600000).toISOString(),plan={kind,account:input.account,conversationId:input.conversationId,mailboxId:String(observed.conversation.mailboxId),mailboxName:text(observed.mailbox.name,255),change,effect,expiresAt},planSha256=hash(plan);
 await ctx.db.execute(`INSERT INTO ${ns(ctx)}.reviewed_support_actions(id,company_id,user_id,chat_session_id,account_key,conversation_id,kind,resource_sha256,config_sha256,baseline_sha256,plan_sha256,plan,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz)`,[actionId,run.companyId,run.userId,run.chatSessionId,input.account,input.conversationId,kind,hash(["help-scout-conversation",input.conversationId]),observed.configHash,hash(observed.baseline),planSha256,JSON.stringify(plan),expiresAt]);
 await ctx.activity.log({companyId:run.companyId,message:"Exact Help Scout support action prepared",entityType:"helpscout_support_action",entityId:actionId,metadata:{userId:run.userId,kind,planSha256}});
 return{actionId,planSha256,plan,instruction:"Prepared only. Show the full mailbox/recipient or tag/owner plan and effects in Clippy before asking for inline confirmation. No message or change was sent."};
}
export async function sendSupportAction(ctx:PluginContext,account:ResolvedAccount,plan:Record<string,unknown>){
 const change=plan.change as Record<string,unknown>,kind=plan.kind;
 const path=`/conversations/${plan.conversationId}${kind==="reply"?"/reply":kind==="tags"?"/tags":""}`;
 const body=kind==="reply"?{customer:{id:Number(change.recipientId)},text:change.text,draft:false}:kind==="tags"?{tags:change.after}:{op:"replace",path:"/assignTo",value:Number(change.assigneeId)};
 const response=await ctx.http.fetch(`https://api.helpscout.net/v2${path}`,{method:kind==="reply"?"POST":kind==="tags"?"PUT":"PATCH",redirect:"manual",signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${account.apiKey}`,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(body)});
 await response.body?.cancel();const reference=response.headers.get("resource-id");
 return{status:response.status===(kind==="reply"?201:204)?"accepted":[400,401,403,404,405,412,422,429].includes(response.status)?"not_sent":"unknown",reference:kind==="reply"&&reference&&id.test(reference)?reference:null};
}
export async function runSupportAction(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,kind:"reply"|"change",read:Read=supportRead,resolve=getHelpScoutAccount,send=sendSupportAction){
 person(run,kind==="reply"?"support:respond":"support:repair");const row=await owned(ctx,run,input.actionId);
 if((kind==="reply")!==(row.kind==="reply")||!run.userConfirmed||input.planSha256!==row.plan_sha256||hash(input.confirmedPlan)!==row.plan_sha256)throw new SupportActionError("Confirm the exact full prepared action with its required permission");
 if(row.status!=="draft")return{actionId:row.id,status:row.status,reference:row.reference,attemptedAgain:false};
 if(Date.parse(row.expires_at)<Date.now())throw new SupportActionError("Action expired; inspect again before preparing a new plan");
 const current=await observe(ctx,run,row.account_key,row.conversation_id,read,resolve);
 if(current.configHash!==row.config_sha256||hash(current.baseline)!==row.baseline_sha256)throw new SupportActionError("Conversation, recipient, mailbox or access changed; prepare a new exact plan");
 let claimed;try{claimed=await ctx.db.execute(`UPDATE ${ns(ctx)}.reviewed_support_actions SET status='sending',started_at=now() WHERE company_id=$1 AND id=$2 AND status='draft' AND expires_at>=now()`,[run.companyId,row.id]);}catch{throw new SupportActionError("An uncertain action exists for this conversation; inspect it before further changes");}
 if(claimed.rowCount!==1)return{actionId:row.id,status:"already_claimed",attemptedAgain:false};
 let result={status:"unknown",reference:null as string|null};try{result=await send(ctx,current.account,row.plan);}catch{/* Durable claim remains uncertain, no retry. */}
 await ctx.db.execute(`UPDATE ${ns(ctx)}.reviewed_support_actions SET status=$3,reference=$4,finished_at=now() WHERE company_id=$1 AND id=$2 AND status='sending'`,[run.companyId,row.id,result.status,result.reference]);
 await ctx.activity.log({companyId:run.companyId,message:`Help Scout reviewed action ${result.status}`,entityType:"helpscout_support_action",entityId:row.id,metadata:{kind:row.kind,userId:run.userId,planSha256:row.plan_sha256,status:result.status}});
 return{actionId:row.id,...result,instruction:"Provider acceptance is not verified state, customer delivery or symptom closure. Inspect with helpscout_support_action_status. Unknown delivery blocks further changes and is never automatically repeated."};
}
export async function supportActionStatus(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,read:Read=supportRead,resolve=getHelpScoutAccount){
 person(run,"support:diagnose");let row=await owned(ctx,run,input.actionId);
 await ctx.db.execute(`UPDATE ${ns(ctx)}.reviewed_support_actions SET status='unknown',finished_at=now() WHERE company_id=$1 AND id=$2 AND status='sending' AND started_at<now()-interval '2 minutes'`,[run.companyId,row.id]);row=await owned(ctx,run,row.id);
 const cfg=await ctx.config.get() as InstanceConfig;companySupportMailboxes(cfg,run.companyId,row.account_key);
 let verification:unknown={status:"unavailable",expectedStateObserved:false};
 try{
   const account=await resolve(ctx,run.companyId,"support-action-inspection",row.account_key),conversation=await read(ctx,account,`/conversations/${row.conversation_id}`);
   if(String(conversation.id)!==row.conversation_id||!companySupportMailboxes(cfg,run.companyId,row.account_key).includes(String(conversation.mailboxId)))throw new SupportActionError("Company conversation changed");
   const change=row.plan.change as Record<string,unknown>;let matched=false;
   if(row.kind==="tags")matched=hash(tags(conversation))===hash(change.after);
   if(row.kind==="assign")matched=String((conversation.assignee as {id?:unknown}|undefined)?.id)===change.assigneeId;
   if(row.kind==="reply"&&row.reference){const page=await read(ctx,account,`/conversations/${row.conversation_id}/threads`);const thread=((page._embedded as {threads?:Record<string,unknown>[]}|undefined)?.threads??[]).find(t=>String(t.id)===row.reference);matched=thread?.state==="published"&&thread.type==="message";}
   verification={status:"available",expectedStateObserved:matched,observedAtUtc:new Date().toISOString(),mailboxId:conversation.mailboxId,limitation:"A published provider thread does not prove customer email delivery. State matching does not prove this action caused it."};
 }catch{/* No fabricated clean result. */}
 if(hash(await ctx.config.get())!==hash(cfg))throw new SupportActionError("Help Scout access changed during inspection");
 await ctx.db.execute(`UPDATE ${ns(ctx)}.reviewed_support_actions SET verification=$3::jsonb WHERE company_id=$1 AND id=$2`,[run.companyId,row.id,JSON.stringify(verification)]);
 return{actionId:row.id,status:row.status,reference:row.reference,verification,plan:row.plan,planSha256:row.plan_sha256,instruction:"No command was repeated. An unknown receipt remains unknown even if matching state is observed. Inspect provider logs before acknowledging it; email cannot be rolled back."};
}
export async function acknowledgeSupportAction(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,read:Read=supportRead,resolve=getHelpScoutAccount){
 const row=await owned(ctx,run,input.actionId);person(run,row.kind==="reply"?"support:respond":"support:repair");
 if(!run.userConfirmed||input.planSha256!==row.plan_sha256||hash(input.confirmedPlan)!==row.plan_sha256||input.acknowledgeUncertainDelivery!==true)throw new SupportActionError("Confirm the full original plan and uncertain delivery acknowledgement");
 const reference=text(input.inspectionReference,500);if(reference.length<10)throw new SupportActionError("Provide a controller/provider inspection reference");
 if(row.status==="acknowledged")return{status:row.status,commandSent:false};
 if(row.status!=="unknown"||!row.started_at||Date.now()-Date.parse(row.started_at)<120000)throw new SupportActionError("Inspect an unknown receipt after two minutes; no in-flight release");
 const current=await observe(ctx,run,row.account_key,row.conversation_id,read,resolve);
 const reconciliation={previousStatus:row.status,inspectionReference:reference,provenance:"operator_attested",userId:run.userId,observedAtUtc:new Date().toISOString(),mailboxId:current.baseline.mailboxId};
 await ctx.db.execute(`UPDATE ${ns(ctx)}.reviewed_support_actions SET status='acknowledged',reconciliation=$3::jsonb WHERE company_id=$1 AND id=$2 AND status='unknown'`,[run.companyId,row.id,JSON.stringify(reconciliation)]);
 await ctx.activity.log({companyId:run.companyId,message:"Operator acknowledged an inspected uncertain Help Scout action",entityType:"helpscout_support_action",entityId:row.id,metadata:{userId:run.userId,planSha256:row.plan_sha256}});
 return{status:(await owned(ctx,run,row.id)).status,reconciliation,commandSent:false,instruction:"Operator acknowledgement released the interlock; original delivery remains uncertain. No email/change was repeated or rolled back. A further action needs new preparation and consent."};
}
type SupportTool=NonNullable<PaperclipPluginManifestV1["tools"]>[number];
const prepared={actionId:{type:"string"},planSha256:{type:"string"},confirmedPlan:{type:"object",additionalProperties:true}};
export const reviewedSupportTools:NonNullable<PaperclipPluginManifestV1["tools"]>=[
 {name:"helpscout_prepare_support_reply",displayName:"Preview brand-aware Help Scout reply",requiredUserPermission:"support:respond",writes:true,description:"Prepare only: read exact company-owned conversation/mailbox/customer and saved brand address/signature. Show full text, sender, recipient and reactivation/email effects. No CC/BCC, attachment or send.",parametersSchema:{type:"object",additionalProperties:false,properties:{account:{type:"string"},conversationId:{type:"string"},body:{type:"string",maxLength:10000}},required:["account","conversationId","body"]}},
 {name:"helpscout_prepare_support_change",displayName:"Preview Help Scout tags or assignment",requiredUserPermission:"support:repair",writes:true,description:"Prepare exact company-owned conversation tag additions or owner assignment after actual mailbox/current-state reads. Preserve all displayed existing tags; inspect actual user/team identity. Explain workflow effects and recovery. No mailbox/domain/status change.",parametersSchema:{type:"object",additionalProperties:false,properties:{account:{type:"string"},conversationId:{type:"string"},kind:{type:"string",enum:["tags","assign"]},addTags:{type:"array",items:{type:"string"},maxItems:10},assigneeId:{type:"string"},assigneeType:{type:"string",enum:["user","team"]}},required:["account","conversationId","kind"]}},
 ...(["reply","change"] as const).map<SupportTool>(kind=>({name:`helpscout_run_support_${kind}`,displayName:`Run reviewed Help Scout ${kind}`,requiredUserPermission:kind==="reply"?"support:respond":"support:repair",requiresUserConfirmation:true,writes:true,executionTimeoutMs:60000,description:"Require full displayed plan and inline human consent. Recheck actual company conversation/customer/mailbox/configuration, then journal one external attempt. Unknown outcomes block further changes; no automatic retry. Provider acceptance is distinct from delivery/state verification.",parametersSchema:{type:"object",additionalProperties:false,properties:prepared,required:Object.keys(prepared)}})),
 {name:"helpscout_support_action_status",displayName:"Inspect Help Scout action receipt",requiredUserPermission:"support:diagnose",executionTimeoutMs:45000,description:"Read this person's/company's/Clippy conversation receipt and inspect exact provider state. No re-send. Provider published reply is not proof customer received email; unavailable is not healthy. Unknown remains uncertain.",parametersSchema:{type:"object",additionalProperties:false,properties:{actionId:{type:"string"}},required:["actionId"]}},
 ...(["reply","change"] as const).map<SupportTool>(kind=>({name:`helpscout_acknowledge_support_${kind}`,displayName:`Acknowledge inspected uncertain Help Scout ${kind}`,requiredUserPermission:kind==="reply"?"support:respond":"support:repair",requiresUserConfirmation:true,writes:true,executionTimeoutMs:45000,description:"After provider inspection and two minutes, explicitly acknowledge an unknown receipt with the full original plan/reference. Fresh company mailbox inspection required. Releases interlock but preserves uncertainty; no retry, delivery claim or rollback.",parametersSchema:{type:"object",additionalProperties:false,properties:{...prepared,inspectionReference:{type:"string",minLength:10,maxLength:500},acknowledgeUncertainDelivery:{type:"boolean",enum:[true]}},required:[...Object.keys(prepared),"inspectionReference","acknowledgeUncertainDelivery"]}})),
];
export function registerReviewedSupport(ctx:PluginContext){for(const tool of reviewedSupportTools)ctx.tools.register(tool.name,tool,async(params,run)=>{try{const input=params as Record<string,unknown>;if(run.userPermission!==tool.requiredUserPermission)throw new SupportActionError("Support permission required");return{data:tool.name.includes("prepare")?await prepareSupportAction(ctx,run,{...input,kind:tool.name.endsWith("reply")?"reply":input.kind}):tool.name.includes("acknowledge")?await acknowledgeSupportAction(ctx,run,input):tool.name.includes("run_support")?await runSupportAction(ctx,run,input,tool.name.endsWith("reply")?"reply":"change"):await supportActionStatus(ctx,run,input)};}catch(error){return{error:error instanceof SupportActionError?error.message:"Help Scout reviewed action unavailable; inspect its receipt before another attempt"};}});}
