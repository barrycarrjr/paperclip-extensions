import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "review-tools";
const PLUGIN_VERSION = "0.6.0";

const SETUP_INSTRUCTIONS = `# Setup: Review Tools

Review Tools tracks customer reviews and replies to them from inside Paperclip. It supports Google Business Profile today, with room for other review platforms later.

Everything below is done on the **Google connection** page inside a company. You do not need a terminal.

## Run sheet

1. In the Google Cloud console, pick (or create) the project that has Business Profile API access.
2. Enable **My Business Account Management API**, **My Business Business Information API**, **Google My Business API**, and (only for email polling) **Gmail API**.
3. Create an OAuth client, type **Desktop app** (simplest). A Web application client works too if its authorised redirect URIs include http://127.0.0.1:54321/oauth/callback. Copy the client ID and secret.
4. In Paperclip, open the company, then **Google connection**. Give the account a short name, paste the ID and secret, and press **Connect to Google**.
5. Grant every permission Google asks for. STOP if it reports a missing permission: nothing is saved, and the plugin cannot work without permission to manage business listings.
6. Under **Choose which locations to watch**, pick the listing group and then the location. This fills in the account id and location id for you.
7. Turn on **Allow posting review replies** in the plugin settings when you want replies to publish. Until then replies are drafted but never posted.

## Why the setup page rather than a script

The two things that go wrong here are invisible in the settings:

- A refresh token granted for a different Google product authenticates perfectly and can read nothing. The page asks Google what the token can actually do and says so.
- The Google account id and the location id are different numbers that look alike. Typed in by hand, the same number often ends up in both fields and every call fails. Picking the location from a list fills in both.

The credentials are stored as this plugin's own secrets, so connecting a different Google plugin cannot overwrite them.

## What it does

- **Daily sync** pulls every configured location's reviews and opens a task for each new unreplied one.
- **Email polling** (optional) watches for Google's review notification emails so a review is noticed within minutes rather than at the next daily sync.
- **Weekly digest** summarises each location's week.
- **Reviews page** lists reviews per location and posts approved replies back to Google.

## Permissions asked for

- The business.manage scope reads reviews and posts replies. Required.
- The gmail.readonly scope reads review notification emails. Optional, and read-only: the plugin cannot change anything in the mailbox, so notification emails stay marked unread.

## If something is wrong

The Google connection page names the fault and who has to fix it. The common ones:

- **Permission missing from the token**: reconnect the account and leave every permission ticked.
- **API not enabled**: enable the named API in the Google Cloud project, then press Check again.
- **Quota refused**: a Business Profile quota of zero means Google has not approved API access for that project yet. That is an access request to Google, not a setting.
- **Google no longer accepts the refresh token**: it was revoked or expired. Reconnect the account.
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
    // Each review's task is a subtask under one parent task per location,
    // and it is closed by the plugin when the review gets its reply, so the
    // plugin reads and updates the tasks it created.
    "issues.read",
    "issues.update",
    // The Reviews page can ask one of the company's own agents to write a
    // reply. It runs on that agent's existing adapter, so there is no
    // second credential to configure and the run is counted like any other.
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "plugin.state.read",
    "plugin.state.write",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "ui.page.register",
    "ui.dashboardWidget.register",
    // Declared because of the Reply tab on a task. The host validates this
    // against the slots: a detailTab slot without it fails the install.
    "ui.detailTab.register",
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
      aiReplies: {
        type: "object",
        title: "AI-written replies",
        description: "Lets the Reviews page ask one of this company's agents to write a reply for a review. It runs on that agent's own adapter, so there is no API key to configure here. Nothing is ever posted without a person reading it first.",
        properties: {
          enabled: {
            type: "boolean",
            title: "Let an agent write replies",
            description: "Off by default, because each press spends one agent run.",
            default: false,
          },
          agentId: {
            type: "string",
            title: "Which agent writes them",
            description: "Optional. Leave empty and the plugin picks one: an agent whose name mentions reviews, else a general-purpose agent, else the assistant, else the CEO. Paused and terminated agents are skipped.",
          },
          instructions: {
            type: "string",
            title: "Instructions for the writer",
            description: "Optional. Tone, how to sign off, things never to say. For example: 'Sign as The team. Mention we are open Saturdays if it fits.'",
          },
        },
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
      description: "List reviews for a configured location (Google Business Profile). Returns reviewer name, star rating, review text, and reply status. Reviews a person chose not to reply to are left out of the unreplied list and must not be replied to.",
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
      description: "Post a reply to a review (Google Business Profile). Requires reply posting to be enabled in plugin settings. Refused for a review a person chose not to reply to. When the company asks before public posts, the reply waits as an approval, which a person can approve from the approvals list or from the review itself on the Reviews page.",
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
      {
        // Shown as a tab on a task. Review tasks get the reply box itself;
        // every other task gets one line saying the tab is not for it,
        // because the host filters tabs by entity type, not by what opened
        // the task.
        type: "detailTab",
        id: "review-reply-tab",
        displayName: "Reply",
        exportName: "ReviewReplyTab",
        entityTypes: ["issue"],
      },
      {
        type: "page",
        id: "review-google-setup",
        displayName: "Review Tools: Google connection",
        exportName: "GoogleSetupPage",
        routePath: "reviews-setup",
      },
    ],
  },
};

export default manifest;
