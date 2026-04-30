import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import nodemailer from "nodemailer";
import { assertCompanyAccess } from "./companyAccess.js";

interface MailboxRuntime {
  key: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
}

interface ConfigMailbox {
  name?: string;
  key?: string;
  imapHost?: string;
  user?: string;
  pass?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpFrom?: string;
  allowedCompanies?: string[];
}

interface InstanceConfig {
  allowSend?: boolean;
  mailboxes?: ConfigMailbox[];
}

function findConfigMailbox(config: InstanceConfig, key: string): ConfigMailbox | undefined {
  const lower = key.toLowerCase();
  return (config.mailboxes ?? []).find((m) => (m.key ?? "").toLowerCase() === lower);
}

function deriveSmtpHost(imapHost: string): string {
  return imapHost.startsWith("imap.") ? "smtp." + imapHost.slice(5) : imapHost;
}

async function buildMailboxRuntime(
  ctx: PluginContext,
  cfg: ConfigMailbox,
  key: string,
): Promise<MailboxRuntime> {
  if (!cfg.imapHost) {
    throw new Error(`Mailbox "${key}": imapHost is required.`);
  }
  if (!cfg.user) {
    throw new Error(`Mailbox "${key}": user is required.`);
  }
  if (!cfg.pass) {
    throw new Error(`Mailbox "${key}": pass (secret reference) is required.`);
  }

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
          return `${k} [${access}]`;
        })
        .join(", ");
      ctx.logger.info(`email-tools: ready. Mailboxes — ${summary}`);

      const orphans = mailboxes.filter(
        (m) => !m.allowedCompanies || m.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `email-tools: ${orphans.length} mailbox(es) have no allowedCompanies and will reject every call. ` +
            `Backfill on the plugin settings page: ${orphans
              .map((m) => m.key ?? "(no-key)")
              .join(", ")}`,
        );
      }
    }

    ctx.tools.register(
      "email_send",
      {
        displayName: "Send Email",
        description:
          "Send a plain-text or HTML email via SMTP using one of the configured mailboxes. Returns the Message-ID and SMTP response.",
        parametersSchema: {
          type: "object",
          properties: {
            mailbox: {
              type: "string",
              description:
                "Mailbox identifier (e.g. 'personal'). Must be configured on the email-tools plugin settings page AND list the calling company under allowedCompanies.",
            },
            to: {
              description:
                "Recipient address(es). String or array of strings. RFC 5322 names allowed.",
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            cc: {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            bcc: {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
            subject: { type: "string" },
            body: {
              type: "string",
              description: "Plain-text body. Required even if body_html is also set.",
            },
            body_html: { type: "string" },
            in_reply_to: { type: "string" },
            references: { type: "array", items: { type: "string" } },
            reply_to: { type: "string" },
          },
          required: ["mailbox", "to", "subject", "body"],
        },
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
        if (!cfg) {
          return {
            error: `Mailbox "${p.mailbox}" not configured. Add it on the email-tools plugin settings page.`,
          };
        }

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

        let mb: MailboxRuntime;
        try {
          mb = await buildMailboxRuntime(ctx, cfg, p.mailbox);
        } catch (err) {
          return { error: (err as Error).message };
        }

        const transporter = nodemailer.createTransport({
          host: mb.smtpHost,
          port: mb.smtpPort,
          secure: mb.smtpSecure,
          auth: { user: mb.smtpUser, pass: mb.smtpPass },
        });

        const inReplyTo = p.in_reply_to ? ensureAngled(p.in_reply_to) : undefined;
        const refsHeader =
          p.references && p.references.length > 0
            ? p.references.map(ensureAngled).join(" ")
            : undefined;
        const toField = (v: string | string[]): string => (Array.isArray(v) ? v.join(", ") : v);

        try {
          const info = await transporter.sendMail({
            from: mb.smtpFrom,
            to: toField(p.to),
            cc: p.cc ? toField(p.cc) : undefined,
            bcc: p.bcc ? toField(p.bcc) : undefined,
            replyTo: p.reply_to,
            subject: p.subject,
            text: p.body,
            html: p.body_html,
            inReplyTo,
            references: refsHeader,
          });

          await ctx.telemetry.track("email-tools.email_send", {
            mailbox: mb.key,
            companyId: runCtx.companyId,
          });

          return {
            content: `Sent. Message-ID ${info.messageId ?? "?"}`,
            data: {
              ok: true,
              mailbox: mb.key,
              message_id: info.messageId ?? "",
              smtp_response: typeof info.response === "string" ? info.response : "",
              accepted: info.accepted ?? [],
              rejected: info.rejected ?? [],
            },
          };
        } catch (err) {
          const e = err as { code?: string; responseCode?: number; message?: string };
          const code = e.code ? String(e.code) : "SMTP_ERROR";
          const message =
            (e.message ?? String(err)) + (e.responseCode ? ` (SMTP ${e.responseCode})` : "");
          return { error: `[${code}] ${message}` };
        } finally {
          transporter.close();
        }
      },
    );

  },

  async onHealth() {
    return { status: "ok", message: "email-tools ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
