import { IntakeError, parseMessage, type IncomingMessage } from "./routing.js";

export function slackCompanyToken(text: string): string {
  const fields = text.split(/\r?\n/).map((line) => line.trim());
  const answers = fields.map((line) => /^\*?Company\*?\s*:\*?\s*(.+)$/i.exec(line)?.[1]?.trim()).filter((value): value is string => Boolean(value));
  if (answers.length !== 1) throw new IntakeError(422, "Slack workflow must contain exactly one Company answer");
  const token = answers[0]!.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!token || token.length > 40) throw new IntakeError(422, "Invalid Company answer");
  return token;
}

/** Normalize a message posted by a Slack Workflow Builder form. */
export function parseSlackWorkflowPost(body: unknown): IncomingMessage {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new IntakeError(422, "JSON object required");
  const input = body as Record<string, unknown>;
  const text = input.text;
  if (typeof text !== "string" || !text.trim()) throw new IntakeError(422, "Slack workflow text is required");

  // Workflow Builder may render field names bold. A missing or repeated company
  // answer is ambiguous, so neither is allowed to fall through to a default.
  const fields = text.split(/\r?\n/).map((line) => line.trim());
  const companyToken = slackCompanyToken(text);

  const channelId = input.channelId;
  if (typeof channelId !== "string" || !/^[CG][A-Z0-9]{8,}$/.test(channelId)) {
    throw new IntakeError(422, "channelId must be a Slack channel ID");
  }
  const messageTs = input.messageTs;
  if (typeof messageTs !== "string" || !/^\d{10,11}\.\d{1,6}$/.test(messageTs)) {
    throw new IntakeError(422, "messageTs must be a Slack timestamp");
  }
  const threadTs = input.threadTs;
  if (threadTs !== undefined && (typeof threadTs !== "string" || !/^\d{10,11}\.\d{1,6}$/.test(threadTs))) {
    throw new IntakeError(422, "threadTs must be a Slack timestamp");
  }
  const requestLine = fields.map((line) => /^\*?Request\*?\s*:\*?\s*(.+)$/i.exec(line)?.[1]?.trim()).find(Boolean);
  const occurredAt = new Date(Number(messageTs) * 1000).toISOString();
  return parseMessage({
    companyId: input.companyId,
    connectionId: input.connectionId,
    externalAccountId: input.externalAccountId,
    externalRouteId: `${channelId}:${companyToken}`,
    externalConversationId: threadTs ?? messageTs,
    externalMessageId: messageTs,
    title: requestLine ?? "Slack support request",
    body: text,
    authorKind: "staff",
    occurredAt,
    externalUrl: input.externalUrl,
    authorExternalId: input.authorExternalId,
    attachments: input.attachments,
  });
}
