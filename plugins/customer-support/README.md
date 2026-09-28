# Support Desk

A reusable Paperclip support plugin. It stores normalized support conversations per company, accepts authenticated intake from an integration agent or board operator, and shows cases and messages on a company-scoped Paperclip page. A board operator can create a reviewed Paperclip issue for local non-software work or a reviewed external escalation draft for software supplied by a vendor. A case can now propose, approve, run, and verify a PowerShell repair on an exact configured Windows target. External replies and vendor submissions remain manual.

## Recent changes

Current development adds company-owned secret checks, a guided company Windows access setup and read-only connection test on the Support page, a board-reviewed remote repair action with one-attempt execution and verification, an agent tool to propose that repair, recovery for interrupted attempts, and an email source label. The setup handles an initially empty plugin configuration and HTTP-hosted browsers, and the command audit uses a local application-data fallback when the worker omits `LOCALAPPDATA`. These changes have not been released.

- **0.1.0** — Company-scoped case and message storage, retry-safe intake, explicit source route mapping, opt-in Slack workflow and reply polling, attachment references, reviewed service routing and target access fields, activity entries, a Support dashboard, and operator-run multi-transport connection diagnostics.

The first build also includes a Slack Workflow Builder intake adapter. It requires an explicit `Company` answer in the posted workflow message and accepts both plain and Slack-bold field labels. Old posts without that answer are refused.

The case detail has a reviewed work-item form for a confirmed bug, feature request, incident, or task. The board operator writes a reviewed title and evidence; the original request title and source URL are not copied into derived work. Software work requires an explicit product route to the vendor's support email or Jira intake form. The plugin stores a draft, opens the configured channel for operator submission, and records a sent-message or ticket reference when an operator marks it submitted. It does not create a Paperclip issue in the vendor's company. IT, equipment, shipping, production, facilities, and general work creates an issue in the reporting company without a code project. The operator may assign a reporting-company agent to that work. Local issue creation is company checked, uses a stable case origin, and recovers a partial create/link failure without creating another issue. Creating an assigned issue does not request an agent wakeup from the plugin. The board operator can then select **Start agent work** on a local linked issue. That action rechecks the reviewed assignee and company, and calls Paperclip's budget- and blocker-aware issue wakeup with a stable idempotency key.

## Communication source requirement

Set up at least one communication route for each company before expecting cases. The plugin includes a Slack workflow poller, so a separate Slack plugin is optional for that path. Another Slack, Help Scout, email, or help desk plugin can deliver normalized messages through the support message API under a company-authorized integration agent. Its installation alone does not connect it: configure the support connection, its exact company route, and the sending integration. Set `deliveryPluginId` to the installed plugin key when one supplies a route; the Support page warns if that plugin is missing or inactive. This check does not prove that it delivers messages. Help Scout, email, and other systems still need delivery adapters; selecting their source label by itself does not start intake.

## Support request model

Cases may cover internal IT, computers, equipment, shipping, production, facilities, or software. Form categories and ownership clicks are context that a board operator reviews. The diagnosis and outcome may appear in thread replies or attached screenshots and videos. The poller syncs one known thread per connection on each two-minute run, storing reply text and file references without downloading file contents. New workflow cases link to their original Slack post. A board operator can also request an immediate sync. For a busy workspace, background freshness may lag; an event-based connector remains the target.

Some troubleshooting threads include credentials intentionally shared for access. This version stores ingested message text as received and has no controlled credential handoff. Before live intake of such threads, add restricted credential handling so approved staff or agents can use access information without copying it into issue summaries, logs, or reusable knowledge.

## Setup

