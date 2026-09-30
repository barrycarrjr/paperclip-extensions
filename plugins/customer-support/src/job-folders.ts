import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError,type Config } from "./routing.js";
import { ns,person,openInteractiveCase,ownedCase,runInteractiveRepair } from "./interactive-support.js";
import { diagnosticScript } from "./diagnostic-catalog.js";
import { resolveRemoteAccess } from "./remote-access.js";
import { runRemoteActionScript,runRemoteActionScriptUnlocked } from "./remote-action.js";
import { validJobComponent,validJobTemplate,validJobRoot } from "./job-folder-schema.js";
import type { DirectoryRecord } from "./directory-schema.js";
export async function jobSource(name: string) {
  const installed = new URL(`./scripts/${name}`,import.meta.url);
  return readFile(existsSync(installed) ? installed : new URL(`../scripts/${name}`,import.meta.url),"utf8");
}
export async function readJobProfile(ctx: PluginContext,cfg: Config,companyId: string,id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new IntakeError(422,"Choose a saved Job folders record from the company directory");
  const [record] = await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2 AND kind='file_root'`,[companyId,id]);
  if (!record || !validJobRoot(record.details.root!) || !validJobTemplate(record.details.namingTemplate!) || !validJobComponent(record.details.originalsFolder!)) throw new IntakeError(422,"Job folder profile is missing or invalid for this company");
  return { record,access: resolveRemoteAccess(cfg,companyId,record.details.target!) };
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new IntakeError(422,"Specify the job date as YYYY-MM-DD");
  return `${value.slice(5,7)}${value.slice(8,10)}${value.slice(0,4)}`;
}
export async function buildJobFolder(record: DirectoryRecord,input: Record<string,unknown>) {
  if (typeof input.customer !== "string" || !validJobComponent(input.customer) || !Number.isInteger(input.sequence) || (input.sequence as number) < 1 || (input.sequence as number) > 99) throw new IntakeError(422,"Use a plain customer name and job sequence from 1 to 99");
  const name = record.details.namingTemplate!.replace("{date}",date(input.date)).replace("{customer}",input.customer).replace("{sequence}",String(input.sequence).padStart(2,"0"));
  if (name.length > 200) throw new IntakeError(422,"The resulting job name is too long");
  const guard = await jobSource("Support-JobFolderGuard.ps1");
  const options = { root: record.details.root,folderName: name,originalsFolder: record.details.originalsFolder };
  const script = diagnosticScript(`${guard}\n$job = Get-CheckedJobPath ([string]$SupportOptions.folderName)\nif (Test-Path -LiteralPath $job) { throw 'Job already exists; search before creating another' }\nNew-Item -Path $job -ItemType Directory -ErrorAction Stop | Out-Null\nNew-Item -Path (Join-Path $job ([string]$SupportOptions.originalsFolder)) -ItemType Directory -ErrorAction Stop | Out-Null`,options);
  const verificationScript = diagnosticScript(`${guard}\n$job = Get-CheckedJobPath ([string]$SupportOptions.folderName)\nif (-not (Test-Path -LiteralPath $job -PathType Container)) { throw 'Job folder is missing' }\n$child = Get-Item -LiteralPath (Join-Path $job ([string]$SupportOptions.originalsFolder)) -ErrorAction Stop\nif (-not $child.PSIsContainer -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Original-files subfolder is missing or redirected' }`,options);
  return { folderName: name,script,verificationScript,planHash: createHash("sha256").update(JSON.stringify([record.id,record.version,script,verificationScript])).digest("hex"),expectedEffect: `Create ${name} and its original-files subfolder in the reviewed job root.`,recoveryNotes: "No existing job is overwritten. A partial creation or unknown outcome must be inspected before another action. No files are deleted or moved. Remove only empty new folders after a separately approved inspection; do not remove a folder staff started using." };
}
export async function searchJobFolders(ctx: PluginContext,cfg: Config,run: ToolRunContext,input: Record<string,unknown>,runner = runRemoteActionScript) {
  const actor = person(run); if (run.userPermission !== "support:diagnose") throw new IntakeError(403,"Diagnostic permission required");
  const { record,access } = await readJobProfile(ctx,cfg,actor.companyId,input.profileId);
  if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 100 || /[\x00-\x1f]/.test(input.query))) throw new IntakeError(422,"Use a short literal customer/folder search");
  const staleDays = input.staleDays ?? 30; if (!Number.isInteger(staleDays) || (staleDays as number) < 1 || (staleDays as number) > 3650) throw new IntakeError(422,"Choose an age threshold from 1 to 3650 days");
  const namePattern = "^"+record.details.namingTemplate!.replace(/[.*+?^$()|[\]\\]/g,"\\$&").replace("{date}","[0-9]{8}").replace("{customer}","[A-Za-z0-9][A-Za-z0-9 ._-]*").replace("{sequence}","[0-9]{2}")+"$";
  const source = (await jobSource("Get-SupportJobFolders.ps1")).replace("# SUPPORT_JOB_FOLDER_GUARD",await jobSource("Support-JobFolderGuard.ps1"));
  const result = await runner(ctx,access,`JOB-SEARCH-${record.id}`,diagnosticScript(source,{ root: record.details.root,originalsFolder: record.details.originalsFolder,query: input.query ?? "",dateToken: input.date === undefined ? "" : date(input.date),namePattern,staleDays }),true);
  if (result.status !== "succeeded" || result.exitCode !== 0 || !result.output) throw new IntakeError(502,"Job search did not complete; no empty-folder result can be inferred");
  let findings: unknown; try { findings = JSON.parse(result.output); } catch { throw new IntakeError(502,"Job search returned invalid findings"); }
  await ctx.activity.log({ companyId: actor.companyId,message: "Reviewed job root searched",entityType: "support_directory",entityId: record.id,metadata: { userId: actor.userId,profileVersion: record.version,runId: result.runId } });
  return { profileId: record.id,profileVersion: record.version,findings };
}
export async function prepareJobFolder(ctx: PluginContext,cfg: Config,run: ToolRunContext,input: Record<string,unknown>) {
  const actor = person(run);if (run.userPermission !== "support:repair") throw new IntakeError(403,"Repair permission required");
  const { record,access } = await readJobProfile(ctx,cfg,actor.companyId,input.profileId);
  const plan = await buildJobFolder(record,input);
  const supportCase = await openInteractiveCase(ctx,cfg,run,{ target: access.target,summary: "Prepare reviewed job-folder creation" });
  return { ...plan,root: record.details.root,originalsFolder: record.details.originalsFolder,caseId: supportCase.caseId,expectedReviewVersion: supportCase.reviewVersion,target: access.target,profileId: record.id,profileVersion: record.version,date: input.date,customer: input.customer,sequence: input.sequence,instruction: "Show the company root, exact folder/subfolder and effect before confirming support_create_job_folder. Preparation does not create any folder. Do not substitute a generic script or blindly retry an uncertain creation." };
}
export async function createJobFolder(ctx: PluginContext,getConfig: () => Promise<Config>,run: ToolRunContext,input: Record<string,unknown>,runner = runRemoteActionScriptUnlocked) {
  const actor = person(run);if (run.userPermission !== "support:repair" || !run.userConfirmed) throw new IntakeError(403,"Confirm the exact job-folder creation in Clippy");
  const cfg = await getConfig(); const { record,access } = await readJobProfile(ctx,cfg,actor.companyId,input.profileId);
  if (record.version !== input.profileVersion) throw new IntakeError(409,"Job root changed; prepare a fresh plan");
  const plan = await buildJobFolder(record,input);
  if (input.planHash !== plan.planHash || input.root !== record.details.root || input.originalsFolder !== record.details.originalsFolder || input.target !== access.target || input.folderName !== plan.folderName) throw new IntakeError(409,"Folder plan changed; prepare and confirm the exact plan");
  const supportCase = await ownedCase(ctx,cfg,run,input.caseId);if (supportCase.target_address !== access.target) throw new IntakeError(403,"This case belongs to another file server");
  return runInteractiveRepair(ctx,cfg,run,{ ...input,...plan,target: access.target },false,async (context,currentAccess,caseId,script,includeOutput) => {
    const latest = await readJobProfile(ctx,await getConfig(),actor.companyId,input.profileId);
    if (latest.record.version !== record.version || JSON.stringify(latest.access) !== JSON.stringify(currentAccess)) throw new IntakeError(409,"Job root or access changed while queued; inspect the case before retrying");
    return runner(context,currentAccess,caseId,script,includeOutput);
  });
}
