import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const SETUP_INSTRUCTIONS = `# Set up Agent roster

1. Open Configuration and select the companies allowed to use Agent roster. An empty list denies every company.
2. Open **Agent roster** in an allowed company's sidebar, or visit \`/:companyPrefix/agent-roster\`.
3. Review the agents marked Idle or Low use first. Each row shows the agent's last run, run counts, last 30 days' cost and open issues.
4. For each flagged agent, choose one: **Pause** it (instance admins only, reversible from the agent page), open the agent page to terminate it, or **Keep** it with a note if it is idle on purpose, such as a seasonal agent.

Agent roster never terminates or pauses an agent by itself.`;

const manifest: PaperclipPluginManifestV1 = {
  id: "agent-roster",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Agent roster",
  description: "Shows which agents in a company are idle or barely used and what each one costs, so the board can pause, remove or knowingly keep them.",
  author: "Bryon Stout",
  categories: ["ui"],
  setupInstructions: SETUP_INSTRUCTIONS,
  capabilities: [
    "instance.settings.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "agents.pause",
    "activity.log.write",
    "ui.sidebar.register",
    "ui.page.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui/" },
  database: {
    namespaceSlug: "roster",
    migrationsDir: "migrations",
    coreReadTables: ["agents", "heartbeat_runs", "cost_events", "issues"],
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["allowedCompanies"],
    properties: {
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description: "Companies whose agent roster may be shown. Empty or missing denies access. Each company only ever sees its own agents.",
        default: [],
        items: { type: "string", format: "company-id" },
      },
    },
    required: ["allowedCompanies"],
  },
  ui: {
    slots: [
      { type: "sidebar", id: "roster-sidebar", displayName: "Agent roster", exportName: "RosterSidebarItem" },
      { type: "page", id: "roster-page", displayName: "Agent roster", exportName: "RosterPage", routePath: "agent-roster" },
      { type: "dashboardWidget", id: "roster-widget", displayName: "Idle agents", exportName: "RosterWidget" },
    ],
  },
};

export default manifest;
