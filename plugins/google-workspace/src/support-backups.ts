import { createHash } from "node:crypto";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { drive as driveApi } from "@googleapis/drive";
import { consumeObservation, observationEvent, type ObservationRequest } from "../../../lib/support-observations.js";
import { getGoogleAccount, type InstanceConfig } from "./googleAuth.js";
import { verifyMarkdownBackup, type BackupDrive, type BackupFile } from "./backup-verification.js";

export function backupProfile(cfg: InstanceConfig, companyId: string, accountKey: string, key: string) {
  const accounts = (cfg.accounts ?? []).filter(a=>a.key?.toLowerCase() === accountKey.toLowerCase());
  const account = accounts[0];
  if (accounts.length !== 1 || !account?.allowedCompanies?.includes(companyId)) throw new Error("Exact backup account/company required");
  const profiles = (account.backupVerificationProfiles ?? []).filter(p=>p.key === key && p.companyId === companyId);
  const profile = profiles[0];
  if (profiles.length !== 1 || !profile?.enabled || !/^[a-z0-9_-]{1,100}$/i.test(key) || !/^[a-zA-Z0-9_-]{1,200}$/.test(profile.driveFolderId) || typeof profile.sourceRoot !== "string") throw new Error("Backup profile is not opted in");
  const fingerprint = createHash("sha256").update(JSON.stringify([profile, account.clientIdRef,account.clientSecretRef,account.refreshTokenRef,account.scopes])).digest("hex");
  return {profile,fingerprint};
}
const fields = "id,name,mimeType,parents,trashed,md5Checksum,size,version,modifiedTime,capabilities(canDownload)";
export function driveBackupPort(api: ReturnType<typeof driveApi>, deadline: number): BackupDrive {
  const options = () => ({timeout:Math.max(1,Math.min(10000,deadline-Date.now())),maxRedirects:0,maxContentLength:1024*1024,retry:false});
  return {
    metadata: async id => (await api.files.get({fileId:id,fields,supportsAllDrives:true},options())).data as BackupFile,
    children: async id => {
      const result = await api.files.list({q:`'${id}' in parents and trashed = false`,pageSize:100,fields:`nextPageToken,incompleteSearch,files(${fields})`,supportsAllDrives:true,includeItemsFromAllDrives:true},options());
      return {files:result.data.files ?? [],incomplete:!!result.data.nextPageToken || !!result.data.incompleteSearch};
    },
    download: async id => {
      const response = await api.files.get({fileId:id,alt:"media",supportsAllDrives:true},{...options(),responseType:"arraybuffer"});
      if (!(response.data instanceof ArrayBuffer) && !Buffer.isBuffer(response.data)) throw new Error("Unsupported media response");
      return Buffer.from(response.data as ArrayBuffer);
    },
  };
}
export async function readBackupObservation(ctx: PluginContext, request: ObservationRequest, factory?: (resolved: Awaited<ReturnType<typeof getGoogleAccount>>, deadline: number)=>BackupDrive) {
  const initial = backupProfile(await ctx.config.get() as InstanceConfig,request.companyId,request.account,request.resourceId);
  const deadline = Math.min(Date.parse(request.expiresAt),Date.now()+45000);
  const guard = async()=>{
    if (Date.now() >= deadline || backupProfile(await ctx.config.get() as InstanceConfig,request.companyId,request.account,request.resourceId).fingerprint !== initial.fingerprint) throw new Error("Backup profile changed or expired");
  };
  await guard();
  const run = {companyId:request.companyId,agentId:"",runId:request.requestId} as ToolRunContext;
  const resolved = await getGoogleAccount(ctx,run,"support-backup-verification",request.account);
  await guard();
  const port = factory ? factory(resolved,deadline) : driveBackupPort(driveApi({version:"v3",auth:resolved.oauth2Client}),deadline);
  const findings = await verifyMarkdownBackup(initial.profile.sourceRoot,initial.profile.driveFolderId,port,guard);
  await guard();
  await ctx.activity.log({companyId:request.companyId,message:"Scoped Markdown cloud backup/temporary restore verification completed",entityType:"support_observation",entityId:request.requestId,metadata:{status:findings.status,sourceFiles:findings.sourceFiles,restoreTestedFiles:findings.restoreTestedFiles,temporaryFilesRemoved:findings.temporaryFilesRemoved}});
  return findings;
}
export function registerBackupObservations(ctx: PluginContext) {
  ctx.events.on(observationEvent,event=>consumeObservation(ctx,"google-workspace",event,request=>readBackupObservation(ctx,request)));
}
