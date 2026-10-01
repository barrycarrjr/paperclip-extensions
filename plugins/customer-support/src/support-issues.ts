import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError } from "./routing.js";

const ORIGIN_KIND = "plugin:customer-support:case";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const kinds = new Set(["bug", "feature", "followup"]);

interface CaseRow {
  id: string;
  service_domain: string;
  work_kind: string;
}

interface LinkRow {
  id: string;
  company_id: string;
  case_id: string;
  project_id: string | null;
  assignee_agent_id: string | null;
  issue_kind: string;
  title: string;
  evidence: string;
  issue_id: string | null;
  activity_logged_at: string | null;
}

export interface ReviewedIssueInput {
  companyId: string;
  caseId: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  kind: "bug" | "feature" | "followup";
  title: string;
  evidence: string;
  actorUserId: string;
}

function validate(input: ReviewedIssueInput): void {
  if (!uuid.test(input.companyId) || !uuid.test(input.caseId) ||
      (input.projectId !== null && (typeof input.projectId !== "string" || !uuid.test(input.projectId))) ||
      (input.assigneeAgentId !== null && (typeof input.assigneeAgentId !== "string" || !uuid.test(input.assigneeAgentId)))) {
    throw new IntakeError(422, "Company, case, project, and agent IDs must be UUIDs when provided");
  }
  if (typeof input.kind !== "string" || !kinds.has(input.kind)) throw new IntakeError(422, "Issue kind is invalid");
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 300) throw new IntakeError(422, "Issue title must be 1 to 300 characters");
  if (typeof input.evidence !== "string" || !input.evidence.trim() || input.evidence.length > 10000) throw new IntakeError(422, "Reviewed evidence is required and must be at most 10000 characters");
  if (typeof input.actorUserId !== "string" || !input.actorUserId) throw new IntakeError(403, "A board user must review issue creation");
}

function namespace(ctx: PluginContext): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Plugin database namespace is unavailable");
  return ctx.db.namespace;
}

async function getLink(ctx: PluginContext, input: ReviewedIssueInput): Promise<LinkRow | null> {
  const rows = await ctx.db.query<LinkRow>(
    `SELECT id, company_id, case_id, project_id,
            assignee_agent_id, issue_kind, title, evidence, issue_id, activity_logged_at
     FROM ${namespace(ctx)}.support_issue_links WHERE company_id=$1 AND case_id=$2`,
    [input.companyId, input.caseId],
  );
  return rows[0] ?? null;
}

async function logLinkIfNeeded(ctx: PluginContext, link: LinkRow): Promise<void> {
  if (!link.issue_id || link.activity_logged_at) return;
  await ctx.activity.log({
    companyId: link.company_id,
    message: `Support case linked to a reviewed ${link.issue_kind} issue`,
    entityType: "support_case",
    entityId: link.case_id,
    metadata: { issueId: link.issue_id, projectId: link.project_id, assigneeAgentId: link.assignee_agent_id },
  });
  await ctx.db.execute(
    `UPDATE ${namespace(ctx)}.support_issue_links SET activity_logged_at=now()
     WHERE company_id=$1 AND case_id=$2 AND issue_id=$3 AND activity_logged_at IS NULL`,
    [link.company_id, link.case_id, link.issue_id],
  );
}

