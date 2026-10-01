import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError, resolveConnection, type Config } from "./routing.js";
import { resolveRemoteAccess } from "./remote-access.js";
import { ticketPolicy, ticketPolicyHash } from "./ticket-policy.js";

export interface TicketProof {
  policyHash: string; agentId: string; messageId: string; diagnosticId: string;
  connectionId: string; accountId: string; routeId: string; conversationId: string;
  accessHash: string; disruption: string;
}
export function accessHash(cfg: Config,companyId: string,target: string) {
  return createHash("sha256").update(JSON.stringify(resolveRemoteAccess(cfg,companyId,target))).digest("hex");
}
export async function operatorTicketProof(ctx: PluginContext,cfg: Config,companyId: string,caseId: string,target: string,actorId: string): Promise<TicketProof | undefined> {
  const [row] = await ctx.db.query<{ agent_id: string; policy_hash: string; latest_message_id: string; target_address: string | null;
    connection_id: string; source_account_id: string; external_route_id: string; external_conversation_id: string }>(
    `SELECT j.agent_id,j.policy_hash,j.latest_message_id,j.target_address,c.connection_id,c.source_account_id,c.external_route_id,c.external_conversation_id
      FROM ${ctx.db.namespace}.support_ticket_jobs j JOIN ${ctx.db.namespace}.support_cases c ON c.company_id=j.company_id AND c.id=j.case_id
      WHERE j.company_id=$1 AND j.case_id=$2`,[companyId,caseId]);
  if (!row) return;
  if (actorId.startsWith("agent:")) throw new IntakeError(403,"Automatic tickets must use the assigned ticket proposal tool and current diagnostic evidence");
  return { policyHash: row.policy_hash,agentId: row.agent_id,messageId: row.latest_message_id,diagnosticId: "operator_review",
    connectionId: row.connection_id,accountId: row.source_account_id,routeId: row.external_route_id,conversationId: row.external_conversation_id,
    accessHash: accessHash(cfg,companyId,target),disruption: "Custom operator proposal: review its exact script and explain disruption before approving." };
}
/** Revalidate the evidence and authorization snapshot at approval and after any device queue wait. */
export async function assertTicketActionCurrent(ctx: PluginContext,cfg: Config | undefined,action: {
  company_id: string; case_id: string; target_address: string; ticket_proof?: TicketProof | null;
}) {
  const proof = action.ticket_proof; if (!proof) return;
  if (!cfg) throw new IntakeError(403,"Current company policy is required for this ticket proposal");
  const policy = ticketPolicy(cfg,action.company_id);
  const [row] = await ctx.db.query<{ latest_message_id: string; policy_hash: string; agent_id: string; target_address: string | null;
    connection_id: string; source_account_id: string; external_route_id: string; external_conversation_id: string; status: string }>(
    `SELECT j.latest_message_id,j.policy_hash,j.agent_id,j.target_address,c.connection_id,c.source_account_id,c.external_route_id,c.external_conversation_id,c.status
     FROM ${ctx.db.namespace}.support_ticket_jobs j JOIN ${ctx.db.namespace}.support_cases c ON c.company_id=j.company_id AND c.id=j.case_id
     WHERE j.company_id=$1 AND j.case_id=$2`,[action.company_id,action.case_id]);
  if (!row || row.status === "resolved" || row.latest_message_id !== proof.messageId || row.policy_hash !== proof.policyHash ||
      ticketPolicyHash(policy) !== proof.policyHash || policy.agentId !== proof.agentId || row.agent_id !== proof.agentId ||
      row.target_address !== action.target_address || row.connection_id !== proof.connectionId || row.source_account_id !== proof.accountId ||
      row.external_route_id !== proof.routeId || row.external_conversation_id !== proof.conversationId ||
      accessHash(cfg,action.company_id,action.target_address) !== proof.accessHash) {
    throw new IntakeError(409,"Ticket evidence, route, policy or access changed. Investigate again and create a fresh proposal");
  }
  resolveConnection(cfg,{ companyId: action.company_id,connectionId: proof.connectionId,externalAccountId: proof.accountId,externalRouteId: proof.routeId } as never);
  const agent = await ctx.agents.get(proof.agentId,action.company_id);
  if (!agent || ["paused","terminated","pending_approval"].includes(agent.status)) throw new IntakeError(403,"The proposal's support agent is unavailable");
}
