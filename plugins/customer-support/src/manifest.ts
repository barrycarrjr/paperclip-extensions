import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { interactiveTools } from "./interactive-tools.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "customer-support",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Support Desk",
  description: "Company-scoped support cases for customer, employee, and operational requests.",
  author: "Paperclip Extensions contributors",
  categories: ["ui", "automation"],
  capabilities: [
    "instance.settings.register",
    "api.routes.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "ui.sidebar.register",
    "ui.page.register",
    "activity.log.write",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "secrets.read-ref",
    "http.outbound",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "agent.tools.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui/" },
  database: { namespaceSlug: "customer_support", migrationsDir: "migrations" },
  tools: [...interactiveTools, {
    name: "support_propose_repair",
    displayName: "Propose support repair",
    description: "Propose an exact PowerShell repair and verification for an already reviewed IT or equipment case. This only creates a proposal; a board user must approve and start execution. Never place credentials or untrusted requester text into scripts.",
    writes: true,
    parametersSchema: {
      type: "object", additionalProperties: false,
      properties: {
        caseId: { type: "string" },
        expectedReviewVersion: { type: "integer" },
        script: { type: "string" },
        verificationScript: { type: "string" },
        expectedEffect: { type: "string" },
        recoveryNotes: { type: "string" },
      },
      required: ["caseId", "expectedReviewVersion", "script", "verificationScript", "expectedEffect", "recoveryNotes"],
    },
  }],
  setupInstructions: `## Set up Windows support

1. Select the company in Paperclip and open **Support**.
2. Under **Connect Windows support**, enter the Windows account and the trusted DNS domain or office IPv4 range that contains the company's computers. Choose a password secret or create one in the same form. The account and allowed computer group are saved in Support Desk settings; the password is stored in Paperclip Secrets.
3. Click **Save access group**. Enter one computer under **Computer to test** and click **Test identity (read only)**. You do not register each computer. This test works before any help desk connection is configured. For WMI, if the test says scripts are disabled, select **Allow PowerShell scripts for this WMI task only** and save again. That option changes only the launched process, not the computer's saved execution policy.

## Use IT tools in Clippy

Open Clippy in the company and ask it to investigate a computer, troubleshoot a printer, or explain a Group Policy problem. It can discover the diagnostic catalog, inspect available modules, consult current official references, and prepare a repair for confirmation in the conversation. Technical reference questions do not require a computer or incoming ticket. Official article retrieval needs outbound HTTPS to Microsoft Learn; no extra API key is needed. Company notes and previously investigated computers appear under **IT tools, devices and reference library** on Support. Passwords stay in Secrets.

After a change, Clippy reports the recorded repair and verification results and asks whether the original problem is gone when it cannot observe that remotely. Confirm recording the outcome in the conversation: resolved, still present, or needs follow-up. Recording ends previous delegation. If a problem returns, Clippy can reopen the case with your confirmation; unknown repair outcomes still require inspection.

## Receive support requests

In the **Configuration** tab, add a Support connection for each workspace or help desk account and map each exact intake route to a Paperclip company. Built-in Slack polling needs a Slack bot token secret and channel routing. A separate Slack, Help Scout, email, or other connector can instead deliver normalized messages to \`POST /api/plugins/customer-support/api/messages\` with a company-authorized integration agent. Installing a communication plugin alone does not start intake; configure and test its delivery route. Record its plugin ID in the connection when an external plugin supplies messages. Each company using a shared source needs an unambiguous route.`,
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["connections", "softwareRoutes", "remoteAccessProfiles"],
    properties: {
      connections: {
        type: "array",
        title: "Support connections (required for incoming messages)",
        description: "Add a Slack workspace or help desk account here when you are ready to receive requests. Each exact route must name one Paperclip company. This is separate from testing a Windows computer.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", title: "Connection ID" },
            source: { type: "string", enum: ["slack", "helpscout", "email", "whmcs", "other"], title: "Source" },
            externalAccountId: { type: "string", title: "External workspace or account ID" },
            ingestAgentId: { type: "string", title: "Intake agent ID", description: "Only this agent may deliver messages for the connection. Board operators may also test intake." },
            deliveryPluginId: { type: "string", title: "Communication plugin ID", description: "Optional ID of the installed plugin that delivers this source to the Support Desk message API. Leave blank for built-in Slack polling." },
            botTokenRef: { type: "string", format: "secret-ref", title: "Slack bot token secret", description: "Optional Slack bot token for polling configured workflow channels. Never paste the token here." },
            pollingEnabled: { type: "boolean", default: false, title: "Poll Slack channels", description: "Start new-message intake from now. Requires the bot token and channel history scopes." },
            allowedCompanies: {
              type: "array",
              title: "Allowed companies",
              items: { type: "string", format: "company-id" },
            },
            routes: {
              type: "array",
              title: "Intake routes",
              description: "Map each exact source routing key to one company. A key can combine channel or inbox ID with a required company selection. Unmapped messages are rejected.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  externalRouteId: { type: "string", title: "Source routing key" },
                  companyId: { type: "string", format: "company-id", title: "Company" },
                },
                required: ["externalRouteId", "companyId"],
              },
            },
          },
          required: ["id", "source", "externalAccountId", "ingestAgentId", "allowedCompanies", "routes"],
        },
      },
      softwareRoutes: {
        type: "array",
        title: "Software escalation routes (only for vendor software)",
        description: "Add one when support cases for a product must be sent to an outside vendor's support email or Jira intake form. No route is needed for the Windows connection test.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", title: "Route ID" },
            reportingCompanyId: { type: "string", format: "company-id", title: "Reporting company" },
            productName: { type: "string", title: "Product name" },
            destinationKind: { type: "string", enum: ["email", "jira_form"], title: "Intake channel" },
            destination: { type: "string", title: "Support email or Jira form URL" },
          },
          required: ["id", "reportingCompanyId", "productName", "destinationKind", "destination"],
        },
      },
      remoteAccessProfiles: {
        type: "array",
        title: "Remote access profiles (advanced)",
        description: "Use the guided form on the selected company's Support page to allow a DNS domain or office IP range once. Exact computer bindings remain available for narrower access.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", title: "Profile ID" },
            companyId: { type: "string", format: "company-id", title: "Company" },
            credentialUser: { type: "string", title: "Windows account (DOMAIN\\user)" },
            passwordRef: { type: "string", format: "secret-ref", title: "Password secret" },
            targets: {
              type: "array",
              title: "Exact computers (optional)",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  address: { type: "string", title: "Hostname or IP" },
                  transport: { type: "string", enum: ["Auto", "WinRMHttps", "WinRMHttp", "Wmi"], title: "Connection method" },
                  allowProcessExecutionPolicyBypass: { type: "boolean", default: false, title: "Allow PowerShell scripts for this WMI task only" },
                },
                required: ["address", "transport"],
              },
            },
            scopes: {
              type: "array",
              title: "Allowed computer groups",
              description: "Allow computers by a trusted DNS suffix or an IPv4 range in CIDR notation. A case still names its exact computer before any action runs.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", enum: ["dns_suffix", "ipv4_cidr"], title: "Group type" },
                  value: { type: "string", title: "DNS domain or IPv4 CIDR" },
                  transport: { type: "string", enum: ["Auto", "WinRMHttps", "WinRMHttp", "Wmi"], title: "Connection method" },
                  allowProcessExecutionPolicyBypass: { type: "boolean", default: false, title: "Allow PowerShell scripts for this WMI task only" },
                },
                required: ["kind", "value", "transport"],
              },
            },
          },
          required: ["id", "companyId", "credentialUser", "passwordRef"],
        },
      },
    },
    required: ["connections"],
  },
  apiRoutes: [
    {
      routeKey: "messages.ingest",
      method: "POST",
      path: "/messages",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "slack.workflow.ingest",
      method: "POST",
      path: "/slack/workflow-messages",
      auth: "board-or-agent",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "remote.identity.setup",
      requiredUserPermission: "support:diagnose",
      method: "POST",
      path: "/remote/identity",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.review",
      method: "POST",
      path: "/cases/:caseId/review",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.sync",
      method: "POST",
      path: "/cases/:caseId/sync",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.remote.identity",
      requiredUserPermission: "support:diagnose",
      method: "POST",
      path: "/cases/:caseId/remote/identity",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.actions.propose",
      method: "POST",
      path: "/cases/:caseId/actions",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.actions.decide",
      requiredUserPermission: "support:repair",
      method: "POST",
      path: "/cases/:caseId/actions/:actionId/decision",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.actions.execute",
      requiredUserPermission: "support:repair",
      method: "POST",
      path: "/cases/:caseId/actions/:actionId/execute",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.actions.reconcile",
      method: "POST",
      path: "/cases/:caseId/actions/:actionId/reconcile",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.issue.create",
      method: "POST",
      path: "/cases/:caseId/issues",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.work.start",
      method: "POST",
      path: "/cases/:caseId/start-work",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.escalation.create",
      method: "POST",
      path: "/cases/:caseId/escalation",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
    {
      routeKey: "cases.escalation.submitted",
      method: "POST",
      path: "/cases/:caseId/escalation/submitted",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "body", key: "companyId" },
    },
  ],
  jobs: [
    { jobKey: "poll-slack-workflows", displayName: "Poll Slack support workflows", schedule: "*/2 * * * *" },
  ],
  ui: {
    slots: [
      { type: "sidebar", id: "support-sidebar", displayName: "Support", exportName: "SupportSidebar" },
      { type: "page", id: "support-page", displayName: "Support", exportName: "SupportPage", routePath: "support" },
    ],
  },
};

export default manifest;
