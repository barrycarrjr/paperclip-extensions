import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import nodemailer from "nodemailer";
import {
  mapAttachmentsForNodemailer,
  parseOutboundAttachments,
  type OutboundAttachment,
} from "./attachments.js";
import { assertCompanyAccess, isCompanyAllowed } from "./companyAccess.js";
import {
  fetchHeaders,
  fetchParsedMessage,
  findTrashFolder,
  getAttachment,
  getUidValidity,
  listFolders,
  listSelectableFolders,
  moveMessages,
  searchMessages,
  setSeenFlag,
  type ParsedMessage,
} from "./imap.js";
import { mergeSearchResults, planFolderScope, type SearchHit } from "./search-scope.js";
import {
  nonBlank,
  resolveOwnAddress,
  resolveSmtpFrom,
  resolveSmtpHost,
  resolveSmtpUser,
  withoutOwnAddress,
} from "./smtp-identity.js";
import {
  describeInvalidPattern,
  isRuleType,
  isValidRulePattern,
  normalizeRulePattern,
} from "./rule-patterns.js";
import {
  parseStoredCursor,
  planCursorAdvance,
  resolveSince,
  triageCursorScope,
} from "./triage-cursor.js";
import { ActionConnectionPool } from "./connection-pool.js";
import {
  runPoll,
  buildMailboxRuntime,
  applyAutoTriageRuleToInbox,
  applyMuteRuleToInbox,
  clearSecretCache,
  resolveMailboxSecret,
} from "./poll.js";
import { IdleManager } from "./idle.js";
import { buildThread } from "./threading.js";
import { testMailbox } from "./test-mailbox.js";
import { getAccessToken, startAuth, handleCallback } from "./oauth.js";
import type { ConfigMailbox, InstanceConfig } from "./types.js";

interface SmtpRuntime {
  key: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  /** OAuth2 access token (XOAUTH2). When set, takes precedence over smtpPass. */
  accessToken?: string;
}

function findConfigMailbox(config: InstanceConfig, key: string): ConfigMailbox | undefined {
  const lower = key.toLowerCase();
  return (config.mailboxes ?? []).find((m) => (m.key ?? "").toLowerCase() === lower);
}

// Superseded by `deriveSmtpHost` in ./smtp-identity.ts, which the resolvers
// there call. Kept as the undo path.
// function deriveSmtpHost(imapHost: string): string {
//   return imapHost.startsWith("imap.") ? "smtp." + imapHost.slice(5) : imapHost;
// }

