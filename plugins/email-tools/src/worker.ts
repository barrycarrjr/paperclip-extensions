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
  getAttachment,
  moveMessages,
  openConnection,
  safeLogout,
  searchMessages,
  setSeenFlag,
  type ParsedMessage,
} from "./imap.js";
import { runPoll, buildMailboxRuntime } from "./poll.js";
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
          await withImapConnection(ctx, gate.cfg, p.mailbox as string, async (client) =>
            moveMessages(client, folder, uids, p.targetFolder as string),
          );
          await ctx.telemetry.track("email_move", {
            mailbox: gate.cfg.key ?? "",
            companyId: runCtx.companyId,
            count: String(uids.length),
          });
          return {
            content: `Moved ${uids.length} message(s) to ${p.targetFolder}`,
            data: { ok: true, mailbox: gate.cfg.key, folder, uids, targetFolder: p.targetFolder },
          };
        } catch (err) {
          return { error: `[IMAP_ERROR] ${(err as Error).message}` };
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
