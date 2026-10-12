/**
 * Socket Mode bridge.
 *
 * Slack pushes events to the plugin over a WebSocket that the plugin opens
 * outbound (https://api.slack.com/apis/socket-mode), so a Paperclip host on a
 * private machine needs no public address. The plugin asks Slack for a socket
 * URL with an app-level token (xapp-...), connects, acknowledges every
 * envelope straight away (Slack retries anything not acknowledged within three
 * seconds), and hands event payloads to a handler.
 *
 * Only the pieces the inbound-DM feature needs are implemented: hello,
 * disconnect (reconnect on request), and events_api envelopes.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";

/** A file attached to a DM, as the message event describes it. */
export interface DmFile {
  name: string;
  /** Slack's id for the file; null when the event did not carry one. */
  id: string | null;
  /** What Slack says the file is, e.g. "image/png"; null when it did not say. */
  mimetype: string | null;
}

export interface OperatorDm {
  workspaceKey: string;
  userId: string;
  channelId: string;
  ts: string;
  threadTs: string | null;
  /** Empty when the message is only files. */
  text: string;
  /** Files attached to the message. */
  files: DmFile[];
  eventId: string | null;
}

type Logger = Pick<PluginContext["logger"], "info" | "warn" | "error">;

/** The subset of the WebSocket API the connection uses; tests pass a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; message?: unknown; error?: unknown }) => void,
  ): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface SocketModeOptions {
  appToken: string;
  logger: Logger;
  onEnvelope: (payload: Record<string, unknown>) => Promise<void> | void;
  /** Button presses and other interactive payloads (`block_actions`). */
  onInteractive?: (payload: Record<string, unknown>) => Promise<void> | void;
  label?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export async function openSocketModeUrl(appToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
  if (!body.ok || !body.url) {
    throw new Error(`apps.connections.open failed: ${body.error ?? `HTTP ${res.status}`}`);
  }
  return body.url;
}

function defaultSocketFactory(url: string): SocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Ctor) {
    throw new Error("WebSocket is not available in this Node runtime (Node 22 or newer is required)");
  }
  return new Ctor(url);
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const inner = (value as { error?: unknown; message?: unknown }).error ?? (value as { message?: unknown }).message;
    if (inner instanceof Error) return inner.message;
    if (typeof inner === "string") return inner;
  }
  return String(value);
}

export class SocketModeConnection {
  private socket: SocketLike | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private readonly seenEnvelopes: string[] = [];
  private readonly label: string;

