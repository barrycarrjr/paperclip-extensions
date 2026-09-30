import type { PaperclipPluginManifestV1, PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { ns, person } from "./interactive-support.js";
import type { DirectoryRecord } from "./directory-schema.js";
import { validJobRoot } from "./job-folder-schema.js";
import { resolveRemoteAccess } from "./remote-access.js";
import { runRemoteActionScript } from "./remote-action.js";
import { diagnosticScript } from "./diagnostic-catalog.js";
import { jobSource } from "./job-folders.js";

export async function checkSkillSync(ctx: PluginContext, cfg: Config, run: ToolRunContext, profileId: unknown, runner = runRemoteActionScript) {
  const actor = person(run);
  if (run.userPermission !== "support:diagnose") throw new IntakeError(403, "Diagnostic permission required");
  if (typeof profileId !== "string" || !/^[a-f0-9-]{36}$/i.test(profileId)) throw new IntakeError(422, "Choose a saved skill backup check profile");
  const [record] = await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2 AND kind='sync_check'`, [actor.companyId, profileId]);
  if (!record || !validJobRoot(record.details.sourcePath!) || !validJobRoot(record.details.backupPath!) || record.details.sourcePath!.toLowerCase() === record.details.backupPath!.toLowerCase()) throw new IntakeError(422, "Choose a valid profile in this company");
  const access = resolveRemoteAccess(cfg, actor.companyId, record.details.target!);
  const receipt = await runner(ctx, access, `SKILL-SYNC-${record.id}`, diagnosticScript(await jobSource("Get-SupportSkillSync.ps1"), record.details), true);
  if (receipt.status !== "succeeded" || receipt.exitCode !== 0 || !receipt.output) throw new IntakeError(502, "Comparison failed; no backup success can be inferred");
  let findings: unknown;
  try { findings = JSON.parse(receipt.output); } catch { throw new IntakeError(502, "Comparison returned invalid findings"); }
  await ctx.activity.log({ companyId: actor.companyId, entityType: "support_directory", entityId: record.id, message: "Local skill backup compared", metadata: { userId: actor.userId, profileVersion: record.version, runId: receipt.runId } });
  return { profileId: record.id, profileVersion: record.version, findings };
}
export const skillSyncTools: NonNullable<PaperclipPluginManifestV1["tools"]> = [{ name: "support_check_skill_sync", displayName: "Check skill backup copy", requiredUserPermission: "support:diagnose", executionTimeoutMs: 210000,
  description: "Compare Markdown skills in one saved company sync_check profile with a local backup/cloud-sync copy through saved Windows access. Bounded hashes stay on the PC; output has counts and newest file times, no file contents/names. A matching local copy does not prove cloud upload or restoration. Never label partial/empty/unavailable results as a healthy backup. Choose a profile with support_search_directory kind=sync_check.",
  parametersSchema: { type: "object", additionalProperties: false, properties: { profileId: { type: "string" } }, required: ["profileId"] } }];
export function registerSkillSyncTools(ctx: PluginContext, getConfig: () => Promise<Config>) {
  ctx.tools.register(skillSyncTools[0]!.name, skillSyncTools[0]!, async (params, run) => {
    try { return { data: await checkSkillSync(ctx, await getConfig(), run, (params as Record<string, unknown>).profileId) }; }
    catch (error) { return { error: error instanceof IntakeError ? error.message : "Skill comparison failed" }; }
  });
}
