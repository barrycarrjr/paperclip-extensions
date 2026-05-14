import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "rollbar-tools";
const PLUGIN_VERSION = "0.2.13";

const projectItemSchema = {
  type: "object",
  required: ["key", "readTokenRef", "allowedCompanies"],
  propertyOrder: [
    "key",
    "displayName",
    "readTokenRef",
    "writeTokenRef",
    "environment",
    "allowedCompanies",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling Rollbar tools (e.g. 'acme-print-prod', 'demo-app-prod'). Lowercase, no spaces. Must be unique across projects. Don't change after skills reference it.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description:
        "Human-readable label shown in this settings form (e.g. 'Acme Print — Production'). Free-form.",
    },
    readTokenRef: {
      type: "string",
      format: "secret-ref",
      title: "Read token (Project Access Token, scope=read)",
      description:
        "Paste the UUID of the secret holding this Rollbar project's READ Project Access Token. Create the secret first on the company's Secrets page; never paste the raw token here. Get the token: rollbar.com → Project → Project Access Tokens → 'Create New Access Token' with scope `read`.",
    },
    writeTokenRef: {
      type: "string",
      format: "secret-ref",
      title: "Write token (scope=write, optional)",
      description:
        "Paste the UUID of the secret for a separate WRITE token (scope `write`). Required only if you'll enable allowMutations to let agents resolve/mute items. Keep blank to make mutations physically impossible.",
    },
    environment: {
      type: "string",
      title: "Default environment filter (optional)",
      description:
        "When set, every list/snapshot tool defaults to this environment unless the agent overrides. Common values: 'production', 'staging'. Helps when one project tracks multiple envs.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may call Rollbar tools against this project. Tick 'Portfolio-wide' to allow every company; otherwise tick specific companies. Empty = unusable. Each Rollbar project should typically be scoped to the LLC that owns the application it monitors.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — Rollbar Tools

Connect a Rollbar project so agents can surface error items, occurrences, and metrics. Reckon on **about 5 minutes** per project.

---

## 1. Create Rollbar Project Access Tokens

Each Rollbar *project* has its own set of tokens — find them at **Project Settings → Project Access Tokens** (not Account Access Tokens).

You need a **read** token. If you'll let agents resolve or mute items, also create a **write** token.

- In the Rollbar dashboard, go to your project
- Go to **Settings → Project Access Tokens → Create New Access Token**
- **Scope**: \`read\` — name it "Paperclip Read"
- Optionally repeat with scope \`write\` — name it "Paperclip Write"
- **Copy each token now**

---

## 2. Create Paperclip secrets

In Paperclip, switch to the company that owns the application this Rollbar project monitors.

- Go to **Secrets → Add** and create:
  - \`rollbar-read-token\` → the read token
  - \`rollbar-write-token\` → the write token (optional)
- Copy both secret UUIDs

---

## 3. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above. Under **Rollbar projects**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`acme-print-prod\` |
| **Display name** | e.g. "Acme Print — Production" |
| **Read token** | UUID of the \`rollbar-read-token\` secret |
| **Write token** | UUID of the \`rollbar-write-token\` secret (leave blank if no mutations) |
| **Default environment** | e.g. \`production\` (optional; agents can override per call) |
| **Allowed companies** | tick the company that owns this application |

Set **Default project key** to your project's identifier at the top.

---

## 4. Enable mutations when ready (optional)

**Allow resolve / mute** defaults to OFF. Even when ON, mutations also require a write token on the project — so leaving the write token blank physically prevents mutations even if the master switch is on.

---

## Troubleshooting

- **401 on read** — the read token is wrong. Copy it directly from the Rollbar dashboard.
- **403 on mutations** — the write token is missing or the master switch is OFF.
- **Empty results from \`rollbar_list_items\`** — the default environment filter on the project might not match actual environments. Run with an explicit \`environment\` override or clear the default.
- **Adding a second project** — each Rollbar project needs a separate entry in the Projects list, even if they're in the same Rollbar account. Tokens are project-scoped, not account-scoped.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Rollbar Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Read items, occurrences, and metrics from Rollbar, plus optional resolve/mute mutations. Multi-project, per-project allowedCompanies, separate read+write tokens.",
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
    propertyOrder: ["allowMutations", "defaultProject", "projects"],
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow resolve / mute",
        description:
          "Master switch for rollbar_resolve_item and rollbar_mute_item. Set false (default) to keep the plugin in read-only mode — mutations return [EDISABLED]. Read tools are unaffected. Even with this on, mutations also require a writeTokenRef on the project.",
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
          "Identifier of the project used when an agent omits the `project` parameter. Strict: if the calling company isn't in the default project's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no fallback). Leave blank to require explicit `project`.",
      },
      projects: {
        type: "array",
        title: "Rollbar projects",
        description:
          "One entry per Rollbar project this plugin can talk to. Each Rollbar project = one application's error stream.",
        items: projectItemSchema,
      },
    },
  },
  tools: [
    {
      name: "rollbar_list_items",
      displayName: "List Rollbar items",
      description:
        "List error items (groups). Filters: status / level / environment / framework / assignee / free-text query.",
      parametersSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "Project identifier as configured. Optional — falls back to defaultProject.",
          },
          status: {
            type: "string",
            enum: ["active", "resolved", "muted", "archived"],
          },
          level: {
            type: "string",
            enum: ["critical", "error", "warning", "info", "debug"],
          },
          environment: {
            type: "string",
            description: "Environment filter (e.g. 'production'). Defaults to project.environment.",
          },
          framework: { type: "string", description: "e.g. 'rails', 'node', 'django'." },
          assignedUserId: { type: "number", description: "Rollbar user ID." },
          query: { type: "string", description: "Free-text search across title + body." },
          page: { type: "number" },
          perPage: { type: "number", description: "Default 25, max 100." },
        },
      },
    },
    {
      name: "rollbar_get_item",
      displayName: "Get Rollbar item",
      description: "Retrieve a single item by ID OR counter (Rollbar's per-project sequential ID).",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          itemId: { type: "number", description: "Global item ID. Mutually exclusive with counter." },
          counter: {
            type: "number",
            description: "Per-project sequential counter (e.g. '#487' from the Rollbar UI).",
          },
        },
      },
    },
    {
      name: "rollbar_list_occurrences",
      displayName: "List Rollbar occurrences for an item",
      description:
        "List individual occurrences of one item. Useful for sampling stack traces / requests.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          itemId: { type: "number" },
          page: { type: "number" },
          perPage: { type: "number", description: "Default 25, max 100." },
        },
        required: ["itemId"],
      },
    },
    {
      name: "rollbar_get_occurrence",
      displayName: "Get Rollbar occurrence",
      description: "Retrieve one occurrence with its full stack trace, request, person, custom data.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          occurrenceId: { type: "number" },
        },
        required: ["occurrenceId"],
      },
    },
    {
      name: "rollbar_get_top_items",
      displayName: "Get top Rollbar items",
      description:
        "Convenience: rank active items by total_occurrences over the last `since` window. Default last 24h, top 10.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          since: {
            type: "string",
            description: "ISO 8601 lower bound on last_occurrence_timestamp.",
          },
          limit: { type: "number", description: "Default 10, max 100." },
          levels: {
            type: "array",
            items: { type: "string" },
            description: "Filter to these levels (e.g. ['critical', 'error']).",
          },
        },
      },
    },
    {
      name: "rollbar_resolve_item",
      displayName: "Resolve Rollbar item",
      description:
        "Mark an item as resolved. Mutation, gated by allowMutations AND requires the project to have a writeTokenRef.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          itemId: { type: "number" },
          comment: {
            type: "string",
            description: "Optional comment recorded with the resolution.",
          },
        },
        required: ["itemId"],
      },
    },
    {
      name: "rollbar_mute_item",
      displayName: "Mute Rollbar item",
      description:
        "Mute an item until a date (or indefinitely). Doesn't resolve — silences notifications. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          itemId: { type: "number" },
          until: {
            type: "string",
            description: "ISO 8601 timestamp. Omit for indefinite mute.",
          },
        },
        required: ["itemId"],
      },
    },
    {
      name: "rollbar_get_metrics_snapshot",
      displayName: "Get Rollbar metrics snapshot",
      description:
        "Aggregate counts over the last `windowHours` (default 24): active items, new items in window, occurrences in window, critical item count. Cached for 5 min per (project, env, window).",
      parametersSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          environment: { type: "string", description: "Optional env filter." },
          windowHours: { type: "number", description: "Look-back window. Default 24." },
        },
      },
    },
  ],
};

export default manifest;
