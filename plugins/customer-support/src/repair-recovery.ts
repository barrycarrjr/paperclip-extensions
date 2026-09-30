import { createHash } from "node:crypto";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { ns, ownedCase } from "./interactive-support.js";

const hash = (value: string) => createHash("sha256").update(value.trim(), "utf8").digest("hex");
interface RecoveryScript { script: string; verificationScript: string; expectedEffect: string; recoveryNotes: string }
export async function rememberRecovery(ctx: PluginContext, run: ToolRunContext, caseId: string, target: string, version: number,
  repair: { script: string; verificationScript: string }, priorState: Record<string, unknown>, recovery: Record<string, unknown>) {
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_recovery_plans(company_id,case_id,target_address,case_review_version,script_sha256,verification_sha256,prior_state,recovery,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) ON CONFLICT(company_id,case_id,script_sha256,verification_sha256) DO NOTHING`,
  [run.companyId, caseId, target, version, hash(repair.script), hash(repair.verificationScript), JSON.stringify(priorState), JSON.stringify(recovery), run.userId]);
  const [row] = await ctx.db.query<{ id: string }>(`SELECT id FROM ${ns(ctx)}.support_recovery_plans WHERE company_id=$1 AND case_id=$2 AND script_sha256=$3 AND verification_sha256=$4`, [run.companyId, caseId, hash(repair.script), hash(repair.verificationScript)]);
  if (!row) throw new IntakeError(500, "Recovery plan could not be read after saving; no repair was started");
  await ctx.activity.log({ companyId: run.companyId, message: "Repair recovery plan saved", entityType: "support_case", entityId: caseId, metadata: { userId: run.userId, recoveryPlanId: row.id } });
  return row.id;
}
export async function prepareRecovery(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  if (run.userPermission !== "support:repair") throw new IntakeError(403, "Repair permission required");
  const supportCase = await ownedCase(ctx, cfg, run, input.caseId);
  if (supportCase.status === "resolved") throw new IntakeError(409, "Reopen and review the case before preparing recovery");
  if (typeof input.actionId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.actionId)) throw new IntakeError(422, "Use an original actionId returned by support_get_case");
  const [plan] = await ctx.db.query<{ id: string; target_address: string; prior_state: Record<string, unknown>; recovery: RecoveryScript; status: string; case_review_version: number }>(
    `SELECT p.id,p.target_address,p.prior_state,p.recovery,a.status,a.case_review_version FROM ${ns(ctx)}.support_recovery_plans p JOIN ${ns(ctx)}.support_actions a
      ON a.company_id=p.company_id AND a.case_id=p.case_id AND a.target_address=p.target_address AND a.script_sha256=p.script_sha256 AND a.verification_sha256=p.verification_sha256
      WHERE p.company_id=$1 AND p.case_id=$2 AND a.id=$3`, [run.companyId, supportCase.id, input.actionId]);
  if (!plan) throw new IntakeError(404, "This action has no captured recovery plan; inspect its recorded recovery notes and current state");
  if (plan.target_address !== supportCase.target_address) throw new IntakeError(409, "Recovery belongs to the original target; the case computer changed");
  if (plan.status === "running" || (plan.status === "unknown" && plan.case_review_version === supportCase.review_version)) throw new IntakeError(409, "Original outcome is running or unknown. Inspect the device and reconcile/review the original case before preparing recovery");
  return { recoveryPlanId: plan.id, originalActionId: input.actionId, originalStatus: plan.status, priorState: plan.prior_state,
    repair: { ...plan.recovery, caseId: supportCase.id, target: supportCase.target_address, expectedReviewVersion: supportCase.review_version },
    instruction: "Recovery preview only; nothing was approved or executed. Inspect current state and explain the saved prior state, exact recovery, disruption and limitations. Submit this exact repair through support_run_repair with new inline confirmation or valid case delegation. Existing unknown-outcome/target locks still apply. Recovery can fail or be irreversible; verify both configuration and the person's original symptom. If this recovery ran before, inspect its recorded result instead of replaying it." };
}
