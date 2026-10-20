import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "email-tools";
const PLUGIN_VERSION = "0.23.1";

const routingSchema = {
  type: "object", additionalProperties: false, title: "Mail routing",
  description: "Optional routing inside email-triage. Ships off. Only the named router may propose configured keys; routing leaves the mailbox unchanged.",
  propertyOrder: ["mode", "routerAgentId", "sendingApprovalConfirmed", "destinations"],
  properties: {
    mode: { type: "string", enum: ["off", "review", "auto"], default: "off", title: "Mode" },
    routerAgentId: { type: "string", format: "agent-id", title: "Triage agent allowed to route", description: "Must belong to this mailbox's Ingest company." },
    sendingApprovalConfirmed: { type: "boolean", default: false, title: "Sending needs approval for every agent",
      description: "Operator acknowledgment only. First configure and verify approval-based sending for every agent. The plugin cannot inspect these policies and this checkbox changes none of them." },
    destinations: { type: "array", maxItems: 50, title: "Routing destinations", items: {
      type: "object", additionalProperties: false,
      required: ["key", "label", "description", "companyId", "projectId", "assigneeAgentId"],
      propertyOrder: ["enabled", "key", "label", "description", "companyId", "projectId", "assigneeAgentId", "priority"],
      properties: {
        enabled: { type: "boolean", default: true, title: "Enabled" },
        key: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$", title: "Destination key" },
        label: { type: "string", minLength: 1, maxLength: 100, title: "Label" },
        description: { type: "string", minLength: 1, maxLength: 600, title: "What belongs here" },
        companyId: { type: "string", format: "company-id", title: "Destination company" },
        projectId: { type: "string", format: "project-id", title: "Project" },
        assigneeAgentId: { type: "string", format: "agent-id", title: "Assignee agent" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium", title: "Priority" },
      },
    } },
  },
} as const;

const mailboxItemSchema = {
  type: "object",
  required: ["key", "imapHost", "user", "allowedCompanies"],
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
    "authType",
    "pass",
    "imapHost",
    // Access control
    "allowedCompanies",
    "supportRecipients",
    // Receive setup
    "pollEnabled",
    "ingestCompanyId",
    "onReceive",
    "routing",
    "pollFolder",
    "pollSinceDays",
    "filterFromContains",
    "filterSubjectContains",
    "disallowMove",
    "watchEnabled",
    "watchIssueId",
    // Advanced overrides
    "imapPort",
    "imapSecure",
    "smtpHost",
    "smtpPort",
    "smtpSecure",
    "smtpUser",
    "smtpFrom",
    "sentFolder",
  ],
  properties: {
    routing: routingSchema,
    // ---- Identity & primary connection (required, top of form) ----
    authType: {
      type: "string",
      enum: ["basic", "oauth2"],
      default: "basic",
      title: "Authentication method",
      description:
        "How this mailbox signs in. 'basic' = username + app password (Gmail, Rackspace, Spacemail, etc.). " +
        "'oauth2' = Sign in with Microsoft — REQUIRED for Outlook / Hotmail / Office 365, which no longer accept app passwords. " +
        "For oauth2, leave Password blank, save, then open the Connect URL to sign in with Microsoft.",
    },
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
    supportRecipients: { type: "array",title: "Support Desk vendor recipients",items: { type: "string" },
      description: "Optional exact vendor support email addresses that this mailbox may send confirmed Support Desk escalations to. Empty disables support delivery; Allow sending and allowed-company rules also apply." },

    // ---- Receive (only relevant when polling/IDLE is on) ----
    pollEnabled: {
      type: "boolean",
      title: "Enable receive (poll + IDLE)",
      description:
        "When true, the plugin polls this mailbox on the global interval and also opens an IMAP IDLE connection for push notifications. Leave false for send-only mailboxes.",
      default: false,
    },
    watchEnabled: {
      type: "boolean",
      title: "Wake an issue when mail needs attention",
      description:
        "When on (and 'Enable receive' is on), each poll tick that dispatches at least one message (after the auto-triage and mute sender rules) requests an assignment wakeup on the 'Issue to wake' below, so the triage agent runs on real mail instead of a schedule. Adds no IMAP traffic. The email-triage skill says what to do at the end of each woken run (keep one long fallback wake pending, park the issue as blocked), so the issue itself only needs to name the mailbox. See the README's wake-on-mail section.",
      default: false,
    },
    watchIssueId: {
      type: "string",
      title: "Issue to wake",
      description:
        "UUID of the Paperclip issue the mailbox triage routine lives on. The wakeup is requested in the 'Ingest company'. The issue must have an assigned agent and must not be closed or blocked by other issues. Required when the watch is on.",
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
    sentFolder: {
      type: "string",
      title: "Sent folder (optional)",
      description:
        "Where copies of sent mail are saved, e.g. 'INBOX.Sent Items'. Leave blank to find it automatically: the folder the mail server marks as Sent, or, when there are several Sent folders, the one holding the most mail. Gmail and Microsoft 365 keep their own copy of what you send, so nothing is uploaded for them unless you fill this in. 'Test connection' shows which folder is in use.",
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

// Current host supports explicit write/approval metadata; npm SDK declarations predate it.
type HostManifest = Omit<PaperclipPluginManifestV1, "tools"> & {
  tools: Array<NonNullable<PaperclipPluginManifestV1["tools"]>[number] & { writes?: boolean; actionType?: "change_knowledge_base" }>;
  setupInstructions?: string; database?: { namespaceSlug: string; migrationsDir: string };
};
const manifest: HostManifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Email Tools",
  setupInstructions: SETUP_INSTRUCTIONS + `

## Shared-mailbox routing (ships off)

1. Install the matching host email-handoff change and approve the new read/audit capabilities.
2. Configure and personally verify approval-based sending for every agent, with no permissive overrides. Leave routing off if this is not satisfied. This plugin cannot verify or change these policies.
3. Select the mailbox's Ingest company and a named router in that company. Keep it in Allowed companies. Use on-receive mode none or event, never issue.
4. Add enabled destination keys, labels, descriptions, companies, projects and assigned agents. Only an instance admin can edit this list.
5. Before activation, deliberately choose the router agent's Change knowledge base action policy. An unset agent policy inherits the company default, then falls back to Ask first if that is unset. Ask first holds EVERY proposal, including review and unsure, as a board approval draft before the worker or ledger. Auto still needs approval per proposal. Unapproved drafts never reach Mail routing and later runs may draft the same unread mail again, especially with changed reasons. Go ahead is an operator choice, never granted by this plugin; sending permission is separate.
6. Tick Sending needs approval for every agent as your acknowledgment, set routing to review, and save. Use the existing email-triage routine, not a second triage.
7. Review the Mail routing panel in the source company. Route or dismiss unstarted entries. Reconcile frozen attempts, or choose Close as handled manually and confirm after checking existing work. This clears review only: an unknown handoff may already exist or still complete, and the retained identity prevents another route. Manual close works while off and for recorded entries whose connection was changed or removed. Once reliable, switch to auto; uncertain mail still waits. Off stops routing and follow-up effects without changing existing issues.
8. The ledger retains sender address, subject (200 characters), free-form classifier note (300 characters, possibly mail content), Message-ID and routing identity indefinitely. Terminal identities prevent duplicate routing. Email page hold badges are company-scoped; source-company mail can still look unread/unhandled after routing.

Routing selectors use the exact messageId of the CURRENT email_search item, or null. Never use email_fetch, which normalizes malformed IDs, or normalize the search value yourself. Routing never sends, deletes, moves or marks email. It does not isolate the clerk's other tools and changes no live sending policy. Existing noise sorting keeps its move ability. Missing/invalid Message-ID requires operator handling. A creation with an uncertain outcome permanently fixes its destination and only reconciles that handoff; it cannot be redirected or dismissed. Routed handoffs with pending follow-ups remain counted in the triage report. Use Retry follow-ups on the source-company panel: the same keyed wake and definitely pending audits only, never another create/reopen or an unknown audit replay. Current config, access, account, credentials and destination are rechecked. Retry cannot repair closed/deleted issues, repointed destinations, replaced routers or terminated agents. After manual checking, an instance admin can use Mark follow-ups checked even with routing off or configuration removed. This removes follow-up alerts, does not prove delivery or cancel work. It records actor/time, keeps unknown facts unchanged and prevents new follow-up claims; already-requested work may still complete. The decision makes no connection, mail read, create, reopen, wake or audit. Source audit unknown means verify manually because this public SDK cannot safely repeat an audit. See README for the recovery limits and activation run sheet.
`,
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
    "events.subscribe",
    "issues.create",
    "issues.read",
    "agents.read",
    "projects.read",
    "activity.log.write",
    "issues.wakeup",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "api.routes.register",
  ],
  apiRoutes: [
    {
      // Operator clicks "Connect" → we 302-redirect the browser to Microsoft.
      // companyId is required only to satisfy the host's company-scoping gate;
      // the OAuth flow itself is instance-level (the target mailbox is carried
      // in the `mailbox` query param and the signed `state`).
      routeKey: "oauth.start",
      method: "GET",
      path: "/oauth/start",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      // Microsoft redirects the browser back here with ?code&state. The redirect
      // is a top-level navigation in the operator's browser, so it carries the
      // Paperclip session cookie (and loopback is trusted in local mode).
      // companyId is baked into the registered redirect URI's query string.
      routeKey: "oauth.callback",
      method: "GET",
      path: "/oauth/callback",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  database: {
    namespaceSlug: "email_tools",
    migrationsDir: "migrations",
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "email-tools-sender-rules",
        displayName: "Sender rules",
        exportName: "RulesSettingsPage",
      },
      { type: "settingsPage", id: "email-tools-mail-routing", displayName: "Mail routing", exportName: "RoutingSettingsPage" },
    ],
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: [
      "allowSend",
      "pollIntervalMinutes",
      "reviewQueueExpiryDays",
      "oauthMicrosoftClientId",
      "oauthRedirectUri",
      "mailboxes",
    ],
    properties: {
      oauthMicrosoftClientId: {
        type: "string",
        title: "Microsoft OAuth Client ID",
        description:
          "Azure Entra 'Application (client) ID' of your registered app. Required for any mailbox using 'oauth2' auth (Outlook / Hotmail / Office 365). Public-client PKCE — no client secret is stored.",
      },
      oauthRedirectUri: {
        type: "string",
        title: "Microsoft OAuth Redirect URI",
        description:
          "Must match the redirect URI registered in the Azure app exactly, e.g. http://localhost:3100/api/plugins/<pluginId>/api/oauth/callback",
      },
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
      reviewQueueExpiryDays: {
        type: "number",
        title: "Review queue expiry (days)",
        description:
          "A sender the triage routine queued for a decision drops out of the review queue after this many days with no new mail from them, so the queue cannot fill up with senders nobody will ever decide on. Default 30, min 1, max 365.",
        default: 30,
        minimum: 1,
        maximum: 365,
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
      name: "email_list_route_destinations", displayName: "List Mail Routing Destinations",
      description: "List enabled keys, labels and descriptions for the one configured mailbox router. Off returns no destinations. No company, project or agent IDs are exposed.",
      writes: false,
      parametersSchema: { type: "object", additionalProperties: false, required: ["mailbox"], properties: { mailbox: { type: "string" } } },
    },
    {
      name: "email_route_message", displayName: "Route Email",
      description: "Inside email-triage, propose one configured destination key or hold an ambiguous message for operator review. Only the named router in the ingest company may call. The server re-reads the immutable message and builds a standard handoff from real email. Routing performs no mailbox mutations. Never use for bulk cleanup, security, sign-in, phishing or payment-detail changes. Routed or waiting email must not be loosely moved.",
      writes: true, actionType: "change_knowledge_base",
      parametersSchema: { type: "object", additionalProperties: false,
        required: ["mailbox", "uid", "uidValidity", "messageId", "confidence", "reason"],
        properties: {
          mailbox: { type: "string" }, folder: { type: "string", maxLength: 300 },
          uid: { type: "integer", minimum: 1, maximum: 4294967295 },
          uidValidity: { type: "string", pattern: "^[1-9][0-9]{0,19}$", description: "The uidValidity string from current email_search." },
          messageId: { type: ["string", "null"], maxLength: 998, description: "The exact messageId of the CURRENT email_search item (not email_fetch, which normalizes malformed IDs), or null if missing. Unusable IDs wait for the operator." },
          confidence: { type: "string", enum: ["sure", "unsure"] }, destination: { type: "string" },
          candidates: { type: "array", maxItems: 3, items: { type: "string" } }, reason: { type: "string", minLength: 1, maxLength: 300, description: "Operator note only; never copied into the destination issue." },
        },
      },
    },
    {
      name: "email_send",
      displayName: "Send Email",
      description:
        "Send a plain-text or HTML email via SMTP using one of the configured mailboxes. A copy is saved to the mailbox's Sent folder (sent_copy in the result says where, or why not). When forwarding a message, pass forward_of_uid so the original is marked forwarded; when replying with in_reply_to, the original is marked answered if it is in the mailbox's watched folder. Returns the Message-ID and SMTP response.",
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
          forward_of_uid: {
            type: "number",
            description:
              "When this message forwards one from the mailbox: that message's UID. It is marked forwarded ($Forwarded) after sending, which is what shows the forwarded icon in Outlook and other mail clients.",
          },
          forward_of_folder: {
            type: "string",
            description:
              "Folder the forwarded message is in, e.g. the folder email_search returned it from. Required with forward_of_uid, because a UID only identifies a message within its own folder.",
          },
          forward_of_message_id: {
            type: "string",
            description:
              "Message-ID of the forwarded message (email_search and email_fetch return it). Optional but recommended: when given, the message at forward_of_uid is only marked if its Message-ID matches.",
          },
          attachments: {
            type: "array",
            description:
              "Files to attach. Each decoded attachment is capped at 25 MB; multiple attachments are allowed.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Filename shown to the recipient." },
                mime: {
                  type: "string",
                  description:
                    "MIME type, e.g. application/pdf. Optional; inferred from the filename when omitted.",
                },
                contentBase64: { type: "string", description: "File content, base64-encoded." },
              },
              required: ["name", "contentBase64"],
            },
          },
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
          text: {
            type: "string",
            description:
              "Free text matched against headers AND body (IMAP TEXT). Use this when you do not know which field the term appears in. Slower than the field-specific filters below.",
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
      name: "email_list_rules",
      displayName: "List Email Triage Rules",
      description:
        "Return the operator's sender rules (auto-triage, keep-always, and mute) for a mailbox. The triage routine should call this at the start of every run. Returns { autoTriage: string[], keepAlways: string[], mute: string[] }. Muted senders are treated like keep-always for the triage agent (skip the message entirely); the difference is that the poll loop marks muted senders' new arrivals as read on receipt. Patterns are full email, @domain, or subject:keyword (case-insensitive substring match).",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: {
            type: "string",
            description:
              "Mailbox identifier (e.g. 'personal'). Must be configured AND list the calling company under allowedCompanies.",
          },
        },
        required: ["mailbox"],
      },
    },
    {
      name: "email_get_triage_cursor",
      displayName: "Get Triage Cursor",
      description:
        "Return the point in time the triage routine should search from for a mailbox. Returns { lastRunAt: string|null, since: string, source: 'cursor'|'fallback' }. Use `since` verbatim as the search cutoff: it already subtracts the 5 minute safety overlap, and falls back to 24 hours ago when no cursor has been recorded yet. Replaces the old `last-run:` line in the Markdown rules-home document.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: {
            type: "string",
            description:
              "Mailbox identifier (e.g. 'personal'). Must be configured AND list the calling company under allowedCompanies.",
          },
        },
        required: ["mailbox"],
      },
    },
    {
      name: "email_set_triage_cursor",
      displayName: "Set Triage Cursor",
      description:
        "Record how far the triage routine got. Call once at the end of a successful run, and NOT when bulkCleanup is true (a backlog pass must not disturb the regular cadence). Defaults to the current time when lastRunAt is omitted. Refuses to move the cursor backwards unless force is true, so a slow or retried run cannot rewind it and cause the next run to reprocess everything in between.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: {
            type: "string",
            description:
              "Mailbox identifier (e.g. 'personal'). Must be configured AND list the calling company under allowedCompanies.",
          },
          lastRunAt: {
            type: "string",
            description: "ISO timestamp. Omit to use the current time.",
          },
          force: {
            type: "boolean",
            description:
              "Allow moving the cursor backwards. Only for a deliberate reseed, never for a normal run.",
          },
        },
        required: ["mailbox"],
      },
    },
    {
      name: "email_add_to_review_queue",
      displayName: "Add Senders to the Review Queue",
      description:
        "Record senders the triage run surfaced for a decision in the mailbox's review queue, which the plugin keeps next to the sender rules (it replaces the Review queue section of the retired rules-home document). Call once near the end of a triage run with every sender you counted as worth a rule, passing the messages you counted (messageId and uid from email_search) so each message is counted once however many runs see it. A sender already queued is updated, not duplicated. A sender already covered by a rule is not queued and comes back under alreadyRuled. An entry that cannot be stored (a sender no rule could match, a bad field, or a last-seen date older than the queue's expiry) is skipped and comes back under skipped with the reason; the rest are stored together. Any rule for a sender removes its entry, as does Dismiss on the Morning Brief or Portfolio Brief, and an entry with no new mail for the configured number of days (default 30) drops out. Returns { added, updated, alreadyRuled, skipped }.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: {
            type: "string",
            description:
              "Mailbox identifier (e.g. 'personal'). Must be configured AND list the calling company under allowedCompanies.",
          },
          entries: {
            type: "array",
            description: "One entry per sender, at most 500 per call.",
            items: {
              type: "object",
              properties: {
                sender: {
                  type: "string",
                  description:
                    "Full address or @domain. A From header like 'Pat Example <pat@example.com>' is accepted and reduced to the address.",
                },
                messages: {
                  type: "array",
                  description:
                    "The messages counted, each as email_search returns it: { messageId, uid }. The Message-ID identifies the message; a message with none (messageId null) is identified by its uid. Recommended over count, because runs see the same unread mail again.",
                  items: {
                    type: "object",
                    properties: {
                      messageId: { type: ["string", "null"] },
                      uid: { type: "number" },
                    },
                  },
                },
                messageIds: {
                  type: "array",
                  items: { type: ["string", "null"] },
                  description:
                    "Alternative to messages: bare Message-IDs. A null or blank one still counts as a message, just not by name.",
                },
                count: {
                  type: "number",
                  description:
                    "Only when you cannot name the messages: the sender has at least this many. Repeating the same count does not add to it. Defaults to the number of messages named.",
                },
                displayName: { type: "string", description: "Name on the From line." },
                subject: { type: "string", description: "Subject of the latest message." },
                note: {
                  type: "string",
                  description:
                    "Why it looks like a rule candidate (or why not), in a sentence. Shown to the operator. Cut at 2000 characters.",
                },
                suggestedRule: {
                  type: "string",
                  enum: ["auto-triage", "keep-always", "mute"],
                  description: "The rule you would pick, if any.",
                },
                lastSeenAt: { type: "string", description: "ISO date of the latest message. Defaults to now." },
                firstSeenAt: { type: "string", description: "ISO date of the earliest message, for an import." },
              },
              required: ["sender"],
            },
          },
        },
        required: ["mailbox", "entries"],
      },
    },
    {
      name: "email_list_review_queue",
      displayName: "List the Review Queue",
      description:
        "Return the senders waiting in the mailbox's review queue for the operator's decision, noisiest first. Use it to say in the run report how many are still waiting, and to avoid reporting a waiting sender as new. Returns { entries: [{ sender, displayName, messageCount, firstSeenAt, lastSeenAt, lastSubject, note, suggestedRule }], total }. A sender covered by a rule is left out, and so is one with no new mail within the queue's expiry (default 30 days).",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: {
            type: "string",
            description:
              "Mailbox identifier (e.g. 'personal'). Must be configured AND list the calling company under allowedCompanies.",
          },
          limit: {
            type: "number",
            description: "Max entries returned. Default 100, max 500. total always counts every waiting sender.",
          },
        },
        required: ["mailbox"],
      },
    },
    {
      name: "email_reply",
      displayName: "Reply to Email",
      description:
        "Reply using exactly one of uid or messageId. Both selectors default to the configured poll folder, or INBOX. Message-ID resolves the actual current message, refusing missing, ambiguous or changed identities. Uses the existing SMTP, company access and send-approval path, saves a Sent copy and marks the original answered.",
      parametersSchema: {
        type: "object",
        properties: {
          mailbox: { type: "string" },
          folder: { type: "string" },
          uid: { type: "integer", minimum: 1, maximum: 4294967295, description: "Supply exactly one of uid or messageId." },
          messageId: { type: "string", description: "Exact bracketed Message-ID. Supply exactly one of uid or messageId. Resolves in folder, defaulting to the configured poll folder or INBOX." },
          body: { type: "string", description: "Plain-text body." },
          body_html: { type: "string" },
          replyAll: { type: "boolean", default: false },
          cc: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Optional carbon copy recipients.",
          },
          bcc: {
            oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
            description: "Optional blind carbon copy recipients.",
          },
          attachments: {
            type: "array",
            description:
              "Files to attach. Each decoded attachment is capped at 25 MB; multiple attachments are allowed.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Filename shown to the recipient." },
                mime: {
                  type: "string",
                  description:
                    "MIME type, e.g. application/pdf. Optional; inferred from the filename when omitted.",
                },
                contentBase64: { type: "string", description: "File content, base64-encoded." },
              },
              required: ["name", "contentBase64"],
            },
          },
        },
        required: ["mailbox", "body"],
      },
    },
    {
      name: "email_search_contacts",
      displayName: "Search Email Contacts",
      description:
        "Search contacts in the company address book by name or email address.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional query to filter contacts by name or email.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of contacts to return (default 20, max 100).",
          },
        },
      },
    },
    {
      name: "email_save_contact",
      displayName: "Save Email Contact",
      description: "Save or update a contact in the company address book.",
      parametersSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "Contact email address." },
          name: { type: "string", description: "Optional display name for the contact." },
          notes: { type: "string", description: "Optional notes for the contact." },
        },
        required: ["email"],
      },
    },
    {
      name: "email_import_contacts",
      displayName: "Import Email Contacts",
      description:
        "Batch import or update contacts in the company address book. Merges and updates duplicates matching an existing email address.",
      parametersSchema: {
        type: "object",
        properties: {
          contacts: {
            type: "array",
            description: "List of contacts to import or update.",
            items: {
              type: "object",
              properties: {
                email: { type: "string", description: "Contact email address." },
                name: { type: "string", description: "Optional display name." },
                notes: { type: "string", description: "Optional notes." },
              },
              required: ["email"],
            },
          },
        },
        required: ["contacts"],
      },
    },
  ],
};

export default manifest;
