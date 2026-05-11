import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "email-tools";
const PLUGIN_VERSION = "0.8.0";

const mailboxItemSchema = {
  type: "object",
  required: ["key", "imapHost", "user", "pass", "allowedCompanies"],
  "x-paperclip-actions": [
    {
      actionKey: "test-mailbox",
      label: "Test connection",
      description:
        "Resolve the secret, connect to IMAP and SMTP using the saved settings, and report which checks pass/fail.",
      paramName: "mailbox",
      itemKey: "key",
    },
  ],
  // PostgreSQL JSONB canonicalizes object key order when storing the
  // manifest, so source declaration order is lost in transit. Declare the
  // intended display order explicitly here; the form renderer respects it.
  propertyOrder: [
    // Identity & primary connection (required)
    "key",
    "name",
    "user",
    "pass",
    "imapHost",
    // Access control
    "allowedCompanies",
    // Receive setup
    "pollEnabled",
    "ingestCompanyId",
    "onReceive",
    "pollFolder",
    "pollSinceDays",
    "filterFromContains",
    "filterSubjectContains",
    "disallowMove",
    // Advanced overrides
    "imapPort",
    "imapSecure",
    "smtpHost",
    "smtpPort",
    "smtpSecure",
    "smtpUser",
    "smtpFrom",
  ],
  properties: {
    // ---- Identity & primary connection (required, top of form) ----
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling this mailbox (e.g. 'personal', 'sales'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it — that's why it's separate from Display name. Must be unique across mailboxes.",
    },
    name: {
      type: "string",
      title: "Display name",
      description:
        "Human-readable label shown in this settings form (e.g. 'Personal Mailbox', 'Sales Inbox'). Free-form; you can rename it later without breaking anything.",
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
    imapHost: {
      type: "string",
      title: "IMAP host",
      description:
        "e.g. imap.gmail.com. Used for both polling/IDLE (when pollEnabled) and to derive the SMTP host by default ('imap.' → 'smtp.').",
    },

    // ---- Access control (who can call tools against this mailbox) ----
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may CALL tools (search/fetch/send/reply) against this mailbox. Tick 'Portfolio-wide' to allow every company; otherwise tick the specific companies. Empty = unusable. This does NOT control inbound mail dispatch — see 'Ingest company' below.",
    },

    // ---- Receive (only relevant when polling/IDLE is on) ----
    pollEnabled: {
      type: "boolean",
      title: "Enable receive (poll + IDLE)",
      description:
        "When true, the plugin polls this mailbox on the global interval and also opens an IMAP IDLE connection for push notifications. Leave false for send-only mailboxes.",
      default: false,
    },
    ingestCompanyId: {
      type: "string",
      format: "company-id",
      title: "Ingest company",
      description:
        "REQUIRED when 'Enable receive' is on. Inbound mail is filed/emitted under this single company. Distinct from 'Allowed companies' (which controls who may call tools). Pick the one entity that should own inbound mail for this mailbox. The Project and Assignee dropdowns below are scoped to the company you pick here.",
    },
    onReceive: {
      type: "object",
      title: "When new mail arrives",
      description:
        "Per-mailbox dispatch behavior. 'none' = agents pull on demand. 'event' = emit plugin.email-tools.email.received. 'issue' = auto-create a Paperclip issue.",
      propertyOrder: ["mode", "projectId", "assigneeAgentId", "defaultPriority", "markAsRead"],
      properties: {
        mode: {
          type: "string",
          enum: ["none", "event", "issue"],
          title: "Mode",
          default: "none",
        },
        projectId: {
          type: "string",
          format: "project-id",
          title: "Project",
          description:
            "Project to file inbound issues under. Dropdown is scoped to the Ingest company picked above.",
          "x-paperclip-showWhen": { mode: "issue" },
        },
        assigneeAgentId: {
          type: "string",
          format: "agent-id",
          title: "Assignee agent",
          description:
            "Optional agent to assign new issues to. Dropdown is scoped to the Ingest company picked above.",
          "x-paperclip-showWhen": { mode: "issue" },
        },
        defaultPriority: {
          type: "string",
          enum: ["low", "medium", "high", "critical"],
          title: "Default priority",
          default: "medium",
          "x-paperclip-showWhen": { mode: "issue" },
        },
        markAsRead: {
          type: "boolean",
          title: "Mark as read after dispatching",
          description:
            "Off by default — messages stay unread so you can still triage them in your mail client. The plugin uses IMAP BODY.PEEK on every read, so neither polling nor email_fetch silently flags a message. Turn this on if the plugin (not you) owns the read state for this mailbox — e.g. an 'inbox processed' workflow where every dispatched message should be marked done.",
          default: false,
          "x-paperclip-showWhen": { mode: ["event", "issue"] },
        },
      },
    },
    pollFolder: {
      type: "string",
      title: "Folder to watch",
      description: "IMAP folder to poll/IDLE on. Defaults to INBOX.",
      default: "INBOX",
    },
    pollSinceDays: {
      type: "number",
      title: "First-run cutoff (days)",
      description:
        "On first run, only ingest messages newer than this many days. Prevents replaying years of history. Defaults to 1.",
      default: 1,
      minimum: 0,
      maximum: 365,
    },
    filterFromContains: {
      type: "array",
      items: { type: "string" },
      title: "From: substring filter",
      description:
        "Only ingest mail whose From: header contains one of these substrings (case-insensitive). Empty = no filter.",
    },
    filterSubjectContains: {
      type: "array",
      items: { type: "string" },
      title: "Subject substring filter",
      description: "Same as From: filter but applied to the Subject header.",
    },
    disallowMove: {
      type: "boolean",
      title: "Disallow moving messages",
      description:
        "When true, the email_move tool refuses every call against this mailbox. Use to protect against an agent accidentally moving mail to Trash (which would auto-purge after the provider's retention window). Mark-read/unread and reply remain available; this only blocks moves.",
      default: false,
    },

    // ---- Advanced connection overrides (most users won't touch these) ----
    imapPort: {
      type: "number",
      title: "IMAP port (optional)",
      description: "Defaults to 993.",
      default: 993,
    },
    imapSecure: {
      type: "boolean",
      title: "IMAP TLS on connect (optional)",
      description: "Defaults to true on port 993, false otherwise.",
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
      title: "SMTP TLS on connect (optional)",
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
} as const;

const SETUP_INSTRUCTIONS = `# Setup — Email Tools

Connect one or more IMAP/SMTP mailboxes so agents can send, search, fetch, and reply to email. Reckon on **about 10 minutes** per mailbox.

---

## Gmail mailboxes (most common)

Gmail requires an **App Password** — your regular account password will not work if 2-Step Verification is enabled (it should be).

### 1. Enable 2-Step Verification (if not already on)

In your Google Account → Security → 2-Step Verification. Required before App Passwords are available.

### 2. Create a Gmail App Password

- Go to [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
- **App name**: "Paperclip"
- Click **Create** — Google shows a 16-character password (no spaces)
- **Copy it now** — it's shown only once

### 3. Create a Paperclip secret

In Paperclip, switch to the company that should own this mailbox.

- Go to **Secrets → Add**
- Name it (e.g. \`gmail-app-password\`)
- Paste the 16-character password as the value
- Save, then **copy the secret's UUID**

### 4. Configure the mailbox (this page, **Configuration** tab)

Click the **Configuration** tab above. Under **Mailboxes**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | \`personal\` (or \`sales\`, \`support\`, etc.) |
| **Display name** | e.g. "Personal Gmail" |
| **Username** | your full Gmail address |
| **Password** | UUID of the secret from step 3 |
| **IMAP host** | \`imap.gmail.com\` |
| **Allowed companies** | tick the companies whose agents may call tools on this mailbox |

Leave IMAP port (993), SMTP host (\`smtp.gmail.com\`), and SMTP port (465) at their defaults.

If you want agents to **receive** new mail automatically:

- Set **Enable receive** → ON
- Set **Ingest company** → the company that should own inbound issues/events
- Set **When new mail arrives** → \`event\` (emit event) or \`issue\` (auto-create a Paperclip issue)

Enable **Allow sending** at the top of the Configuration tab when you're ready to send outbound mail.

---

## Other IMAP providers (Outlook, iCloud, custom)

The same steps apply — create an App Password or use your regular password if the provider allows IMAP with password auth:

| Provider | IMAP host | SMTP host | Notes |
|---|---|---|---|
| Outlook / Microsoft 365 | \`outlook.office365.com\` | \`smtp.office365.com\` | Use an app password; SMTP port 587, TLS=STARTTLS (set smtpPort=587, smtpSecure=false) |
| iCloud | \`imap.mail.me.com\` | \`smtp.mail.me.com\` | Requires an [app-specific password](https://support.apple.com/HT204397) |
| Custom / self-hosted | your IMAP host | your SMTP host | Standard IMAP/SMTP — fill in the advanced overrides as needed |

---

## Troubleshooting

- **IMAP auth failure** — wrong password, or you pasted the raw password instead of the secret UUID. Use the **Test connection** button on the mailbox row to verify.
- **Gmail "Less secure app" error** — Gmail no longer supports password auth for regular accounts. You must use an App Password (step 2 above).
- **Sent mail appears in Sent but SMTP fails** — SMTP port/host mismatch. For Gmail: port 465 (TLS on connect). For Office 365: port 587 (STARTTLS — set smtpSecure=false).
- **Inbound mail not ingesting** — make sure **Enable receive** is ON and **Ingest company** is set. Check the plugin worker logs (Status tab) for poll errors.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string; database?: { namespaceSlug: string; migrationsDir: string } } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Email Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Send + receive email via SMTP/IMAP. Multi-mailbox, polling + IDLE push, per-mailbox dispatch (event / issue / on-demand), threading, bulk operations.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
    "jobs.schedule",
    "events.emit",
    "issues.create",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
  ],
  database: {
    namespaceSlug: "email_tools",
    migrationsDir: "migrations",
  },
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["allowSend", "pollIntervalMinutes", "mailboxes"],
    properties: {
      allowSend: {
        type: "boolean",
        title: "Allow sending",
        description:
          "Master switch for outbound mail. Must be true for any email_send/email_reply call to succeed. Disable for read-only mode.",
        default: false,
      },
      pollIntervalMinutes: {
        type: "number",
        title: "Poll interval (minutes)",
        description:
          "How often pollEnabled mailboxes are checked via IMAP. IDLE push triggers out-of-band polls between intervals. Default 5, min 1, max 60.",
        default: 5,
        minimum: 1,
        maximum: 60,
      },
      mailboxes: {
        type: "array",
        title: "Mailboxes",
        description:
          "Each mailbox the plugin can use. The 'Display name' is what humans see; the 'Identifier' is the short stable ID agents pass as the mailbox parameter. Every mailbox must list 'Allowed companies' (who can call tools) and, if receive is enabled, an 'Ingest company' (who owns inbound mail).",
        items: mailboxItemSchema,
      },
    },
  },
  jobs: [
    {
      jobKey: "poll-mailboxes",
      displayName: "Poll mailboxes for new mail",
      description:
        "Heartbeat that runs every minute and, when due per pollIntervalMinutes, checks each pollEnabled mailbox via IMAP and dispatches new messages.",
      schedule: "* * * * *",
    },
  ],
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
              "Mailbox identifier (e.g. 'personal'). Must be configured AND list the calling company under allowedCompanies.",
          },
          to: {
            description:
              "Recipient address(es). String or array of strings. RFC 5322 names allowed.",
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          cc: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          },
          bcc: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
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
    {
      name: "email_search",
      displayName: "Search Email",
      description:
        "Search a configured mailbox via IMAP. Returns up to limit headers/snippets (no bodies). Use email_fetch for full bodies.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: {
            type: "string",
            description: "Folder to search. Defaults to the mailbox's pollFolder (INBOX if unset).",
          },
          from: { type: "string", description: "Match against From: header (substring)." },
          to: { type: "string", description: "Match against To: header (substring)." },
          subject: { type: "string", description: "Match against Subject: header (substring)." },
          since: {
            type: "string",
            description: "ISO date or 'YYYY-MM-DD'. Only messages on/after this date.",
          },
          before: {
            type: "string",
            description: "ISO date or 'YYYY-MM-DD'. Only messages before this date.",
          },
          unseen: { type: "boolean", description: "Only unseen (\\Unseen) messages." },
          limit: {
            type: "number",
            description: "Max results. Default 50, max 200.",
            default: 50,
            minimum: 1,
            maximum: 200,
          },
        },
        required: ["mailbox"],
      },
    },
    {
      name: "email_fetch",
      displayName: "Fetch Email",
      description:
        "Fetch a single parsed message by UID. Returns text, html, AND markdown bodies plus headers and attachment metadata (no attachment bytes).",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string", description: "Defaults to the mailbox's pollFolder." },
          uid: { type: "number" },
        },
        required: ["mailbox", "uid"],
      },
    },
    {
      name: "email_get_attachment",
      displayName: "Get Email Attachment",
      description:
        "Download a specific attachment from a message. Returns base64-encoded content, capped at 25 MB.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string" },
          uid: { type: "number" },
          partId: { type: "string", description: "Part ID returned by email_fetch.attachments[].partId" },
        },
        required: ["mailbox", "uid", "partId"],
      },
    },
    {
      name: "email_thread",
      displayName: "Get Email Thread",
      description:
        "Return all messages in the same conversation as the given UID, ordered by date. Walks References/In-Reply-To headers client-side.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string" },
          uid: { type: "number" },
          messageId: { type: "string", description: "Alternative to uid." },
        },
        required: ["mailbox"],
      },
    },
    {
      name: "email_mark_read",
      displayName: "Mark Email Read",
      description: "Add the \\Seen flag to one or many UIDs.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string" },
          uid: {
            description: "Single UID or array of UIDs.",
            oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
          },
        },
        required: ["mailbox", "uid"],
      },
    },
    {
      name: "email_mark_unread",
      displayName: "Mark Email Unread",
      description: "Remove the \\Seen flag from one or many UIDs.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string" },
          uid: {
            oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
          },
        },
        required: ["mailbox", "uid"],
      },
    },
    {
      name: "email_move",
      displayName: "Move Email",
      description: "Move one or many messages to a target folder.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string" },
          uid: {
            oneOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
          },
          targetFolder: { type: "string" },
        },
        required: ["mailbox", "uid", "targetFolder"],
      },
    },
    {
      name: "email_reply",
      displayName: "Reply to Email",
      description:
        "Reply to a previously-fetched message. Looks up the original Message-ID and References, then sends with proper threading headers via the same SMTP path as email_send.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string" },
          uid: { type: "number" },
          body: { type: "string", description: "Plain-text body." },
          body_html: { type: "string" },
          replyAll: { type: "boolean", default: false },
        },
        required: ["mailbox", "uid", "body"],
      },
    },
  ],
};

export default manifest;
