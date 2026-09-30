import type { PaperclipPluginManifestV1, PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { companyHasSupport, IntakeError, type Config } from "./routing.js";
import { person } from "./interactive-support.js";
import { listOutbound, prepareOutbound, retryNotSent, sendOutbound } from "./support-outbound.js";

const caseId = { type: "string" };
export const outboundTools: NonNullable<PaperclipPluginManifestV1["tools"]> = [
  { name: "support_prepare_message",displayName: "Prepare a support reply or vendor email",requiredUserPermission: "support:respond",writes: true,
    description: "Save a reviewed message draft for a company support case. Slack replies are pinned to the original workspace/channel/thread; vendor emails use a configured software product route and Email Tools mailbox. No arbitrary recipient or credentials. This does not send anything. Show the exact destination, subject and body before asking to send. Jira forms, Help Scout replies and email source replies are not automated yet.",
    parametersSchema: { type: "object",additionalProperties: false,properties: { caseId,expectedReviewVersion: { type: "integer" },kind: { type: "string",enum: ["slack_reply","vendor_email"] },routeId: { type: "string" },subject: { type: "string",maxLength: 300 },body: { type: "string",maxLength: 10000 } },required: ["caseId","expectedReviewVersion","kind","body"] } },
  { name: "support_send_message",displayName: "Approve and send the saved support message",requiredUserPermission: "support:respond",requiresUserConfirmation: true,writes: true,
    description: "Ask the person to confirm sending this exact saved draft inside Clippy. Pass the complete destination object, body and hash returned by support_prepare_message so they can review it. Approval queues one provider attempt; pending is not sent. Read the receipt before claiming delivery. Unknown outcomes cannot be retried blindly; emergency repair delegation does not authorize sending messages.",
    parametersSchema: { type: "object",additionalProperties: false,properties: { caseId,deliveryId: { type: "string" },contentSha256: { type: "string" },body: { type: "string" },destination: { type: "object",additionalProperties: false,properties: { workspaceId: { type: "string" },channelId: { type: "string" },threadTs: { type: "string" },to: { type: "string" },subject: { type: "string" } } } },required: ["caseId","deliveryId","contentSha256","body","destination"] } },
  { name: "support_get_deliveries",displayName: "Read support drafts and delivery receipts",requiredUserPermission: "support:respond",
    description: "Read this company case's saved outbound drafts and delivery receipts. sent means accepted by Slack/SMTP, not read by the recipient. unknown requires inspection at the provider, never a blind resend.",
    parametersSchema: { type: "object",additionalProperties: false,properties: { caseId },required: ["caseId"] } },
  { name: "support_prepare_message_retry",displayName: "Prepare a confirmed not-sent message retry",requiredUserPermission: "support:respond",writes: true,
    description: "Prepare a new draft only for a delivery whose receipt says not_sent. Correct connector configuration first. Fresh confirmation is required to send it. Refuses pending, sent and unknown outcomes.",
    parametersSchema: { type: "object",additionalProperties: false,properties: { caseId,deliveryId: { type: "string" } },required: ["caseId","deliveryId"] } },
];
export async function handleOutboundTool(ctx: PluginContext,cfg: Config,name: string,params: Record<string,unknown>,run: ToolRunContext) {
  if (run.userPermission !== "support:respond") throw new IntakeError(403,"Paperclip must verify your support reply permission");
  const actor = person(run);
  if (!companyHasSupport(cfg,actor.companyId)) throw new IntakeError(403,"Support Desk is not configured for this company");
  const input = { ...params,companyId: actor.companyId,actorUserId: actor.userId,caseId: params.caseId as string };
  if (name === "support_prepare_message") return prepareOutbound(ctx,cfg,{ ...input,kind: params.kind,body: params.body,expectedReviewVersion: params.expectedReviewVersion });
  if (name === "support_prepare_message_retry") return retryNotSent(ctx,{ ...input,deliveryId: params.deliveryId });
  if (name === "support_send_message") {
    if (!run.userConfirmed) throw new IntakeError(403,"Confirm the exact message in Clippy before sending");
    return sendOutbound(ctx,cfg,{ ...input,deliveryId: params.deliveryId,contentSha256: params.contentSha256,confirmedBody: params.body,confirmedDestination: params.destination });
  }
  if (name === "support_get_deliveries") return listOutbound(ctx,actor.companyId,input.caseId);
  throw new IntakeError(404,"Unknown support message tool");
}
export function registerOutboundTools(ctx: PluginContext,config: () => Promise<Config>) {
  for (const tool of outboundTools) ctx.tools.register(tool.name,tool,async (params,run) => {
    try { return { data: await handleOutboundTool(ctx,await config(),tool.name,params as Record<string,unknown>,run) }; }
    catch (error) { return { error: error instanceof IntakeError ? error.message : "Support message operation failed. Read saved delivery receipts before retrying." }; }
  });
}
