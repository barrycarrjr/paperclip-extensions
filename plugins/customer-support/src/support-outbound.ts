import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { deliveryHash, containsCredential, type DeliveryRequest, type DeliveryReceipt } from "../../../lib/support-delivery.js";
import { IntakeError, resolveConnection, type Config } from "./routing.js";
import { resolveSoftwareRoute } from "./support-escalations.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface OutboundRow {
  policy_authorization?: { policySha256: string; agentId: string } | null;
  id: string; company_id: string; case_id: string; case_review_version: number;
  provider: DeliveryRequest["provider"]; account: string; kind: DeliveryRequest["kind"];
  destination: DeliveryRequest["destination"]; body: string; content_sha256: string;
  status: string; approved_by_user_id: string | null; expires_at: string | null;
  external_reference: string | null; delivery_code: string | null; retry_of_id: string | null;
}
interface Scope { companyId: string; caseId: string; actorUserId: string }
function ns(ctx: PluginContext) {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Invalid support namespace");
  return ctx.db.namespace;
}
function scope(input: Scope) {
  if (!uuid.test(input.companyId) || !uuid.test(input.caseId) || !input.actorUserId) throw new IntakeError(403, "A company support operator is required");
}
function text(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || containsCredential(value)) throw new IntakeError(422, `${name} must be nonempty and contain no credentials (maximum ${max} characters)`);
  return value.trim();
}
export async function listOutbound(ctx: PluginContext, companyId: string, caseId: string) {
  if (!uuid.test(companyId) || !uuid.test(caseId)) throw new IntakeError(422, "Company and case IDs must be UUIDs");
  return ctx.db.query<OutboundRow>(`SELECT * FROM ${ns(ctx)}.support_outbound WHERE company_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 30`, [companyId,caseId]);
}
async function read(ctx: PluginContext, input: Scope & { deliveryId: unknown }) {
  scope(input);
  if (typeof input.deliveryId !== "string" || !uuid.test(input.deliveryId)) throw new IntakeError(422, "deliveryId must be a UUID");
  const rows = await ctx.db.query<OutboundRow>(`SELECT * FROM ${ns(ctx)}.support_outbound WHERE company_id=$1 AND case_id=$2 AND id=$3`, [input.companyId,input.caseId,input.deliveryId]);
  if (!rows[0]) throw new IntakeError(404, "Delivery not found in this company case");
  return rows[0];
}
async function destination(ctx: PluginContext, cfg: Config, input: Scope & { kind: unknown; routeId?: unknown }) {
  const cases = await ctx.db.query<{ source: string; source_account_id: string | null; connection_id: string; external_route_id: string; external_conversation_id: string; review_version: number; service_domain: string; work_kind: string }>(
    `SELECT source,source_account_id,connection_id,external_route_id,external_conversation_id,review_version,service_domain,work_kind FROM ${ns(ctx)}.support_cases WHERE company_id=$1 AND id=$2`, [input.companyId,input.caseId]);
  const supportCase = cases[0];
  if (!supportCase) throw new IntakeError(404, "Support case not found");
  if (input.kind === "slack_reply") {
    if (supportCase.source !== "slack" || !supportCase.source_account_id) throw new IntakeError(422, "A verified Slack source account is required. Sync a legacy thread before preparing its reply.");
    const connection = resolveConnection(cfg, { companyId: input.companyId,connectionId: supportCase.connection_id,externalAccountId: supportCase.source_account_id,externalRouteId: supportCase.external_route_id } as never);
    if (connection.deliveryPluginId !== "slack-tools" || !connection.outboundAccount) throw new IntakeError(422, "Choose Slack Tools and its workspace key on this support connection");
    const channelId = supportCase.external_route_id.split(":")[0]!;
    if (!/^[CG][A-Z0-9]{8,}$/.test(channelId) || !/^\d{10,11}\.\d{1,6}$/.test(supportCase.external_conversation_id)) throw new IntakeError(422, "Case has no valid Slack thread destination");
    return { version: supportCase.review_version,provider: "slack-tools" as const,account: connection.outboundAccount,
      destination: { workspaceId: connection.externalAccountId,channelId,threadTs: supportCase.external_conversation_id } };
  }
  if (input.kind !== "vendor_email" || typeof input.routeId !== "string") throw new IntakeError(422, "Choose Slack reply or a vendor email product route");
  if (supportCase.service_domain !== "software" || !["bug","feature","incident","task"].includes(supportCase.work_kind)) throw new IntakeError(409, "Review the software case before vendor escalation");
  const route = resolveSoftwareRoute(cfg,input.companyId,input.routeId);
  if (route.destinationKind !== "email" || !route.outboundAccount) throw new IntakeError(422, "Email escalation needs an Email Tools mailbox key. Jira forms still use their configured form intake.");
  return { version: supportCase.review_version,provider: "email-tools" as const,account: route.outboundAccount,destination: { to: route.destination } };
}
export async function prepareOutbound(ctx: PluginContext, cfg: Config, input: Scope & { kind: unknown; routeId?: unknown; body: unknown; subject?: unknown; expectedReviewVersion: unknown }) {
  scope(input);
  const bound = await destination(ctx,cfg,input);
  if (bound.version !== input.expectedReviewVersion) throw new IntakeError(409, "Case review changed; refresh the case before drafting");
  const body = text(input.body,"Reviewed message",10000);
  const dest: DeliveryRequest["destination"] = { ...bound.destination };
  if (input.kind === "vendor_email") { dest.subject = text(input.subject,"Email subject",300); if (/[\r\n]/.test(dest.subject)) throw new IntakeError(422,"Email subject must be one line"); }
  const request = { companyId: input.companyId,caseId: input.caseId,provider: bound.provider,account: bound.account,kind: input.kind as DeliveryRequest["kind"],destination: dest,body };
  const hash = deliveryHash(request);
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_outbound(id,company_id,case_id,case_review_version,provider,account,kind,destination,body,content_sha256,created_by_user_id)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11 WHERE EXISTS(SELECT 1 FROM ${ns(ctx)}.support_cases WHERE company_id=$2 AND id=$3 AND review_version=$4)
    ON CONFLICT DO NOTHING`, [randomUUID(),input.companyId,input.caseId,bound.version,bound.provider,bound.account,input.kind,JSON.stringify(dest),body,hash,input.actorUserId]);
  const rows = await ctx.db.query<OutboundRow>(`SELECT * FROM ${ns(ctx)}.support_outbound WHERE company_id=$1 AND case_id=$2 AND case_review_version=$3 AND content_sha256=$4 AND retry_of_id IS NULL`, [input.companyId,input.caseId,bound.version,hash]);
  if (!rows[0]) throw new IntakeError(409,"Case changed before the draft was saved");
  return rows[0];
}
function request(row: OutboundRow): DeliveryRequest {
  return { version: 1,deliveryId: row.id,companyId: row.company_id,caseId: row.case_id,provider: row.provider,account: row.account,kind: row.kind,destination: row.destination,body: row.body,
    contentSha256: row.content_sha256,approvedByUserId: row.approved_by_user_id!,expiresAt: new Date(row.expires_at!).toISOString() };
}
export async function sendOutbound(ctx: PluginContext, cfg: Config, input: Scope & { deliveryId: unknown; contentSha256: unknown; confirmedBody?: unknown; confirmedDestination?: unknown }) {
  const row = await read(ctx,input);
  if ((row as OutboundRow & { policy_authorization?: unknown }).policy_authorization) throw new IntakeError(409, "This is a policy-authorized ticket update; inspect its receipt rather than sending it as a human draft");
  if (row.content_sha256 !== input.contentSha256) throw new IntakeError(409,"Confirm the exact saved message hash");
  if (input.confirmedBody !== undefined && (input.confirmedBody !== row.body || !input.confirmedDestination ||
    deliveryHash({ ...row,companyId: row.company_id,caseId: row.case_id,destination: input.confirmedDestination as DeliveryRequest["destination"] }) !== row.content_sha256)) throw new IntakeError(409,"The displayed message differs from the saved draft");
  if (row.status !== "draft") return { deliveryId: row.id,status: row.status,reference: row.external_reference,instruction: "Read the receipt; no new external attempt was made. Unknown outcomes must be checked at the provider before any new send." };
  // Re-resolve the saved destination against current configuration and review.
  const caseRows = await ctx.db.query<{ review_version: number; source_account_id: string | null; connection_id: string; external_route_id: string; external_conversation_id: string }>(
    `SELECT review_version,source_account_id,connection_id,external_route_id,external_conversation_id FROM ${ns(ctx)}.support_cases WHERE company_id=$1 AND id=$2`, [input.companyId,input.caseId]);
  const supportCase = caseRows[0];
  if (!supportCase || supportCase.review_version !== row.case_review_version) throw new IntakeError(409,"Case changed after drafting; prepare a new reviewed draft");
  if (row.kind === "slack_reply") {
    const connection = resolveConnection(cfg,{ companyId: input.companyId,connectionId: supportCase.connection_id,externalAccountId: supportCase.source_account_id,externalRouteId: supportCase.external_route_id } as never);
    if (connection.deliveryPluginId !== row.provider || connection.outboundAccount !== row.account || connection.externalAccountId !== row.destination.workspaceId ||
      supportCase.external_route_id.split(":")[0] !== row.destination.channelId || supportCase.external_conversation_id !== row.destination.threadTs) throw new IntakeError(409,"Slack route changed after drafting");
  } else if (!(cfg.softwareRoutes ?? []).some(route => route.reportingCompanyId === input.companyId && route.destinationKind === "email" && route.destination === row.destination.to && route.outboundAccount === row.account)) throw new IntakeError(409,"Vendor route changed after drafting");
  const changed = await ctx.db.execute(`UPDATE ${ns(ctx)}.support_outbound AS o SET status='pending',approved_by_user_id=$4,approved_at=now(),expires_at=now()+interval '10 minutes',updated_at=now()
    WHERE company_id=$1 AND case_id=$2 AND id=$3 AND status='draft'
      AND EXISTS(SELECT 1 FROM ${ns(ctx)}.support_cases c WHERE c.company_id=o.company_id AND c.id=o.case_id AND c.review_version=o.case_review_version)`, [input.companyId,input.caseId,row.id,input.actorUserId]);
  if (changed.rowCount !== 1) throw new IntakeError(409,"Draft changed before confirmation was recorded");
  await ctx.activity.log({ companyId: input.companyId,message: "Support message approved for delivery",entityType: "support_case",entityId: input.caseId,
    metadata: { deliveryId: row.id,provider: row.provider,contentSha256: row.content_sha256,userId: input.actorUserId } });
  const saved = await read(ctx,input);
  await ctx.events.emit("delivery-requested",input.companyId,request(saved));
  return { deliveryId: row.id,status: "pending",instruction: "Queued for the configured communication plugin, not confirmed sent. Read the delivery receipt before telling the requester it was delivered." };
}
export async function retryNotSent(ctx: PluginContext, input: Scope & { deliveryId: unknown }) {
  const row = await read(ctx,input);
  if (row.status !== "not_sent") throw new IntakeError(409,"Only a confirmed not-sent delivery can prepare a retry. Unknown/pending/sent deliveries cannot be replayed.");
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_outbound(id,company_id,case_id,case_review_version,provider,account,kind,destination,body,content_sha256,created_by_user_id,retry_of_id)
    SELECT $1,company_id,case_id,case_review_version,provider,account,kind,destination,body,content_sha256,$4,id FROM ${ns(ctx)}.support_outbound WHERE company_id=$2 AND id=$3 AND status='not_sent' ON CONFLICT DO NOTHING`, [randomUUID(),input.companyId,row.id,input.actorUserId]);
  const rows = await ctx.db.query<OutboundRow>(`SELECT * FROM ${ns(ctx)}.support_outbound WHERE company_id=$1 AND retry_of_id=$2`,[input.companyId,row.id]);
  if (!rows[0]) throw new IntakeError(409,"Delivery changed before retry preparation");
  return rows[0];
}
export async function recordDeliveryReceipt(ctx: PluginContext, event: PluginEvent) {
  if (event.actorType !== "plugin" || !["slack-tools","email-tools"].includes(event.actorId ?? "") || event.eventType !== `plugin.${event.actorId}.support-delivery-receipt`) return;
  const p = event.payload as DeliveryReceipt;
  if (!p || p.version !== 1 || p.companyId !== event.companyId || !uuid.test(p.deliveryId ?? "") || !["sent","not_sent","unknown"].includes(p.status) || !["accepted","preflight_failed","delivery_uncertain"].includes(p.code) || !/^[a-f0-9]{64}$/.test(p.contentSha256 ?? "") ||
    p.code !== ({ sent: "accepted",not_sent: "preflight_failed",unknown: "delivery_uncertain" } as const)[p.status] ||
    (p.status !== "sent" && p.reference !== null) ||
    (p.status === "sent" && (typeof p.reference !== "string" || !p.reference || p.reference.length > 500 || /[\r\n]/.test(p.reference)))) return;
  const changed = await ctx.db.execute(`UPDATE ${ns(ctx)}.support_outbound SET status=$5,external_reference=$6,delivery_code=$7,updated_at=now()
    WHERE company_id=$1 AND id=$2 AND content_sha256=$3 AND provider=$4 AND status IN ('pending','unknown')`,[event.companyId,p.deliveryId,p.contentSha256,event.actorId,p.status,p.reference,p.code]);
  if (changed.rowCount) await ctx.activity.log({ companyId: event.companyId,message: `Support delivery ${p.status}`,entityType: "support_delivery",entityId: p.deliveryId,
    metadata: { provider: event.actorId,reference: p.reference,code: p.code } });
}
export async function reconcilePendingDeliveries(ctx: PluginContext) {
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_outbound SET status='unknown',delivery_code='receipt_missing',updated_at=now()
    WHERE policy_authorization IS NOT NULL AND status='pending' AND expires_at <= now()`);
  const rows = await ctx.db.query<OutboundRow>(`SELECT * FROM ${ns(ctx)}.support_outbound WHERE status='pending' AND policy_authorization IS NULL ORDER BY approved_at LIMIT 20`);
  for (const row of rows) {
    // Reemit the same immutable id; the connector ledger can only repeat its
    // receipt, never replay an already-claimed provider call.
    await ctx.events.emit("delivery-requested",row.company_id,request(row));
    if (new Date(row.expires_at!).getTime() <= Date.now()) await ctx.db.execute(`UPDATE ${ns(ctx)}.support_outbound SET status='unknown',delivery_code='receipt_missing',updated_at=now() WHERE company_id=$1 AND id=$2 AND status='pending'`,[row.company_id,row.id]);
  }
}
