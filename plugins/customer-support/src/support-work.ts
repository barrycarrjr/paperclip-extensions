import type { PluginContext, PluginIssueWakeupResult } from "@paperclipai/plugin-sdk";
import { IntakeError } from "./routing.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function startSupportWork(
  ctx: PluginContext,
  input: { companyId: string; caseId: string; actorUserId: string },
): Promise<PluginIssueWakeupResult> {
  if (!uuid.test(input.companyId) || !uuid.test(input.caseId)) throw new IntakeError(422, "Company and case IDs must be UUIDs");
  if (!input.actorUserId) throw new IntakeError(403, "A board user must start agent work");
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Plugin database namespace is unavailable");
  const links = await ctx.db.query<{ issue_id: string; assignee_agent_id: string | null }>(
    `SELECT issue_id, assignee_agent_id FROM ${ctx.db.namespace}.support_issue_links
     WHERE company_id=$1 AND case_id=$2 AND issue_id IS NOT NULL`,
    [input.companyId, input.caseId],
  );
  const link = links[0];
  if (!link) throw new IntakeError(404, "Linked support issue not found in this company");
  const issue = await ctx.issues.get(link.issue_id, input.companyId);
  if (!issue || issue.companyId !== input.companyId) throw new IntakeError(404, "Linked issue not found in this company");
  if (!link.assignee_agent_id || issue.assigneeAgentId !== link.assignee_agent_id) {
    throw new IntakeError(409, "Issue assignee changed; review it in Paperclip before starting work");
  }
  if (["backlog", "done", "cancelled"].includes(issue.status)) {
    throw new IntakeError(409, `Issue is not ready for agent work: ${issue.status}`);
  }
  return ctx.issues.requestWakeup(issue.id, input.companyId, {
    reason: "support_case_reviewed_work",
    contextSource: "customer-support.case",
    idempotencyKey: `customer-support:${input.caseId}:start`,
    actorUserId: input.actorUserId,
  });
}
