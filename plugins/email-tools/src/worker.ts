import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";

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
  key?: string;
  imapHost?: string;
  user?: string;
  pass?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpFrom?: string;
}

interface InstanceConfig {
  allowSend?: boolean;
  mailboxes?: ConfigMailbox[];
}

const ENV_FILE_PATH = join(homedir(), ".paperclip", "instances", "default", "email-tools.env");

function loadEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE_PATH)) return {};
  const text = readFileSync(ENV_FILE_PATH, "utf-8");
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function findConfigMailbox(config: InstanceConfig, key: string): ConfigMailbox | undefined {
  const lower = key.toLowerCase();
  return (config.mailboxes ?? []).find((m) => (m.key ?? "").toLowerCase() === lower);
}

function deriveSmtpHost(imapHost: string): string {
  return imapHost.startsWith("imap.") ? "smtp." + imapHost.slice(5) : imapHost;
}

function isAllowSend(config: InstanceConfig, env: Record<string, string>): boolean {
  if (typeof config.allowSend === "boolean") return config.allowSend;
  return (env["IMAP_ALLOW_SEND"] ?? "").toLowerCase() === "true";
}

function listConfiguredKeys(config: InstanceConfig, env: Record<string, string>): string[] {
  const fromConfig = (config.mailboxes ?? [])
    .map((m) => (m.key ?? "").trim().toLowerCase())
    .filter(Boolean);
  const fromEnv = (env["IMAP_MAILBOXES"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([...fromConfig, ...fromEnv]));
}

async function buildMailboxRuntime(
  ctx: PluginContext,
  config: InstanceConfig,
  env: Record<string, string>,
  key: string,
): Promise<MailboxRuntime> {
  const cfg = findConfigMailbox(config, key);

  // Prefer plugin config (with secret-ref pass). Fall back to env file for
  // mailboxes that haven't been migrated yet.
  if (cfg) {
    if (!cfg.imapHost) {
      throw new Error(`Mailbox "${key}": imapHost is required in plugin config.`);
    }
    if (!cfg.user) {
      throw new Error(`Mailbox "${key}": user is required in plugin config.`);
    }
    if (!cfg.pass) {
      throw new Error(
        `Mailbox "${key}": pass (secret reference) is required in plugin config.`,
      );
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

  const upper = key.toUpperCase().replace(/-/g, "_");
  const get = (suffix: string): string | undefined =>
    env[`IMAP_${upper}_${suffix}`]?.trim() || undefined;

  const imapHost = get("HOST");
  if (!imapHost) {
    throw new Error(
      `Mailbox "${key}" not configured: add it on the email-tools plugin settings page (with a secret-ref pass), ` +
        `or set IMAP_${upper}_HOST in ${ENV_FILE_PATH}.`,
    );
  }
  const user = get("USER");
  if (!user) {
    throw new Error(`Mailbox "${key}": missing IMAP_${upper}_USER`);
  }
  const passPlain = get("PASS");
  if (!passPlain) {
    throw new Error(`Mailbox "${key}": missing IMAP_${upper}_PASS`);
  }

  const portRaw = get("SMTP_PORT");
  const smtpPort = portRaw ? Number.parseInt(portRaw, 10) : 465;
  if (!Number.isFinite(smtpPort) || smtpPort <= 0 || smtpPort > 65535) {
    throw new Error(`Mailbox "${key}": invalid SMTP_PORT "${portRaw}"`);
  }
  const secureRaw = get("SMTP_SECURE")?.toLowerCase();
  const smtpSecure = secureRaw ? secureRaw === "true" : smtpPort === 465;

  return {
    key,
    smtpHost: get("SMTP_HOST") ?? deriveSmtpHost(imapHost),
    smtpPort,
    smtpSecure,
    smtpUser: get("SMTP_USER") ?? user,
    smtpPass: get("SMTP_PASS") ?? passPlain,
    smtpFrom: get("SMTP_FROM") ?? user,
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

    const env = loadEnvFile();
    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowSend = isAllowSend(rawConfig, env);
    const keys = listConfiguredKeys(rawConfig, env);

    if (!allowSend) {
      ctx.logger.warn(
        "email-tools: sending is disabled. Set 'allowSend' true on the plugin settings page or IMAP_ALLOW_SEND=true in the env file.",
      );
    } else if (keys.length === 0) {
      ctx.logger.warn(
        "email-tools: no mailboxes configured. Add them on the plugin settings page or via the env file.",
      );
    } else {
      const sources: string[] = [];
      const fromConfig = (rawConfig.mailboxes ?? [])
        .map((m) => (m.key ?? "").trim().toLowerCase())
        .filter(Boolean);
      const fromEnv = (env["IMAP_MAILBOXES"] ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (fromConfig.length > 0) sources.push(`config: ${fromConfig.join(", ")}`);
      if (fromEnv.length > 0) sources.push(`env: ${fromEnv.join(", ")}`);
      ctx.logger.info(`email-tools: ready. Mailboxes — ${sources.join("; ") || "(none)"}`);
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
                "Mailbox key (e.g. 'personal'). Must be configured on the email-tools plugin settings page.",
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
      async (params, _runCtx): Promise<ToolResult> => {
        const env = loadEnvFile();
        const config = (await ctx.config.get()) as InstanceConfig;

        if (!isAllowSend(config, env)) {
          return {
            error:
              "Sending is disabled. Set 'allowSend' true on the email-tools plugin settings page (or IMAP_ALLOW_SEND=true in " +
              ENV_FILE_PATH +
              ") and restart the paperclip server.",
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

        let mb: MailboxRuntime;
        try {
          mb = await buildMailboxRuntime(ctx, config, env, p.mailbox);
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
    const env = loadEnvFile();
    const envReady =
      existsSync(ENV_FILE_PATH) &&
      (env["IMAP_ALLOW_SEND"] ?? "").toLowerCase() === "true" &&
      (env["IMAP_MAILBOXES"] ?? "").trim().length > 0;
    return {
      status: envReady ? "ok" : "degraded",
      message: envReady
        ? "email-tools env-side ready"
        : `env file not configured (${ENV_FILE_PATH}); plugin config may still provide mailboxes`,
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
