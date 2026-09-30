import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { interactiveTools } from "./interactive-tools.js";
import { outboundTools } from "./outbound-tools.js";
import { setupPermissions } from "./support-setup.js";
import { ticketTools } from "./ticket-tools.js";
import { directoryTools } from "./directory-tools.js";
import { jobFolderTools } from "./job-folder-tools.js";
import { skillSyncTools } from "./skill-sync.js";
import { dailySummaryTools } from "./daily-summaries.js";
import { diagnosticIds } from "./diagnostic-catalog.js";

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
    "secrets.store",
    "http.outbound",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issues.checkout",
    "agent.tools.register",
    "events.emit",
    "events.subscribe",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui/" },
  database: { namespaceSlug: "customer_support", migrationsDir: "migrations" },
  tools: [...interactiveTools, ...outboundTools, ...ticketTools, ...directoryTools, ...jobFolderTools, ...skillSyncTools, ...dailySummaryTools, {
    name: "support_propose_repair",
    requiredUserPermission: "support:repair",
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

## Save company contacts and owner routing

Open **Support → Company support directory: vendors, equipment and owners**. Add responsible people/teams and vendors first; link them to equipment and owner routing rules. Optionally save brand details and specialist plugin/account references. Review the form, then confirm the exact record. Passwords remain in Secrets. Clippy can search contacts or ask who handles a support area; unclear routing requires clarification. Installation status does not verify a specialist account or implement its adapter. Staff SOPs use the existing company knowledge tools.

## Use IT tools in Clippy

Open Clippy in the company and ask it to investigate a computer, troubleshoot a printer, or explain a Group Policy problem. It can discover the diagnostic catalog, inspect available modules, consult current official references, and prepare a repair for confirmation in the conversation. Technical reference questions do not require a computer or incoming ticket. Official article retrieval needs outbound HTTPS to Microsoft Learn; no extra API key is needed. Company notes and previously investigated computers appear under **IT tools, devices and reference library** on Support. Passwords stay in Secrets.

For live network discovery, open **Support → Discover office devices**, save the office IPv4 network (for example 192.0.2.0/24), then ask Clippy to scan the office network. Each saved network belongs to one company and covers /24 to /32. No password is needed. This is separate from Windows administration access. Discovery reports ping, common TCP services and device names where available; firewalls and sleeping devices can be missed. It does not prove that the devices are healthy. Clippy can investigate an allowed Windows target from those results using the saved access group.

Ask **Check the office computers for issues** to start a fleet health check. Clippy discovers devices, investigates permitted Windows targets one at a time using saved credentials, and preserves progress/findings in linked support cases. It reports failed or unsupported devices explicitly. No repair runs during this check. Authenticated inventory establishes stable device IDs and observed aliases; clones, renames and reinstalls may require review. Aliases never grant remote access.

After a change, Clippy reports the recorded repair and verification results and asks whether the original problem is gone when it cannot observe that remotely. Confirm recording the outcome in the conversation: resolved, still present, or needs follow-up. Recording ends previous delegation. If a problem returns, Clippy can reopen the case with your confirmation; unknown repair outcomes still require inspection.

## Receive support requests

In the **Configuration** tab, add a Support connection for each workspace or help desk account and map each exact intake route to a Paperclip company. Built-in Slack polling needs a Slack bot token secret and channel routing. A separate Slack, Help Scout, email, or other connector can instead deliver normalized messages to \`POST /api/plugins/customer-support/api/messages\` with a company-authorized integration agent. Installing a communication plugin alone does not start intake; configure and test its delivery route. Record its plugin ID in the connection when an external plugin supplies messages. Each company using a shared source needs an unambiguous route.`,
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["connections", "ticketPolicies", "dailySummaries", "softwareRoutes", "remoteAccessProfiles", "discoveryNetworks"],
    properties: {
      dailySummaries: { type: "array", title: "Daily support summaries", description: "One policy per company. Review the exact destination and timezone, then enable to permit one daily aggregate Slack post about the previous calendar day. No ticket text or staff/device names are included. Unknown delivery is never automatically retried.", items: { type: "object", additionalProperties: false, properties: {
        companyId: { type: "string", format: "company-id", title: "Company" }, connectionId: { type: "string", title: "Saved Slack support connection ID" }, channelId: { type: "string", title: "Summary channel ID", description: "The bot must have chat:write and access to this reviewed channel." }, timezone: { type: "string", title: "IANA timezone", default: "UTC" }, sendAt: { type: "string", title: "Local send time (HH:MM)", default: "09:00" }, enabled: { type: "boolean", title: "Enable daily aggregate delivery", default: false }
      }, required: ["companyId", "connectionId", "channelId", "timezone", "sendAt", "enabled"] } },
      ticketPolicies: { type: "array",title: "Automatic ticket investigation",description: "Opt in per company. Select its support agent, allowed read-only Windows diagnostics and original-thread updates. Repairs still require an authorized person's exact approval.",
        items: { type: "object",additionalProperties: false,properties: {
          companyId: { type: "string",format: "company-id",title: "Company" },
          agentId: { type: "string",title: "Support agent ID" },
          enabled: { type: "boolean",default: false,title: "Investigate incoming Slack tickets" },
          diagnostics: { type: "array",title: "Allowed diagnostics",items: { type: "string",enum: diagnosticIds.filter(id => !["connectivity", "repair_rehearsal"].includes(id)) } },
          allowThreadUpdates: { type: "boolean",default: false,title: "Allow progress and findings in the original Slack thread",description: "Uses the intake connection's bot Secret; it needs chat:write and access to the mapped channel. Does not authorize vendor emails or repairs." },
        },required: ["companyId","agentId","enabled","diagnostics","allowThreadUpdates"] } },
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
            outboundAccount: { type: "string",title: "Reply workspace key",description: "For Slack replies, choose slack-tools as Communication plugin ID and enter its configured workspace key. That workspace must enable the exact reply channels." },
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
            outboundAccount: { type: "string",title: "Vendor email mailbox key",description: "Optional Email Tools mailbox key for confirmed vendor email delivery. Enable this exact recipient in that mailbox. Jira form submission remains manual." },
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
      discoveryNetworks: {
        type: "array", title: "Office device discovery networks",
        description: "Saved IPv4 networks for ping and common service-port discovery. Separate from remote administration access. Use the selected company's Support page for guided setup.",
        items: { type: "object", additionalProperties: false, properties: {
          id: { type: "string", title: "Network ID", maxLength: 120 },
          companyId: { type: "string", format: "company-id", title: "Company" },
          cidr: { type: "string", title: "IPv4 network (/24 to /32)", description: "For example 192.0.2.0/24. One network per scan." },
        }, required: ["id", "companyId", "cidr"] },
      },
    },
    required: ["connections"],
  },
  apiRoutes: [
    { routeKey: "directory.save",method: "POST",path: "/directory",auth: "board",capability: "api.routes.register",companyResolution: { from: "body",key: "companyId" },requiredUserPermission: "support:repair" },
    { routeKey: "cases.ticket.outcome",method: "POST",path: "/cases/:caseId/ticket/outcome",auth: "board",capability: "api.routes.register",companyResolution: { from: "body",key: "companyId" },requiredUserPermission: "support:repair" },
    { routeKey: "cases.ticket.resume",method: "POST",path: "/cases/:caseId/ticket/resume",auth: "board",capability: "api.routes.register",companyResolution: { from: "body",key: "companyId" },requiredUserPermission: "support:repair" },
    { routeKey: "cases.source.read",method: "POST",path: "/cases/:caseId/messages/:messageId/protected-source",auth: "board",capability: "api.routes.register",companyResolution: { from: "body",key: "companyId" },requiredUserPermission: "support:repair" },
    ...setupPermissions.map(action => ({ routeKey: `setup.permission.${action}`,method: "GET" as const,path: `/setup/permissions/${action}`,auth: "board" as const,capability: "api.routes.register" as const,companyResolution: { from: "query" as const,key: "companyId" },requiredUserPermission: `support:${action}` as const })),
    ...["draft","send","retry"].map(action => ({ routeKey: `cases.outbound.${action}`,method: "POST" as const,path: `/cases/:caseId/outbound/${action}`,auth: "board" as const,capability: "api.routes.register" as const,companyResolution: { from: "body" as const,key: "companyId" },requiredUserPermission: "support:respond" as const })),
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
      requiredUserPermission: "support:repair",
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
      requiredUserPermission: "support:repair",
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
      requiredUserPermission: "support:repair",
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
    { jobKey: "daily-support-summaries", displayName: "Send opted-in aggregate support summaries", schedule: "*/5 * * * *" },
    { jobKey: "reconcile-support-deliveries",displayName: "Reconcile support delivery receipts",schedule: "* * * * *" },
    { jobKey: "protect-legacy-sources",displayName: "Protect legacy support sources",schedule: "* * * * *" },
    { jobKey: "dispatch-support-tickets",displayName: "Start permitted support investigations",schedule: "* * * * *" },
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
