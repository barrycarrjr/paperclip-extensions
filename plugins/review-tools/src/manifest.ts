import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "review-tools";
const PLUGIN_VERSION = "0.1.13";

const SETUP_INSTRUCTIONS = `# Setup: Review Tools

Review Tools coordinates customer review workflows across multiple review platforms for your portfolio companies, allowing agents and team members to track reviews, draft suggested responses, and post replies directly from Paperclip.

Currently supports **Google Business Profile (GBP)**, with architecture for connecting additional review platforms (Trustpilot, Facebook, Yelp, App Store, etc.).

## What it does
- **Multi-platform support**: Unified review tracking and responses across connected review APIs
- **Phase 1**: Polls Gmail for review notification emails and creates Paperclip issues with suggested replies
- **Phase 2**: Posts approved replies back via review provider APIs, from an agent tool or the Reviews dashboard
- **Phase 3**: Daily/weekly review digest, sentiment tracking, and cross-channel dashboard

---

## Google Business Profile (GBP) Setup

### 1. Create a GCP project and OAuth credentials

Go to [https://console.cloud.google.com](https://console.cloud.google.com):
1. Create (or reuse) a project
2. Enable: **My Business API** and **Gmail API**
3. Create OAuth 2.0 credentials (Desktop app type)
4. Download client ID and secret

### 2. Get a refresh token

From the \`paperclip-extensions\` repo:
\`\`\`bash
pnpm --filter paperclip-plugin-review-tools grant <account-key>
\`\`\`
Use a Google account that has **Owner or Manager** access to the GBP location(s).

Required scopes:
- \`https://www.googleapis.com/auth/business.manage\`
- \`https://www.googleapis.com/auth/gmail.readonly\`

### 3. Create Paperclip secrets

For each Google account, create three secrets in Paperclip:
- \`GBP_CLIENT_ID\` → the OAuth client ID
- \`GBP_CLIENT_SECRET\` → the OAuth client secret
- \`GBP_REFRESH_TOKEN\` → the refresh token from step 2

### 4. Configure the plugin (Configuration tab)

Under **Google / GBP OAuth accounts**, add an entry:
| Field | Value |
|---|---|
| **Key** | e.g. \`primary-gbp\` |
| **Google Account ID** | The numeric GBP account ID (get from the GBP URL or API) |
| **OAuth client ID** | UUID of the client ID secret |
| **OAuth client secret** | UUID of the client secret secret |
| **Refresh token** | UUID of the refresh token secret |
| **Allowed companies** | Companies that may use this account |

Under **Monitored review locations**, add each location:
| Field | Value |
|---|---|
| **Key** | e.g. \`main-st-store\` |
| **Display name** | e.g. \`Main St Store\` |
| **Google Account ID** | Same as above |
| **Location ID** | The GBP location ID (e.g. \`1234567890123456789\`) |
| **Account key** | References the account entry above |
| **Target company ID** | Paperclip company where review issues should be created |

---

## Additional Review Providers
Support for additional review platforms (Trustpilot, Facebook, Yelp) uses the same unified review database schema and response pipeline. Contact your administrator or check upcoming extension releases for provider connectors.

---

## Troubleshooting
- **\`invalid_grant\`**: re-run the grant script and update the refresh token secret.
- **Missing Gmail permissions**: make sure the refresh token was obtained with the \`gmail.readonly\` scope.
- **Reviews not appearing**: confirm the Google account has Owner/Manager access to the location.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Review Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Multi-platform customer review management and automation suite. Supports Google Business Profile (with expansion architecture for additional review APIs). Detects incoming review notifications, drafts suggested replies, synchronizes reviews via APIs, posts approved replies, and surfaces a unified review dashboard.",
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
    // Read-only, and needed for one thing: telling whether the company you
    // are viewing from is the portfolio root, so the review dashboard can
    // show HQ a cross-company roll-up while showing every other company only
    // its own locations. Without it the dashboard cannot tell the two apart
    // and would have to show everyone the same list, which is the leak this
    // capability exists to close.
    "companies.read",
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
      displayName: "Poll review notification emails (Gmail/GBP)",
      description: "Scans the configured Gmail inbox for review notification emails and creates Paperclip issues with suggested replies.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: "sync-all-reviews",
      displayName: "Sync all reviews (Google Business Profile)",
      description: "Pulls all reviews from configured GBP locations via provider API and updates the local database.",
      schedule: "0 6 * * *",
    },
    {
      jobKey: "send-weekly-digest",
      displayName: "Send weekly review digest",
      description: "Creates a weekly digest issue summarising new reviews, response times, and unreplied reviews across channels.",
      schedule: "0 8 * * 1",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      allowReplies: {
        type: "boolean",
        title: "Allow posting review replies (Google GBP)",
        description: "Master switch. When enabled, allows agents and operators to post replies directly to review platforms. When off, replies remain drafts. Default: off.",
        default: false,
      },
      gmailAccountKey: {
        type: "string",
        title: "Gmail notification polling account",
        description: "Key of the Google account to use for review notification email polling (must include gmail.readonly scope).",
      },
      accounts: {
        type: "array",
        title: "Google / GBP OAuth accounts",
        description: "Connected Google accounts with GBP and Gmail access. Additional provider accounts will be configured here as more review APIs are connected.",
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
        title: "Monitored review locations (Google GBP)",
        description: "Configured business locations to monitor across review platforms.",
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
      displayName: "List Reviews (Google GBP)",
      description: "List reviews for a configured location (Google Business Profile). Returns reviewer name, star rating, review text, and reply status.",
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
      displayName: "Get Review (Google GBP)",
      description: "Get a single review by its resource name (Google Business Profile).",
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
      displayName: "Reply to Review (Google GBP)",
      description: "Post a reply to a review (Google Business Profile). Requires reply posting to be enabled in plugin settings.",
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
      displayName: "Sync Reviews (Google GBP)",
      description: "Manually trigger a sync of all reviews for a specific location via provider API.",
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
        displayName: "Review Tools",
        exportName: "ReviewSummaryWidget",
      },
      {
        type: "page",
        id: "review-dashboard",
        displayName: "Review Dashboard",
        exportName: "ReviewDashboardPage",
        routePath: "reviews",
      },
    ],
  },
};

export default manifest;
