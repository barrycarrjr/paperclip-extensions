import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import nodemailer from "nodemailer";
import { assertCompanyAccess } from "./companyAccess.js";
import {
  fetchHeaders,
  fetchParsedMessage,
  findTrashFolder,
  getAttachment,
  getUidValidity,
  listFolders,
  moveMessages,
  openConnection,
  safeLogout,
  searchMessages,
  setSeenFlag,
  type ParsedMessage,
} from "./imap.js";
import {
  runPoll,
  buildMailboxRuntime,
  applyAutoTriageRuleToInbox,
  applyMuteRuleToInbox,
} from "./poll.js";
import { IdleManager } from "./idle.js";
import { buildThread } from "./threading.js";
import { testMailbox } from "./test-mailbox.js";
import type { ConfigMailbox, InstanceConfig } from "./types.js";

interface SmtpRuntime {
  key: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
}

function findConfigMailbox(config: InstanceConfig, key: string): ConfigMailbox | undefined {
  const lower = key.toLowerCase();
  return (config.mailboxes ?? []).find((m) => (m.key ?? "").toLowerCase() === lower);
}

function deriveSmtpHost(imapHost: string): string {
  return imapHost.startsWith("imap.") ? "smtp." + imapHost.slice(5) : imapHost;
}

async function buildSmtpRuntime(
  ctx: PluginContext,
  cfg: ConfigMailbox,
  key: string,
): Promise<SmtpRuntime> {
  if (!cfg.imapHost) throw new Error(`Mailbox "${key}": imapHost is required.`);
  if (!cfg.user) throw new Error(`Mailbox "${key}": user is required.`);
  if (!cfg.pass) throw new Error(`Mailbox "${key}": pass (secret reference) is required.`);
  const smtpPass = await ctx.secrets.resolve(cfg.pass);
  const smtpPort = typeof cfg.smtpPort === "number" ? cfg.smtpPort : 465;
  if (!Number.isFinite(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
    throw new Error(`Mailbox "${key}": invalid smtpPort ${smtpPort}.`);
  }
  const smtpSecure = typeof cfg.smtpSecure === "boolean" ? cfg.smtpSecure : smtpPort === 465;
  return {
    key,
    smtpHost: cfg.smtpHost ?? deriveSmtpHost(cfg.imapHost),
    smtpPort,
    smtpSecure,
    smtpUser: cfg.smtpUser ?? cfg.user,
    smtpPass,
    smtpFrom: cfg.smtpFrom ?? cfg.user,
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
    auth: { user: rt.smtpUser, pass: rt.smtpPass },
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
  const client = await openConnection(rt);
  try {
    return await fn(client);
  } finally {
    await safeLogout(client);
  }
}

function resolveFolder(cfg: ConfigMailbox, override: unknown): string {
  if (typeof override === "string" && override.length > 0) return override;
  return cfg.pollFolder ?? "INBOX";
}

let idleManager: IdleManager | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("email-tools plugin setup");

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
        };
        if (!p.mailbox) return { error: "mailbox is required" };
        if (!p.to) return { error: "to is required" };
        if (!p.subject) return { error: "subject is required" };
        if (p.body === undefined) return { error: "body is required" };

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
        };
        const gate = gateMailbox("email_reply", p.mailbox, runCtx, config);
        if (!gate.ok) return { error: gate.error };
        if (typeof p.uid !== "number") return { error: "uid is required" };
        if (typeof p.body !== "string") return { error: "body is required" };
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

        const ourAddress = (gate.cfg.smtpFrom ?? gate.cfg.user ?? "").toLowerCase();
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
          cc = merged.filter((addr) => !addr.toLowerCase().includes(ourAddress));
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
      const conn = await openConnection(rt);
      try {
        // No DB-side filtering: the Email view should mirror what's actually in
        // INBOX (matching the user's Outlook/other client view). Messages
        // disappear when they're moved (auto-triage / move-to-folder) or marked
        // read (after reply / handoff) — the natural "taken care of" signals.
        const uidValidity = await getUidValidity(conn, folder);
        const uids = await searchMessages(conn, { folder, unseen: unseen || undefined });
        const slicedUids = uids.slice(-limit);
        const messages = await fetchHeaders(conn, folder, slicedUids);
        return { messages, uidValidity };
      } finally {
        await safeLogout(conn);
      }
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
      const conn = await openConnection(rt);
      try {
        const msg = await fetchParsedMessage(conn, folder, uid);
        if (!msg) throw new Error(`Message UID ${uid} not found in "${folder}"`);
        return msg;
      } finally {
        await safeLogout(conn);
      }
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
      const conn = await openConnection(rt);
      try {
        const folders = await listFolders(conn);
        return { folders };
      } finally {
        await safeLogout(conn);
      }
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
      const conn = await openConnection(rt);
      try {
        // Mark as read first — prevents the triage routine's unseen filter
        // from double-processing the same message if it runs concurrently.
        await setSeenFlag(conn, folder, [uid], true);
        const result = await moveMessages(conn, folder, [uid], targetFolder);
        return { ok: true, movedCount: result.movedCount };
      } finally {
        await safeLogout(conn);
      }
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
      const conn = await openConnection(rt);
      try {
        const trashFolder = await findTrashFolder(conn);
        if (!trashFolder) {
          throw new Error(
            `[ETRASH_NOT_FOUND] could not find a Trash folder on this mailbox (no SPECIAL-USE \\Trash and no Trash / Deleted Items / [Gmail]/Trash). Configure one manually if your provider uses a different name.`,
          );
        }
        await setSeenFlag(conn, folder, [uid], true);
        const result = await moveMessages(conn, folder, [uid], trashFolder);
        return { ok: true, movedCount: result.movedCount, trashFolder };
      } finally {
        await safeLogout(conn);
      }
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
      const conn = await openConnection(rt);
      try {
        await setSeenFlag(conn, folder, uids, true);
        return { ok: true };
      } finally {
        await safeLogout(conn);
      }
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
      const conn = await openConnection(rt);
      try {
        await setSeenFlag(conn, folder, uids, false);
        return { ok: true };
      } finally {
        await safeLogout(conn);
      }
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

    // Upserts a sender rule (auto-triage, keep-always, or mute) for a mailbox.
    ctx.actions.register("email.set-rule", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const senderPattern = typeof params.senderPattern === "string" ? params.senderPattern.trim() : null;
      const ruleType = typeof params.ruleType === "string" ? params.ruleType : null;
      if (!companyId || !mailboxKey || !senderPattern || !ruleType) {
        throw new Error("companyId, mailbox, senderPattern, and ruleType are required");
      }
      if (ruleType !== "auto-triage" && ruleType !== "keep-always" && ruleType !== "mute") {
        throw new Error(
          `ruleType must be 'auto-triage', 'keep-always', or 'mute', got: ${ruleType}`,
        );
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
      await ctx.db.execute(
        `INSERT INTO plugin_email_tools_7cbee3fdf3.email_sender_rules
           (company_id, mailbox_key, sender_pattern, rule_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, mailbox_key, sender_pattern)
         DO UPDATE SET rule_type = $4, updated_at = now()`,
        [companyId, mailboxKey, senderPattern, ruleType],
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

    // One-time import of sender rules from a Markdown rules doc body.
    // Returns counts so the UI can show "imported N rules, skipped M dupes".
    ctx.actions.register("email.import-rules", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const mailboxKey = typeof params.mailbox === "string" ? params.mailbox : null;
      const docBody = typeof params.docBody === "string" ? params.docBody : null;
      if (!companyId || !mailboxKey || docBody === null) {
        throw new Error("companyId, mailbox, and docBody are required");
      }
      const config = (await ctx.config.get()) as InstanceConfig;
      const cfg = findConfigMailbox(config, mailboxKey);
      if (!cfg) throw new Error(`Mailbox "${mailboxKey}" not configured`);
      assertCompanyAccess(ctx, {
        tool: "email.import-rules",
        resourceLabel: `Mailbox "${mailboxKey}"`,
        resourceKey: mailboxKey,
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });

      // Process keep-always FIRST so it wins any cross-section conflicts —
      // the safer interpretation when a pattern is contradictorily listed
      // under both auto-triage and keep-always in the source doc.
      const sections: Array<{ header: string; ruleType: "auto-triage" | "keep-always" }> = [
        { header: "## Keep-always senders", ruleType: "keep-always" },
        { header: "## Auto-triage senders", ruleType: "auto-triage" },
      ];
      let imported = 0;
      let conflicts = 0;
      for (const { header, ruleType } of sections) {
        const start = docBody.indexOf(header);
        if (start === -1) continue;
        const after = start + header.length;
        const nextHeader = docBody.indexOf("\n## ", after);
        const section = docBody.slice(after, nextHeader === -1 ? docBody.length : nextHeader);
        for (const rawLine of section.split("\n")) {
          const line = rawLine.replace(/^[-*+]\s+/, "").trim();
          if (!line || line.startsWith("<!--") || line.startsWith("#") || line.startsWith("`<")) continue;
          const pattern = line.split("|")[0]!.trim();
          if (!pattern) continue;
          if (
            !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(pattern) &&
            !/^@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(pattern) &&
            !/^subject:/i.test(pattern)
          ) {
            continue;
          }
          const result = await ctx.db.execute(
            `INSERT INTO plugin_email_tools_7cbee3fdf3.email_sender_rules
               (company_id, mailbox_key, sender_pattern, rule_type)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (company_id, mailbox_key, sender_pattern) DO NOTHING`,
            [companyId, mailboxKey, pattern, ruleType],
          );
          if (result.rowCount > 0) imported += 1;
          else conflicts += 1;
        }
      }
      return { ok: true, imported, conflicts };
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

      const original = await withImapConnection(ctx, cfg, mailboxKey, (client) =>
        fetchParsedMessage(client, folder, uid),
      );
      if (!original) throw new Error(`Message UID ${uid} not found in "${folder}"`);

      const ourAddress = (cfg.smtpFrom ?? cfg.user ?? "").toLowerCase();
      const replyTo = original.fromAddress ? [original.fromAddress] : original.from ? [original.from] : [];
      let cc: string[] = [];
      if (replyAll) {
        const merged = [...original.to, ...original.cc].flatMap((s) =>
          s.split(",").map((x) => x.trim()).filter(Boolean),
        );
        cc = merged.filter((addr) => !addr.toLowerCase().includes(ourAddress));
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
      const rt = await buildSmtpRuntime(ctx, cfg, mailboxKey);
      const info = await sendViaSmtp(rt, {
        from: rt.smtpFrom,
        to: to as string | string[],
        cc: params.cc as string | string[] | undefined,
        bcc: params.bcc as string | string[] | undefined,
        subject,
        body,
        bodyHtml: typeof params.body_html === "string" ? params.body_html : undefined,
      });
      return { ok: true, messageId: info.messageId };
    });

    idleManager = new IdleManager(ctx);
    await idleManager.start(rawConfig);
  },

  async onConfigChanged(newConfig: Record<string, unknown>): Promise<void> {
    if (idleManager) {
      await idleManager.onConfigChanged(newConfig as InstanceConfig);
    }
  },

  async onShutdown(): Promise<void> {
    if (idleManager) {
      await idleManager.shutdown();
      idleManager = null;
    }
  },

  async onHealth() {
    return { status: "ok", message: "email-tools ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
