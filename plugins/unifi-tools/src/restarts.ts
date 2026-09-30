import { createHash, randomUUID } from "node:crypto";
import type { PluginContext, ToolRunContext, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { networkRequest, resolveNetworkAccount, uuid, type NetworkAccount, type NetworkConfig } from "./network.js";
function hash(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,stable(item)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
function ns(ctx: PluginContext) { if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Invalid plugin namespace"); return ctx.db.namespace; }
function person(run: ToolRunContext, permission: string) { if (!run.userId || !run.chatSessionId || !uuid.test(run.companyId) || run.userPermission !== permission) throw new Error("Use an authorized human support conversation"); }
interface RestartRow { id: string; company_id: string; account_key: string; site_id: string; device_id: string; config_sha256: string; plan_sha256: string; plan: Record<string, unknown>; baseline: Record<string, unknown>; status: string; expires_at: string; started_at: string | null; verification: unknown }
async function accountFor(ctx: PluginContext, run: ToolRunContext, account: unknown, site: unknown) {
  const cfg = await ctx.config.get() as NetworkConfig;
  if (!cfg.allowDeviceRestarts) throw new Error("Device restarts are disabled in this plugin's settings");
  const selected = resolveNetworkAccount(cfg, run.companyId, account, site);
  return { selected, configHash: hash([selected,cfg.allowDeviceRestarts]) };
}
async function baseline(ctx: PluginContext, account: NetworkAccount, siteId: string, deviceId: string, api = networkRequest) {
  if (!uuid.test(deviceId)) throw new Error("Use an exact device UUID");
  const path = `sites/${siteId}/devices/${deviceId}`;
  const device = await api(ctx,account,path), stats = await api(ctx,account,`${path}/statistics/latest`);
  if (device.id !== deviceId || device.state !== "ONLINE" || device.supported === false || typeof device.configurationId !== "string" || !device.configurationId || typeof stats.uptimeSec !== "number" || !Number.isFinite(stats.uptimeSec) || stats.uptimeSec < 60) throw new Error("Restart preparation requires an online identified device, stable configuration and at least one minute of uptime; updating/adopting/offline devices need investigation");
  return { id:device.id,name:device.name,model:device.model,configurationId:device.configurationId,firmwareVersion:device.firmwareVersion ?? null,uptimeSec:stats.uptimeSec,lastHeartbeatAt:stats.lastHeartbeatAt ?? null };
}
async function owned(ctx: PluginContext,run: ToolRunContext,id: unknown) {
  if(typeof id!=="string" || !uuid.test(id)) throw new Error("Use the prepared action UUID");
  const [row]=await ctx.db.query<RestartRow>(`SELECT * FROM ${ns(ctx)}.restart_actions WHERE company_id=$1 AND id=$2 AND user_id=$3 AND chat_session_id=$4`,[run.companyId,id,run.userId,run.chatSessionId]);
  if(!row)throw new Error("Restart not found in this company/person/conversation");
  return row;
}
export async function prepareRestart(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,api=networkRequest){
  person(run,"support:repair");
  const {selected,configHash}=await accountFor(ctx,run,input.account,input.siteId);
  const observed=await baseline(ctx,selected,input.siteId as string,input.deviceId as string,api),id=randomUUID(),expiresAt=new Date(Date.now()+600000).toISOString();
  const plan={ action:"RESTART",controllerBase:selected.baseUrl,account:selected.key,siteId:input.siteId,deviceId:input.deviceId,deviceName:observed.name,model:observed.model,configurationId:observed.configurationId,firmwareVersion:observed.firmwareVersion,
    effect:"Restart this exact adopted UniFi device. It can disconnect staff, active calls and downstream devices; an AP/switch/gateway restart may interrupt the whole office depending on topology. No factory reset, firmware change or configuration edit.",
    recovery:"A restart cannot restore interrupted calls/transactions. Confirm an alternate management path and a responsible on-site contact before execution. If it does not return, use the qualified network owner and inspected power/uplink/controller status; do not blindly restart it again.",expiresAt };
  const planHash=hash(plan),resourceHash=hash([new URL(selected.baseUrl).href.replace(/\/$/,""),input.siteId,input.deviceId]);
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.restart_actions(id,company_id,user_id,chat_session_id,account_key,site_id,device_id,resource_sha256,config_sha256,plan_sha256,plan,baseline,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::timestamptz)`,[id,run.companyId,run.userId,run.chatSessionId,selected.key,input.siteId,input.deviceId,resourceHash,configHash,planHash,JSON.stringify(plan),JSON.stringify(observed),expiresAt]);
  await ctx.activity.log({companyId:run.companyId,message:"Exact UniFi restart prepared",entityType:"unifi_restart",entityId:id,metadata:{userId:run.userId,planSha256:planHash}});
  return {actionId:id,planSha256:planHash,plan,instruction:"Prepared only. Explain the exact device, downstream disruption and recovery; confirm an alternate management path/on-site contact. Show the full plan in Clippy before unifi_run_restart. No emergency delegation bypass applies to this connector."};
}
export async function postRestart(ctx:PluginContext,account:NetworkAccount,siteId:string,deviceId:string){
  const key=await ctx.secrets.resolve(account.apiKeyRef);
  const response=await ctx.http.fetch(`${account.baseUrl.replace(/\/$/,"")}/v1/sites/${siteId}/devices/${deviceId}/actions`,{method:"POST",redirect:"manual",signal:AbortSignal.timeout(15000),headers:{"X-API-Key":key,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({action:"RESTART"})});
  await response.body?.cancel();
  return response.status===200 ? "accepted" : [401,403,404,405].includes(response.status) ? "not_sent" : "unknown";
}
export async function executeRestart(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,api=networkRequest,send=postRestart){
  person(run,"support:repair");if(!run.userConfirmed)throw new Error("Confirm this exact restart plan in Clippy");
  const row=await owned(ctx,run,input.actionId);
  if(row.plan_sha256!==input.planSha256 || hash(input.confirmedPlan)!==row.plan_sha256 || input.managementRecoveryConfirmed!==true)throw new Error("Confirm the full unchanged device/disruption/recovery plan and alternate management/on-site recovery arrangement");
  if(row.status!=="draft")return {actionId:row.id,status:row.status,attemptedAgain:false,instruction:"Read the existing receipt. Accepted/unknown restarts are never automatically repeated."};
  if(Date.parse(row.expires_at)<Date.now())throw new Error("Restart plan expired; investigate and prepare a new one");
  const resolved=await accountFor(ctx,run,row.account_key,row.site_id);
  if(resolved.configHash!==row.config_sha256)throw new Error("Controller access/configuration changed; prepare a new plan");
  const current=await baseline(ctx,resolved.selected,row.site_id,row.device_id,api);
  if(current.configurationId!==row.baseline.configurationId || current.model!==row.baseline.model || current.firmwareVersion!==row.baseline.firmwareVersion || current.name!==row.baseline.name || (current.uptimeSec as number)<(row.baseline.uptimeSec as number))throw new Error("Device changed or restarted since preparation; investigate before a new plan");
  if((await accountFor(ctx,run,row.account_key,row.site_id)).configHash!==row.config_sha256)throw new Error("Controller access changed before execution");
  let claimed;
  try {claimed=await ctx.db.execute(`UPDATE ${ns(ctx)}.restart_actions SET status='running',started_at=now(),baseline=$5::jsonb WHERE company_id=$1 AND id=$2 AND user_id=$3 AND chat_session_id=$4 AND status='draft' AND expires_at>=now()`,[run.companyId,row.id,run.userId,run.chatSessionId,JSON.stringify(current)]);}catch{throw new Error("Another unsettled restart exists for this device; inspect its receipt before any further action");}
  if(claimed.rowCount!==1)return {actionId:row.id,status:"already_claimed",attemptedAgain:false};
  // Durable running claim precedes the one external attempt. Lost responses stay unknown.
  let status="unknown";
  try {status=await send(ctx,resolved.selected,row.site_id,row.device_id);}catch{/* No automatic replay. */}
  await ctx.db.execute(`UPDATE ${ns(ctx)}.restart_actions SET status=$3,finished_at=now() WHERE company_id=$1 AND id=$2 AND status='running'`,[run.companyId,row.id,status]);
  await ctx.activity.log({companyId:run.companyId,message:`UniFi restart ${status}`,entityType:"unifi_restart",entityId:row.id,metadata:{userId:run.userId,planSha256:row.plan_sha256,status}});
  return {actionId:row.id,status,instruction:"Accepted means the controller returned HTTP 200, not that the device rebooted or the symptom is fixed. Use unifi_restart_status after it reconnects. Unknown outcomes block further restarts and require provider inspection; never automatically retry."};
}
export async function restartStatus(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,api=networkRequest){
  person(run,"support:diagnose");let row=await owned(ctx,run,input.actionId);
  await ctx.db.execute(`UPDATE ${ns(ctx)}.restart_actions SET status='unknown',finished_at=now() WHERE company_id=$1 AND id=$2 AND status='running' AND started_at<now()-interval '2 minutes'`,[run.companyId,row.id]);
  row=await owned(ctx,run,input.actionId);
  if(!["accepted","unknown"].includes(row.status))return {actionId:row.id,status:row.status,verification:row.verification};
  const selected=resolveNetworkAccount(await ctx.config.get() as NetworkConfig,run.companyId,row.account_key,row.site_id);
  let verification:unknown={status:"unavailable",restartObserved:false};let shouldVerify=false;
  try{
    const device=await api(ctx,selected,`sites/${row.site_id}/devices/${row.device_id}`),stats=await api(ctx,selected,`sites/${row.site_id}/devices/${row.device_id}/statistics/latest`);
    const elapsed=(Date.now()-Date.parse(row.started_at!))/1000;
    const observed=device.id===row.device_id && device.model===row.baseline.model && device.configurationId===row.baseline.configurationId && device.state==="ONLINE" && typeof stats.uptimeSec==="number" && stats.uptimeSec>=0 && stats.uptimeSec<(row.baseline.uptimeSec as number) && stats.uptimeSec<=elapsed+30 && typeof stats.lastHeartbeatAt==="string" && Date.parse(stats.lastHeartbeatAt)>Date.parse(row.started_at!) && Date.parse(stats.lastHeartbeatAt)<=Date.now()+30000;
    verification={status:"available",deviceState:device.state,uptimeSec:stats.uptimeSec ?? null,lastHeartbeatAt:stats.lastHeartbeatAt ?? null,restartObserved:observed,observedAtUtc:new Date().toISOString()};
    shouldVerify=observed && row.status==="accepted";
  }catch{/* No fabricated healthy result. */}
  const latest=resolveNetworkAccount(await ctx.config.get() as NetworkConfig,run.companyId,row.account_key,row.site_id);
  if(hash(latest)!==hash(selected))throw new Error("Controller access changed during recovery inspection");
  if(shouldVerify)await ctx.db.execute(`UPDATE ${ns(ctx)}.restart_actions SET status='verified',verification=$3::jsonb WHERE company_id=$1 AND id=$2 AND status='accepted'`,[run.companyId,row.id,JSON.stringify(verification)]);
  await ctx.db.execute(`UPDATE ${ns(ctx)}.restart_actions SET verification=$3::jsonb WHERE company_id=$1 AND id=$2`,[run.companyId,row.id,JSON.stringify(verification)]);
  await ctx.activity.log({companyId:run.companyId,message:"UniFi restart recovery inspected",entityType:"unifi_restart",entityId:row.id,metadata:{userId:run.userId,restartVerified:shouldVerify}});
  return {actionId:row.id,status:(await owned(ctx,run,row.id)).status,verification,instruction:"A reset uptime and new heartbeat on the online unchanged device are restart observations, not proof every client recovered or the original symptom is gone. Unknown delivery stays unknown even if a reboot is observed; inspect the controller before any new restart. No repeated command was sent."};
}
/** An operator releases the interlock after inspecting the controller. This never
 * changes an uncertain receipt into proof of success or replays its command. */
export async function reconcileRestart(ctx:PluginContext,run:ToolRunContext,input:Record<string,unknown>,api=networkRequest){
  person(run,"support:repair");
  const row=await owned(ctx,run,input.actionId);
  if(!run.userConfirmed || row.plan_sha256!==input.planSha256 || hash(input.confirmedPlan)!==row.plan_sha256 || input.acknowledgeUncertainDelivery!==true || input.managementRecoveryConfirmed!==true)throw new Error("Confirm the full original plan, uncertain delivery acknowledgement and recovery arrangement");
  const reference=input.inspectionReference;
  if(typeof reference!=="string" || reference.trim().length<10 || reference.length>500 || /(?:password|secret|token|api.?key)\s*[:=]|:\/\/[^\s/]+:[^\s/]+@/i.test(reference))throw new Error("Provide a non-secret controller inspection reference, not credentials");
  if(row.status==="acknowledged")return{actionId:row.id,status:row.status,commandSent:false};
  if(!["unknown","accepted"].includes(row.status) || !row.started_at || Date.now()-Date.parse(row.started_at)<120000)throw new Error("Inspect an unsettled receipt after at least two minutes; do not release an in-flight restart");
  const resolved=await accountFor(ctx,run,row.account_key,row.site_id);
  const current=await baseline(ctx,resolved.selected,row.site_id,row.device_id,api);
  if(current.model!==row.baseline.model || current.configurationId!==row.baseline.configurationId)throw new Error("The device identity/configuration changed; investigate with the network owner");
  if((await accountFor(ctx,run,row.account_key,row.site_id)).configHash!==resolved.configHash)throw new Error("Controller access changed during inspection");
  const reconciliation={previousStatus:row.status,provenance:"operator_attested",inspectionReference:reference.trim(),observedAtUtc:new Date().toISOString(),device:current,userId:run.userId,uncertainDeliveryAcknowledged:true};
  await ctx.db.execute(`UPDATE ${ns(ctx)}.restart_actions SET status='acknowledged',reconciliation=$3::jsonb WHERE company_id=$1 AND id=$2 AND status IN ('unknown','accepted')`,[run.companyId,row.id,JSON.stringify(reconciliation)]);
  await ctx.activity.log({companyId:run.companyId,message:"Operator acknowledged unsettled UniFi restart after inspection",entityType:"unifi_restart",entityId:row.id,metadata:{userId:run.userId,previousStatus:row.status,planSha256:row.plan_sha256}});
  return{actionId:row.id,status:(await owned(ctx,run,row.id)).status,reconciliation,commandSent:false,instruction:"The interlock was released by operator acknowledgement after a fresh online inspection. Original delivery remains uncertain; this is not proof of success, rollback or symptom closure. Any further restart needs a separately prepared and confirmed plan."};
}
const actionId={type:"string"};
export const restartTools:NonNullable<PaperclipPluginManifestV1["tools"]>=[
  {name:"unifi_reconcile_restart",displayName:"Acknowledge an inspected uncertain restart",requiredUserPermission:"support:repair",requiresUserConfirmation:true,writes:true,executionTimeoutMs:45000,description:"After at least two minutes, release an accepted/unknown restart interlock only through explicit human acknowledgement, a controller inspection reference, the full original plan and recovery arrangement. Requires a fresh online unchanged-device inspection. Preserves original uncertainty and sends no command; never claims success or retries.",parametersSchema:{type:"object",additionalProperties:false,properties:{actionId:{type:"string"},planSha256:{type:"string"},confirmedPlan:{type:"object",additionalProperties:true},managementRecoveryConfirmed:{type:"boolean",enum:[true]},acknowledgeUncertainDelivery:{type:"boolean",enum:[true]},inspectionReference:{type:"string",minLength:10,maxLength:500}},required:["actionId","planSha256","confirmedPlan","managementRecoveryConfirmed","acknowledgeUncertainDelivery","inspectionReference"]}},
  {name:"unifi_prepare_restart",displayName:"Preview exact UniFi restart",requiredUserPermission:"support:repair",writes:true,description:"Prepare a company-owned exact online device restart with a fresh configuration/uptime baseline. No restart runs. Show target, downstream disruption, recovery and full plan before confirming. Saved device-restart opt-in and repair permission are required.",parametersSchema:{type:"object",additionalProperties:false,properties:{account:{type:"string"},siteId:{type:"string"},deviceId:{type:"string"}},required:["account","siteId","deviceId"]}},
  {name:"unifi_run_restart",displayName:"Run the exact reviewed UniFi restart",requiredUserPermission:"support:repair",requiresUserConfirmation:true,writes:true,executionTimeoutMs:60000,description:"Confirm the full prepared plan and alternate management/on-site recovery arrangement. Rechecks current company/account/device configuration and sends RESTART once. Durable claims serialize the exact controller/site/device. No retry after accepted/unknown responses; no emergency bypass, factory reset or firmware edit.",parametersSchema:{type:"object",additionalProperties:false,properties:{actionId,planSha256:{type:"string"},confirmedPlan:{type:"object",additionalProperties:true},managementRecoveryConfirmed:{type:"boolean",enum:[true]}},required:["actionId","planSha256","confirmedPlan","managementRecoveryConfirmed"]}},
  {name:"unifi_restart_status",displayName:"Inspect UniFi restart receipt and recovery",requiredUserPermission:"support:diagnose",executionTimeoutMs:45000,description:"Read a prepared restart in this company/person/Clippy conversation and, after an attempt, observe exact device/uptime/heartbeat recovery. Never resends. A controller 200 is acceptance; an online device with reset uptime/new heartbeat is an observed restart, not symptom closure. Unknown delivery remains blocked for operator inspection.",parametersSchema:{type:"object",additionalProperties:false,properties:{actionId},required:["actionId"]}},
];