To configure Windows support, select the company in Paperclip and open **Support → Connect Windows support**. Enter the Windows account (`DOMAIN\\username`) and an allowed DNS domain or office IPv4 range. This grants the account to computers beneath that domain or inside that range; an exact-computer rule is available for exceptions. Choose an existing company password secret, or create one in that form. Choose **Auto** unless a known connection method is required. For WMI targets where scripts are disabled, select **Allow PowerShell scripts for this WMI task only**; it changes the launched process, not the computer's saved policy. Click **Save access group**, enter a computer under **Computer to test**, then click **Test identity (read only)**. Computers are named on individual cases, not registered one by one. The test works before any help desk route or support case exists. The account and group remain editable settings; the password is stored only as a company secret. A successful identity test proves access to that computer, but it does not approve a repair or close a support case.

Configure **Support connections** in plugin settings. Each connection represents an external workspace or help desk account and has an `id`, `source`, `externalAccountId`, `ingestAgentId`, `allowedCompanies`, and exact `routes`. Each route contains an `externalRouteId` (a source routing key) and one `companyId`. That key may be a dedicated Slack channel ID, a help desk inbox ID, or a composite such as `channel-id:companyalpha` when a Slack workflow requires a company selection. A route is usable only if its company is in the connection's allowed companies. Empty access, missing routes, duplicate matches, and company mismatches are rejected.

Configure **Software escalation routes** for each reporting company and product. Each route has a stable `id`, `reportingCompanyId`, `productName`, `destinationKind` (`email` or `jira_form`), and `destination` (email address or HTTPS form URL). Create separate routes when two companies report the same product. A board operator selects the route after reviewing a software case. The plugin refuses missing, ambiguous, or malformed routes. It stores the reviewed outbound draft in the reporting company and does not create an internal issue in a vendor company. Keep access credentials out of the reviewed evidence; the source conversation retains its existing access controls until a credential handoff exists. The plugin currently stores and displays raw source text to board users.

Example route entries (replace the company IDs with the actual Paperclip IDs):

```json
[
  { "id": "alpha-product-email", "reportingCompanyId": "<Company Alpha UUID>", "productName": "Example Product", "destinationKind": "email", "destination": "support@example.com" },
  { "id": "beta-product-email", "reportingCompanyId": "<Company Beta UUID>", "productName": "Example Product", "destinationKind": "email", "destination": "support@example.com" }
]
```

For automated Slack intake, set `botTokenRef` to an existing Paperclip secret reference and enable `pollingEnabled` only after the workflow posts include the Company answer. The bot token needs Slack `channels:history` for public channels and `groups:history` for private channels; the bot must be a member of the private channel. The scheduled job runs every two minutes. Its first run records the newest message in each configured channel and intentionally skips older posts. Later runs ingest new top-level workflow posts and revisits one known thread per connection, taking the least recently checked case first. Reply cursors advance only after every fetched message is stored. This bounded polling is not real-time; outbound replies and historical backfill remain future work. A post recognized as a workflow request but missing Company fails the job without advancing its cursor, so it can be corrected and retried.

One Slack workspace may serve multiple Paperclip companies. Shared channels require a reliable company answer or another explicit routing signal. A required company selection can produce composite routing keys without splitting the channels. Do not map ambiguous messages.

For each shared-channel workflow, add a required **Company** selector and include its answer in the posted message. Configure exact route keys such as `<channel ID>:companyalpha` and `<channel ID>:companybeta`. The adapter will not infer a company from an absent answer, even if the form has a default.

The configured integration agent, using its Paperclip API key for the target company, can post a normalized message to `POST /api/plugins/customer-support/api/messages`. The host enforces agent access to `companyId`; the plugin checks the agent, workspace, and route. A board operator can also send a test event. Example body:

```json
{
  "companyId": "<Paperclip company UUID>",
  "connectionId": "example-workspace",
  "externalAccountId": "TEXAMPLE01",
  "externalRouteId": "<configured source routing key>",
  "externalConversationId": "<thread ID>",
  "externalMessageId": "<message ID>",
  "title": "Order page error",
  "body": "The customer reports an error on checkout.",
  "authorKind": "customer",
  "occurredAt": "2026-09-27T12:00:00Z",
  "externalUrl": "https://example.slack.com/archives/..."
}
```