export async function createReviewedIssue(ctx: PluginContext, input: ReviewedIssueInput): Promise<{ issueId: string; created: boolean }> {
  validate(input);
  const ns = namespace(ctx);
  const cases = await ctx.db.query<CaseRow>(
    `SELECT id, service_domain, work_kind FROM ${ns}.support_cases WHERE company_id=$1 AND id=$2`,
    [input.companyId, input.caseId],
  );
  const supportCase = cases[0];
  if (!supportCase) throw new IntakeError(404, "Support case not found in this company");
  if (supportCase.service_domain === "software") {
    throw new IntakeError(409, "Software reports must use the vendor escalation channel");
  }
  if (supportCase.service_domain === "unclassified" || supportCase.work_kind === "unclassified" || supportCase.work_kind === "question") {
    throw new IntakeError(409, "Review actionable work before creating an issue");
  }
  if (input.kind !== "followup" || (supportCase.work_kind !== "task" && supportCase.work_kind !== "incident")) {
    throw new IntakeError(409, "Only reviewed non-software incidents and tasks become local issues");
  }
  if (input.projectId) throw new IntakeError(422, "Non-software work must not use a code project");
  if (input.assigneeAgentId) {
    const agent = await ctx.agents.get(input.assigneeAgentId, input.companyId);
    if (!agent || agent.companyId !== input.companyId) throw new IntakeError(404, "Agent not found in this company");
  }

  await ctx.db.execute(
    `INSERT INTO ${ns}.support_issue_links
       (company_id, case_id, project_id, assignee_agent_id, issue_kind, title, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (company_id, case_id) DO NOTHING`,
    [input.companyId, input.caseId, null, input.assigneeAgentId, input.kind, input.title.trim(), input.evidence.trim()],
  );
  const existing = await getLink(ctx, input);
  if (!existing) throw new Error("Support issue intent was not found after insertion");
  if (existing.project_id !== null || existing.assignee_agent_id !== input.assigneeAgentId || existing.issue_kind !== input.kind ||
      existing.title !== input.title.trim() || existing.evidence !== input.evidence.trim()) {
    throw new IntakeError(409, "This case already has a different reviewed issue request");
  }
  if (existing.issue_id) {
    await logLinkIfNeeded(ctx, existing);
    return { issueId: existing.issue_id, created: false };
  }

  const leaseToken = randomUUID();
  const claim = await ctx.db.execute(
    `UPDATE ${ns}.support_issue_links SET lease_token=$3, lease_until=now()+interval '10 minutes', updated_at=now()
     WHERE company_id=$1 AND case_id=$2 AND issue_id IS NULL
       AND (lease_token IS NULL OR lease_until < now())`,
    [input.companyId, input.caseId, leaseToken],
  );
  if (claim.rowCount !== 1) {
    const latest = await getLink(ctx, input);
    if (latest?.issue_id) {
      await logLinkIfNeeded(ctx, latest);
      return { issueId: latest.issue_id, created: false };
    }
    throw new IntakeError(409, "Issue creation is already in progress; retry shortly");
  }

  try {
    const matches = await ctx.issues.list({
      companyId: input.companyId, originKind: ORIGIN_KIND, originId: input.caseId, limit: 2,
    });
    if (matches.length > 1) throw new IntakeError(409, "Multiple existing issues need operator review");
    const issue = matches[0] ?? await ctx.issues.create({
      companyId: input.companyId,
      assigneeAgentId: input.assigneeAgentId ?? undefined,
      title: input.title.trim(),
      description: [
        `Reviewed ${input.kind} from support case ${input.caseId}.`,
        "",
        "Reviewed evidence:",
        input.evidence.trim(),
      ].filter(Boolean).join("\n"),
      status: "todo",
      originKind: ORIGIN_KIND,
      originId: input.caseId,
      actor: { actorUserId: input.actorUserId },
    });
    if (issue.companyId !== input.companyId || (issue.projectId ?? null) !== null ||
        (issue.assigneeAgentId ?? null) !== input.assigneeAgentId) {
      throw new IntakeError(409, "Recovered issue does not match the selected company, project, and agent");
    }
    const linked = await ctx.db.execute(
      `UPDATE ${ns}.support_issue_links
       SET issue_id=$3, lease_token=NULL, lease_until=NULL, updated_at=now()
       WHERE company_id=$1 AND case_id=$2 AND lease_token=$4 AND issue_id IS NULL`,
      [input.companyId, input.caseId, issue.id, leaseToken],
    );
    if (linked.rowCount !== 1) throw new Error("Could not link the recovered issue to the support case");
    const saved = await getLink(ctx, input);
    if (!saved) throw new Error("Linked support issue was not found");
    await logLinkIfNeeded(ctx, saved);
    return { issueId: issue.id, created: matches.length === 0 };
  } catch (error) {
    await ctx.db.execute(
      `UPDATE ${ns}.support_issue_links SET lease_token=NULL, lease_until=NULL, updated_at=now()
       WHERE company_id=$1 AND case_id=$2 AND lease_token=$3 AND issue_id IS NULL`,
      [input.companyId, input.caseId, leaseToken],
    );
    throw error;
  }
}
