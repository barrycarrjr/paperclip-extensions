import { randomUUID } from "node:crypto";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { deliveryHash, containsCredential } from "../../../lib/support-delivery.js";
import { IntakeError, type Config } from "./routing.js";
import { ns } from "./interactive-support.js";
import { authorizedTicket, ticketSource } from "./ticket-investigation.js";
import { ticketPolicy, ticketPolicyHash } from "./ticket-policy.js";
import { redactSource } from "./source-protection.js";
import { verifySlackWorkspace } from "./slack-poller.js";
import type { OutboundRow } from "./support-outbound.js";

interface PolicyReply extends OutboundRow { policy_authorization: { policySha256: string; agentId: string } }
/** One direct Slack attempt. Uses the pinned intake bot under explicit company policy,
 * not an invented human approval. The ordinary reviewed connector path remains unchanged. */
export async function sendTicketReply(ctx: PluginContext,getConfig: () => Promise<Config>,input: { companyId: string; caseId: string; body: string; actorAgentId: string }) {
  const cfg = await getConfig(); const policy = ticketPolicy(cfg,input.companyId);
  if (!policy.allowThreadUpdates || policy.agentId !== input.actorAgentId) throw new IntakeError(403, "Company policy does not authorize this agent's thread updates");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 10000 || containsCredential(input.body) || redactSource(input.body) !== input.body) throw new IntakeError(422, "Support update must contain no access information and be at most 10000 characters");
  const { supportCase,connection } = await ticketSource(ctx,cfg,input.companyId,input.caseId);
  if (!connection.botTokenRef) throw new IntakeError(422, "Automatic thread updates need this intake connection's Slack bot Secret and chat:write scope");
  const channelId = supportCase.external_route_id.split(":")[0]!;
  if (!/^[CG][A-Z0-9]{8,}$/.test(channelId) || !/^\d{10,11}\.\d{1,6}$/.test(supportCase.external_conversation_id)) throw new IntakeError(422, "Original Slack thread is invalid");
  const destination = { workspaceId: connection.externalAccountId,channelId,threadTs: supportCase.external_conversation_id };
  const request = { companyId: input.companyId,caseId: input.caseId,provider: "slack-tools" as const,account: connection.id,
    kind: "slack_reply" as const,destination,body: input.body.trim() };
  const hash = deliveryHash(request); const policyHash = ticketPolicyHash(policy);
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_outbound(id,company_id,case_id,case_review_version,provider,account,kind,destination,body,content_sha256,created_by_user_id,policy_authorization)
    VALUES($1,$2,$3,$4,'slack-tools',$5,'slack_reply',$6::jsonb,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING`,
    [randomUUID(),input.companyId,input.caseId,supportCase.review_version,connection.id,JSON.stringify(destination),request.body,hash,`agent:${input.actorAgentId}`,
      JSON.stringify({ policySha256: policyHash,agentId: input.actorAgentId })]);
  const [row] = await ctx.db.query<PolicyReply>(`SELECT * FROM ${ns(ctx)}.support_outbound WHERE company_id=$1 AND case_id=$2 AND case_review_version=$3 AND content_sha256=$4 AND retry_of_id IS NULL`, [input.companyId,input.caseId,supportCase.review_version,hash]);
  if (!row || row.policy_authorization?.policySha256 !== policyHash || row.policy_authorization.agentId !== input.actorAgentId) throw new IntakeError(409, "Existing reply requires operator review");
  if (row.status !== "draft") return { deliveryId: row.id,status: row.status,reference: row.external_reference };
  // Resolve and verify before claiming. Preflight failure has made no provider attempt.
  const token = await ctx.secrets.resolve(connection.botTokenRef);
  await verifySlackWorkspace(connection.externalAccountId,{ token,fetch: (url,init) => ctx.http.fetch(url,init) });
  const fresh = await getConfig(); const current = await ticketSource(ctx,fresh,input.companyId,input.caseId);
  if (ticketPolicyHash(ticketPolicy(fresh,input.companyId)) !== policyHash || current.connection.botTokenRef !== connection.botTokenRef ||
      current.supportCase.review_version !== row.case_review_version || current.supportCase.external_route_id !== supportCase.external_route_id ||
      current.supportCase.external_conversation_id !== supportCase.external_conversation_id) throw new IntakeError(409, "Ticket route or policy changed before sending");
  const claimed = await ctx.db.execute(`UPDATE ${ns(ctx)}.support_outbound SET status='pending',approved_at=now(),expires_at=now()+interval '1 minute',updated_at=now()
    WHERE company_id=$1 AND case_id=$2 AND id=$3 AND status='draft'`, [input.companyId,input.caseId,row.id]);
  if (!claimed.rowCount) return { deliveryId: row.id,status: "pending",reference: null };
  let status = "unknown"; let reference: string | null = null;
  try {
    const response = await ctx.http.fetch("https://slack.com/api/chat.postMessage",{ method: "POST",headers: { Authorization: `Bearer ${token}`,"Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: channelId,thread_ts: destination.threadTs,text: request.body,unfurl_links: false,unfurl_media: false }) });
    const result = await response.json() as { ok?: boolean; channel?: string; ts?: string; error?: string };
    if (response.ok && result.ok === true && result.channel === channelId && typeof result.ts === "string" && /^\d{10,11}\.\d{1,6}$/.test(result.ts)) { status = "sent"; reference = `${result.channel}:${result.ts}`; }
    else if (response.ok && result.ok === false && ["missing_scope","not_in_channel","channel_not_found","invalid_auth","token_revoked","account_inactive","restricted_action"].includes(result.error ?? "")) status = "not_sent";
  } catch { /* Provider outcome is unknown; never automatically repeat the request. */ }
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_outbound SET status=$4,external_reference=$5,delivery_code=$6,updated_at=now()
    WHERE company_id=$1 AND case_id=$2 AND id=$3 AND status='pending'`, [input.companyId,input.caseId,row.id,status,reference,status === "sent" ? "accepted" : status === "not_sent" ? "preflight_failed" : "delivery_uncertain"]);
  await ctx.activity.log({ companyId: input.companyId,message: `Policy-authorized support update ${status}`,entityType: "support_case",entityId: input.caseId,
    metadata: { deliveryId: row.id,policySha256: policyHash,agentId: input.actorAgentId,status,reference } });
  return { deliveryId: row.id,status,reference };
}

export async function reportTicket(ctx: PluginContext,getConfig: () => Promise<Config>,run: ToolRunContext,input: Record<string,unknown>) {
  const ticket = await authorizedTicket(ctx,await getConfig(),run,input.caseId);
  if (["awaiting_approval","resolved","needs_operator"].includes(ticket.job.status)) throw new IntakeError(409,"This ticket is awaiting operator review; the agent cannot resume or close it through a status report");
  if (typeof input.body !== "string" || !["investigating","waiting_requester","needs_operator","vendor_escalation"].includes(input.status as string)) throw new IntakeError(422, "Choose investigation, clarification, operator review or vendor escalation");
  const delivery = await sendTicketReply(ctx,getConfig,{ companyId: run.companyId,caseId: ticket.job.case_id,body: input.body,actorAgentId: run.agentId });
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_ticket_jobs SET status=$3,updated_at=now() WHERE company_id=$1 AND case_id=$2 AND status <> 'resolved'`,
    [run.companyId,ticket.job.case_id,delivery.status === "sent" ? input.status : "needs_operator"]);
  return { ...delivery,instruction: "Only sent means Slack accepted the update; it does not establish that the requester read it or the symptom is resolved. Unknown outcomes need provider inspection and cannot be replayed." };
}
