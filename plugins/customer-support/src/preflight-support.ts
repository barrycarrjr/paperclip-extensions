import { createHash } from "node:crypto";
import type { PaperclipPluginManifestV1, PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError, companyHasSupport, type Config } from "./routing.js";
import { ns, person } from "./interactive-support.js";
import type { DirectoryRecord } from "./directory-schema.js";
import { redactSource } from "./source-protection.js";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const checkNames = ["resolution", "bleed", "color_space", "page_size", "other"];
function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || redactSource(value) !== value || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new IntakeError(422, "Use reviewed references/evidence without credentials");
  return value.trim();
}
async function profile(ctx: PluginContext, cfg: Config, run: ToolRunContext, id: unknown) {
  const actor = person(run);
  if (!companyHasSupport(cfg, actor.companyId) || typeof id !== "string" || !uuid.test(id)) throw new IntakeError(403, "Choose a saved preflight procedure in this company");
  const [record] = await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2 AND kind='preflight'`, [actor.companyId, id]);
  if (!record) throw new IntakeError(404, "Preflight procedure not found in this company");
  return { actor, record };
}
export async function preparePreflight(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  if (run.userPermission !== "support:diagnose") throw new IntakeError(403, "Diagnostic permission required");
  const { record } = await profile(ctx, cfg, run, input.profileId), fileReference = text(input.fileReference, 200);
  return { status: "handoff_required", profileId: record.id, profileVersion: record.version, softwareName: record.details.softwareName, fileReference, officialUrl: record.details.website ?? null, procedure: record.details.procedure, checksToRequest: checkNames.slice(0, 4), ownerId: record.details.ownerId ?? null,
    instruction: "No file was inspected. Use the saved production software's actual preflight workflow and retain its report for the exact file/version. Request resolution, bleed, color space and page-size checks; not every engine supports all. Read findings before explaining them; never invent pass/fail results or upload customer files to public services. Record real report evidence with explicit operator confirmation." };
}
export async function recordPreflightResult(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  if (run.userPermission !== "support:repair" || !run.userConfirmed) throw new IntakeError(403, "Confirm the actual software report and findings");
  const { actor, record } = await profile(ctx, cfg, run, input.profileId);
  if (record.version !== input.profileVersion || typeof input.resultId !== "string" || !uuid.test(input.resultId)) throw new IntakeError(409, "Use a fresh result UUID and current preflight procedure version");
  const fileReference = text(input.fileReference, 200), reportReference = text(input.reportReference, 500);
  if (typeof input.checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input.checkedAt) || !Number.isFinite(Date.parse(input.checkedAt)) || Date.parse(input.checkedAt) > Date.now() + 300000) throw new IntakeError(422, "Use the actual software check time");
  const checkedAt = new Date(input.checkedAt).toISOString();
  if (!Array.isArray(input.findings) || !input.findings.length || input.findings.length > 10) throw new IntakeError(422, "Record one to ten actual checks");
  const findings = input.findings.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IntakeError(422, "Invalid check evidence");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !["check", "status", "evidence"].includes(key)) || !checkNames.includes(String(item.check)) || !["pass", "fail", "unavailable", "needs_review"].includes(String(item.status))) throw new IntakeError(422, "Choose a known check and the actual software status");
    return { check: item.check, status: item.status, evidence: text(item.evidence, 500) };
  });
  if (new Set(findings.map(item => item.check)).size !== findings.length) throw new IntakeError(422, "Record each check once, including its unavailable status");
  const hash = createHash("sha256").update(JSON.stringify([actor.companyId, record.id, record.version, fileReference, reportReference, checkedAt, findings])).digest("hex");
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_preflight_results(company_id,id,profile_id,profile_version,software_name,file_reference,provider_report_reference,checked_at,findings,content_sha256,recorded_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb,$10,$11) ON CONFLICT DO NOTHING`, [actor.companyId, input.resultId, record.id, record.version, record.details.softwareName, fileReference, reportReference, checkedAt, JSON.stringify(findings), hash, actor.userId]);
  const [saved] = await ctx.db.query<{ content_sha256: string }>(`SELECT content_sha256 FROM ${ns(ctx)}.support_preflight_results WHERE company_id=$1 AND id=$2`, [actor.companyId, input.resultId]);
  if (saved?.content_sha256 !== hash) throw new IntakeError(409, "Result ID has different evidence; record a new correction");
  await ctx.activity.log({ companyId: actor.companyId, message: "Operator-confirmed production software preflight recorded", entityType: "support_preflight", entityId: input.resultId, metadata: { userId: actor.userId, profileVersion: record.version, provenance: "operator_attested" } });
  return { resultId: input.resultId, recorded: true, provenance: "operator_attested", instruction: "These are operator-confirmed findings from the named software/report, not a Support Desk inspection or verified connector receipt. Explain only the actual evidence. A changed file needs a new software check." };
}
export async function preflightHistory(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  if (run.userPermission !== "support:diagnose") throw new IntakeError(403, "Diagnostic permission required");
  const { actor, record } = await profile(ctx, cfg, run, input.profileId);
  const rows = await ctx.db.query(`SELECT id,profile_version,software_name,file_reference,provider_report_reference,checked_at,findings,recorded_by_user_id FROM ${ns(ctx)}.support_preflight_results WHERE company_id=$1 AND profile_id=$2 ORDER BY checked_at DESC,id LIMIT 21`, [actor.companyId, record.id]);
  return { results: rows.slice(0, 20), truncated: rows.length > 20, provenance: "operator_attested", instruction: "Reports apply to their named file/version and actual check time. These are confirmed staff records, not a live automated preflight engine. Do not assume an old pass covers an edited file." };
}
const profileId = { type: "string" };
export const preflightTools: NonNullable<PaperclipPluginManifestV1["tools"]> = [
  { name: "support_prepare_preflight", displayName: "Use existing production preflight", requiredUserPermission: "support:diagnose", description: "Prepare a staff handoff to saved company preflight software for an exact job/file reference. Does not inspect or upload a document and does not invent findings. Use its actual report for resolution/bleed/color/page-size explanations.", parametersSchema: { type: "object", additionalProperties: false, properties: { profileId, fileReference: { type: "string", maxLength: 200 } }, required: ["profileId", "fileReference"] } },
  { name: "support_record_preflight_result", displayName: "Record actual preflight findings", requiredUserPermission: "support:repair", requiresUserConfirmation: true, writes: true, description: "Confirm the named software/report, exact file/version and actual findings. Records immutable operator-attested evidence; no claim of a live connector or local file analysis. Include unavailable checks. Result IDs cannot overwrite evidence.", parametersSchema: { type: "object", additionalProperties: false, properties: { profileId, profileVersion: { type: "integer" }, resultId: { type: "string" }, fileReference: { type: "string" }, reportReference: { type: "string" }, checkedAt: { type: "string" }, findings: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", additionalProperties: false, properties: { check: { type: "string", enum: checkNames }, status: { type: "string", enum: ["pass", "fail", "unavailable", "needs_review"] }, evidence: { type: "string", maxLength: 500 } }, required: ["check", "status", "evidence"] } } }, required: ["profileId", "profileVersion", "resultId", "fileReference", "reportReference", "checkedAt", "findings"] } },
  { name: "support_preflight_history", displayName: "Read recorded preflight reports", requiredUserPermission: "support:diagnose", description: "Read up to twenty operator-confirmed software reports in this company's preflight profile. Findings retain software, report and exact file references; no old result proves an edited document is print-ready.", parametersSchema: { type: "object", additionalProperties: false, properties: { profileId }, required: ["profileId"] } },
];
export function registerPreflightTools(ctx: PluginContext, getConfig: () => Promise<Config>) {
  for (const tool of preflightTools) ctx.tools.register(tool.name, tool, async (params, run) => {
    try {
      if (run.userPermission !== tool.requiredUserPermission) throw new IntakeError(403, "Preflight support permission required");
      const input = params as Record<string, unknown>, cfg = await getConfig();
      return { data: tool.name === "support_prepare_preflight" ? await preparePreflight(ctx, cfg, run, input) : tool.name === "support_record_preflight_result" ? await recordPreflightResult(ctx, cfg, run, input) : await preflightHistory(ctx, cfg, run, input) };
    } catch (error) { return { error: error instanceof IntakeError ? error.message : "Preflight handoff failed" }; }
  });
}
