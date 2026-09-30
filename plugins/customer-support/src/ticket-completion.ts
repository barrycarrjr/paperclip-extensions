import { createHash } from "node:crypto";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { authorizedTicket, readTicketJob, ticketSource } from "./ticket-investigation.js";
import { ns, person } from "./interactive-support.js";
import { reviewCase } from "./case-review.js";
import { proposeSupportAction, decideSupportAction, executeSupportAction, listSupportActions } from "./support-actions.js";
import { accessHash, type TicketProof } from "./ticket-action-proof.js";
import { ticketPolicyHash } from "./ticket-policy.js";
import { prepareCaseRecipe } from "./repair-catalog.js";
import { redactSource } from "./source-protection.js";
import { containsCredential } from "../../../lib/support-delivery.js";
import { sendTicketReply } from "./ticket-replies.js";
import { runRemoteActionScriptUnlocked } from "./remote-action.js";
import { createEscalationDraft, resolveSoftwareRoute } from "./support-escalations.js";

function clean(value: unknown,name: string,max: number) {
  if (typeof value !== "string" || !value.trim() || value.length>max || containsCredential(value) || redactSource(value)!==value) throw new IntakeError(422,`${name} is required without access information (maximum ${max} characters)`);
  return value.trim();
}
export async function proposeTicketRepair(ctx: PluginContext,getConfig: () => Promise<Config>,run: ToolRunContext,input: Record<string,unknown>) {
  const cfg = await getConfig(); const ticket = await authorizedTicket(ctx,cfg,run,input.caseId);
  if (!["investigating","awaiting_approval"].includes(ticket.job.status) || ticket.supportCase.status === "resolved") throw new IntakeError(409,"Investigate this open ticket before proposing a repair");
  const target = ticket.job.target_address;
  if (!target) throw new IntakeError(422,"Run an allowed diagnostic on the confirmed affected computer first");
  const rationale = clean(input.rationale,"Diagnosis and applicability",2000);
  const [diagnostic] = await ctx.db.query<{ id: string }>(`SELECT id FROM ${ns(ctx)}.support_diagnostics WHERE company_id=$1 AND case_id=$2
    AND ticket_message_id=$3 AND ticket_target_address=$4 AND created_at>now()-interval '30 minutes' ORDER BY created_at DESC LIMIT 1`,[run.companyId,ticket.job.case_id,ticket.job.latest_message_id,target]);
  if (!diagnostic) throw new IntakeError(409,"A fresh diagnostic for this ticket's latest requester message and target is required");
  const proposalKey = createHash("sha256").update(JSON.stringify([ticket.job.latest_message_id,target,input.operation,input.options ?? {},rationale])).digest("hex");
  const [existing] = await ctx.db.query<{ id: string; status: string }>(`SELECT id,status FROM ${ns(ctx)}.support_actions WHERE company_id=$1 AND case_id=$2 AND proposal_key=$3`,[run.companyId,ticket.job.case_id,proposalKey]);
  if (existing) return { actionId: existing.id,status: existing.status,instruction: "Existing proposal; nothing was approved or executed. Read its receipt before further work." };
  if (ticket.job.status === "awaiting_approval") throw new IntakeError(409,"An existing proposal is waiting for operator review");
  if (ticket.supportCase.service_domain !== "unclassified" && !["it","equipment"].includes(ticket.supportCase.service_domain)) throw new IntakeError(409,"This is not a computer/equipment repair case; use its external software support route when appropriate");
  // Agent classification is explicitly attributed to the agent. It is not human approval.
  const prepared = await prepareCaseRecipe(ctx,cfg,{ companyId: run.companyId,actorId: `agent:${run.agentId}` },
    { id: ticket.job.case_id,target_address: target,review_version: ticket.supportCase.review_version+1,status: ticket.supportCase.status },input);
  const current = await authorizedTicket(ctx,await getConfig(),run,ticket.job.case_id);
  if (current.job.latest_message_id !== ticket.job.latest_message_id || current.supportCase.review_version !== ticket.supportCase.review_version) throw new IntakeError(409,"Ticket changed during preparation");
  const reviewed = await reviewCase(ctx,{ companyId: run.companyId,caseId: ticket.job.case_id,actorUserId: `agent:${run.agentId}`,
    expectedVersion: ticket.supportCase.review_version,serviceDomain: "it",workKind: "incident",status: "triage",targetAddress: target,
    accessMethod: "unknown",assetRef: null,orderRef: null,vendorRef: null,resolutionSummary: null });
  const proof: TicketProof = { policyHash: ticketPolicyHash(ticket.policy),agentId: run.agentId,messageId: ticket.job.latest_message_id,diagnosticId: diagnostic.id,
    connectionId: ticket.supportCase.connection_id,accountId: ticket.supportCase.source_account_id,routeId: ticket.supportCase.external_route_id,
    conversationId: ticket.supportCase.external_conversation_id,accessHash: accessHash(cfg,run.companyId,target),disruption: prepared.disruption };
  const action = await proposeSupportAction(ctx,await getConfig(),{ companyId: run.companyId,actorUserId: `agent:${run.agentId}`,
    ...prepared.repair,expectedReviewVersion: reviewed.reviewVersion,expectedEffect: `${prepared.repair.expectedEffect}. ${rationale}`.slice(0,1000),ticketProof: proof,proposalKey });
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_ticket_jobs SET status='awaiting_approval',proposal_action_id=$3,updated_at=now() WHERE company_id=$1 AND case_id=$2`,[run.companyId,ticket.job.case_id,action.id]);
  const delivery = await notifyTicket(ctx,getConfig,run.companyId,ticket.job.case_id,`Investigation has prepared a repair for operator review: ${prepared.repair.expectedEffect}. Disruption: ${prepared.disruption} Nothing has been approved or executed.`);
  return { actionId: action.id,status: action.status,target,reviewVersion: reviewed.reviewVersion,disruption: prepared.disruption,recoveryNotes: action.recovery_notes,delivery,
    instruction: "Waiting for an authorized operator's exact approval in the dashboard or Clippy. Requester messages, this agent and emergency delegation on another case cannot authorize it." };
}

/** Result updates are optional company policy, and always return the recorded delivery receipt. */
export async function notifyTicket(ctx: PluginContext,getConfig: () => Promise<Config>,companyId: string,caseId: string,body: string) {
  const [job] = await ctx.db.query<{ agent_id: string }>(`SELECT agent_id FROM ${ns(ctx)}.support_ticket_jobs WHERE company_id=$1 AND case_id=$2`,[companyId,caseId]);
  if (!job) return { status: "not_requested" };
  try { return await sendTicketReply(ctx,getConfig,{ companyId,caseId,body,actorAgentId: job.agent_id }); }
  catch { return { status: "unconfirmed",instruction: "No confirmed thread update. Inspect saved delivery receipts and current policy before sending another update; do not infer no provider attempt." }; }
}
export async function afterTicketRepair(ctx: PluginContext,getConfig: () => Promise<Config>,companyId: string,caseId: string,action: { status: string; id: string }) {
  const state = action.status === "verified" ? "waiting_requester" : "needs_operator";
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_ticket_jobs SET status=$3,updated_at=now() WHERE company_id=$1 AND case_id=$2`,[companyId,caseId,state]);
  return notifyTicket(ctx,getConfig,companyId,caseId,action.status === "verified"
    ? `Approved repair ${action.id} completed and its verification check passed. Does the original problem still occur? The case remains open until the symptom is confirmed.`
    : `Approved repair ${action.id} recorded outcome ${action.status}. We cannot claim the problem is fixed. An operator must inspect the outcome before another change.`);
}
export async function inspectOperatorTicket(ctx: PluginContext,cfg: Config,run: ToolRunContext,input: Record<string,unknown>) {
  const actor = person(run);
  if (run.userPermission !== "support:repair") throw new IntakeError(403,"Repair operator permission required");
  const job = await readTicketJob(ctx,actor.companyId,input.caseId);
  const source = await ticketSource(ctx,cfg,actor.companyId,job.case_id);
  const messages = await ctx.db.query(`SELECT id,body,author_kind,occurred_at FROM ${ns(ctx)}.support_messages WHERE company_id=$1 AND case_id=$2 AND source_protection_version=1 ORDER BY occurred_at DESC LIMIT 30`,[actor.companyId,job.case_id]);
  const diagnostics = await ctx.db.query(`SELECT id,check_kind,result,created_at FROM ${ns(ctx)}.support_diagnostics WHERE company_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 20`,[actor.companyId,job.case_id]);
  return { caseId: job.case_id,reviewVersion: source.supportCase.review_version,target: source.supportCase.target_address,job,messages,diagnostics,
    actions: await listSupportActions(ctx,actor.companyId,job.case_id),instruction: "Explain the exact proposal, disruption, verification and recovery. Use support_run_ticket_repair only after inline confirmation of the returned action ID, script and verification hashes, target and review version. This is an external ticket, not a delegated Clippy case." };
}
export async function runOperatorTicketRepair(ctx: PluginContext,getConfig: () => Promise<Config>,run: ToolRunContext,input: Record<string,unknown>,runner = runRemoteActionScriptUnlocked) {
  const cfg = await getConfig(); const inspected = await inspectOperatorTicket(ctx,cfg,run,input);
  if (!run.userConfirmed) throw new IntakeError(403,"Confirm this exact ticket repair in Clippy");
  const action = inspected.actions.find(item => item.id === input.actionId);
  if (!action || !action.ticket_proof || action.target_address !== input.target || action.case_review_version !== input.expectedReviewVersion ||
      action.script_sha256 !== input.scriptSha256 || action.verification_sha256 !== input.verificationSha256 || action.script_text !== input.script || action.verification_text !== input.verificationScript) throw new IntakeError(409,"Review the exact current ticket proposal before confirming");
  if (action.expected_effect !== input.expectedEffect || action.recovery_notes !== input.recoveryNotes || action.ticket_proof.disruption !== input.disruption) throw new IntakeError(409,"Review the proposal's effect, disruption and recovery before confirming");
  if (!["proposed","approved"].includes(action.status)) return { actionId: action.id,status: action.status,instruction: "Previously attempted or rejected; no new execution. Inspect its recorded outcome." };
  const scope = { companyId: run.companyId,caseId: inspected.caseId,actionId: action.id,actorUserId: run.userId! };
  if (action.status === "proposed") await decideSupportAction(ctx,{ ...scope,decision: "approved" },cfg);
  const result = await executeSupportAction(ctx,cfg,scope,runner,undefined,getConfig);
  const delivery = await afterTicketRepair(ctx,getConfig,run.companyId,inspected.caseId,result);
  return { actionId: result.id,status: result.status,repairRunId: result.repair_run_id,verificationRunId: result.verification_run_id,delivery };
}

