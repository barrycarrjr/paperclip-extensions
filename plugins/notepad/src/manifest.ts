import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "notepad";
const PLUGIN_VERSION = "0.1.12";

const SETUP_INSTRUCTIONS = `# Setup — Notepad

The Notepad plugin is a self-contained per-company scratchpad. There's nothing
external to wire up — no API keys, no SIP trunks, no OAuth. Just enable the
plugin, allow-list the companies that should see it, and you're done.

Reckon on **about 2 minutes** for setup.

## 1. Allow a company to use the Notepad

In **Configuration → Allowed companies**, tick the company (or companies) that
should see the Notepad in their sidebar. Tick **Portfolio-wide** (\`['*']\`)
if you want every company to see it.

Each company's notes are isolated — there is no cross-company read. A note
created in company A is invisible to company B even if both are allow-listed.

## 2. (Optional) Pick a cleanup agent

When an operator clicks **Convert to issue** on a note, the plugin opens a
one-shot session with the company's chat-agent (Clippy) so it can extract a
clean title and tighten the body before creating the issue.

Auto-pick is fine for most setups: leave **Cleanup agent (optional)** blank and
the plugin uses the company's first \`assistant\`-role agent.

Override only if:
- You have multiple chat-style agents in the company and want a specific one
  to handle conversions.
- You want to pin a particular agent for cost / model-mix reasons.

## 3. (Optional) Toggle AI cleanup

**Use AI cleanup on convert** is on by default. Turn it off if you want
strictly raw-text issue creation (first line → title, rest → body) with no
LLM call. The plugin always degrades gracefully — if no chat-agent exists, or
the session errors, or the response can't be parsed as JSON — the convert
still produces an issue from the raw note text.

## 4. (Optional) Hide the sidebar entry

**Show in sidebar** is on by default. Turn it off if you want the page
reachable at \`/:companyPrefix/notepad\` but no nav link. Useful for staged
rollout or for companies that prefer accessible-but-hidden.

---

## Smoke test

After saving the configuration:

1. Switch to one of the allow-listed companies.
2. Click **Notepad** in the sidebar (or visit \`/:companyPrefix/notepad\`).
3. Click **+ New note**, type a brain-dump, watch it auto-save.
4. Click **Convert to issue**. The modal should show the cleaned title + body
   from Clippy and a link to the new issue.

If step 4 produces an issue with raw text and a "AI cleanup failed" warning,
the cleanup agent dispatch fell back. Check the agent's session history and
the plugin's logs to see why.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Notepad",
  description:
    "Per-company freeform notepad mounted in the company sidebar. Operators jot ideas, meeting notes, and half-formed asks; a 'Convert to issue' action runs the note through the company's chat-agent (Clippy) for an AI cleanup pass and creates a real issue. Notes are plugin-owned, isolated per company, and kept after conversion so the audit trail survives.",
  author: "Barry Carr & Tony Allard",
  categories: ["ui", "automation"],
  setupInstructions: SETUP_INSTRUCTIONS,
  capabilities: [
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
    "api.routes.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "companies.read",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.send",
    "agent.sessions.close",
    "issues.create",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  database: {
    namespaceSlug: "notepad",
    migrationsDir: "migrations",
    coreReadTables: ["issues"],
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: [
      "allowedCompanies",
      "convertWithCleanup",
      "cleanupAgentId",
      "showInSidebar",
    ],
    properties: {
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description:
          "Which Paperclip companies see the Notepad in their sidebar and can read/write notes. Tick 'Portfolio-wide' for ['*']; otherwise tick specific companies. Each company's notes are isolated — no cross-company reads. Empty = unusable (fail-safe deny).",
        items: { type: "string", format: "company-id" },
      },
      convertWithCleanup: {
        type: "boolean",
        default: true,
        title: "Use AI cleanup on convert",
        description:
          "When true (default), 'Convert to issue' opens a session with the company's chat agent (Clippy) to extract a title and clean the body before creating the issue. When false, the issue is created with the note's first line as title and the rest as body — no agent call. The convert always falls back to raw text if the cleanup fails (no agent / session error / unparseable response), so this toggle is for explicit cost/control rather than reliability.",
      },
      cleanupAgentId: {
        type: "string",
        format: "agent-id",
        title: "Cleanup agent (optional)",
        description:
          "Which agent runs the convert-to-issue cleanup. Leave blank to auto-pick the company's chat-agent (the first agent with role='assistant'). Override only if you have multiple chat-style agents and want a specific one to handle conversions.",
      },
      showInSidebar: {
        type: "boolean",
        default: true,
        title: "Show in sidebar",
        description:
          "Whether the Notepad entry appears in the per-company sidebar. Off = the page is still reachable at /:companyPrefix/notepad but no nav link. Useful for staged rollout or for companies that prefer accessible-but-hidden.",
      },
    },
    required: ["allowedCompanies"],
  },
  apiRoutes: [
    {
      routeKey: "notes.list",
      method: "GET",
      path: "/notes",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "notes.create",
      method: "POST",
      path: "/notes",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "notes.get",
      method: "GET",
      path: "/notes/:noteId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "notes.update",
      method: "PATCH",
      path: "/notes/:noteId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "notes.delete",
      method: "DELETE",
      path: "/notes/:noteId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "notes.convert",
      method: "POST",
      path: "/notes/:noteId/convert-to-issue",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "notepad-sidebar",
        displayName: "Notepad",
        exportName: "NotepadSidebarItem",
      },
      {
        type: "page",
        id: "notepad-page",
        displayName: "Notepad",
        exportName: "NotepadPage",
        routePath: "notepad",
      },
    ],
  },
};

export default manifest;
