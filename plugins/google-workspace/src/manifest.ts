import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { ALL_TOOLS } from "./schemas.js";

const PLUGIN_ID = "google-workspace";
const PLUGIN_VERSION = "0.3.5";
const SETUP_ROUTE = "setup-account";

const SETUP_INSTRUCTIONS = `# Setup — Google Workspace

Connect a Google account so agents can read and write Calendar events, Tasks, Sheets, and Drive files. Each Google account goes through a one-time OAuth consent flow. Reckon on **about 20 minutes** for first-time setup (most of that is GCP).

---

## Quickstart — use the built-in setup wizard

This plugin ships a setup wizard that walks you through the entire flow in the browser. **No terminal required.** Click the **Connect a Google account** tab at the top of this page to launch it.

The wizard will guide you through:
1. Creating a GCP project and enabling the required APIs
2. Configuring the OAuth consent screen
3. Creating OAuth credentials (client ID + secret)
4. Running the device-code consent flow in your browser
5. Storing all three secrets (client ID, client secret, refresh token) and registering the account

If the wizard isn't available, follow the manual steps below.

---

## Manual setup

### 1. Create a GCP project (skip if you have one)

- Go to [https://console.cloud.google.com](https://console.cloud.google.com) → New Project
- Name it "Paperclip" or similar

### 2. Enable the required APIs

In the GCP project, go to **APIs & Services → Library** and enable:

| API | Required for |
|---|---|
| Google Calendar API | \`gcal_*\` tools |
| Tasks API | \`gtasks_*\` tools |
| Google Sheets API | \`gsheet_*\` tools |
| Google Drive API | \`gdrive_*\` tools |
| People API | \`gcontacts_*\` tools (if used) |

### 3. Configure the OAuth consent screen

Go to **APIs & Services → OAuth consent screen**:
- **User type**: Internal (if using a Google Workspace org) or External
- Fill in App name, User support email, Developer contact
- Add scopes: Calendar, Tasks, Sheets, Drive, and userinfo.email / userinfo.profile
- Add yourself as a test user if External

### 4. Create OAuth 2.0 credentials

Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
- **Application type**: Desktop app
- **Name**: "Paperclip"
- Click **Create** → **Download JSON** (or copy the Client ID and Client Secret)

### 5. Create Paperclip secrets for client ID and client secret

In Paperclip, switch to the company that should own this Google account:
- Go to **Secrets → Add** and create:
  1. \`google-client-id\` → the OAuth client ID
  2. \`google-client-secret\` → the OAuth client secret
- Copy both secret UUIDs

### 6. Get a refresh token

From the \`paperclip-extensions\` repo:

\`\`\`bash
pnpm --filter paperclip-plugin-google-workspace grant <account-key>
\`\`\`

The script opens a browser for OAuth consent, then prints the refresh token. Create a third Paperclip secret with that token value and copy its UUID.

### 7. Configure the plugin (this page, **Configuration** tab)

Under **Google accounts**, click **+ Add item**:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`personal\` |
| **Email** | the Google email you consented as |
| **OAuth client ID** | UUID of the \`google-client-id\` secret |
| **OAuth client secret** | UUID of the \`google-client-secret\` secret |
| **Refresh token** | UUID of the refresh-token secret |
| **Allowed companies** | tick the companies whose agents may use this account |

---

## Troubleshooting

- **\`invalid_grant\`** — the refresh token expired or was revoked (Google revokes tokens for External apps after 7 days if the consent screen isn't verified). Re-run the \`grant\` script or re-run the wizard.
- **\`access_denied\` during consent** — you're not listed as a test user on an External consent screen. Add yourself under OAuth consent screen → Test users.
- **API not enabled error** — the specific API (e.g. Tasks API) wasn't enabled in step 2. Enable it and wait ~30 seconds.
- **One account per Google email** — you can't have two plugin accounts for the same Google email. Create a second GCP OAuth client if you need separate client credentials per company.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Google Workspace",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Calendar, Tasks, Sheets, and Drive operations as agent tools. One OAuth flow per Google account; multi-account; per-company isolation via allowedCompanies. Setup wizard at /<company>/plugins/google-workspace/setup-account walks you through adding an account end-to-end (creates secrets, runs the OAuth device flow, registers the account) — no terminal required.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow create/update/delete tools",
        description:
          "Master switch for mutation tools (gcal_create_event, gtasks_create_task, gsheet_append, gdrive_upload_file, etc.). Read-only tools always work; mutations are blocked until you flip this on. Default: off, so a fresh install is read-only.",
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
          "Identifier of the account agents fall back to when they don't specify one. Optional — if blank, agents must always pass an `account` parameter.",
      },
      accounts: {
        type: "array",
        title: "Google accounts",
        description:
          "One entry per Google account this plugin can act as. Each account holds the OAuth client credentials and a refresh token, with per-company access control. To create an account: run `pnpm --filter paperclip-plugin-google-workspace grant <account-key>` from the plugins repo, paste the printed refresh token into a new Secret on the company's Secrets page, then fill in the secret UUIDs below.",
        items: {
          type: "object",
          required: [
            "key",
            "clientIdRef",
            "clientSecretRef",
            "refreshTokenRef",
            "allowedCompanies",
          ],
          properties: {
            displayName: {
              type: "string",
              title: "Display name",
              description:
                "Human-readable label shown in this settings form (e.g. 'Personal account', 'Acme Print shared inbox'). Free-form, you can rename without breaking anything.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass as the `account` parameter (e.g. 'personal', 'acme-print'). Lowercase, no spaces. Once skills reference it, don't change it. Must be unique across accounts.",
            },
            userEmail: {
              type: "string",
              title: "Email this account authenticates as",
              description:
                "Informational — the Google email this account belongs to (e.g. 'you@example.com'). Helps you keep track of which OAuth grant is which.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to use this Google account. Tick 'Portfolio-wide' to allow every company; otherwise tick the specific companies. Empty = unusable (fail-safe deny). Critical: a personal Google account should typically only be allowed for the Personal company; a shared business inbox should be restricted to that LLC.",
            },
            clientIdRef: {
              type: "string",
              format: "secret-ref",
              title: "OAuth client ID (secret UUID)",
              description:
                "Paste the UUID of the secret holding this account's Google OAuth client ID. Get the client ID from Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0 Client (Desktop app type). Then create a Secret on the company's Secrets page with that value, and paste the resulting UUID here.",
            },
            clientSecretRef: {
              type: "string",
              format: "secret-ref",
              title: "OAuth client secret (secret UUID)",
              description:
                "Paste the UUID of the secret holding this account's Google OAuth client secret. Found alongside the client ID in Google Cloud Console.",
            },
            refreshTokenRef: {
              type: "string",
              format: "secret-ref",
              title: "Refresh token (secret UUID)",
              description:
                "Paste the UUID of the secret holding this account's long-lived refresh token. Obtain by running `pnpm --filter paperclip-plugin-google-workspace grant <account-key>` from the plugins repo — it opens a browser for consent and prints the refresh token. Then create a Secret with that token's value and paste the resulting UUID here.",
            },
            scopes: {
              type: "array",
              items: { type: "string" },
              title: "OAuth scopes (advanced override)",
              description:
                "Optional. Defaults to: calendar, tasks, spreadsheets, drive (full), userinfo.email, userinfo.profile. Override only if you've reduced the consent screen to a narrower scope set. The refresh token must have been obtained with these exact scopes.",
            },
          },
        },
      },
    },
    required: ["accounts"],
  },
  tools: ALL_TOOLS,
  ui: {
    slots: [
      {
        type: "page",
        id: "setup-account",
        displayName: "Connect a Google account",
        exportName: "SetupAccountPage",
        routePath: SETUP_ROUTE,
      },
    ],
  },
};

export default manifest;