export async function recordTicketOutcome(ctx: PluginContext,getConfig: () => Promise<Config>,input: { companyId: string; caseId: string; userId: string; expectedReviewVersion: number;
  expectedMessageId: unknown; outcome: unknown; basis: unknown; summary: unknown; evidence: unknown }) {
  if (!input.userId) throw new IntakeError(403,"Authorized repair operator required");
  const job = await readTicketJob(ctx,input.companyId,input.caseId);
  if (input.expectedMessageId !== job.latest_message_id) throw new IntakeError(409,"A requester message arrived since the review; refresh and confirm the latest symptom");
  await ticketSource(ctx,await getConfig(),input.companyId,job.case_id);
  if (!["resolved","still_present","needs_follow_up"].includes(input.outcome as string) || !["person_confirmed","observed","not_confirmed"].includes(input.basis as string) ||
      (input.outcome === "resolved" && input.basis === "not_confirmed")) throw new IntakeError(422,"Resolution needs original symptom observation or requester confirmation verified by the operator");
  const summary = clean(input.summary,"Outcome summary",2000); const evidence = clean(input.evidence,"Original symptom evidence",2000);
  const status = input.outcome === "resolved" ? "resolved" : input.outcome === "still_present" ? "triage" : "waiting";
  const changed = await ctx.db.execute(`UPDATE ${ns(ctx)}.support_cases c SET status=$4,resolution_summary=$5,symptom_outcome=$6,symptom_basis=$7,symptom_evidence=$8,
    symptom_recorded_by_user_id=$9,symptom_recorded_at=now(),review_version=review_version+1,reviewed_by_user_id=$9,reviewed_at=now(),updated_at=now()
    WHERE c.company_id=$1 AND c.id=$2 AND review_version=$3
      AND EXISTS (SELECT 1 FROM ${ns(ctx)}.support_ticket_jobs j WHERE j.company_id=c.company_id AND j.case_id=c.id AND j.latest_message_id=$10)
      AND NOT EXISTS (SELECT 1 FROM ${ns(ctx)}.support_actions a WHERE a.company_id=c.company_id AND a.case_id=c.id AND
        (a.status='running' OR (a.status IN ('unknown','proposed','approved') AND a.case_review_version=c.review_version)))`,
    [input.companyId,input.caseId,input.expectedReviewVersion,status,summary,input.outcome,input.basis,evidence,input.userId,input.expectedMessageId]);
  if (!changed.rowCount) throw new IntakeError(409,"Case changed or a repair still needs a decision/inspection. Reject unused proposals and inspect uncertain outcomes first");
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_ticket_jobs SET status=$3,updated_at=now() WHERE company_id=$1 AND case_id=$2`,[input.companyId,input.caseId,status === "resolved" ? "resolved" : "needs_operator"]);
  await ctx.activity.log({ companyId: input.companyId,message: "Ticket symptom outcome confirmed by operator",entityType: "support_case",entityId: input.caseId,
    metadata: { userId: input.userId,outcome: input.outcome,basis: input.basis } });
  let issueStatus: string = "not_linked";
  if (status === "resolved" && job.issue_id) {
    try {
      const issue = await ctx.issues.get(job.issue_id,input.companyId);
      if (!issue || issue.originKind !== "plugin:customer-support:investigation" || issue.originId !== input.caseId) throw new Error();
      await ctx.issues.update(issue.id,{ status: "done" },input.companyId,{ actorUserId: input.userId }); issueStatus = "done";
    } catch { issueStatus = "needs_operator_review"; }
  }
  const delivery = await notifyTicket(ctx,getConfig,input.companyId,input.caseId,status === "resolved" ? "An authorized operator confirmed the original problem is resolved and closed this case. Please report any returning problem."
    : "An authorized operator recorded that this case needs further investigation or follow-up. It remains open.");
  return { status,reviewVersion: input.expectedReviewVersion+1,delivery,issueStatus };
}
export async function draftTicketEscalation(ctx: PluginContext,getConfig: () => Promise<Config>,run: ToolRunContext,input: Record<string,unknown>) {
  const cfg = await getConfig(); const ticket = await authorizedTicket(ctx,cfg,run,input.caseId);
  if (!["investigating","vendor_escalation"].includes(ticket.job.status) || ticket.supportCase.status === "resolved") throw new IntakeError(409,"Review this open ticket before vendor escalation");
  const route = resolveSoftwareRoute(cfg,run.companyId,clean(input.routeId,"Configured product route",120));
  const title = clean(input.title,"Vendor issue title",300); const evidence = clean(input.evidence,"Vendor evidence",10000);
  const [existing] = await ctx.db.query<{ id: string }>(`SELECT id FROM ${ns(ctx)}.support_escalations WHERE company_id=$1 AND case_id=$2`,[run.companyId,ticket.job.case_id]);
  if (!existing) await reviewCase(ctx,{ companyId: run.companyId,caseId: ticket.job.case_id,actorUserId: `agent:${run.agentId}`,expectedVersion: ticket.supportCase.review_version,
    serviceDomain: "software",workKind: "incident",status: "waiting",targetAddress: null,accessMethod: "unknown",assetRef: null,orderRef: null,vendorRef: route.id,resolutionSummary: null });
  const draft = await createEscalationDraft(ctx,{ companyId: run.companyId,caseId: ticket.job.case_id,routeId: route.id,title,evidence,actorUserId: `agent:${run.agentId}` },cfg);
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_ticket_jobs SET status='vendor_escalation',updated_at=now() WHERE company_id=$1 AND case_id=$2`,[run.companyId,ticket.job.case_id]);
  return { ...draft,status: "draft",destinationKind: route.destinationKind,destination: route.destination,
    instruction: "Draft only. No vendor message or vendor-company issue was created. An authorized responder must review and send through the configured public email channel, or submit the public Jira form and record its external ticket reference. Do not claim submission without that receipt." };
}
