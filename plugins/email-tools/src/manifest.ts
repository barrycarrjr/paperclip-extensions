import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "email-tools";
const PLUGIN_VERSION = "0.3.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Email Tools",
  description: "Exposes email_send as an agent tool with multi-mailbox SMTP support.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      allowSend: {
        type: "boolean",
        title: "Allow sending",
        description:
          "Master switch. Must be true for any email_send call to succeed. Disable to put the plugin into read-only mode.",
        default: false,
      },
      mailboxes: {
        type: "array",
        title: "Mailboxes",
        description:
          "Each mailbox the plugin can send from. The 'Display name' is what humans see in this form; the 'Identifier' is the short stable ID agents pass as the mailbox parameter. Every mailbox must list the company UUIDs allowed to use it under 'Allowed companies' — leaving it empty makes the mailbox unusable (fail-safe default deny).",
        items: {
          type: "object",
          required: ["key", "name", "imapHost", "user", "pass", "allowedCompanies"],
          properties: {
            name: {
              type: "string",
              title: "Display name",
              description:
                "Human-readable label shown in this settings form (e.g. 'Personal Mailbox', 'Sales Inbox'). Free-form; you can rename it later without breaking anything.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass when calling this mailbox (e.g. 'personal', 'acme'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it — that's why it's separate from Display name. Must be unique across mailboxes.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to use this mailbox. Tick 'Portfolio-wide' to allow every company; otherwise tick the specific companies. Empty = unusable (fail-safe deny — useful for staged setup).",
            },
            imapHost: {
              type: "string",
              title: "IMAP host",
              description:
                "e.g. imap.gmail.com. Used to derive the SMTP host by default ('imap.' → 'smtp.').",
            },
            user: {
              type: "string",
              title: "Username (email address)",
              description: "The full email address used for both IMAP and SMTP auth.",
            },
            pass: {
              type: "string",
              format: "secret-ref",
              title: "Password",
              description:
                "Paste the UUID of the secret holding this mailbox's app password. Create the secret first in the company's Secrets page.",
            },
            smtpHost: {
              type: "string",
              title: "SMTP host (optional)",
              description: "Override the SMTP host. Defaults to 'smtp.<imap-host-tail>'.",
            },
            smtpPort: {
              type: "number",
              title: "SMTP port (optional)",
              description: "Defaults to 465.",
              default: 465,
            },
            smtpSecure: {
              type: "boolean",
              title: "TLS on connect (optional)",
              description: "Defaults to true on port 465, false otherwise.",
            },
            smtpUser: {
              type: "string",
              title: "SMTP username (optional)",
              description: "Defaults to the mailbox's user.",
            },
            smtpFrom: {
              type: "string",
              title: "From address (optional)",
              description: "Defaults to the mailbox's user.",
            },
          },
        },
      },
    },
  },
  tools: [
    {
      name: "email_send",
      displayName: "Send Email",
      description:
        "Send a plain-text or HTML email via SMTP using one of the configured mailboxes. Returns the Message-ID and SMTP response.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: {
            type: "string",
            description:
              "Mailbox identifier (e.g. 'personal'). Must be configured on the email-tools plugin settings page.",
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
  ],
};

export default manifest;