The same message ID may be retried safely. The response contains the Paperclip `caseId` and whether the message was newly stored. Optional `authorExternalId` and `attachments` fields preserve a source author ID and up to 20 file references (`id`, `name`, optional `mimeType` and HTTPS `permalink`) without downloading files.

For Slack Workflow Builder posts, the configured intake agent can instead call `POST /api/plugins/customer-support/api/slack/workflow-messages` with `companyId`, `connectionId`, `externalAccountId`, `channelId`, `messageTs`, optional `threadTs`, full posted `text`, and optional `externalUrl`. The adapter extracts the `Company` and `Request` lines, derives the route key, and uses the same company and retry checks. This endpoint is useful for integrations that deliver events themselves; the scheduled poller is the built-in intake option.

## Current scope

Supported source labels are Slack, Help Scout, Email, WHMCS, and Other. The source-neutral intake contract, opt-in Slack workflow and bounded reply polling, attachment references, board-reviewed case classification, reviewed vendor escalation drafts, reporting-company work items, and board-started Paperclip issue wakeup are implemented. Staff can record service domain, work kind, status, device or asset, order or shipment, vendor reference, and resolution summary. A board operator can optionally assign a company agent to a local issue and explicitly start its work; human/vendor assignment and automated handoff remain subsequent stages. The case page also supports a board-reviewed PowerShell repair proposal, explicit approval, one execution attempt, and a separate verification script on an exact Windows target. This does not automatically resolve the case. Automated email/Jira submission, Help Scout and WHMCS adapters, automated triage, reply drafting, and source writeback are subsequent stages. WHMCS remains optional for operators who use it.

For an IT or equipment case, review can also record a target hostname or IP and an access method (`unknown`, WinRM HTTP/HTTPS, WMI/DCOM plus SMB, SSH, SMB file access, interactive RDP, RMM, local, or other). Network reachability does not establish remote management access. The source tree includes [a read-only connectivity probe](scripts/Test-SupportConnectivity.ps1) and [a connection suite probe](scripts/Test-SupportConnectionSuite.ps1). The suite checks DNS and TCP for WinRM HTTP/HTTPS, WMI/DCOM, SMB, SSH, and RDP. When supplied a `PSCredential`, it also checks WinRM Kerberos, WMI, and the SMB administrative share. SSH requires separately configured key and host trust; RDP is interactive. A port check is reachability only, not authentication or permission to run fixes.

Configure **Remote access profiles** per Paperclip company with a Windows account name, a Paperclip password secret reference, and allowed DNS domains, IPv4 ranges, or exact device targets. Cross-company lookups, ambiguous matches, and raw password values in place of a secret UUID are rejected. An exact device rule takes precedence over a group rule. The settings form exposes a secret picker; the plugin source and configuration hold only the reference. After reviewing an IT or equipment case with a target in an allowed group, a board operator can use **Test remote identity (read only)** on its Support page. The plugin resolves the company-owned password secret, passes it to a short-lived PowerShell process through standard input, and records the attempt and outcome in company activity. For a repair, the case page requires exact PowerShell repair and verification scripts, expected effect, and recovery notes. Approval and execution are separate board actions; execution is one-shot and records both run outcomes. An unknown outcome must be inspected before proposing another action. The secret-backed WMI/DCOM plus SMB identity path has passed a live workstation test; live repair execution and other transports still need validation.

Use [the read-only WinRM authentication probe](scripts/Test-SupportWinRM.ps1) with a workstation DNS name. From this plugin directory, run the following in an interactive PowerShell window to enter a domain password in the Windows credential prompt:

```powershell
.\scripts\Test-SupportWinRM.ps1 -Target workstation.example.local -ExpectedIdentity 'EXAMPLE\support-agent' -Credential (Get-Credential -UserName 'EXAMPLE\support-agent' -Message 'Domain account for the read-only WinRM test')
```