  constructor(private readonly opts: SocketModeOptions) {
    this.label = opts.label ?? "slack-tools socket mode";
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "plugin shutdown");
    } catch {
      // closing an already-closed socket is fine
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      url = await openSocketModeUrl(this.opts.appToken, this.opts.fetchImpl ?? fetch);
    } catch (err) {
      this.opts.logger.warn(`${this.label}: could not open a Socket Mode connection: ${describeError(err)}`);
      this.scheduleReconnect();
      return;
    }
    let socket: SocketLike;
    try {
      socket = (this.opts.socketFactory ?? defaultSocketFactory)(url);
    } catch (err) {
      this.opts.logger.error(`${this.label}: ${describeError(err)}`);
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.opts.logger.info(`${this.label}: connected`);
    });
    socket.addEventListener("message", (event) => {
      void this.handleMessage(socket, typeof event.data === "string" ? event.data : String(event.data ?? ""));
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    });
    socket.addEventListener("error", (event) => {
      this.opts.logger.warn(`${this.label}: socket error: ${describeError(event)}`);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = this.opts.reconnectDelayMs ?? 1_000;
    const max = this.opts.maxReconnectDelayMs ?? 30_000;
    const delay = Math.min(max, base * 2 ** Math.min(this.attempt, 10));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async handleMessage(socket: SocketLike, raw: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof message.type === "string" ? message.type : "";
    const envelopeId = typeof message.envelope_id === "string" ? message.envelope_id : null;
    if (envelopeId) {
      // Acknowledge before doing anything else; Slack re-sends unacknowledged
      // envelopes, and a slow handler must not turn one message into three.
      try {
        socket.send(JSON.stringify({ envelope_id: envelopeId }));
      } catch (err) {
        this.opts.logger.warn(`${this.label}: could not acknowledge envelope: ${describeError(err)}`);
      }
      if (this.seenEnvelopes.includes(envelopeId)) return;
      this.seenEnvelopes.push(envelopeId);
      if (this.seenEnvelopes.length > 500) this.seenEnvelopes.shift();
    }
    if (type === "hello") return;
    if (type === "disconnect") {
      const reason = typeof message.reason === "string" ? message.reason : "unspecified";
      this.opts.logger.info(`${this.label}: Slack asked for a reconnect (${reason})`);
      if (this.socket === socket) this.socket = null;
      try {
        socket.close(1000, "slack requested reconnect");
      } catch {
        // already closed
      }
      this.scheduleReconnect();
      return;
    }
    const payload =
      message.payload && typeof message.payload === "object"
        ? (message.payload as Record<string, unknown>)
        : {};
    if (type === "events_api") {
      try {
        await this.opts.onEnvelope(payload);
      } catch (err) {
        this.opts.logger.error(`${this.label}: event handler failed: ${describeError(err)}`);
      }
      return;
    }
    if (type === "interactive" && this.opts.onInteractive) {
      try {
        await this.opts.onInteractive(payload);
      } catch (err) {
        this.opts.logger.error(`${this.label}: interactive handler failed: ${describeError(err)}`);
      }
    }
  }
}

export const APPROVE_ACTION_ID = "paperclip_approval_approve";
export const REJECT_ACTION_ID = "paperclip_approval_reject";

export interface BlockAction {
  actionId: string;
  value: string;
  userId: string;
  channelId: string | null;
  messageTs: string | null;
}

/** The first button press in a `block_actions` payload, or null. */
export function extractBlockAction(payload: unknown): BlockAction | null {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  if (!root || root.type !== "block_actions") return null;
  const actions = Array.isArray(root.actions) ? root.actions : [];
  const first = actions.find((entry) => entry && typeof entry === "object") as Record<string, unknown> | undefined;
  if (!first) return null;
  const actionId = typeof first.action_id === "string" ? first.action_id : "";
  const value = typeof first.value === "string" ? first.value : "";
  const user = root.user && typeof root.user === "object" ? (root.user as Record<string, unknown>) : null;
  const userId = typeof user?.id === "string" ? user.id : "";
  if (!actionId || !value || !userId) return null;
  const channel = root.channel && typeof root.channel === "object" ? (root.channel as Record<string, unknown>) : null;
  const message = root.message && typeof root.message === "object" ? (root.message as Record<string, unknown>) : null;
  return {
    actionId,
    value,
    userId,
    channelId: typeof channel?.id === "string" ? channel.id : null,
    messageTs: typeof message?.ts === "string" ? message.ts : null,
  };
}

export interface PendingApprovalSummary {
  id: string;
  toolName: string;
  summary: string | null;
}

/** This plugin's own tools by their namespaced name, with the name the operator knows them by. */
const OWN_TOOL_LABELS = new Map((manifest.tools ?? []).map((tool) => [`${manifest.id}:${tool.name}`, tool.displayName]));

/**
 * What kind of action a tool is, in words: "Send Slack DM" rather than
 * "slack-tools:slack_send_dm". Another plugin's tool gets its own name with
 * the underscores taken out.
 */
export function toolLabel(toolName: string): string {
  const own = OWN_TOOL_LABELS.get(toolName);
  if (own) return own;
  const words = (toolName.split(":").pop() ?? toolName).replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Action";
}

export function approvalLabel(approval: PendingApprovalSummary): string {
  const summary = approval.summary?.trim();
  return summary ? `${toolLabel(approval.toolName)} ${summary}` : toolLabel(approval.toolName);
}

/**
 * A time Slack shows in each reader's own time zone, with UTC as the
 * fallback for clients that cannot. The worker's clock is UTC, so a time it
 * formats itself reads hours off to anyone else.
 */
export function slackLocalTime(date: Date): string {
  const seconds = Math.floor(date.getTime() / 1000);
  return `<!date^${seconds}^{time}|${date.toISOString().slice(11, 16)} UTC>`;
}

/**
 * Block Kit blocks: one section plus Approve and Reject buttons per approval.
 * `note` adds a line under them, e.g. why a press did not go through.
 */
export function buildApprovalBlocks(pending: PendingApprovalSummary[], note?: string): unknown[] {
  const blocks: unknown[] = [];
  for (const approval of pending) {
    blocks.push(
      {
        type: "section",
        block_id: `approval_text:${approval.id}`,
        text: { type: "mrkdwn", text: `*Waiting for your approval:* ${approvalLabel(approval)}` },
      },
      {
        type: "actions",
        block_id: `approval:${approval.id}`,
        elements: [
          {
            type: "button",
            action_id: APPROVE_ACTION_ID,
            value: approval.id,
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
          },
          {
            type: "button",
            action_id: REJECT_ACTION_ID,
            value: approval.id,
            style: "danger",
            text: { type: "plain_text", text: "Reject" },
          },
        ],
      },
    );
    if (note) {
      blocks.push({
        type: "context",
        block_id: `approval_note:${approval.id}`,
        elements: [{ type: "mrkdwn", text: note }],
      });
    }
  }
  return blocks;
}

/**
 * The same message after a decision: the buttons are gone and the first line
 * says what happened ("Sent:", "Rejected:"), so it cannot be read as still
 * waiting. `outcome` adds the detail underneath.
 */
export function buildDecidedBlocks(input: {
  approval: PendingApprovalSummary;
  headline: string;
  outcome: string;
}): unknown[] {
  return [
    {
      type: "section",
      block_id: `approval_text:${input.approval.id}`,
      text: { type: "mrkdwn", text: `*${input.headline}* ${approvalLabel(input.approval)}` },
    },
    {
      type: "context",
      block_id: `approval_outcome:${input.approval.id}`,
      elements: [{ type: "mrkdwn", text: input.outcome }],
    },
  ];
}

/** Split a long reply at paragraph boundaries so each Slack message stays readable. */
export function chunkText(text: string, max = 3800): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return [trimmed];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    current = "";
    let rest = paragraph;
    while (rest.length > max) {
      chunks.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    current = rest;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Message subtypes that are still the operator writing to the bot: a message
 * with files attached, and a thread reply also sent to the conversation.
 * Every other subtype (edits, deletions, joins) is not a new message.
 */
const OPERATOR_MESSAGE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/**
 * A direct message from one of the operator's user ids, or null for anything
 * else: bot posts, edits and deletions, channel messages, other people, and a
 * message with neither text nor files.
 */
export function extractOperatorDm(
  payload: unknown,
  opts: { workspaceKey: string; fromUserIds: string[] },
): OperatorDm | null {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const event = root?.event && typeof root.event === "object" ? (root.event as Record<string, unknown>) : null;
  if (!event || event.type !== "message") return null;
  if (event.channel_type !== "im") return null;
  if (typeof event.subtype === "string" && event.subtype.length > 0 && !OPERATOR_MESSAGE_SUBTYPES.has(event.subtype)) {
    return null;
  }
  if (event.bot_id) return null;
  const userId = typeof event.user === "string" ? event.user : "";
  if (!userId || !opts.fromUserIds.includes(userId)) return null;
  const text = typeof event.text === "string" ? event.text.trim() : "";
  const files = (Array.isArray(event.files) ? event.files : []).map((file): DmFile => {
    const entry = file && typeof file === "object" ? (file as { name?: unknown; id?: unknown; mimetype?: unknown }) : {};
    return {
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "a file",
      id: typeof entry.id === "string" && entry.id ? entry.id : null,
      mimetype: typeof entry.mimetype === "string" && entry.mimetype ? entry.mimetype.toLowerCase() : null,
    };
  });
  if (!text && files.length === 0) return null;
  const channelId = typeof event.channel === "string" ? event.channel : "";
  const ts = typeof event.ts === "string" ? event.ts : "";
  if (!channelId || !ts) return null;
  return {
    workspaceKey: opts.workspaceKey,
    userId,
    channelId,
    ts,
    threadTs: typeof event.thread_ts === "string" ? event.thread_ts : null,
    text,
    files,
    eventId: typeof root?.event_id === "string" ? root.event_id : null,
  };
}

/** Images that went to Clippy with a DM, and ones that could not be opened, with why in plain words. */
export interface DmImageNotes {
  sent: Array<{ name: string }>;
  failed: Array<{ name: string; reason: string }>;
}

/** "an image (a.png)" or "2 images (a.png, b.png)". */
function namedList(items: Array<{ name: string }>, one: string, many: string): string {
  return items.length === 1
    ? `${one} (${items[0]!.name})`
    : `${items.length} ${many} (${items.map((item) => item.name).join(", ")})`;
}

/**
 * The message with a note on what came with it. A file Clippy cannot be
 * shown is named, so a message that was only a file is still answered rather
 * than ignored. Images that were sent are named too: a Paperclip server too
 * old to take them drops them without a word, and the note is then all
 * Clippy has.
 */
export function withAttachmentNote(
  text: string,
  files: Array<{ name: string }>,
  images: DmImageNotes = { sent: [], failed: [] },
): string {
  const notes: string[] = [];
  if (files.length > 0) {
    notes.push(
      `[Slack: the sender also attached ${namedList(files, "a file", "files")}, which cannot be opened from Slack. If it matters, say so and ask what it shows.]`,
    );
  }
  const failedByReason = new Map<string, Array<{ name: string }>>();
  for (const image of images.failed) {
    failedByReason.set(image.reason, [...(failedByReason.get(image.reason) ?? []), image]);
  }
  for (const [reason, group] of failedByReason) {
    const [matters, shows] = group.length === 1 ? ["it matters", "it shows"] : ["they matter", "they show"];
    notes.push(
      `[Slack: the sender also attached ${namedList(group, "an image", "images")}, which could not be opened: ${reason}. If ${matters}, say so and ask what ${shows}.]`,
    );
  }
  if (images.sent.length > 0) {
    const [it, shows] = images.sent.length === 1 ? ["it", "it shows"] : ["them", "they show"];
    notes.push(
      `[Slack: the sender also attached ${namedList(images.sent, "an image", "images")}, sent with this message. If you cannot see ${it}, say so and ask what ${shows}.]`,
    );
  }
  if (notes.length === 0) return text;
  const note = notes.join("\n");
  return text ? `${text}\n\n${note}` : note;
}

export function slackTsToIso(ts: string): string | null {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * The prompt handed to the agent for one operator DM. It carries the message
 * and enough to reply in place; the agent's own instructions say how to treat
 * the sender.
 */
export function buildWakePrompt(dm: OperatorDm, now: Date = new Date()): string {
  const sentAt = slackTsToIso(dm.ts) ?? now.toISOString();
  const thread = dm.threadTs ? `, in thread ${dm.threadTs}` : "";
  return [
    `Slack DM from ${dm.userId} at ${sentAt} (workspace ${dm.workspaceKey}, channel ${dm.channelId}, ts ${dm.ts}${thread}):`,
    "",
    withAttachmentNote(dm.text, dm.files),
    "",
    `Act on it now and reply in the same DM with slack_send_dm (workspace ${dm.workspaceKey}, threadTs ${dm.threadTs ?? dm.ts}), so the answer sits in a thread under the message. Then read the DM channel for anything newer than ts ${dm.ts} and handle that too.`,
  ].join("\n");
}
