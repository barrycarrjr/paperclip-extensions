import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "revenuecat-tools";
const PLUGIN_VERSION = "0.2.11";

const projectItemSchema = {
  type: "object",
  required: ["key", "apiKeyRef", "allowedCompanies"],
  propertyOrder: ["key", "displayName", "apiKeyRef", "projectId", "allowedCompanies"],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling RevenueCat tools (e.g. 'demo-app'). Lowercase, no spaces. Must be unique across projects.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description: "Human-readable label (e.g. 'Demo iOS App'). Free-form.",
    },
    apiKeyRef: {
      type: "string",
      format: "secret-ref",
      title: "Project secret API key",
      description:
        "Paste the UUID of the secret holding this RevenueCat project's secret API key (NOT a public SDK key — this is the server-side secret key). Get it: app.revenuecat.com → Project Settings → API keys → Secret API keys → 'New' (read-write scope by default; this plugin gates writes via allowMutations regardless). Create the paperclip secret first; never paste the raw key here.",
    },
    projectId: {
      type: "string",
      title: "RevenueCat project ID",
      description:
        "Project ID used by RevenueCat's v2 API endpoints. Find it in app.revenuecat.com → Project Settings, displayed near the project name. Required for the metrics-snapshot tool which uses v2 listings.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may call RevenueCat tools against this project. Each RevenueCat project usually corresponds to one mobile app — scope to the LLC that owns it. Empty = unusable.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — RevenueCat Tools

Connect a RevenueCat project so agents can look up subscribers, check entitlements, and pull metrics. Reckon on **about 5 minutes** per project.

---

## 1. Get a RevenueCat secret API key

- Log into [app.revenuecat.com](https://app.revenuecat.com)
- Select the project for your app
- Go to **Project Settings → API Keys → Secret API keys**
- Click **+ New** (or use an existing secret key if you have one)
- **Copy the key** — it starts with \`sk_...\`

> Use the **secret** key (server-side), not the public SDK key (\`pk_...\`). Public keys can only be used by your app's client SDK; they can't access subscriber data server-side.

---

## 2. Find your RevenueCat project ID

Still in **Project Settings** — the Project ID is displayed near the project name (a short UUID-like string). Copy it; you'll need it for the metrics snapshot tool.

---

## 3. Create a Paperclip secret

In Paperclip, switch to the company that owns the app.

- Go to **Secrets → Add**
- Name it (e.g. \`revenuecat-secret-key\`)
- Paste the \`sk_...\` key as the value
- Save, then **copy the secret's UUID**

---

## 4. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above. Under **RevenueCat projects**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`demo-app\` |
| **Display name** | e.g. "Demo iOS App" |
| **Project secret API key** | UUID of the secret from step 3 |
| **RevenueCat project ID** | the Project ID from step 2 |
| **Allowed companies** | tick the company that owns this app |

Set **Default project key** at the top.

---

## Troubleshooting

- **401 Unauthorized** — you may have used the public SDK key (\`pk_...\`) instead of the secret key. Get the server-side \`sk_...\` key.
- **Subscriber not found** — the \`appUserId\` must match exactly what your app sets via the RevenueCat SDK. It's often an opaque internal ID, not the user's email.
- **Metrics snapshot is approximate** — \`revenuecat_get_metrics_snapshot\` derives MRR from a paginated listing of active subscriptions, not from RevenueCat's native analytics. For exact figures use the RevenueCat dashboard or BigQuery export.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "RevenueCat Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Read RevenueCat subscriber and entitlement data, set custom attributes, and pull metrics snapshots. Multi-project, per-project allowedCompanies, mutations gated.",
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
    propertyOrder: ["allowMutations", "defaultProject", "projects"],
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow set-attribute / delete-subscriber",
        description:
          "Master switch for revenuecat_set_subscriber_attribute and revenuecat_delete_subscriber. Set false (default) to keep the plugin in read-only mode — mutations return [EDISABLED]. Read tools are unaffected.",
        default: false,
      },
      defaultProject: {
        type: "string",
        title: "Default project key",
        "x-paperclip-optionsFromSibling": {
          sibling: "projects",
          valueKey: "key",
          labelKey: "displayName",
        },
        description:
          "Identifier of the project used when an agent omits the `project` parameter. Strict: if the calling company isn't in the default project's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED]. Leave blank to require explicit `project`.",
      },
      projects: {
        type: "array",
        title: "RevenueCat projects",
        description:
          "One entry per RevenueCat project this plugin can talk to. A project = one app's subscriber data.",
        items: projectItemSchema,
      },
    },
  },
  tools: [
    {
      name: "revenuecat_get_subscriber",
      displayName: "Get RevenueCat subscriber",
      description:
        "Retrieve a subscriber by app_user_id. Returns entitlements, subscriptions, custom attributes, original_app_user_id.",
      parametersSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project identifier. Optional — falls back to defaultProject.",
          },
          appUserId: {
            type: "string",
            description:
              "App user ID as set by your app's RevenueCat client (e.g. an internal user UUID, or a Supabase user id). NOT the email; RevenueCat's primary key is opaque.",
          },
        },
        required: ["appUserId"],
      },
    },
    {
      name: "revenuecat_list_subscribers",
      displayName: "List RevenueCat subscribers",
      description:
        "Paginated list of subscribers for the project. Useful for batch operations or building snapshots.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          limit: { type: "number", description: "Page size, default 100, max 1000." },
          startingAfter: { type: "string", description: "Pagination cursor (last app_user_id seen)." },
          lastSeenAfter: {
            type: "string",
            description: "ISO 8601 — only subscribers with last_seen >= this timestamp.",
          },
        },
      },
    },
    {
      name: "revenuecat_get_subscriber_attributes",
      displayName: "Get RevenueCat subscriber attributes",
      description:
        "Return custom attributes (display name, email, signup_source, etc.) and their last-updated timestamps.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          appUserId: { type: "string" },
        },
        required: ["appUserId"],
      },
    },
    {
      name: "revenuecat_set_subscriber_attribute",
      displayName: "Set RevenueCat subscriber attributes",
      description:
        "Set one or more custom attributes on a subscriber. Mutation, gated. Useful for marking lifecycle stages or running A/B test assignments.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          appUserId: { type: "string" },
          attributes: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "key → value pairs. Use empty string to delete an attribute (RevenueCat semantics).",
          },
        },
        required: ["appUserId", "attributes"],
      },
    },
    {
      name: "revenuecat_delete_subscriber",
      displayName: "Delete RevenueCat subscriber",
      description:
        "Permanently delete a subscriber and all their data on RevenueCat. RARE — typically only used in tests. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          appUserId: { type: "string" },
        },
        required: ["appUserId"],
      },
    },
    {
      name: "revenuecat_get_metrics_snapshot",
      displayName: "Get RevenueCat metrics snapshot",
      description:
        "Aggregate counts: active subscribers, approximate MRR, new subs in window, churn in window, churn rate. Cached for 5 min per (project, windowDays). APPROXIMATE — derived from paginated listings; for exact MRR use the RevenueCat dashboard or BigQuery export.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          windowDays: { type: "number", description: "Look-back window. Default 30." },
        },
      },
    },
  ],
};

export default manifest;