async function buildSmtpRuntime(
  ctx: PluginContext,
  cfg: ConfigMailbox,
  key: string,
): Promise<SmtpRuntime> {
  // Whitespace counts as not set. A field holding only spaces used to pass
  // these guards and then resolve to an empty sender, which the mail server
  // rejects with a message naming no setting the operator could go and fix.
  if (!nonBlank(cfg.imapHost)) throw new Error(`Mailbox "${key}": imapHost is required.`);
  if (!nonBlank(cfg.user)) throw new Error(`Mailbox "${key}": user is required.`);
  const smtpPort = typeof cfg.smtpPort === "number" ? cfg.smtpPort : 465;
  if (!Number.isFinite(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
    throw new Error(`Mailbox "${key}": invalid smtpPort ${smtpPort}.`);
  }
  const smtpSecure = typeof cfg.smtpSecure === "boolean" ? cfg.smtpSecure : smtpPort === 465;

  let smtpPass = "";
  let accessToken: string | undefined;
  if (cfg.authType === "oauth2") {
    const clientId = ((await ctx.config.get()) as InstanceConfig).oauthMicrosoftClientId;
    if (!clientId) {
      throw new Error(`Mailbox "${key}": OAuth is enabled but no Microsoft OAuth Client ID is set on the plugin settings page.`);
    }
    accessToken = await getAccessToken(ctx, { clientId, mailboxKey: key });
  } else {
    if (!cfg.pass) throw new Error(`Mailbox "${key}": pass (secret reference) is required.`);
    smtpPass = await resolveMailboxSecret(ctx, key, cfg.pass);
  }

  return {
    key,
    smtpHost: resolveSmtpHost(cfg),
    smtpPort,
    smtpSecure,
    smtpUser: resolveSmtpUser(cfg),
    smtpPass,
    accessToken,
    smtpFrom: resolveSmtpFrom(cfg),
  };
}

function ensureAngled(id: string): string {
  const t = id.trim();
  if (!t) return t;
  if (t.startsWith("<") && t.endsWith(">")) return t;
  return `<${t}>`;
}

function toField(v: string | string[]): string {
  return Array.isArray(v) ? v.join(", ") : v;
}

function normalizeUidArg(uid: unknown): number[] {
  if (typeof uid === "number" && Number.isFinite(uid)) return [Math.floor(uid)];
  if (Array.isArray(uid)) {
    return uid.filter((n) => typeof n === "number" && Number.isFinite(n)).map((n) => Math.floor(n));
  }
  return [];
}

/** Narrows an untyped bridge param to a non-empty string, or undefined. */
function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseDateArg(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

interface SendInput {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
  /** Validated wire shape (see parseOutboundAttachments); decoded to Buffers at send time. */
  attachments?: OutboundAttachment[];
}

async function sendViaSmtp(rt: SmtpRuntime, input: SendInput): Promise<{
  messageId: string;
  smtpResponse: string;
  accepted: string[];
  rejected: string[];
}> {
  const transporter = nodemailer.createTransport({
    host: rt.smtpHost,
    port: rt.smtpPort,
    secure: rt.smtpSecure,
    auth: rt.accessToken
      ? { type: "OAuth2", user: rt.smtpUser, accessToken: rt.accessToken }
      : { user: rt.smtpUser, pass: rt.smtpPass },
  });
  try {
    const info = await transporter.sendMail({
      from: input.from,
      to: toField(input.to),
      cc: input.cc ? toField(input.cc) : undefined,
      bcc: input.bcc ? toField(input.bcc) : undefined,
      replyTo: input.replyTo,
      subject: input.subject,
      text: input.body,
      html: input.bodyHtml,
      inReplyTo: input.inReplyTo ? ensureAngled(input.inReplyTo) : undefined,
      references:
        input.references && input.references.length > 0
          ? input.references.map(ensureAngled).join(" ")
          : undefined,
      attachments:
        input.attachments && input.attachments.length > 0
          ? mapAttachmentsForNodemailer(input.attachments)
          : undefined,
    });
    return {
      messageId: info.messageId ?? "",
      smtpResponse: typeof info.response === "string" ? info.response : "",
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  } finally {
    transporter.close();
  }
}

async function withImapConnection<T>(
  ctx: PluginContext,
  cfg: ConfigMailbox,
  key: string,
  fn: (client: import("imapflow").ImapFlow) => Promise<T>,
): Promise<T> {
  const rt = await buildMailboxRuntime(ctx, cfg, key);
  return actionPool.run(rt, fn);
}

function resolveFolder(cfg: ConfigMailbox, override: unknown): string {
  if (typeof override === "string" && override.length > 0) return override;
  return cfg.pollFolder ?? "INBOX";
}

function firstQuery(q: Record<string, string | string[]>, key: string): string {
  const v = q[key];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function oauthHtmlPage(message: string): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body:
      `<!doctype html><html><head><meta charset="utf-8"><title>Paperclip Email — OAuth</title>` +
      `<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b0b0d;color:#eee;` +
      `display:flex;align-items:center;justify-content:center;height:100vh;margin:0}` +
      `div{max-width:34rem;padding:2rem;text-align:center;line-height:1.6;font-size:1.05rem}</style>` +
      `</head><body><div>${message}</div></body></html>`,
  };
}

const actionPool = new ActionConnectionPool();

let idleManager: IdleManager | null = null;
let workerCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("email-tools plugin setup");
    workerCtx = ctx;

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowSend = !!rawConfig.allowSend;
    const mailboxes = rawConfig.mailboxes ?? [];

    if (!allowSend) {
      ctx.logger.warn(
        "email-tools: sending is disabled. Set 'allowSend' true on the plugin settings page.",
      );
    } else if (mailboxes.length === 0) {
      ctx.logger.warn(
        "email-tools: no mailboxes configured. Add them on the plugin settings page.",
      );
    } else {
      const summary = mailboxes
        .map((m) => {
          const k = m.key ?? "(no-key)";
          const allowed = m.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          const recv = m.pollEnabled
            ? `recv=${m.onReceive?.mode ?? "none"}@${m.ingestCompanyId ?? "MISSING"}`
            : "send-only";
          return `${k} [${access}, ${recv}]`;
        })
        .join(", ");
      ctx.logger.info(`email-tools: ready. Mailboxes — ${summary}`);

      const orphans = mailboxes.filter(
        (m) => !m.allowedCompanies || m.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `email-tools: ${orphans.length} mailbox(es) have no allowedCompanies and will reject every call. ` +
            `Backfill on the plugin settings page: ${orphans.map((m) => m.key ?? "(no-key)").join(", ")}`,
        );
      }
      const pollMissingIngest = mailboxes.filter(
        (m) => m.pollEnabled && !m.ingestCompanyId,
      );
      if (pollMissingIngest.length > 0) {
        ctx.logger.warn(
          `email-tools: ${pollMissingIngest.length} mailbox(es) have pollEnabled but no ingestCompanyId — receive will be skipped: ` +
            pollMissingIngest.map((m) => m.key ?? "(no-key)").join(", "),
        );
      }
    }

    ctx.tools.register(
      "email_send",
      {
        displayName: "Send Email",
        description:
          "Send a plain-text or HTML email via SMTP using one of the configured mailboxes.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        if (!config.allowSend) {
          return {
            error:
              "Sending is disabled. Set 'allowSend' true on the email-tools plugin settings page and save.",
          };
        }
        const p = params as {
          mailbox?: string;
          to?: string | string[];
          cc?: string | string[];
          bcc?: string | string[];
          subject?: string;
          body?: string;
          body_html?: string;
          in_reply_to?: string;
          references?: string[];
          reply_to?: string;
          attachments?: unknown;
        };
        if (!p.mailbox) return { error: "mailbox is required" };
        if (!p.to) return { error: "to is required" };
        if (!p.subject) return { error: "subject is required" };
        if (p.body === undefined) return { error: "body is required" };
        const attParse = parseOutboundAttachments(p.attachments);
        if (!attParse.ok) return { error: attParse.error };

        const cfg = findConfigMailbox(config, p.mailbox);
        if (!cfg) return { error: `Mailbox "${p.mailbox}" not configured.` };

        try {
          assertCompanyAccess(ctx, {
            tool: "email_send",
            resourceLabel: `email-tools mailbox "${p.mailbox}"`,
            resourceKey: p.mailbox,
            allowedCompanies: cfg.allowedCompanies,
            companyId: runCtx.companyId,
          });
        } catch (err) {
          return { error: (err as Error).message };
        }

        let rt: SmtpRuntime;
        try {
          rt = await buildSmtpRuntime(ctx, cfg, p.mailbox);
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const info = await sendViaSmtp(rt, {
            from: rt.smtpFrom,
            to: p.to,
            cc: p.cc,
            bcc: p.bcc,
            replyTo: p.reply_to,
            subject: p.subject,
            body: p.body,
            bodyHtml: p.body_html,
            inReplyTo: p.in_reply_to,
            references: p.references,
            attachments: attParse.attachments.length > 0 ? attParse.attachments : undefined,
          });
          await ctx.telemetry.track("email_send", {
            mailbox: rt.key,
            companyId: runCtx.companyId,
          });
          return {
            content: `Sent. Message-ID ${info.messageId || "?"}`,
            data: {
              ok: true,
              mailbox: rt.key,
              message_id: info.messageId,
              smtp_response: info.smtpResponse,
              accepted: info.accepted,
              rejected: info.rejected,
            },
          };
        } catch (err) {
          const e = err as { code?: string; responseCode?: number; message?: string };
          const code = e.code ? String(e.code) : "SMTP_ERROR";
          const message =
            (e.message ?? String(err)) + (e.responseCode ? ` (SMTP ${e.responseCode})` : "");
          return { error: `[${code}] ${message}` };
        }
      },
    );

    function gateMailbox(
      tool: string,
      mailboxKey: string | undefined,
      runCtx: ToolRunContext,
      config: InstanceConfig,
    ): { ok: true; cfg: ConfigMailbox } | { ok: false; error: string } {
      if (!mailboxKey) return { ok: false, error: "mailbox is required" };
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) return { ok: false, error: `Mailbox "${mailboxKey}" not configured.` };
      try {
        assertCompanyAccess(ctx, {
          tool,
          resourceLabel: `email-tools mailbox "${mailboxKey}"`,
          resourceKey: mailboxKey,
          allowedCompanies: cfg.allowedCompanies,
          companyId: runCtx.companyId,
        });
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      return { ok: true, cfg };
    }

    ctx.tools.register(
      "email_search",
      {
        displayName: "Search Email",
        description:
          "Search a configured mailbox via IMAP. Returns headers and snippets, no bodies.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        const p = params as {
          mailbox?: string;
          folder?: string;
          text?: string;
          from?: string;
          to?: string;
          subject?: string;
          since?: string;
          before?: string;
          unseen?: boolean;
          limit?: number;
        };
        const gate = gateMailbox("email_search", p.mailbox, runCtx, config);
        if (!gate.ok) return { error: gate.error };
        const { cfg } = gate;
        const folder = resolveFolder(cfg, p.folder);
        const limit = Math.min(200, Math.max(1, Math.floor(p.limit ?? 50)));
        try {
          const items = await withImapConnection(ctx, cfg, p.mailbox as string, async (client) => {
            const uids = await searchMessages(client, {
              folder,
              text: p.text,
              from: p.from,
              to: p.to,
              subject: p.subject,
              since: parseDateArg(p.since),
              before: parseDateArg(p.before),
              unseen: !!p.unseen,
            });
            const truncated = uids.length > limit;
            const slice = uids.slice(-limit);
            const headers = await fetchHeaders(client, folder, slice);
            return { items: headers, truncated };
          });
          await ctx.telemetry.track("email_search", {
            mailbox: cfg.key ?? "",
            companyId: runCtx.companyId,
            count: String(items.items.length),
          });
          return {
            content: `${items.items.length} message(s)`,
            data: { ok: true, mailbox: cfg.key, folder, ...items },
          };
        } catch (err) {
          return { error: `[IMAP_ERROR] ${(err as Error).message}` };
        }
      },
    );

    ctx.tools.register(
      "email_fetch",
      {
        displayName: "Fetch Email",
        description: "Fetch a single parsed message by UID.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        const p = params as { mailbox?: string; folder?: string; uid?: number };
        const gate = gateMailbox("email_fetch", p.mailbox, runCtx, config);
        if (!gate.ok) return { error: gate.error };
        if (typeof p.uid !== "number") return { error: "uid is required" };
        const folder = resolveFolder(gate.cfg, p.folder);
        try {
          const parsed = await withImapConnection(
            ctx,
            gate.cfg,
            p.mailbox as string,
            async (client) => fetchParsedMessage(client, folder, p.uid as number),
          );
          if (!parsed) return { error: "message not found" };
          await ctx.telemetry.track("email_fetch", {
            mailbox: gate.cfg.key ?? "",
            companyId: runCtx.companyId,
          });
          return {
            content: `Fetched UID ${parsed.uid}`,
            data: { ok: true, mailbox: gate.cfg.key, folder, message: parsed },
          };
        } catch (err) {
          return { error: `[IMAP_ERROR] ${(err as Error).message}` };
        }
      },
    );

    ctx.tools.register(
      "email_get_attachment",
      {
        displayName: "Get Email Attachment",
        description: "Download an attachment, base64-encoded, capped at 25 MB.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        const p = params as { mailbox?: string; folder?: string; uid?: number; partId?: string };
        const gate = gateMailbox("email_get_attachment", p.mailbox, runCtx, config);
        if (!gate.ok) return { error: gate.error };
        if (typeof p.uid !== "number") return { error: "uid is required" };
        if (!p.partId) return { error: "partId is required" };
        const folder = resolveFolder(gate.cfg, p.folder);
        try {
          const att = await withImapConnection(
            ctx,
            gate.cfg,
            p.mailbox as string,
            async (client) => getAttachment(client, folder, p.uid as number, p.partId as string),
          );
          if (!att) return { error: "attachment not found" };
          await ctx.telemetry.track("email_get_attachment", {
            mailbox: gate.cfg.key ?? "",
            companyId: runCtx.companyId,
            size: String(att.content.length),
          });
          return {
            content: `Downloaded ${att.filename} (${att.content.length} bytes)`,
            data: {
              ok: true,
              mailbox: gate.cfg.key,
              filename: att.filename,
              mime: att.mime,
              contentBase64: att.content.toString("base64"),
            },
          };
        } catch (err) {
          return { error: `[IMAP_ERROR] ${(err as Error).message}` };
        }
      },
    );

    ctx.tools.register(
      "email_thread",
      {
        displayName: "Get Email Thread",
        description: "Return all messages in the same conversation as the given UID or messageId.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        const p = params as { mailbox?: string; folder?: string; uid?: number; messageId?: string };
        const gate = gateMailbox("email_thread", p.mailbox, runCtx, config);
        if (!gate.ok) return { error: gate.error };
        if (typeof p.uid !== "number" && !p.messageId) {
          return { error: "uid or messageId is required" };
        }
        const folder = resolveFolder(gate.cfg, p.folder);
        try {
          const items = await withImapConnection(ctx, gate.cfg, p.mailbox as string, async (client) =>
            buildThread(client, folder, typeof p.uid === "number" ? p.uid : null, p.messageId ?? null),
          );
          await ctx.telemetry.track("email_thread", {
            mailbox: gate.cfg.key ?? "",
            companyId: runCtx.companyId,
            count: String(items.length),
          });
          return {
            content: `Thread with ${items.length} message(s)`,
            data: { ok: true, mailbox: gate.cfg.key, folder, items },
          };
        } catch (err) {
          return { error: `[IMAP_ERROR] ${(err as Error).message}` };
        }
      },
    );

    function registerFlagTool(toolName: string, on: boolean): void {
      ctx.tools.register(
        toolName,
        {
          displayName: on ? "Mark Email Read" : "Mark Email Unread",
          description: on ? "Add the \\Seen flag." : "Remove the \\Seen flag.",
          parametersSchema: {} as Record<string, unknown>,
        },
        async (params, runCtx): Promise<ToolResult> => {
          const config = (await ctx.config.get()) as InstanceConfig;
          const p = params as { mailbox?: string; folder?: string; uid?: unknown };
          const gate = gateMailbox(toolName, p.mailbox, runCtx, config);
          if (!gate.ok) return { error: gate.error };
          const uids = normalizeUidArg(p.uid);
          if (uids.length === 0) return { error: "uid is required" };
          const folder = resolveFolder(gate.cfg, p.folder);
          try {
            await withImapConnection(ctx, gate.cfg, p.mailbox as string, async (client) =>
              setSeenFlag(client, folder, uids, on),
            );
            await ctx.telemetry.track(toolName, {
              mailbox: gate.cfg.key ?? "",
              companyId: runCtx.companyId,
              count: String(uids.length),
            });
            return {
              content: `${on ? "Marked read" : "Marked unread"}: ${uids.length} message(s)`,
              data: { ok: true, mailbox: gate.cfg.key, folder, uids },
            };
          } catch (err) {
            return { error: `[IMAP_ERROR] ${(err as Error).message}` };
          }
        },
      );
    }
    registerFlagTool("email_mark_read", true);
    registerFlagTool("email_mark_unread", false);

    ctx.tools.register(
      "email_move",
      {
        displayName: "Move Email",
        description: "Move one or many messages to a target folder.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        const p = params as {
          mailbox?: string;
          folder?: string;
          uid?: unknown;
          targetFolder?: string;
        };
        const gate = gateMailbox("email_move", p.mailbox, runCtx, config);
        if (!gate.ok) return { error: gate.error };
        if (gate.cfg.disallowMove) {
          return {
            error: `[EMOVE_DISALLOWED] email_move is disabled for mailbox "${p.mailbox}". Untick 'Disallow moving messages' on the mailbox settings to enable.`,
          };
        }
        const uids = normalizeUidArg(p.uid);
        if (uids.length === 0) return { error: "uid is required" };
        if (!p.targetFolder) return { error: "targetFolder is required" };
        const folder = resolveFolder(gate.cfg, p.folder);
        try {
          const result = await withImapConnection(
            ctx,
            gate.cfg,
            p.mailbox as string,
            async (client) => moveMessages(client, folder, uids, p.targetFolder as string),
          );
          await ctx.telemetry.track("email_move", {
            mailbox: gate.cfg.key ?? "",
            companyId: runCtx.companyId,
            count: String(result.movedCount),
            destinationCreated: String(result.destinationCreated),
          });
          return {
            content:
              result.destinationCreated
                ? `Moved ${result.movedCount} message(s) to ${p.targetFolder} (folder created on first move).`
                : `Moved ${result.movedCount} message(s) to ${p.targetFolder}.`,
            data: {
              ok: true,
              mailbox: gate.cfg.key,
              folder,
              uids,
              targetFolder: p.targetFolder,
              movedCount: result.movedCount,
              destinationCreated: result.destinationCreated,
            },
          };
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          // Preserve structured error codes (`[EFOLDER_CREATE_FAILED]`,
          // `[EMOVE_FAILED]`, `[EMOVE_PARTIAL]`) thrown from moveMessages so
          // callers can branch on them. Only wrap as [IMAP_ERROR] if the
          // message doesn't already carry a code.
          const isStructured = /^\[E[A-Z_]+\]/.test(msg);
          return { error: isStructured ? msg : `[IMAP_ERROR] ${msg}` };
        }
      },
    );

    ctx.tools.register(
      "email_reply",
      {
        displayName: "Reply to Email",
        description:
          "Reply to a message by UID. Looks up Message-ID and References, then sends with proper threading headers.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const config = (await ctx.config.get()) as InstanceConfig;
        if (!config.allowSend) {
          return { error: "Sending is disabled. Set 'allowSend' true on the plugin settings page." };
        }
        const p = params as {
          mailbox?: string;
          folder?: string;
          uid?: number;
          body?: string;
          body_html?: string;
          replyAll?: boolean;
          attachments?: unknown;
        };
        const gate = gateMailbox("email_reply", p.mailbox, runCtx, config);
        if (!gate.ok) return { error: gate.error };
        if (typeof p.uid !== "number") return { error: "uid is required" };
        if (typeof p.body !== "string") return { error: "body is required" };
        const attParse = parseOutboundAttachments(p.attachments);
        if (!attParse.ok) return { error: attParse.error };
        const folder = resolveFolder(gate.cfg, p.folder);

        let original: ParsedMessage | null;
        try {
          original = await withImapConnection(ctx, gate.cfg, p.mailbox as string, async (client) =>
            fetchParsedMessage(client, folder, p.uid as number),
          );
        } catch (err) {
          return { error: `[IMAP_ERROR] ${(err as Error).message}` };
        }
        if (!original) return { error: "original message not found" };

        const ourAddress = resolveOwnAddress(gate.cfg);
        const replyTo = original.fromAddress
          ? [original.fromAddress]
          : original.from
            ? [original.from]
            : [];
        let cc: string[] = [];
        if (p.replyAll) {
          const merged = [...original.to, ...original.cc].flatMap((s) =>
            s.split(",").map((x) => x.trim()).filter(Boolean),
          );
          cc = withoutOwnAddress(merged, ourAddress);
        }

        const subject = original.subject?.match(/^re:/i)
          ? original.subject
          : `Re: ${original.subject ?? ""}`.trim();

        const refsChain = [...original.references];
        if (original.messageId && !refsChain.includes(original.messageId)) {
          refsChain.push(original.messageId);
        }

        let rt: SmtpRuntime;
        try {
          rt = await buildSmtpRuntime(ctx, gate.cfg, p.mailbox as string);
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const info = await sendViaSmtp(rt, {
            from: rt.smtpFrom,
            to: replyTo,
            cc: cc.length > 0 ? cc : undefined,
            subject,
            body: p.body,
            bodyHtml: p.body_html,
            inReplyTo: original.messageId ?? undefined,
            references: refsChain.length > 0 ? refsChain : undefined,
            attachments: attParse.attachments.length > 0 ? attParse.attachments : undefined,
          });
          await ctx.telemetry.track("email_reply", {
            mailbox: rt.key,
            companyId: runCtx.companyId,
          });
          return {
            content: `Replied. Message-ID ${info.messageId || "?"}`,
            data: {
              ok: true,
              mailbox: rt.key,
              message_id: info.messageId,
              smtp_response: info.smtpResponse,
              accepted: info.accepted,
              rejected: info.rejected,
              repliedTo: original.messageId,
            },
          };
        } catch (err) {
          const e = err as { code?: string; responseCode?: number; message?: string };
          const code = e.code ? String(e.code) : "SMTP_ERROR";
          return {
            error: `[${code}] ${(e.message ?? String(err)) + (e.responseCode ? ` (SMTP ${e.responseCode})` : "")}`,
          };
        }
      },
    );

    ctx.tools.register(
      "email_list_rules",
      {
        displayName: "List Email Triage Rules",
        description:
          "Return the operator's sender rules from the email-tools DB. Use this in place of reading the Markdown rules-home doc.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { mailbox?: string };
        if (typeof p.mailbox !== "string" || !p.mailbox) {
          return { error: "mailbox is required" };
        }
        const config = (await ctx.config.get()) as InstanceConfig;
        const cfg = findConfigMailbox(config, p.mailbox);
        if (!cfg) return { error: `Mailbox "${p.mailbox}" not configured` };
        try {
          assertCompanyAccess(ctx, {
            tool: "email_list_rules",
            resourceLabel: `Mailbox "${p.mailbox}"`,
            resourceKey: p.mailbox,
            allowedCompanies: cfg.allowedCompanies,
            companyId: runCtx.companyId,
          });
        } catch (err) {
          return { error: (err as Error).message };
        }
        const rows = await ctx.db.query<{ sender_pattern: string; rule_type: string }>(
          `SELECT sender_pattern, rule_type
           FROM plugin_email_tools_7cbee3fdf3.email_sender_rules
           WHERE company_id = $1 AND mailbox_key = $2
           ORDER BY rule_type, sender_pattern`,
          [runCtx.companyId, p.mailbox],
        );
        const autoTriage = rows.filter((r) => r.rule_type === "auto-triage").map((r) => r.sender_pattern);
        const keepAlways = rows.filter((r) => r.rule_type === "keep-always").map((r) => r.sender_pattern);
        const mute = rows.filter((r) => r.rule_type === "mute").map((r) => r.sender_pattern);
        return {
          content: `auto-triage: ${autoTriage.length} sender(s), keep-always: ${keepAlways.length} sender(s), mute: ${mute.length} sender(s)`,
          data: { autoTriage, keepAlways, mute },
        };
      },
    );

    /**
     * Resolve a mailbox and confirm the calling company may touch it.
     *
     * Both cursor tools need the same two checks in the same order. Skipping
     * the access check would let any company read or reset another company's
     * triage position, which is a quiet way to make mail go unprocessed.
     */
    async function resolveCursorMailbox(
      tool: string,
      mailboxKey: string,
      companyId: string,
    ): Promise<void> {
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool,
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
    }

    ctx.tools.register(
      "email_get_triage_cursor",
      {
        displayName: "Get Triage Cursor",
        description:
          "Return the point in time the triage routine should search from for a mailbox. Use the returned `since` verbatim; it already includes the safety overlap and the fallback window.",
        parametersSchema: {
          type: "object",
          properties: {
            mailbox: {
              type: "string",
              description: "Mailbox identifier, matching a key in plugin config.",
            },
          },
          required: ["mailbox"],
        } as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { mailbox?: string };
        if (typeof p.mailbox !== "string" || !p.mailbox) {
          return { error: "mailbox is required" };
        }
        try {
          await resolveCursorMailbox("email_get_triage_cursor", p.mailbox, runCtx.companyId);
        } catch (err) {
          return { error: (err as Error).message };
        }
        const stored = parseStoredCursor(
          await ctx.state.get(triageCursorScope(runCtx.companyId, p.mailbox)),
        );
        const { since, source } = resolveSince(stored, new Date());
        return {
          content:
            source === "cursor"
              ? `Last triaged ${stored}. Search from ${since}.`
              : `No stored cursor. Search from ${since} (24 hour fallback).`,
          data: { lastRunAt: stored, since, source },
        };
      },
    );

    ctx.tools.register(
      "email_set_triage_cursor",
      {
        displayName: "Set Triage Cursor",
        description:
          "Record how far the triage routine got. Call once at the end of a successful run, except on a bulk cleanup. Defaults to now. Refuses to move the cursor backwards unless force is set.",
        parametersSchema: {
          type: "object",
          properties: {
            mailbox: {
              type: "string",
              description: "Mailbox identifier, matching a key in plugin config.",
            },
            lastRunAt: {
              type: "string",
              description: "ISO timestamp. Omit to use the current time.",
            },
            force: {
              type: "boolean",
              description: "Allow moving the cursor backwards. Only for a deliberate reseed.",
            },
          },
          required: ["mailbox"],
        } as Record<string, unknown>,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { mailbox?: string; lastRunAt?: string; force?: boolean };
        if (typeof p.mailbox !== "string" || !p.mailbox) {
          return { error: "mailbox is required" };
        }
        try {
          await resolveCursorMailbox("email_set_triage_cursor", p.mailbox, runCtx.companyId);
        } catch (err) {
          return { error: (err as Error).message };
        }
        const scope = triageCursorScope(runCtx.companyId, p.mailbox);
        const stored = parseStoredCursor(await ctx.state.get(scope));
        const proposed =
          typeof p.lastRunAt === "string" && p.lastRunAt.trim()
            ? p.lastRunAt
            : new Date().toISOString();
        const plan = planCursorAdvance(stored, proposed, { force: p.force === true });
        if (!plan.ok) return { error: plan.reason ?? "Cursor write refused" };
        await ctx.state.set(scope, { lastRunAt: plan.lastRunAt });
        return {
          content: `Triage cursor for "${p.mailbox}" set to ${plan.lastRunAt}.`,
          data: { lastRunAt: plan.lastRunAt },
        };
      },
    );

    ctx.jobs.register("poll-mailboxes", async () => {
      const config = (await ctx.config.get()) as InstanceConfig;
      await runPoll(ctx, config);
    });

    ctx.actions.register("test-mailbox", async (params) => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      if (!mailboxKey) {
        return { ok: false, checks: [{ name: "params", passed: false, message: "mailbox key is required" }] };
      }
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) {
        return { ok: false, checks: [{ name: "config", passed: false, message: `Mailbox "${mailboxKey}" not configured` }] };
      }
      return testMailbox(ctx, cfg, mailboxKey);
    });

    // ─── UI bridge: getData handlers (operator Email view) ───────────────

    // Returns the mailboxes accessible to a given company — drives the
    // left-pane mailbox picker in the Email view.
    ctx.data.register("email.list-mailboxes", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const config = (await ctx.config.get()) as InstanceConfig;
      const mailboxes = (config.mailboxes ?? [])
        .filter((m) => {
          if (!companyId) return false;
          const allowed = m.allowedCompanies;
          if (!allowed || allowed.length === 0) return false;
          return allowed.includes("*") || allowed.includes(companyId);
        })
        .map((m) => ({
          key: m.key ?? "",
          name: m.name ?? m.key ?? "",
          pollFolder: m.pollFolder ?? "INBOX",
          // The address mail actually leaves as, so a composer can show the
          // operator which identity they are about to send from instead of
          // leaving it implicit in whichever mailbox happens to be selected.
          //
          // Uses the same resolver the send path uses rather than repeating
          // its defaulting here. That defaulting is not obvious — an optional
          // field the operator opened and cleared is saved as an empty string,
          // which `??` would pass straight through — and a second copy that
          // drifted would show one address while sending as another, which is
          // worse than showing nothing.
          // Empty, not undefined, is how the resolver says "not configured",
          // so normalise it here — a caller checking for null would otherwise
          // render a blank From line as though it were an address.
          from: resolveSmtpFrom(m) || null,
        }));
      return { mailboxes };
    });

    // Returns message headers for a mailbox folder — drives the center pane.
    ctx.data.register("email.list-messages", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      if (!companyId || !mailboxKey) throw new Error("companyId and mailbox are required");
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.list-messages",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      const unseen = params.unseen === true;
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 200) : 50;
      return actionPool.run(rt, async (conn) => {
        // No DB-side filtering: the Email view should mirror what's actually in
        // INBOX (matching the user's Outlook/other client view). Messages
        // disappear when they're moved (auto-triage / move-to-folder) or marked
        // read (after reply / handoff) — the natural "taken care of" signals.
        const uidValidity = await getUidValidity(conn, folder);
        const uids = await searchMessages(conn, { folder, unseen: unseen || undefined });
        const slicedUids = uids.slice(-limit);
        // Snippets feed the inbox-row hover preview in the UI. The fetch is
        // batched (one round trip), but does pull full message bodies through
        // simpleParser — heavier than envelope-only.
        const messages = await fetchHeaders(conn, folder, slicedUids, { withSnippets: true });
        return { messages, uidValidity };
      });
    });

    // Returns the full parsed message body — drives the right pane.
    ctx.data.register("email.fetch-message", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const uid = typeof params.uid === "number" ? params.uid : null;
      if (!companyId || !mailboxKey || uid === null) throw new Error("companyId, mailbox, and uid are required");
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.fetch-message",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      return actionPool.run(rt, async (conn) => {
        const msg = await fetchParsedMessage(conn, folder, uid);
        if (!msg) throw new Error(`Message UID ${uid} not found in "${folder}"`);
        return msg;
      });
    });

    // Returns one attachment's bytes, base64-encoded (drives the attachment
    // chip download in the message pane). partId comes from the attachments
    // metadata on email.fetch-message. getAttachment enforces the 25 MB cap.
    ctx.data.register("email.get-attachment", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const uid = typeof params.uid === "number" ? params.uid : null;
      const partId = typeof params.partId === "string" && params.partId ? params.partId : null;
      if (!companyId || !mailboxKey || uid === null || !partId) {
        throw new Error("companyId, mailbox, uid, and partId are required");
      }
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.get-attachment",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      return actionPool.run(rt, async (conn) => {
        const att = await getAttachment(conn, folder, uid, partId);
        if (!att) throw new Error(`Attachment "${partId}" not found on UID ${uid} in "${folder}"`);
        return {
          name: att.filename,
          mime: att.mime,
          size: att.content.length,
          contentBase64: att.content.toString("base64"),
        };
      });
    });

    // Returns the list of IMAP folders — drives the Move-to-folder picker.
    ctx.data.register("email.list-folders", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      if (!companyId || !mailboxKey) throw new Error("companyId and mailbox are required");
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.list-folders",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      return actionPool.run(rt, async (conn) => {
        const folders = await listFolders(conn);
        return { folders };
      });
    });

    /**
     * `email.search` — the operator search box.
     *
     * Differs from `email.list-messages` in scope: that one deliberately
     * mirrors a single folder, this one crosses folders and (when no mailbox
     * is named) every mailbox the company may see. Envelopes only — snippets
     * would mean pulling full message bodies from every folder searched.
     */
    ctx.data.register("email.search", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      if (!companyId) throw new Error("[EINVALID_INPUT] companyId is required");

      const p = params as {
        mailbox?: string;
        folder?: string;
        text?: string;
        from?: string;
        to?: string;
        subject?: string;
        since?: string;
        before?: string;
        unseen?: boolean;
        includeTrash?: boolean;
        limit?: number;
      };

      const criteria = {
        text: str(p.text),
        from: str(p.from),
        to: str(p.to),
        subject: str(p.subject),
        since: parseDateArg(str(p.since)),
        before: parseDateArg(str(p.before)),
        unseen: p.unseen === true,
      };
      // Without this an empty box would fetch every message in every folder of
      // every mailbox — minutes of IMAP traffic for a result nobody asked for.
      const hasCriteria =
        !!criteria.text ||
        !!criteria.from ||
        !!criteria.to ||
        !!criteria.subject ||
        !!criteria.since ||
        !!criteria.before ||
        criteria.unseen;
      if (!hasCriteria) {
        throw new Error("[EINVALID_INPUT] Provide at least one of: text, from, to, subject, since, before, unseen");
      }

      const config = (await ctx.config.get()) as InstanceConfig;
      const limit = Math.min(200, Math.max(1, Math.floor(p.limit ?? 50)));

      // A named mailbox is access-checked and fails loudly; the all-mailboxes
      // case filters instead, so a company never learns which other mailboxes
      // exist by watching which keys error.
      let targets: Array<{ key: string; cfg: ConfigMailbox }>;
      if (p.mailbox) {
        const cfg = findConfigMailbox(config, p.mailbox);
        if (!cfg) throw new Error(`Mailbox "${p.mailbox}" not configured`);
        assertCompanyAccess(ctx, {
          tool: "email.search",
          resourceLabel: `Mailbox "${p.mailbox}"`,
          resourceKey: p.mailbox,
          allowedCompanies: cfg.allowedCompanies,
          companyId,
        });
        targets = [{ key: cfg.key ?? p.mailbox, cfg }];
      } else {
        targets = (config.mailboxes ?? [])
          .filter((m) => !!m.key && isCompanyAllowed(m.allowedCompanies, companyId))
          .map((m) => ({ key: m.key as string, cfg: m }));
      }

      if (targets.length === 0) {
        return { results: [], truncated: false, searchedMailboxes: [], skippedFolders: [], errors: [] };
      }

      const skippedFolders: string[] = [];
      const errors: Array<{ mailbox: string; folder?: string; message: string }> = [];

      // Mailboxes run concurrently — each holds its own pooled connection, so
      // they do not contend. Folders within a mailbox stay sequential: they
      // share one connection and IMAP only has one selected folder at a time.
      const perMailbox = await Promise.all(
        targets.map(async ({ key, cfg }): Promise<SearchHit[]> => {
          try {
            const rt = await buildMailboxRuntime(ctx, cfg, key);
            return await actionPool.run(rt, async (conn) => {
              const available = await listSelectableFolders(conn);
              const scope = planFolderScope(available, {
                folder: str(p.folder),
                pollFolder: cfg.pollFolder ?? "INBOX",
                includeTrash: p.includeTrash === true,
              });
              for (const folder of scope.skipped) skippedFolders.push(`${key}/${folder}`);

              const hits: SearchHit[] = [];
              for (const folder of scope.folders) {
                try {
                  const uids = await searchMessages(conn, { folder, ...criteria });
                  if (uids.length === 0) continue;
                  // Highest UIDs are the most recent arrivals in that folder;
                  // the global newest-first ordering happens after the merge.
                  const headers = await fetchHeaders(conn, folder, uids.slice(-limit));
                  for (const h of headers) hits.push({ ...h, mailbox: key, folder });
                } catch (err) {
                  // One unreadable folder must not lose the whole search.
                  errors.push({ mailbox: key, folder, message: (err as Error).message });
                }
              }
              return hits;
            });
          } catch (err) {
            errors.push({ mailbox: key, message: (err as Error).message });
            return [];
          }
        }),
      );

      const merged = mergeSearchResults(perMailbox.flat(), limit);
      await ctx.telemetry.track("email.search", {
        companyId,
        mailboxes: String(targets.length),
        count: String(merged.results.length),
      });

      return {
        results: merged.results,
        truncated: merged.truncated,
        searchedMailboxes: targets.map((t) => t.key),
        skippedFolders,
        errors,
      };
    });

    // ─── UI bridge: performAction handlers (operator Email view) ─────────

    // Moves a single message to a target folder and optionally marks it read.
    ctx.actions.register("email.move-message", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const uid = typeof params.uid === "number" ? params.uid : null;
      const targetFolder = typeof params.targetFolder === "string" ? params.targetFolder : null;
      if (!companyId || !mailboxKey || uid === null || !targetFolder) {
        throw new Error("companyId, mailbox, uid, and targetFolder are required");
      }
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.move-message",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      if (cfg.disallowMove) {
        throw new Error(`[EMOVE_DISALLOWED] Moving messages is disabled for mailbox "${mailboxKey}"`);
      }
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      return actionPool.run(rt, async (conn) => {
        // Mark as read first — prevents the triage routine's unseen filter
        // from double-processing the same message if it runs concurrently.
        await setSeenFlag(conn, folder, [uid], true);
        const result = await moveMessages(conn, folder, [uid], targetFolder);
        return { ok: true, movedCount: result.movedCount };
      });
    });

    // Moves a message to the mailbox's Trash folder (soft-delete: recoverable
    // until the mail provider's retention window empties Trash). Auto-detects
    // the Trash folder via IMAP SPECIAL-USE `\Trash`, falling back to common
    // path names. Returns the resolved trash folder so the UI can confirm.
    ctx.actions.register("email.delete-message", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const uid = typeof params.uid === "number" ? params.uid : null;
      if (!companyId || !mailboxKey || uid === null) {
        throw new Error("companyId, mailbox, and uid are required");
      }
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.delete-message",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      if (cfg.disallowMove) {
        throw new Error(`[EMOVE_DISALLOWED] Moving messages is disabled for mailbox "${mailboxKey}"`);
      }
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      return actionPool.run(rt, async (conn) => {
        const trashFolder = await findTrashFolder(conn);
        if (!trashFolder) {
          throw new Error(
            `[ETRASH_NOT_FOUND] could not find a Trash folder on this mailbox (no SPECIAL-USE \\Trash and no Trash / Deleted Items / [Gmail]/Trash). Configure one manually if your provider uses a different name.`,
          );
        }
        await setSeenFlag(conn, folder, [uid], true);
        const result = await moveMessages(conn, folder, [uid], trashFolder);
        return { ok: true, movedCount: result.movedCount, trashFolder };
      });
    });

    // Marks one or more messages as read.
    ctx.actions.register("email.mark-read", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const rawUid = params.uid;
      if (!companyId || !mailboxKey || rawUid === null || rawUid === undefined) {
        throw new Error("companyId, mailbox, and uid are required");
      }
      const uids = Array.isArray(rawUid)
        ? (rawUid as unknown[]).filter((u): u is number => typeof u === "number")
        : typeof rawUid === "number"
          ? [rawUid]
          : [];
      if (uids.length === 0) throw new Error("uid must be a number or array of numbers");
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.mark-read",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      return actionPool.run(rt, async (conn) => {
        await setSeenFlag(conn, folder, uids, true);
        return { ok: true };
      });
    });

    // Marks one or more messages as unread (clears the \Seen flag).
    ctx.actions.register("email.mark-unread", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const rawUid = params.uid;
      if (!companyId || !mailboxKey || rawUid === null || rawUid === undefined) {
        throw new Error("companyId, mailbox, and uid are required");
      }
      const uids = Array.isArray(rawUid)
        ? (rawUid as unknown[]).filter((u): u is number => typeof u === "number")
        : typeof rawUid === "number"
          ? [rawUid]
          : [];
      if (uids.length === 0) throw new Error("uid must be a number or array of numbers");
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.mark-unread",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const rt = await buildMailboxRuntime(ctx, cfg, mailboxKey);
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      return actionPool.run(rt, async (conn) => {
        await setSeenFlag(conn, folder, uids, false);
        return { ok: true };
      });
    });

    /**
     * Mailboxes paired with the company their rules belong to.
     *
     * The plugin settings screen is instance-level, but sender rules are
     * stored per company, so a panel that filtered by "the company you happen
     * to be viewing from" showed nothing at all when that was a company with
     * no mailbox of its own. This returns every configured mailbox with the
     * company that owns it, so the panel can offer them directly.
     *
     * Safe to expose here: the bridge is board-gated, and the configuration
     * form on the very same screen already lists every mailbox and its
     * allowedCompanies. A mailbox whose owning company cannot be determined
     * is omitted, because there is no company to file its rules under.
     */
    ctx.data.register("email.list-rule-scopes", async () => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const scopes: Array<{ key: string; name: string; companyId: string }> = [];
      for (const m of config.mailboxes ?? []) {
        const key = m.key ?? "";
        if (!key) continue;
        const allowed = (m.allowedCompanies ?? []).filter((c) => c && c !== "*");
        const companyId = m.ingestCompanyId ?? (allowed.length === 1 ? allowed[0] : undefined);
        if (!companyId) continue;
        scopes.push({ key, name: m.name ?? key, companyId });
      }
      return { scopes };
    });

    // Returns all sender rules for a mailbox.
    ctx.data.register("email.list-rules", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      if (!companyId || !mailboxKey) throw new Error("companyId and mailbox are required");
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.list-rules",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const rows = await ctx.db.query<{
        sender_pattern: string;
        rule_type: string;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT sender_pattern, rule_type, created_at, updated_at
         FROM plugin_email_tools_7cbee3fdf3.email_sender_rules
         WHERE company_id = $1 AND mailbox_key = $2
         ORDER BY rule_type, sender_pattern`,
        [companyId, mailboxKey],
      );
      return {
        rules: rows.map((r) => ({
          senderPattern: r.sender_pattern,
          ruleType: r.rule_type,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      };
    });

    // Reads the triage routine's cursor for a mailbox. Same data as the
    // agent tool, reachable from the UI and from curl.
    ctx.data.register("email.get-triage-cursor", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      if (!companyId || !mailboxKey) throw new Error("companyId and mailbox are required");
      await resolveCursorMailbox("email.get-triage-cursor", mailboxKey, companyId);
      const stored = parseStoredCursor(
        await ctx.state.get(triageCursorScope(companyId, mailboxKey)),
      );
      const { since, source } = resolveSince(stored, new Date());
      return { lastRunAt: stored, since, source };
    });

    // Writes the triage cursor. This is the seed path for a mailbox whose
    // previous cursor lived in the retired Markdown rules document.
    ctx.actions.register("email.set-triage-cursor", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      if (!companyId || !mailboxKey) throw new Error("companyId and mailbox are required");
      await resolveCursorMailbox("email.set-triage-cursor", mailboxKey, companyId);
      const scope = triageCursorScope(companyId, mailboxKey);
      const stored = parseStoredCursor(await ctx.state.get(scope));
      const proposed =
        typeof params.lastRunAt === "string" && params.lastRunAt.trim()
          ? params.lastRunAt
          : new Date().toISOString();
      const plan = planCursorAdvance(stored, proposed, { force: params.force === true });
      if (!plan.ok) throw new Error(plan.reason ?? "Cursor write refused");
      await ctx.state.set(scope, { lastRunAt: plan.lastRunAt });
      return { ok: true, lastRunAt: plan.lastRunAt };
    });

    // Upserts a sender rule (auto-triage, keep-always, or mute) for a mailbox.
    ctx.actions.register("email.set-rule", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const senderPattern = typeof params.senderPattern === "string" ? params.senderPattern.trim() : null;
      const ruleType = typeof params.ruleType === "string" ? params.ruleType : null;
      if (!companyId || !mailboxKey || !senderPattern || !ruleType) {
        throw new Error("companyId, mailbox, senderPattern, and ruleType are required");
      }
      if (!isRuleType(ruleType)) {
        throw new Error(
          `ruleType must be 'auto-triage', 'keep-always', or 'mute', got: ${ruleType}`,
        );
      }
      // Reject a malformed pattern rather than storing a rule that can never
      // match. Silently accepting one is worse than refusing it: the operator
      // believes the noise is handled and the mail keeps arriving.
      if (!isValidRulePattern(senderPattern)) {
        throw new Error(describeInvalidPattern(senderPattern));
      }
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.set-rule",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const storedPattern = normalizeRulePattern(senderPattern);
      await ctx.db.execute(
        `INSERT INTO plugin_email_tools_7cbee3fdf3.email_sender_rules
           (company_id, mailbox_key, sender_pattern, rule_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, mailbox_key, sender_pattern)
         DO UPDATE SET rule_type = $4, updated_at = now()`,
        [companyId, mailboxKey, storedPattern, ruleType],
      );

      // Auto-triage and mute rules do a one-shot sweep of unread INBOX so
      // backlog mail from the same sender gets cleaned up immediately
      // (otherwise the rule only applies to new arrivals past the poll
      // cursor). Auto-triage moves the mail to _paperclip/triage; mute just
      // marks it read in-place.
      let sweptCount = 0;
      if (ruleType === "auto-triage") {
        try {
          sweptCount = await applyAutoTriageRuleToInbox(ctx, cfg, senderPattern);
        } catch (err) {
          ctx.logger.warn("email-tools: backlog sweep after set-rule failed", {
            mailbox: mailboxKey,
            pattern: senderPattern,
            error: (err as Error).message,
          });
        }
      } else if (ruleType === "mute") {
        try {
          sweptCount = await applyMuteRuleToInbox(ctx, cfg, senderPattern);
        } catch (err) {
          ctx.logger.warn("email-tools: backlog mute sweep after set-rule failed", {
            mailbox: mailboxKey,
            pattern: senderPattern,
            error: (err as Error).message,
          });
        }
      }
      return { ok: true, sweptCount };
    });

    // Deletes a sender rule for a mailbox.
    ctx.actions.register("email.delete-rule", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const senderPattern = typeof params.senderPattern === "string" ? params.senderPattern.trim() : null;
      if (!companyId || !mailboxKey || !senderPattern) {
        throw new Error("companyId, mailbox, and senderPattern are required");
      }
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.delete-rule",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      await ctx.db.execute(
        `DELETE FROM plugin_email_tools_7cbee3fdf3.email_sender_rules
         WHERE company_id = $1 AND mailbox_key = $2 AND sender_pattern = $3`,
        [companyId, mailboxKey, senderPattern],
      );
      return { ok: true };
    });

    // Sends a reply to a message via SMTP — bridge equivalent of the email_reply agent tool.
    ctx.actions.register("email.send-reply", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const uid = typeof params.uid === "number" ? params.uid : null;
      if (!companyId || !mailboxKey || uid === null) {
        throw new Error("companyId, mailbox, and uid are required");
      }
      const body = typeof params.body === "string" ? params.body : null;
      if (!body) throw new Error("body is required");
      const config = (await ctx.config.get()) as InstanceConfig;
      if (!config.allowSend) throw new Error("Sending is disabled. Enable allowSend on the plugin settings page.");
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.send-reply",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const folder = typeof params.folder === "string" ? params.folder : (cfg.pollFolder ?? "INBOX");
      const replyAll = params.replyAll === true;
      const bodyHtml = typeof params.body_html === "string" ? params.body_html : undefined;
      const attParse = parseOutboundAttachments(params.attachments);
      if (!attParse.ok) throw new Error(attParse.error);

      const original = await withImapConnection(ctx, cfg, mailboxKey, (client) =>
        fetchParsedMessage(client, folder, uid),
      );
      if (!original) throw new Error(`Message UID ${uid} not found in "${folder}"`);

      const ourAddress = resolveOwnAddress(cfg);
      const replyTo = original.fromAddress ? [original.fromAddress] : original.from ? [original.from] : [];
      let cc: string[] = [];
      if (replyAll) {
        const merged = [...original.to, ...original.cc].flatMap((s) =>
          s.split(",").map((x) => x.trim()).filter(Boolean),
        );
        cc = withoutOwnAddress(merged, ourAddress);
      }
      const subject = original.subject?.match(/^re:/i) ? original.subject : `Re: ${original.subject ?? ""}`.trim();
      const refsChain = [...original.references];
      if (original.messageId && !refsChain.includes(original.messageId)) {
        refsChain.push(original.messageId);
      }

      const rt = await buildSmtpRuntime(ctx, cfg, mailboxKey);
      const info = await sendViaSmtp(rt, {
        from: rt.smtpFrom,
        to: replyTo,
        cc: cc.length > 0 ? cc : undefined,
        subject,
        body,
        bodyHtml,
        inReplyTo: original.messageId ?? undefined,
        references: refsChain.length > 0 ? refsChain : undefined,
        attachments: attParse.attachments.length > 0 ? attParse.attachments : undefined,
      });
      return { ok: true, messageId: info.messageId };
    });

    // Sends a new message via SMTP — bridge equivalent of the email_send agent tool.
    ctx.actions.register("email.send-new", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      if (!companyId || !mailboxKey) throw new Error("companyId and mailbox are required");
      const config = (await ctx.config.get()) as InstanceConfig;
      if (!config.allowSend) throw new Error("Sending is disabled. Enable allowSend on the plugin settings page.");
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.send-new",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const to = params.to;
      const subject = typeof params.subject === "string" ? params.subject : null;
      const body = typeof params.body === "string" ? params.body : null;
      if (!to || !subject || !body) throw new Error("to, subject, and body are required");
      const attParse = parseOutboundAttachments(params.attachments);
      if (!attParse.ok) throw new Error(attParse.error);
      const rt = await buildSmtpRuntime(ctx, cfg, mailboxKey);
      const info = await sendViaSmtp(rt, {
        from: rt.smtpFrom,
        to: to as string | string[],
        cc: params.cc as string | string[] | undefined,
        bcc: params.bcc as string | string[] | undefined,
        subject,
        body,
        bodyHtml: typeof params.body_html === "string" ? params.body_html : undefined,
        attachments: attParse.attachments.length > 0 ? attParse.attachments : undefined,
      });
      return { ok: true, messageId: info.messageId };
    });

    idleManager = new IdleManager(ctx);
    await idleManager.start(rawConfig);
  },

  // ─── OAuth2 sign-in endpoints (Microsoft Outlook / 365) ────────────────────
  // Routes are declared in the manifest as:
  //   GET /oauth/start    (auth: board)  — operator clicks "Connect", we 302 to Microsoft
  //   GET /oauth/callback (auth: public) — Microsoft redirects here with ?code&state
  async onApiRequest(input): Promise<{ status?: number; headers?: Record<string, string>; body?: unknown }> {
    const ctx = workerCtx;
    if (!ctx) return { status: 503, body: { error: "email-tools worker not initialized yet" } };
    const config = (await ctx.config.get()) as InstanceConfig;
    const clientId = config.oauthMicrosoftClientId;
    const redirectUri = config.oauthRedirectUri;

    if (input.routeKey === "oauth.start") {
      if (!clientId || !redirectUri) {
        return oauthHtmlPage("OAuth is not configured. Set the Microsoft OAuth Client ID and Redirect URI on the Email Tools settings page first.");
      }
      const mailboxKey = firstQuery(input.query, "mailbox");
      if (!mailboxKey) return { status: 400, body: { error: "mailbox query parameter is required" } };
      const cfg = findConfigMailbox(config, mailboxKey);
      const url = await startAuth(ctx, { clientId, redirectUri, mailboxKey, loginHint: cfg?.user });
      // The host strips redirect (Location) headers and forces a JSON body, so
      // we return the authorize URL for the caller to navigate to.
      return { status: 200, body: { authorizeUrl: url } };
    }

    if (input.routeKey === "oauth.callback") {
      const err = firstQuery(input.query, "error");
      if (err) {
        return oauthHtmlPage(`Microsoft sign-in failed: <b>${err}</b><br>${firstQuery(input.query, "error_description")}`);
      }
      const code = firstQuery(input.query, "code");
      const state = firstQuery(input.query, "state");
      if (!code || !state) return oauthHtmlPage("Missing authorization code or state in the callback.");
      if (!clientId || !redirectUri) return oauthHtmlPage("OAuth is not configured.");
      try {
        const { mailboxKey } = await handleCallback(ctx, { clientId, redirectUri, code, state });
        return oauthHtmlPage(`✅ Connected <b>${mailboxKey}</b> via Microsoft.<br>You can close this tab and click <b>Test connection</b> in Paperclip.`);
      } catch (e) {
        return oauthHtmlPage(`Sign-in error: ${(e as Error).message}`);
      }
    }

    return { status: 404, body: { error: `Unknown route: ${input.routeKey}` } };
  },

  async onConfigChanged(newConfig: Record<string, unknown>): Promise<void> {
    if (idleManager) {
      await idleManager.onConfigChanged(newConfig as InstanceConfig);
    }
    // A config change can repoint a mailbox at a different secret, or follow a
    // password rotation, so cached passwords are no longer trustworthy.
    clearSecretCache();
    await actionPool.dropAll();
  },

  async onShutdown(): Promise<void> {
    if (idleManager) {
      await idleManager.shutdown();
      idleManager = null;
    }
    clearSecretCache();
    await actionPool.dropAll();
  },

  async onHealth() {
    return { status: "ok", message: "email-tools ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
