import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { resolveRemoteAccess } from "./remote-access.js";
import { runRemoteActionScript } from "./remote-action.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function namespace(ctx: PluginContext): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Plugin database namespace is unavailable");
  return ctx.db.namespace;
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new IntakeError(422, `${name} is required and must be at most ${max} characters`);
  return value.trim();
}

export interface SupportAction {
  id: string;
  company_id: string;
  case_id: string;
  case_review_version: number;
  target_address: string;
  script_text: string;
  script_sha256: string;
  verification_text: string;
  verification_sha256: string;
  expected_effect: string;
  recovery_notes: string;
  status: string;
  proposed_by_user_id: string;
  approved_by_user_id: string | null;
  repair_run_id: string | null;
  verification_run_id: string | null;
  repair_exit_code: number | null;
  verification_exit_code: number | null;
  started_at: string | null;
}

export async function listSupportActions(ctx: PluginContext, companyId: string, caseId: string) {
  if (!uuid.test(companyId) || !uuid.test(caseId)) throw new IntakeError(422, "Company and case IDs must be UUIDs");
  const rows = await ctx.db.query<SupportAction>(
    `SELECT * FROM ${namespace(ctx)}.support_actions WHERE company_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 20`,
    [companyId, caseId],
  );
  return rows;
}

export async function proposeSupportAction(ctx: PluginContext, cfg: Config, input: {
  companyId: string; caseId: string; actorUserId: string; expectedReviewVersion: number;
  script: unknown; verificationScript: unknown; expectedEffect: unknown; recoveryNotes: unknown;
}) {
  if (!uuid.test(input.companyId) || !uuid.test(input.caseId) || !input.actorUserId) throw new IntakeError(422, "Invalid action scope");
  if (!Number.isInteger(input.expectedReviewVersion) || input.expectedReviewVersion < 1) throw new IntakeError(422, "Review the target before proposing a repair");
  const script = text(input.script, "script", 16_384);
  const verification = text(input.verificationScript, "verificationScript", 16_384);
  const effect = text(input.expectedEffect, "expectedEffect", 1000);
  const recovery = text(input.recoveryNotes, "recoveryNotes", 2000);
  const ns = namespace(ctx);
  const cases = await ctx.db.query<{ target_address: string | null; service_domain: string; review_version: number }>(
    `SELECT target_address, service_domain, review_version FROM ${ns}.support_cases WHERE company_id=$1 AND id=$2`,
    [input.companyId, input.caseId],
  );
  const supportCase = cases[0];
  if (!supportCase) throw new IntakeError(404, "Support case not found in this company");
  if (!supportCase.target_address || !["it", "equipment"].includes(supportCase.service_domain)) throw new IntakeError(422, "Review an IT or equipment target first");
  if (supportCase.review_version !== input.expectedReviewVersion) throw new IntakeError(409, "Case review changed; refresh before proposing a repair");
  resolveRemoteAccess(cfg, input.companyId, supportCase.target_address);
  const rows = await ctx.db.query<SupportAction>(
    `INSERT INTO ${ns}.support_actions
      (company_id, case_id, case_review_version, target_address, script_text, script_sha256,
       verification_text, verification_sha256, expected_effect, recovery_notes, proposed_by_user_id)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
     WHERE EXISTS (SELECT 1 FROM ${ns}.support_cases WHERE company_id=$1 AND id=$2 AND review_version=$3 AND target_address=$4)
     RETURNING *`,
    [input.companyId, input.caseId, input.expectedReviewVersion, supportCase.target_address,
      script, sha256(script), verification, sha256(verification), effect, recovery, input.actorUserId],
  );
  if (!rows[0]) throw new IntakeError(409, "Case target changed; refresh before proposing a repair");
  await ctx.activity.log({ companyId: input.companyId, message: "Remote repair proposed", entityType: "support_case", entityId: input.caseId,
    metadata: { actionId: rows[0].id, target: supportCase.target_address, scriptSha256: rows[0].script_sha256 } });
  return rows[0];
}

export async function decideSupportAction(ctx: PluginContext, input: {
  companyId: string; caseId: string; actionId: string; actorUserId: string; decision: "approved" | "rejected";
}) {
  if (![input.companyId, input.caseId, input.actionId].every((value) => uuid.test(value)) || !input.actorUserId) throw new IntakeError(422, "Invalid action scope");
  if (!["approved", "rejected"].includes(input.decision)) throw new IntakeError(422, "Invalid decision");
  const ns = namespace(ctx);
  const rows = await ctx.db.query<SupportAction>(
    `UPDATE ${ns}.support_actions AS a SET status=$4, approved_by_user_id=$5,
       approved_at=CASE WHEN $4='approved' THEN now() ELSE NULL END, updated_at=now()
     FROM ${ns}.support_cases AS c
     WHERE a.company_id=$1 AND a.case_id=$2 AND a.id=$3 AND a.status='proposed'
       AND c.company_id=a.company_id AND c.id=a.case_id AND c.review_version=a.case_review_version
       AND c.target_address=a.target_address AND c.service_domain IN ('it','equipment')
     RETURNING a.*`,
    [input.companyId, input.caseId, input.actionId, input.decision, input.actorUserId],
  );
  if (!rows[0]) throw new IntakeError(409, "Action is missing, already decided, or its case target changed");
  await ctx.activity.log({ companyId: input.companyId, message: `Remote repair ${input.decision}`, entityType: "support_case", entityId: input.caseId,
    metadata: { actionId: input.actionId, actorUserId: input.actorUserId, scriptSha256: rows[0].script_sha256 } });
  return rows[0];
}

