import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { ALL_TOOLS } from "./schemas.js";

const PLUGIN_ID = "google-workspace";
const PLUGIN_VERSION = "0.2.0";
const SETUP_ROUTE = "setup-account";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Google Workspace",
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
                "Human-readable label shown in this settings form (e.g. 'Barry personal', 'M3 Printing shared inbox'). Free-form, you can rename without breaking anything.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass as the `account` parameter (e.g. 'barry-personal', 'm3-printing'). Lowercase, no spaces. Once skills reference it, don't change it. Must be unique across accounts.",
            },
            userEmail: {
              type: "string",
              title: "Email this account authenticates as",
              description:
                "Informational — the Google email this account belongs to (e.g. 'barry@example.com'). Helps you keep track of which OAuth grant is which.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to use this Google account. Tick 'Portfolio-wide' to allow every company; otherwise tick the specific companies. Empty = unusable (fail-safe deny). Critical: a personal Google account should typically only be allowed for the Personal company; a shared M3 Printing inbox should be restricted to that LLC.",
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
