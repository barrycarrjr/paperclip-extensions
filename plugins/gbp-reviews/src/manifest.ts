import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "gbp-reviews";
const PLUGIN_VERSION = "0.1.0";

const SETUP_INSTRUCTIONS = `# Setup — Google Business Profile Reviews

This plugin monitors GBP reviews for your portfolio companies and lets CEO agents reply directly from Paperclip.

## What it does
- **Phase 1**: Polls Gmail for GBP review notification emails → creates Paperclip issues with AI-drafted replies
- **Phase 2**: Posts approved replies back to GBP via the My Business API
- **Phase 3**: Daily/weekly review digest, sentiment tracking, and dashboard

---

## Setup steps

### 1. Create a GCP project and OAuth credentials

Go to [https://console.cloud.google.com](https://console.cloud.google.com):
1. Create (or reuse) a project
2. Enable: **My Business API** and **Gmail API**
3. Create OAuth 2.0 credentials (Desktop app type)
4. Download client ID and secret

### 2. Get a refresh token

From the \`paperclip-extensions\` repo:
\`\`\`bash
pnpm --filter paperclip-plugin-google-workspace grant <account-key>
\`\`\`
Use a Google account that has **Owner or Manager** access to the GBP location(s).

Required scopes:
- \`https://www.googleapis.com/auth/business.manage\`
- \`https://www.googleapis.com/auth/gmail.readonly\`

### 3. Create Paperclip secrets

For each GBP account, create three secrets in Paperclip:
- \`GBP_CLIENT_ID\` → the OAuth client ID
- \`GBP_CLIENT_SECRET\` → the OAuth client secret
- \`GBP_REFRESH_TOKEN\` → the refresh token from step 2

### 4. Configure the plugin (Configuration tab)

Under **GBP accounts**, add an entry:
| Field | Value |
|---|---|
| **Key** | e.g. \`primary-gbp\` |
| **Google Account ID** | The numeric GBP account ID (get from the GBP URL or API) |
| **OAuth client ID** | UUID of the client ID secret |
| **OAuth client secret** | UUID of the client secret secret |
| **Refresh token** | UUID of the refresh token secret |
| **Allowed companies** | Companies that may use this account |

Under **GBP locations**, add each location:
| Field | Value |
|---|---|
| **Key** | e.g. \`main-st-store\` |
| **Display name** | e.g. \`Main St Store\` |
| **Google Account ID** | Same as above |
| **Location ID** | The GBP location ID (e.g. \`1234567890123456789\`) |
| **Account key** | References the account entry above |
| **Target company ID** | Paperclip company where review issues should be created |

---

## Troubleshooting
- **\`invalid_grant\`** — re-run the grant script and update the refresh token secret.
- **Missing Gmail permissions** — make sure the refresh token was obtained with the \`gmail.readonly\` scope.
- **Reviews not appearing** — confirm the GBP account has Owner/Manager access to the location.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GBP Reviews",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Google Business Profile review management. Detects incoming review emails, creates Paperclip issues with AI-drafted replies, posts replies via the GBP API, and surfaces a review dashboard.",
  author: "Barry Carr",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "jobs.schedule",
    "events.subscribe",
    "events.emit",
    "issues.create",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  database: {
    migrationsDir: "migrations",
  },
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  jobs: [
    {
      jobKey: "poll-review-emails",
      displayName: "Poll Gmail for new GBP review emails",
      description: "Scans the configured Gmail inbox for GBP review notification emails and creates Paperclip issues with AI-drafted replies.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "sync-all-reviews",
      displayName: "Sync all GBP reviews",
      description: "Pulls all reviews from all configured GBP locations via the My Business API and updates the local database.",
      schedule: "0 6 * * *",
    },
    {
      jobKey: "send-weekly-digest",
      displayName: "Send weekly review digest",
      description: "Creates a weekly digest issue (or briefing comment) summarising new reviews, response time, and unreplied reviews.",
      schedule: "0 8 * * 1",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      allowReplies: {
        type: "boolean",
        title: "Allow posting replies to GBP",
        description: "Master switch. When off, the plugin drafts replies but never posts them — agents must manually post. Default: off.",
        default: false,
      },
      gmailAccountKey: {
        type: "string",
        title: "Gmail account key",
        description: "Key of the account to use for Gmail polling (must include gmail.readonly scope). Leave blank to skip Phase 1 email polling.",
      },
      accounts: {
        type: "array",
        title: "GBP OAuth accounts",
        description: "One entry per Google account with GBP + Gmail access.",
        items: {
          type: "object",
          required: ["key", "clientIdRef", "clientSecretRef", "refreshTokenRef", "allowedCompanies"],
          properties: {
            key: {
              type: "string",
              title: "Key",
              description: "Short stable ID (e.g. 'primary-gbp'). Used by locations to reference this account.",
            },
            displayName: { type: "string", title: "Display name" },
            userEmail: { type: "string", title: "Google email" },
            clientIdRef: {
              type: "string",
              format: "secret-ref",
              title: "OAuth client ID (secret UUID)",
            },
            clientSecretRef: {
              type: "string",
              format: "secret-ref",
              title: "OAuth client secret (secret UUID)",
            },
            refreshTokenRef: {
              type: "string",
              format: "secret-ref",
              title: "Refresh token (secret UUID)",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
            },
          },
        },
      },
      locations: {
        type: "array",
        title: "GBP locations",
        description: "One entry per GBP location to monitor.",
        items: {
          type: "object",
          required: ["key", "displayName", "googleAccountId", "locationId", "accountKey", "targetCompanyId"],
          properties: {
            key: { type: "string", title: "Key", description: "Short stable ID (e.g. 'main-st-store')." },
            displayName: { type: "string", title: "Display name", description: "e.g. 'Main St Store'" },
            googleAccountId: { type: "string", title: "Google Account ID", description: "Numeric GBP account ID." },
            locationId: { type: "string", title: "Location ID", description: "Numeric GBP location ID (e.g. '1234567890123456789')." },
            accountKey: { type: "string", title: "Account key", description: "References accounts[].key above." },
            targetCompanyId: { type: "string", title: "Target Paperclip company ID", description: "UUID of the Paperclip company where review issues should be created." },
            targetProjectId: { type: "string", title: "Target project ID (optional)" },
          },
        },
      },
    },
    required: [],
  },
  tools: [
    {
      name: "gbp_list_reviews",
      displayName: "List GBP Reviews",
      description: "List all reviews for a GBP location. Returns reviewer name, star rating, review text, and reply status.",
      parametersSchema: {
        type: "object",
        properties: {
          locationKey: { type: "string", description: "The location key as configured in plugin settings (e.g. 'main-st-store')." },
          includeReplied: { type: "boolean", description: "Include reviews that already have a reply. Default: false." },
        },
        required: ["locationKey"],
      },
    },
    {
      name: "gbp_get_review",
      displayName: "Get GBP Review",
      description: "Get a single GBP review by its resource name.",
      parametersSchema: {
        type: "object",
        properties: {
          reviewName: { type: "string", description: "Full GBP review resource name from a list_reviews call." },
          locationKey: { type: "string", description: "Location key for authentication." },
        },
        required: ["reviewName", "locationKey"],
      },
    },
    {
      name: "gbp_reply_to_review",
      displayName: "Reply to GBP Review",
      description: "Post a reply to a GBP review. Requires allowReplies to be enabled in plugin settings.",
      parametersSchema: {
        type: "object",
        properties: {
          reviewName: { type: "string", description: "Full GBP review resource name." },
          locationKey: { type: "string", description: "Location key for authentication and authorisation." },
          replyText: { type: "string", description: "The reply text to post (max 4096 characters)." },
        },
        required: ["reviewName", "locationKey", "replyText"],
      },
    },
    {
      name: "gbp_sync_location",
      displayName: "Sync GBP Location Reviews",
      description: "Manually trigger a sync of all reviews for a specific location.",
      parametersSchema: {
        type: "object",
        properties: {
          locationKey: { type: "string", description: "Location key to sync." },
        },
        required: ["locationKey"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "review-summary-widget",
        displayName: "GBP Reviews",
        exportName: "ReviewSummaryWidget",
      },
      {
        type: "page",
        id: "review-dashboard",
        displayName: "GBP Review Dashboard",
        exportName: "ReviewDashboardPage",
        routePath: "gbp-reviews",
      },
    ],
  },
};

export default manifest;
