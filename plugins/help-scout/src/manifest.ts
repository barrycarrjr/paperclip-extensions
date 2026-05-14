import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "help-scout";
const PLUGIN_VERSION = "0.5.1";

const accountItemSchema = {
  type: "object",
  required: ["key", "clientIdRef", "clientSecretRef", "allowedCompanies"],
  propertyOrder: [
    "key",
    "displayName",
    "clientIdRef",
    "clientSecretRef",
    "defaultMailbox",
    "allowedMailboxes",
    "allowedCompanies",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling Help Scout tools (e.g. 'main', 'support'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it. Must be unique across accounts.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description:
        "Human-readable label shown in this settings form (e.g. 'Customer Support', 'Brand-B Support'). Free-form.",
    },
    clientIdRef: {
      type: "string",
      format: "secret-ref",
      title: "OAuth2 Client ID",
      description:
        "Paste the UUID of the secret holding this Help Scout app's OAuth2 Client ID. Create the secret first on the company's Secrets page; never paste the raw value here. See the Setup tab for how to get the Client ID from Help Scout.",
    },
    clientSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "OAuth2 Client Secret",
      description:
        "Paste the UUID of the secret holding this Help Scout app's OAuth2 Client Secret. Same Help Scout app as Client ID above. The plugin exchanges these for short-lived (48h) access tokens via client_credentials grant and refreshes automatically.",
    },
    defaultMailbox: {
      type: "string",
      title: "Default mailbox (optional)",
      description:
        "When a tool call needs a mailbox and the agent omits one, this is the fallback. The dropdown is populated by calling the Help Scout API with the saved credentials above — click Save Configuration once the Client ID and Client Secret refs are filled, then this dropdown will populate.",
      "x-paperclip-optionsFrom": { actionKey: "list-mailboxes" },
      "x-paperclip-showWhenAllPresent": ["clientIdRef", "clientSecretRef"],
    },
    allowedMailboxes: {
      type: "array",
      items: { type: "string" },
      title: "Allowed mailbox IDs (optional)",
      description:
        "If non-empty, restricts every tool call that addresses a mailbox to these mailbox IDs. Empty/missing = unrestricted within this account. Same flow as Default mailbox above — appears after the credentials are filled and saved.",
      "x-paperclip-itemsOptionsFrom": { actionKey: "list-mailboxes" },
      "x-paperclip-showWhenAllPresent": ["clientIdRef", "clientSecretRef"],
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may call Help Scout tools against this account. Tick 'Portfolio-wide' to allow every company; otherwise tick specific companies. Empty = unusable (fail-safe deny). A Help Scout account typically belongs to one LLC's support team, so prefer single-company lists.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — Help Scout

Connect a Help Scout account so agents can find conversations, reply, add notes, manage customers, and pull reports. Reckon on **about 10 minutes** the first time.

Help Scout's Mailbox API uses **OAuth2 with the client_credentials grant**. The plugin handles token refresh automatically — you only need to provide the Client ID and Client Secret once.

---

## 1. Create a Help Scout custom app (gives you Client ID + Client Secret)

- Log into Help Scout
- Click your avatar (top right) → **Your Profile**
- In the left sidebar click **My Apps**
- Click **Create App** (top right)
- Fill in:
  - **App Name**: e.g. \`Paperclip\`
  - **Redirection URL**: paste any URL — Help Scout requires the field but doesn't use it for the client_credentials flow. \`https://www.google.com\` works fine.
- Click **Create**
- The next page shows **App ID** (= Client ID) and **App Secret** (= Client Secret). Copy both — the App Secret is shown only once.

> The custom app has full Mailbox API scope on your Help Scout account. Treat the Client Secret like a password.

---

## 2. Create two Paperclip secrets

In Paperclip, go to the company that should own these secrets and open **Secrets → Add**.

> If you store shared cross-company secrets in a portfolio-root or "HQ"-style company, create them there instead. Secret UUIDs are globally unique and the plugin resolves them regardless of which company holds them — you only need one copy of the credentials no matter how many LLCs use this Help Scout account.

Secret names follow the all-caps snake_case convention used across paperclip plugins (\`IMAP_PERSONAL_PASS\`, \`SLACK_BOT_TOKEN\`, etc.) — keep that pattern so they sort together in the secrets list.

- Create one secret for the **Client ID**:
  - Name: \`HELPSCOUT_CLIENT_ID\`
  - Value: the App ID from step 1
  - Save and **copy the secret's UUID**
- Create a second secret for the **Client Secret**:
  - Name: \`HELPSCOUT_SECRET_ID\`
  - Value: the App Secret from step 1
  - Save and **copy the secret's UUID**

---

## 3. Add the account row (**Configuration** tab — first save)

Click the **Configuration** tab above. Under **Help Scout accounts**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | \`main\` (or a per-brand key like \`support\`, \`sales\`) |
| **Display name** | e.g. "Customer Support" |
| **OAuth2 Client ID** | UUID of \`HELPSCOUT_CLIENT_ID\` secret from step 2 |
| **OAuth2 Client Secret** | UUID of \`HELPSCOUT_SECRET_ID\` secret from step 2 |
| **Allowed companies** | tick the companies whose agents may use this account |

Set **Default account key** at the top to the identifier you just used. Click **Save Configuration**.

> The Default mailbox and Allowed mailbox IDs fields don't appear yet — they're hidden until both credential refs are filled and saved, because they need to call Help Scout's API to populate.

---

## 4. Pick the mailbox (Configuration tab — second pass)

After step 3's save, the same row reveals two new fields:

- **Default mailbox**: a dropdown listing every mailbox visible on your Help Scout account, fetched live via the credentials you just saved. Pick the one you want as the default for this account key.
- **Allowed mailbox IDs**: a checkbox list of the same mailboxes. Tick only the ones agents in this account's allowed companies should be able to address. Leave all unchecked to allow every mailbox on the account (often fine for a single-mailbox setup; necessary to restrict when one Help Scout account hosts many brands' inboxes).

Click **Save Configuration** again.

> If the dropdown shows "No options available yet", the action couldn't reach Help Scout. Check that both secrets resolve to the values shown in Help Scout's My Apps page; the most common cause is pasting the App ID where the App Secret should be (or vice versa).

---

## 5. Enable mutations when ready

**Allow create/reply/note/status/tag changes** at the top of the page defaults to OFF (read-only). Flip it ON once you've verified read tools work and you're ready for agents to reply, tag, or change status.

---

## Troubleshooting

- **\`[EHELP_SCOUT_AUTH]\`** — Client ID or Secret is wrong, or the app was deleted in Help Scout. Verify both secrets resolve to the values shown in Help Scout's My Apps page; recreate the app if needed.
- **\`[EHELP_SCOUT_TOKEN_EXCHANGE]\`** — Help Scout's OAuth endpoint rejected the credentials. Same fix as above.
- **\`[ECOMPANY_NOT_ALLOWED]\`** — the calling company isn't ticked in Allowed companies.
- **Mailbox not found** — the default mailbox ID is wrong, or the mailbox is restricted by Allowed mailbox IDs. Run \`helpscout_list_mailboxes\` to verify the IDs.
- **Duplicate conversations** — use \`idempotencyKey\` on \`helpscout_create_conversation\` to prevent double-creation if a skill retries.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Help Scout",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Customer-support operations on Help Scout — find / create / reply / note conversations, look up customers, change status, assign, tag, and pull day/week/custom reports. Multi-account, per-account allowedCompanies, mutations gated.",
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
    additionalProperties: false,
    propertyOrder: ["allowMutations", "defaultAccount", "accounts"],
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow create/reply/note/status/tag changes",
        description:
          "Master switch for every Help Scout tool that modifies a conversation, customer, or thread. Set false (default) to keep the plugin in read-only mode — mutation tools return [EDISABLED] without hitting Help Scout. Read tools (find, get, reports) are unaffected. Flip to true once you've reviewed which agents/skills can mutate.",
        default: false,
      },
      defaultAccount: {
        type: "string",
        title: "Default account key",
        "x-paperclip-optionsFromSibling": {
          sibling: "accounts",
          valueKey: "key",
          labelKey: "displayName",
        },
        description:
          "Identifier of the account used when an agent omits the `account` parameter in a tool call. Strict: if the calling company isn't in the default account's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no automatic fallback). Leave blank to require an explicit `account` on every call.",
      },
      accounts: {
        type: "array",
        title: "Help Scout accounts",
        description:
          "One entry per Help Scout account this plugin can talk to. Most operators have one account per LLC. Every account must list 'Allowed companies' — empty list = unusable.",
        items: accountItemSchema,
      },
    },
  },
  tools: [
    {
      name: "helpscout_list_mailboxes",
      displayName: "List Help Scout mailboxes",
      description:
        "List all mailboxes on the account. Returns id, name, and email. Use once at setup time to find the mailbox ID for defaultMailbox / allowedMailboxes.",
      parametersSchema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              "Account identifier as configured on the plugin settings page. Optional — falls back to defaultAccount.",
          },
        },
      },
    },
    {
      name: "helpscout_find_conversation",
      displayName: "Find Help Scout conversations",
      description:
        "Search conversations on a Help Scout account. Returns id, subject, status, mailboxId, customer, and timestamps. Pass any combination of filters; all are optional. Pagination via `page`.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          mailboxId: {
            type: "string",
            description: "Filter to one mailbox by ID. Falls back to defaultMailbox if omitted.",
          },
          query: {
            type: "string",
            description:
              "Help Scout search query (Lucene-like). Examples: 'subject:refund', 'tag:vip', 'modifiedAt:[2026-04-01T00:00:00Z TO *]'.",
          },
          status: {
            type: "string",
            enum: ["active", "pending", "closed", "spam", "open", "all"],
            description:
              "Conversation status filter. 'open' = active+pending. 'all' = no filter.",
          },
          tag: { type: "string", description: "Filter to one tag." },
          assignedTo: { type: "string", description: "Filter to one Help Scout user ID." },
          since: {
            type: "string",
            description:
              "ISO 8601 timestamp — only conversations modified at or after this time.",
          },
          limit: { type: "number", description: "Page size. Default 25, max 50." },
          page: { type: "number", description: "Page number, 1-indexed." },
        },
      },
    },
    {
      name: "helpscout_get_conversation",
      displayName: "Get Help Scout conversation",
      description:
        "Retrieve a single conversation by ID. Pass `embed: 'threads'` to include the full thread body in the response.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          conversationId: { type: "string", description: "Help Scout conversation ID." },
          embed: {
            type: "string",
            enum: ["threads"],
            description:
              "Optional embed. 'threads' includes the full message bodies; otherwise only metadata is returned.",
          },
        },
        required: ["conversationId"],
      },
    },
    {
      name: "helpscout_create_conversation",
      displayName: "Create Help Scout conversation",
      description:
        "Create a new conversation. Use for proactive outreach (e.g. 'we noticed your subscription renewal failed'). Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          mailboxId: {
            type: "string",
            description:
              "Mailbox ID this conversation lives in. Required. Falls back to defaultMailbox if omitted.",
          },
          subject: { type: "string", description: "Subject line for the conversation." },
          customer: {
            type: "object",
            properties: {
              email: { type: "string" },
              firstName: { type: "string" },
              lastName: { type: "string" },
            },
            required: ["email"],
            description:
              "Customer to attach. If a customer with this email exists, Help Scout reuses it; otherwise creates one.",
          },
          type: {
            type: "string",
            enum: ["email", "chat", "phone"],
            default: "email",
            description: "Conversation channel.",
          },
          status: {
            type: "string",
            enum: ["active", "pending", "closed"],
            default: "active",
          },
          assignTo: { type: "string", description: "Optional Help Scout user ID to assign to." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags to apply on creation. Lowercased automatically.",
          },
          threads: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["customer", "reply", "note"],
                  description:
                    "'customer' = inbound message from the customer (use for imported convos). 'reply' = outbound from the operator. 'note' = internal note (no email sent).",
                },
                body: { type: "string", description: "Plain-text or HTML body." },
                customerEmail: {
                  type: "string",
                  description: "Override the conversation customer for this thread (rare).",
                },
              },
              required: ["type", "body"],
            },
            description: "First thread(s) to seed the conversation. At least one required.",
          },
          idempotencyKey: {
            type: "string",
            description:
              "Optional. The plugin stores this as a custom property on the conversation; subsequent calls with the same key dedupe to the existing conversation.",
          },
        },
        required: ["subject", "customer", "threads"],
      },
    },
    {
      name: "helpscout_send_reply",
      displayName: "Send Help Scout reply",
      description:
        "Reply to an existing conversation as the operator. The customer receives an email. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          conversationId: { type: "string", description: "Conversation to reply to." },
          body: { type: "string", description: "Plain-text or HTML body." },
          customerEmail: {
            type: "string",
            description:
              "Optional customer email override. By default, replies to the conversation's customer.",
          },
          cc: { type: "array", items: { type: "string" }, description: "CC recipients." },
          bcc: { type: "array", items: { type: "string" }, description: "BCC recipients." },
          imported: {
            type: "boolean",
            default: false,
            description:
              "When true, records the reply in Help Scout WITHOUT actually sending an email. Useful for backfilling history.",
          },
        },
        required: ["conversationId", "body"],
      },
    },
    {
      name: "helpscout_add_note",
      displayName: "Add Help Scout note",
      description:
        "Add an internal note to a conversation. Notes are visible to operators; the customer never sees them. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          conversationId: { type: "string", description: "Conversation to add the note to." },
          body: { type: "string", description: "Plain-text or HTML body of the note." },
          userId: {
            type: "string",
            description:
              "Optional Help Scout user ID to attribute the note to. Defaults to the API key's user.",
          },
        },
        required: ["conversationId", "body"],
      },
    },
    {
      name: "helpscout_change_status",
      displayName: "Change Help Scout conversation status",
      description:
        "Change a conversation's status (active / pending / closed / spam). Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          conversationId: { type: "string", description: "Conversation to update." },
          status: {
            type: "string",
            enum: ["active", "pending", "closed", "spam"],
          },
        },
        required: ["conversationId", "status"],
      },
    },
    {
      name: "helpscout_assign_conversation",
      displayName: "Assign Help Scout conversation",
      description:
        "Assign a conversation to a user, or unassign by passing userId=null. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          conversationId: { type: "string", description: "Conversation to assign." },
          userId: {
            type: ["string", "null"],
            description: "User ID to assign to, or null to unassign.",
          },
        },
        required: ["conversationId", "userId"],
      },
    },
    {
      name: "helpscout_add_label",
      displayName: "Add Help Scout label/tag",
      description:
        "Add one or more tags to a conversation. Tag names are case-insensitive in Help Scout's UI; the plugin lowercases on input/output to normalize. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          conversationId: { type: "string", description: "Conversation to tag." },
          labels: {
            type: "array",
            items: { type: "string" },
            description:
              "Tags to add. Existing tags on the conversation are preserved; this is union, not replace.",
          },
        },
        required: ["conversationId", "labels"],
      },
    },
    {
      name: "helpscout_remove_label",
      displayName: "Remove Help Scout label/tag",
      description: "Remove one or more tags from a conversation. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          conversationId: { type: "string", description: "Conversation to untag." },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Tags to remove. Other tags on the conversation are preserved.",
          },
        },
        required: ["conversationId", "labels"],
      },
    },
    {
      name: "helpscout_find_customer",
      displayName: "Find Help Scout customers",
      description: "Search customers by email, query, or name fields. Pagination via `page`.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          email: { type: "string", description: "Match by email (exact)." },
          query: { type: "string", description: "Help Scout customer search query." },
          firstName: { type: "string", description: "Match by first name (partial)." },
          lastName: { type: "string", description: "Match by last name (partial)." },
          limit: { type: "number", description: "Page size. Default 25, max 50." },
          page: { type: "number", description: "Page number, 1-indexed." },
        },
      },
    },
    {
      name: "helpscout_create_customer",
      displayName: "Create Help Scout customer",
      description:
        "Create a customer record. Idempotent on email — calling twice with the same email returns the existing customer rather than creating a duplicate. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          email: { type: "string", description: "Customer email (required, used for dedup)." },
          firstName: { type: "string" },
          lastName: { type: "string" },
          properties: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Help Scout custom properties as key:value strings. Property keys must already be defined at the account level.",
          },
          idempotencyKey: {
            type: "string",
            description:
              "Optional. Stored as a custom property; subsequent calls with same key short-circuit to the existing customer.",
          },
        },
        required: ["email"],
      },
    },
    {
      name: "helpscout_update_customer_properties",
      displayName: "Update Help Scout customer properties",
      description:
        "Update one or more Help Scout custom properties on a customer. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          customerId: { type: "string", description: "Help Scout customer ID." },
          properties: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Property key:value pairs to update. Other properties are unchanged.",
          },
        },
        required: ["customerId", "properties"],
      },
    },
    {
      name: "helpscout_find_user",
      displayName: "Find Help Scout user (agent)",
      description:
        "Search Help Scout users (operators / agents — NOT end customers). Use to look up user IDs for assignTo and note authorship.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          email: { type: "string", description: "Match by email (exact)." },
          query: { type: "string", description: "Free-text query against name." },
          limit: { type: "number", description: "Page size. Default 25." },
        },
      },
    },
    {
      name: "helpscout_get_day_report",
      displayName: "Get Help Scout day report",
      description:
        "Pull the day report — counts of new / closed / replies, response time stats, busiest hours. Cached for 60 s per (account, mailboxId, date).",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          mailboxId: {
            type: "string",
            description: "Mailbox ID. Optional — defaults to defaultMailbox.",
          },
          date: {
            type: "string",
            description: "ISO date (YYYY-MM-DD). Defaults to yesterday in account TZ.",
          },
        },
      },
    },
    {
      name: "helpscout_get_week_report",
      displayName: "Get Help Scout week report",
      description: "Weekly aggregated report. Cached for 60 s per (account, mailboxId, week-start).",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          mailboxId: { type: "string", description: "Mailbox ID. Optional." },
          start: {
            type: "string",
            description: "ISO date (YYYY-MM-DD) for the start of the week. Defaults to last Monday.",
          },
        },
      },
    },
    {
      name: "helpscout_get_custom_report",
      displayName: "Get Help Scout custom report",
      description:
        "Custom-range report between `start` and `end`. Optional grouping by tag / user / mailbox.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          mailboxId: { type: "string", description: "Mailbox ID. Optional." },
          start: { type: "string", description: "ISO date (YYYY-MM-DD)." },
          end: { type: "string", description: "ISO date (YYYY-MM-DD)." },
          group: {
            type: "string",
            enum: ["tag", "user", "mailbox"],
            description: "Optional grouping dimension.",
          },
        },
        required: ["start", "end"],
      },
    },
  ],
};

export default manifest;
