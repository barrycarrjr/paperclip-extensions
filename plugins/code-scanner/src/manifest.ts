import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "code-scanner";
const PLUGIN_VERSION = "0.2.13";

const repoItemSchema = {
  type: "object",
  required: ["key", "path", "allowedCompanies"],
  propertyOrder: ["key", "displayName", "path", "allowedCompanies"],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling scan tools (e.g. 'paperclip', 'paperclip-extensions'). Lowercase, no spaces. Must be unique. Don't change after skills reference it.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description: "Human-readable label shown in this settings form. Free-form.",
    },
    path: {
      type: "string",
      title: "Absolute repo path",
      description:
        "Absolute filesystem path to the git repo on the host. Example: 'C:\\path\\to\\repo' or '/path/to/repo'. The plugin shells out from here — must point at a real, readable git working tree.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may scan this repo. Tick 'Portfolio-wide' to allow every company; otherwise tick specific companies. Empty = unusable. For Steward, this is typically ['*'] since the whole point is portfolio-wide observation.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — Code Scanner

Give agents read-only visibility into local git repos — secret leaks, dead exports, stale TODOs, and cross-company agent health. No external credentials; everything runs on the Paperclip host machine. Reckon on **about 10 minutes** including binary installs.

---

## 1. Install gitleaks (for secret scanning)

\`gitleaks\` is a Go binary — download a release from [https://github.com/gitleaks/gitleaks/releases](https://github.com/gitleaks/gitleaks/releases).

**Windows (Paperclip host)**:
- Download \`gitleaks_<version>_windows_x64.zip\`
- Extract and place \`gitleaks.exe\` somewhere on the system PATH (e.g. \`C:\\Windows\\System32\\\`) or note the full path

**Linux/macOS (if running Paperclip there)**:
\`\`\`bash
# macOS
brew install gitleaks
# Linux
curl -sSfL https://raw.githubusercontent.com/zricethezav/gitleaks/master/scripts/install.sh | sh
\`\`\`

Verify: \`gitleaks version\` should print the version number.

If gitleaks isn't available, \`code_secret_scan\` returns \`[ESCANNER_GITLEAKS_MISSING]\` — other scan tools still work.

---

## 2. Install knip in target repos (for dead export scanning)

\`knip\` is a Node.js dev tool. In each repo you want to scan:

\`\`\`bash
pnpm add -D knip
# or npm install --save-dev knip
\`\`\`

Alternatively, \`npx knip\` (the default) works without installing if the host has Node.js and npx available.

Verify: \`npx knip --version\` in the repo directory.

---

## 3. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above and fill in:

**Repos to scan** — click **+ Add item** for each repo:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`paperclip\`, \`paperclip-extensions\` |
| **Display name** | e.g. "Paperclip core repo" |
| **Absolute repo path** | e.g. \`C:\\path\\to\\repo\` or \`/home/user/repo\` |
| **Allowed companies** | tick the companies whose agents may scan this repo (\`*\` for Steward) |

**Other settings**:

| Field | Default | Notes |
|---|---|---|
| **TODO age threshold** | 6 months | \`code_todo_age_scan\` only reports TODOs older than this |
| **gitleaks executable** | \`gitleaks\` (PATH) | Override with an absolute path if needed |
| **knip executable** | \`npx knip\` | Override if the repo uses a local install |

---

## Typical Steward configuration

For the portfolio-wide Steward agent, add both repos and set Allowed companies to \`*\` (portfolio-wide):

\`\`\`
Repos:
  - key: paperclip        path: C:\path\to\paperclip              allowed: *
  - key: extensions       path: C:\path\to\paperclip-extensions   allowed: *
\`\`\`

The \`agent_observability_query\` tool doesn't need repo access — it reads Paperclip's agent state directly and works immediately without any repo configuration.

---

## Troubleshooting

- **\`[ESCANNER_GITLEAKS_MISSING]\`** — gitleaks isn't on PATH. Either install it and ensure it's findable, or set **gitleaks executable** to the full path.
- **\`[ESCANNER_KNIP_MISSING]\`** — knip isn't installed in the repo and npx can't resolve it. Run \`pnpm add -D knip\` in the target repo.
- **Path not found** — the absolute path must point to an existing git working tree on the Paperclip host. Check for typos and use forward slashes or escaped backslashes.
- **Read permission denied** — the Paperclip server process must have read access to the repo directory.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Code Scanner",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Read-only code and agent-observability detectors. Wraps gitleaks (secret scan), knip (dead exports), git (aged TODOs, doc drift), and Paperclip's own agent state for portfolio-wide health checks. No mutations — every tool returns findings, never changes anything.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "telemetry.track",
    "agents.read",
    "companies.read",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["repos", "todoAgeMonths", "gitleaksBinary", "knipBinary"],
    properties: {
      repos: {
        type: "array",
        title: "Repos to scan",
        description:
          "One entry per git repo this plugin is allowed to scan. The scan tools take a `repoKey` (not a path) so the operator decides which paths are scannable; an agent can never aim a scan at an arbitrary directory. For Steward Phase 1: add the paperclip repo and the paperclip-extensions repo.",
        items: repoItemSchema,
      },
      todoAgeMonths: {
        type: "number",
        title: "TODO age threshold (months)",
        description:
          "code_todo_age_scan only reports TODO/FIXME/XXX comments older than this many months by `git blame` author date. Default 6.",
        default: 6,
      },
      gitleaksBinary: {
        type: "string",
        title: "gitleaks executable",
        description:
          "Path to the gitleaks binary. Default 'gitleaks' (PATH lookup). Install: https://github.com/gitleaks/gitleaks/releases — drop the binary on PATH or pin an absolute path here. The plugin returns [ESCANNER_GITLEAKS_MISSING] if it can't be invoked.",
        default: "gitleaks",
      },
      knipBinary: {
        type: "string",
        title: "knip executable",
        description:
          "Path to the knip executable. Default 'npx knip' (resolved via shell). Install in the target repo via 'pnpm add -D knip' or rely on npx. Return [ESCANNER_KNIP_MISSING] on failure.",
        default: "npx knip",
      },
    },
  },
  tools: [
    {
      name: "code_secret_scan",
      displayName: "Scan repo for secrets",
      description:
        "Run gitleaks against the working tree of a configured repo. Returns finding records with file, line, kind, and a stable fingerprint. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          repoKey: {
            type: "string",
            description: "Identifier of one of the repos in the plugin's settings.",
          },
          maxFindings: {
            type: "number",
            description: "Cap on findings returned. Default 200.",
          },
        },
        required: ["repoKey"],
      },
    },
    {
      name: "code_dead_export_scan",
      displayName: "Scan repo for dead exports",
      description:
        "Run knip against a configured repo and return unreferenced exports. TypeScript / JavaScript only. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          repoKey: { type: "string" },
          maxFindings: { type: "number", description: "Default 200." },
        },
        required: ["repoKey"],
      },
    },
    {
      name: "code_todo_age_scan",
      displayName: "Scan repo for aged TODO/FIXME/XXX",
      description:
        "Find every TODO|FIXME|XXX comment in tracked files via `git grep`, then `git blame` each occurrence to compute its age. Returns entries older than `todoAgeMonths`. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          repoKey: { type: "string" },
          minAgeMonths: {
            type: "number",
            description:
              "Override the per-instance todoAgeMonths. Useful for digest skills that want to surface really stale items only.",
          },
          maxFindings: { type: "number", description: "Default 100." },
        },
        required: ["repoKey"],
      },
    },
    {
      name: "code_doc_drift_scan",
      displayName: "Scan README/AGENTS.md for code-style claims that don't match the code",
      description:
        "Read README.md and AGENTS.md in the repo, extract code-style references (function names like `foo()`, env vars like `FOO_BAR`, file paths like `src/foo.ts`), and `git grep` for each. Findings are claims that grep can't find. Crude, but catches the obvious doc drift. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          repoKey: { type: "string" },
          maxFindings: { type: "number", description: "Default 50." },
        },
        required: ["repoKey"],
      },
    },
    {
      name: "agent_observability_query",
      displayName: "Query cross-company agent observability",
      description:
        "Surface portfolio-wide agent health findings: paused agents, agents with stale lastHeartbeatAt, agents in error state. Uses ctx.companies.list + ctx.agents.list — works for any agent in HQ thanks to the cross-company read bypass. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          staleHoursThreshold: {
            type: "number",
            description:
              "Agents whose lastHeartbeatAt is older than this many hours are flagged. Default 24.",
          },
          includeIdleStatuses: {
            type: "boolean",
            description:
              "If true, idle agents are reported alongside paused/error. Default false (idle is normal).",
          },
        },
      },
    },
    {
      name: "org_structural_scan",
      displayName: "Scan portfolio for structural-org problems",
      description:
        "Cross-company organisational drift detector. Finds agents with no manager (and a non-CEO role) and agents idle past a configurable threshold. Each finding carries a stable fingerprint that pairs with Steward's `originKind=\"steward_finding\"` + `originFingerprint` dedupe. Read-only.",
      parametersSchema: {
        type: "object",
        properties: {
          kinds: {
            type: "array",
            items: {
              type: "string",
              enum: ["orphan_no_manager", "idle_agent"],
            },
            description:
              "Subset of detector kinds to run. Omit to run every detector.",
          },
          newAgentGraceDays: {
            type: "number",
            description:
              "Agents younger than this many days are exempt from flagging. Default 7.",
          },
          idleAgentDays: {
            type: "number",
            description:
              "An agent with no heartbeat in this many days is flagged as idle. Default 30.",
          },
          rootRoles: {
            type: "array",
            items: { type: "string" },
            description:
              "Roles that legitimately have no manager (CEO, etc.). Default ['ceo'].",
          },
        },
      },
    },
  ],
};

export default manifest;
