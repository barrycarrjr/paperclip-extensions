import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config, type SoftwareRoute } from "./routing.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EscalationDraftInput {
  companyId: string;
  caseId: string;
  routeId: string;
  title: string;
  evidence: string;
  actorUserId: string;
}

interface EscalationRow {
  id: string;
  company_id: string;
  case_id: string;
  route_id: string;
  product_name: string;
  destination_kind: string;
  destination: string;
  title: string;
  evidence: string;
  status: string;
  external_ticket_ref: string | null;
  activity_logged_at: string | null;
}

function namespace(ctx: PluginContext): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Plugin database namespace is unavailable");
  return ctx.db.namespace;
}

export function resolveSoftwareRoute(config: Config, companyId: string, routeId: string): SoftwareRoute {
  const matches = (config.softwareRoutes ?? []).filter((route) => route.id === routeId && route.reportingCompanyId === companyId);
  if (matches.length !== 1) throw new IntakeError(409, "Software product route is missing or ambiguous");
  const route = matches[0]!;
  if (!route.productName?.trim() || route.productName.length > 200 || !route.destination || route.destination.length > 2000) {
    throw new IntakeError(422, "Software route is incomplete");
  }
  if (route.destinationKind === "email") {
    if (!email.test(route.destination)) throw new IntakeError(422, "Software support email is invalid");
  } else if (route.destinationKind === "jira_form") {
    let url: URL;
    try { url = new URL(route.destination); } catch { throw new IntakeError(422, "Jira form URL is invalid"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new IntakeError(422, "Jira form must use HTTPS");
  } else {
    throw new IntakeError(422, "Software destination kind is invalid");
  }
  return route;
}

export async function createEscalationDraft(
  ctx: PluginContext, input: EscalationDraftInput, config: Config,
): Promise<{ id: string; created: boolean }> {
  if (!uuid.test(input.companyId) || !uuid.test(input.caseId)) throw new IntakeError(422, "Company and case IDs must be UUIDs");
  if (!input.actorUserId) throw new IntakeError(403, "A board user must review escalation");
  if (!input.routeId || input.routeId.length > 120 || !input.title?.trim() || input.title.length > 300 ||
      !input.evidence?.trim() || input.evidence.length > 10000) {
    throw new IntakeError(422, "Reviewed route, title, and evidence are required");
  }
  const route = resolveSoftwareRoute(config, input.companyId, input.routeId);
  const ns = namespace(ctx);
  const cases = await ctx.db.query<{ service_domain: string; work_kind: string }>(
    `SELECT service_domain, work_kind FROM ${ns}.support_cases WHERE company_id=$1 AND id=$2`,
    [input.companyId, input.caseId],
  );
  if (!cases[0]) throw new IntakeError(404, "Support case not found in this company");
  if (cases[0].service_domain !== "software" || !["bug", "feature", "incident", "task"].includes(cases[0].work_kind)) {
    throw new IntakeError(409, "Review the software case as actionable work before escalation");
  }
  const inserted = await ctx.db.execute(
    `INSERT INTO ${ns}.support_escalations
      (company_id, case_id, route_id, product_name, destination_kind, destination, title, evidence, reviewed_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (company_id, case_id) DO NOTHING`,
    [input.companyId, input.caseId, route.id, route.productName, route.destinationKind,
      route.destination, input.title.trim(), input.evidence.trim(), input.actorUserId],
  );
  const rows = await ctx.db.query<EscalationRow>(
    `SELECT id, company_id, case_id, route_id, product_name, destination_kind,
            destination, title, evidence, status, external_ticket_ref, activity_logged_at
     FROM ${ns}.support_escalations WHERE company_id=$1 AND case_id=$2`,
    [input.companyId, input.caseId],
  );
  const saved = rows[0];
  if (!saved) throw new Error("Software escalation draft was not found after insertion");
  if (saved.route_id !== route.id || saved.product_name !== route.productName ||
      saved.destination_kind !== route.destinationKind || saved.destination !== route.destination ||
      saved.title !== input.title.trim() || saved.evidence !== input.evidence.trim()) {
    throw new IntakeError(409, "This case already has a different software escalation draft");
  }
  if (!saved.activity_logged_at) {
    await ctx.activity.log({ companyId: input.companyId, message: "Software support escalation drafted",
      entityType: "support_case", entityId: input.caseId,
      metadata: { escalationId: saved.id, productName: route.productName, destinationKind: route.destinationKind } });
    await ctx.db.execute(`UPDATE ${ns}.support_escalations SET activity_logged_at=now()
      WHERE company_id=$1 AND id=$2 AND activity_logged_at IS NULL`, [input.companyId, saved.id]);
  }
  return { id: saved.id, created: inserted.rowCount > 0 };
}

export async function markEscalationSubmitted(
  ctx: PluginContext, input: { companyId: string; caseId: string; externalTicketRef: string; actorUserId: string },
): Promise<{ status: "submitted" }> {
  if (!uuid.test(input.companyId) || !uuid.test(input.caseId)) throw new IntakeError(422, "Company and case IDs must be UUIDs");
  if (!input.actorUserId) throw new IntakeError(403, "A board user must record submission");
  if (!input.externalTicketRef?.trim() || input.externalTicketRef.length > 500) {
    throw new IntakeError(422, "A sent-message or Jira ticket reference is required");
  }
  const ns = namespace(ctx);
  const rows = await ctx.db.query<EscalationRow>(
    `SELECT id, status, external_ticket_ref FROM ${ns}.support_escalations WHERE company_id=$1 AND case_id=$2`,
    [input.companyId, input.caseId],
  );
  if (!rows[0]) throw new IntakeError(404, "Software escalation draft not found in this company");
  if (rows[0].status === "submitted") {
    if (rows[0].external_ticket_ref !== input.externalTicketRef.trim()) throw new IntakeError(409, "Escalation was already submitted with another reference");
    return { status: "submitted" };
  }
  const updated = await ctx.db.execute(
    `UPDATE ${ns}.support_escalations SET status='submitted', external_ticket_ref=$3,
       submitted_by_user_id=$4, submitted_at=now()
     WHERE company_id=$1 AND case_id=$2 AND status='draft'`,
    [input.companyId, input.caseId, input.externalTicketRef.trim(), input.actorUserId],
  );
  if (updated.rowCount !== 1) throw new IntakeError(409, "Escalation changed; reload the case");
  await ctx.activity.log({ companyId: input.companyId, message: "Software support escalation marked submitted",
    entityType: "support_case", entityId: input.caseId,
    metadata: { escalationId: rows[0].id, externalTicketRef: input.externalTicketRef.trim() } });
  return { status: "submitted" };
}