export async function executeSupportAction(ctx: PluginContext, cfg: Config, input: {
  companyId: string; caseId: string; actionId: string; actorUserId: string;
}, runner: typeof runRemoteActionScript = runRemoteActionScript) {
  if (![input.companyId, input.caseId, input.actionId].every((value) => uuid.test(value)) || !input.actorUserId) throw new IntakeError(422, "Invalid action scope");
  const ns = namespace(ctx);
  const rows = await ctx.db.query<SupportAction>(
    `UPDATE ${ns}.support_actions AS a SET status='running', started_at=now(), updated_at=now()
     FROM ${ns}.support_cases AS c
     WHERE a.company_id=$1 AND a.case_id=$2 AND a.id=$3 AND a.status='approved'
       AND c.company_id=a.company_id AND c.id=a.case_id AND c.review_version=a.case_review_version
       AND c.target_address=a.target_address AND c.service_domain IN ('it','equipment')
     RETURNING a.*`,
    [input.companyId, input.caseId, input.actionId],
  );
  const action = rows[0];
  if (!action) throw new IntakeError(409, "Action is not approved, already attempted, or its case target changed");
  await ctx.activity.log({ companyId: input.companyId, message: "Remote repair started", entityType: "support_case", entityId: input.caseId,
    metadata: { actionId: action.id, target: action.target_address, scriptSha256: action.script_sha256 } });
  let status = "unknown";
  let repairRunId: string | null = null;
  let verificationRunId: string | null = null;
  let repairExitCode: number | null = null;
  let verificationExitCode: number | null = null;
  try {
    if (sha256(action.script_text) !== action.script_sha256 || sha256(action.verification_text) !== action.verification_sha256) {
      throw new IntakeError(409, "Approved action content changed");
    }
    const access = resolveRemoteAccess(cfg, input.companyId, action.target_address);
    const currentCase = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${ns}.support_cases WHERE company_id=$1 AND id=$2 AND review_version=$3
         AND target_address=$4 AND service_domain IN ('it','equipment')`,
      [input.companyId, input.caseId, action.case_review_version, action.target_address],
    );
    if (!currentCase[0]) throw new IntakeError(409, "Case target changed before remote execution");
    const repair = await runner(ctx, access, input.caseId, action.script_text);
    repairRunId = repair.runId;
    repairExitCode = repair.exitCode;
    if (repair.status !== "succeeded" || repair.exitCode !== 0) {
      status = "repair_failed";
    } else {
      const verification = await runner(ctx, access, input.caseId, action.verification_text);
      verificationRunId = verification.runId;
      verificationExitCode = verification.exitCode;
      status = verification.status === "succeeded" && verification.exitCode === 0 ? "verified" : "verification_failed";
    }
  } catch {
    // After the claim, the remote outcome may be unknown. Never make this action executable again automatically.
    status = "unknown";
  }
  const finished = await ctx.db.query<SupportAction>(
    `UPDATE ${ns}.support_actions SET status=$4, repair_run_id=$5, verification_run_id=$6,
       repair_exit_code=$7, verification_exit_code=$8, finished_at=now(), updated_at=now()
     WHERE company_id=$1 AND case_id=$2 AND id=$3 AND status='running' RETURNING *`,
    [input.companyId, input.caseId, input.actionId, status, repairRunId, verificationRunId, repairExitCode, verificationExitCode],
  );
  if (!finished[0]) throw new IntakeError(500, "Action outcome could not be recorded; inspect the device before taking further action");
  await ctx.activity.log({ companyId: input.companyId, message: `Remote repair ${status}`, entityType: "support_case", entityId: input.caseId,
    metadata: { actionId: action.id, target: action.target_address, repairRunId, verificationRunId } });
  return finished[0];
}

/** Preserve an interrupted attempt as unknown. A new repair needs a new proposal and device inspection. */
export async function markInterruptedActionUnknown(ctx: PluginContext, input: {
  companyId: string; caseId: string; actionId: string; actorUserId: string;
}) {
  if (![input.companyId, input.caseId, input.actionId].every((value) => uuid.test(value)) || !input.actorUserId) throw new IntakeError(422, "Invalid action scope");
  const rows = await ctx.db.query<SupportAction>(
    `UPDATE ${namespace(ctx)}.support_actions SET status='unknown', finished_at=now(), updated_at=now()
     WHERE company_id=$1 AND case_id=$2 AND id=$3 AND status='running'
       AND started_at < now() - interval '5 minutes' RETURNING *`,
    [input.companyId, input.caseId, input.actionId],
  );
  if (!rows[0]) throw new IntakeError(409, "Action is not an interrupted attempt older than five minutes");
  await ctx.activity.log({ companyId: input.companyId, message: "Interrupted remote repair marked outcome unknown",
    entityType: "support_case", entityId: input.caseId,
    metadata: { actionId: input.actionId, actorUserId: input.actorUserId } });
  return rows[0];
}
