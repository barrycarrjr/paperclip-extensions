import { IntakeError, parseMessage, type AttachmentRef, type Connection, type IncomingMessage } from "./routing.js";
import { parseSlackWorkflowPost, slackCompanyToken } from "./slack-workflow.js";

interface SlackMessage {
  ts: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  files?: { id?: string; name?: string; title?: string; mimetype?: string; permalink?: string }[];
}

interface SlackResponse {
  ok?: boolean;
  error?: string;
  team_id?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackPollDeps {
  token: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  getCursor: (channelId: string) => Promise<string | null>;
  setCursor: (channelId: string, timestamp: string) => Promise<void>;
  ingest: (message: IncomingMessage) => Promise<void>;
}

export interface SlackThreadCase {
  companyId: string;
  externalRouteId: string;
  parentTs: string;
  title: string;
  cursorTs: string | null;
}

function attachmentRefs(message: SlackMessage): AttachmentRef[] {
  return (message.files ?? []).filter((file) => typeof file.id === "string" && file.id.length > 0)
    .slice(0, 20).map((file) => ({
      id: file.id!,
      name: file.name || file.title || file.id!,
      mimeType: file.mimetype,
      permalink: file.permalink,
    }));
}

function slackMessageUrl(channelId: string, timestamp: string): string {
  return `https://app.slack.com/archives/${channelId}/p${timestamp.replace(".", "")}`;
}

async function slackRequest(deps: Pick<SlackPollDeps, "token" | "fetch">, method: string, params?: URLSearchParams): Promise<SlackResponse> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) url.search = params.toString();
  const response = await deps.fetch(url.toString(), { headers: { Authorization: `Bearer ${deps.token}` } });
  if (!response.ok) throw new Error(`Slack HTTP request failed: ${response.status}`);
  const data = await response.json() as SlackResponse;
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? "unknown error"}`);
  return data;
}

export async function verifySlackWorkspace(externalAccountId: string, deps: Pick<SlackPollDeps, "token" | "fetch">): Promise<void> {
  const identity = await slackRequest(deps, "auth.test");
  if (identity.team_id !== externalAccountId) throw new Error("Slack token belongs to a different workspace");
}

function watchedChannelIds(connection: Connection): string[] {
  return [...new Set(connection.routes.map((route) => route.externalRouteId.split(":")[0]!)
    .filter((channelId) => /^[CG][A-Z0-9]{8,}$/.test(channelId)))];
}

function isWorkflowPost(message: SlackMessage): boolean {
  const botName = message.bot_profile?.name ?? message.username ?? "";
  if (/Help Desk Request Manager|Help Required Workflow/i.test(botName)) return true;
  const text = message.text ?? "";
  return /(?:^|\n)\*?Company\*?\s*:/i.test(text) && /(?:^|\n)\*?Request\*?\s*:/i.test(text);
}

async function history(deps: SlackPollDeps, channelId: string, oldest: string, cursor?: string): Promise<SlackResponse> {
  const params = new URLSearchParams({ channel: channelId, oldest, inclusive: "false", limit: "100" });
  if (cursor) params.set("cursor", cursor);
  return slackRequest(deps, "conversations.history", params);
}

/** Poll only explicitly configured Slack workflow channels; the first run baselines without backfill. */
export async function pollSlackWorkflows(connection: Connection, deps: SlackPollDeps): Promise<number> {
  if (connection.source !== "slack") throw new Error("Slack polling requires a Slack connection");
  await verifySlackWorkspace(connection.externalAccountId, deps);
  let ingested = 0;
  for (const channelId of watchedChannelIds(connection)) {
    const last = await deps.getCursor(channelId);
    if (!last) {
      const latest = await history(deps, channelId, "0", undefined);
      const baseline = latest.messages?.[0]?.ts ?? `${Math.floor(Date.now() / 1000)}.000000`;
      await deps.setCursor(channelId, baseline);
      continue;
    }
    const pending: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await history(deps, channelId, last, cursor);
      pending.push(...(result.messages ?? []));
      if (!result.has_more) break;
      cursor = result.response_metadata?.next_cursor;
      if (!cursor || page === 9) throw new Error("Slack history exceeds one polling batch; cursor was not advanced");
    }
    pending.sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const post of pending) {
      if (isWorkflowPost(post)) {
        const text = post.text ?? "";
        const routeKey = `${channelId}:${slackCompanyToken(text)}`;
        const routes = connection.routes.filter((route) => route.externalRouteId === routeKey);
        if (routes.length !== 1 || !connection.allowedCompanies.includes(routes[0]!.companyId)) {
          throw new IntakeError(403, `No unique company route for ${routeKey}`);
        }
        const normalized = parseSlackWorkflowPost({
          companyId: routes[0]!.companyId,
          connectionId: connection.id,
          externalAccountId: connection.externalAccountId,
          channelId,
          messageTs: post.ts,
          threadTs: post.thread_ts,
          text,
          externalUrl: slackMessageUrl(channelId, post.ts),
          authorExternalId: post.user ?? post.bot_id,
          attachments: attachmentRefs(post),
        });
        await deps.ingest(normalized);
        ingested += 1;
      }
      await deps.setCursor(channelId, post.ts);
    }
  }
  return ingested;
}

/** Sync one known case after workspace identity was verified by the parent poll. */
export async function syncSlackThread(connection: Connection, thread: SlackThreadCase, deps: Pick<SlackPollDeps, "token" | "fetch" | "ingest">): Promise<{ ingested: number; cursorTs: string | null }> {
  if (connection.source !== "slack") throw new Error("Slack thread sync requires a Slack connection");
  const route = connection.routes.filter((item) => item.externalRouteId === thread.externalRouteId);
  if (route.length !== 1 || route[0]!.companyId !== thread.companyId || !connection.allowedCompanies.includes(thread.companyId)) {
    throw new IntakeError(403, "Thread route does not map uniquely to this company");
  }
  const channelId = thread.externalRouteId.split(":")[0];
  if (!channelId || !/^[CG][A-Z0-9]{8,}$/.test(channelId) || !/^\d{10,11}\.\d{1,6}$/.test(thread.parentTs)) {
    throw new IntakeError(422, "Invalid Slack thread identity");
  }
  if (thread.cursorTs && !/^\d{10,11}\.\d{1,6}$/.test(thread.cursorTs)) {
    throw new IntakeError(422, "Invalid Slack thread cursor");
  }
  const pending: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ channel: channelId, ts: thread.parentTs, limit: "15" });
    if (thread.cursorTs) {
      params.set("oldest", thread.cursorTs);
      params.set("inclusive", "false");
    }
    if (cursor) params.set("cursor", cursor);
    const result = await slackRequest(deps, "conversations.replies", params);
    pending.push(...(result.messages ?? []));
    if (!result.has_more) break;
    cursor = result.response_metadata?.next_cursor;
    if (!cursor || page === 9) throw new Error("Slack thread exceeds one sync batch; cursor was not advanced");
  }
  pending.sort((a, b) => Number(a.ts) - Number(b.ts));
  let latestTs = thread.cursorTs;
  let ingested = 0;
  for (const reply of pending) {
    if (!/^\d{10,11}\.\d{1,6}$/.test(reply.ts)) throw new Error("Slack returned an invalid message timestamp");
    if (reply.thread_ts && reply.thread_ts !== thread.parentTs) throw new Error("Slack returned a reply from another thread");
    const attachments = attachmentRefs(reply);
    if (reply.text?.trim() || attachments.length) {
      await deps.ingest(parseMessage({
        companyId: thread.companyId,
        connectionId: connection.id,
        externalAccountId: connection.externalAccountId,
        externalRouteId: thread.externalRouteId,
        externalConversationId: thread.parentTs,
        externalMessageId: reply.ts,
        title: thread.title,
        body: reply.text?.trim() || "[Attachment shared]",
        authorKind: reply.bot_id || reply.bot_profile ? "bot" : "staff",
        authorExternalId: reply.user ?? reply.bot_id,
        attachments,
        occurredAt: new Date(Number(reply.ts) * 1000).toISOString(),
      }));
      ingested += 1;
    }
    if (!latestTs || Number(reply.ts) > Number(latestTs)) latestTs = reply.ts;
  }
  return { ingested, cursorTs: latestTs };
}
