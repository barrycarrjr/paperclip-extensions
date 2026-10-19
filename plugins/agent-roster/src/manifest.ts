import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "agent-roster", apiVersion: 1, version: "0.1.0",
  displayName: "Agent roster",
  description: "Review agent activity and costs for one company and confirm reversible pauses.",
  author: "Paperclip contributors", categories: ["ui"],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui/" },
  capabilities: ["instance.settings.register", "database.namespace.read", "database.namespace.migrate", "agents.read", "agents.pause", "activity.log.write", "api.routes.register", "ui.sidebar.register", "ui.page.register", "ui.dashboardWidget.register"],
  database: { namespaceSlug: "agent_roster", migrationsDir: "migrations", coreReadTables: ["agents", "heartbeat_runs", "cost_events", "issues", "companies"] },
  setupInstructions: "Select allowed companies in Configuration. Empty or missing configuration denies every company. Open Agent roster in a selected company to review activity and costs. Pause requires an explicit board confirmation and is reversible on the core agent page. No agent is automatically paused or terminated. Hand-off links use the selected company's board-authorized Hand-off API when available.",
  instanceConfigSchema: {
    type: "object", additionalProperties: false, required: ["allowedCompanies"],
    properties: { allowedCompanies: {
      type: "array", title: "Allowed companies", default: [],
      description: "Only these companies can use their own roster. Empty or missing denies access.",
      items: { type: "string", format: "company-id" },
    } },
  },
  apiRoutes: [
    { routeKey: "roster.list", method: "GET", path: "/roster", auth: "board", capability: "api.routes.register", companyResolution: { from: "query", key: "companyId" } },
    { routeKey: "roster.pause", method: "POST", path: "/agents/:agentId/pause", auth: "board", capability: "api.routes.register", requiredUserPermission: "agents:create", companyResolution: { from: "query", key: "companyId" } },
  ],
  ui: { slots: [
    { type: "sidebar", id: "roster-sidebar", displayName: "Agent roster", exportName: "AgentRosterSidebar" },
    { type: "page", id: "roster-page", displayName: "Agent roster", exportName: "AgentRosterPage", routePath: "agent-roster" },
    { type: "dashboardWidget", id: "roster-idle", displayName: "Idle agents", exportName: "AgentRosterWidget" },
  ] },
};
export default manifest;