The probe checks TCP 5985, the WSMan handshake, Kerberos authentication, and then runs only a hostname and identity query through a remote shell. Its JSON result names the stage that failed and verifies the remote identity when requested. The password stays in the PowerShell credential object and is neither placed in the command nor included in JSON output. The probe does not modify TrustedHosts or make remote changes. If PowerShell already runs as the authorized domain identity, omit `-Credential`. Use [the read-only firewall inspection script](scripts/Inspect-SupportWinRMFirewall.ps1) to inspect a Windows target's network profile, listener, and WinRM HTTP firewall rules over DCOM when WinRM itself is unavailable.

When WinRM is unavailable, [the remote process probe](scripts/Test-SupportRemoteProcess.ps1) can test a WMI/DCOM and SMB path. It accepts a `PSCredential` from `Get-Credential`, connects to the target's administrative `C$` share, starts only `cmd.exe /c whoami` through WMI, reads the identity from a unique temporary file under `C:\Windows\Temp`, and removes the file and temporary drive.

[The operator-run script runner](scripts/Invoke-SupportRemoteScript.ps1) accepts a reviewed local `.ps1` file, company, case reference, target, optional `PSCredential`, expected remote identity, timeout, and transport (`Auto`, `WinRMHttps`, `WinRMHttp`, or `Wmi`). `Auto` tries authenticated WinRM HTTPS, then WMI/DCOM plus SMB when its ports are reachable, then WinRM HTTP. It stops on authorization failures and never reruns a script after execution begins. Set `-ExpectedIdentity 'DOMAIN\account'` to refuse execution under another remote account; this check runs before the reviewed script on both WinRM and WMI paths. Operators can select a specific transport for a known device. Add `-Verbose` to see connection and execution stages. WMI execution stages the file under a unique temporary folder and removes it after completion. If a target blocks `.ps1` files through its default execution policy, an operator can add `-AllowProcessExecutionPolicyBypass` to the runner; this sets `Bypass` only on the launched PowerShell process and cannot override a Group Policy setting. Both paths write a local metadata-only audit record under `%LOCALAPPDATA%\Paperclip\SupportRemoteCommands`. The same transport runner now also backs the installed plugin's reviewed case action. Company-owned asset inventory, Paperclip's central Approvals queue integration, and live validation of the secret-backed path remain to be completed. Never turn source conversation text directly into a command.

### Case-based remote repairs

After reviewing an IT or equipment case with an exact target, use **Test remote identity** on its Support page. It resolves the password secret for that case's company and runs a read-only remote identity check. A board user or company agent can propose a PowerShell repair with its expected effect, a separate verification script that throws if the problem remains, and recovery notes. The agent tool only proposes; it cannot approve or execute. The case stores the exact scripts and SHA-256 hashes. A board user must explicitly approve the proposal, then explicitly start it. Approval and execution recheck the company, case review version, service domain, and target. Execution claims the action once before starting any remote process; a repeated request cannot rerun it. The action records the repair and verification run IDs and exit codes. A failed, interrupted, or unknown attempt requires device inspection and a new proposal rather than automatic replay. Scripts and raw output are not copied into the activity log. The source conversation text must never be used directly as a script.

This is a local board approval gate in the plugin; it does not yet create an entry in Paperclip's central Approvals queue. The end-to-end secret-backed path and repair have not been tested against a live device through the installed plugin. Operator-run script tests alone do not establish that result. Only use this action after configuring a company-owned Paperclip secret and reviewing the exact scripts.

For a read-only transport test, run `Get-SupportIdentity.ps1` through the same runner with an interactive credential prompt:

```powershell
.\scripts\Invoke-SupportRemoteScript.ps1 -Target workstation.example.local -Company 'Company Alpha' -CaseReference 'CASE-EXAMPLE' -ScriptPath .\scripts\Get-SupportIdentity.ps1 -Transport Auto -Credential (Get-Credential -UserName 'EXAMPLE\support-agent' -Message 'Account for the read-only connection test')
```
