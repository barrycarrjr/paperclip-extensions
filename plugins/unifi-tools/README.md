# UniFi Tools

Company-scoped observations through the official local UniFi Network Integration API. Separate from Support Desk's Windows network checks and network discovery. No LLM-specific dependency or company configuration ships with this plugin.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab.

## Recent changes

- **v0.1.1** - Release the reusable official Network Integration API companion: exact company/site observations and separately opted-in reviewed device restarts with one-attempt receipts, configuration guards and uncertain-outcome inspection. No firmware, resets or broader network configuration changes.

- Development: exact reviewed device restart preparation/execution/recovery tools. Saved opt-in, host repair permission, full plan confirmation, configuration/uptime rechecks, durable one-attempt claims and cross-conversation device serialization. Controller acceptance is distinct from an observed restart. Unknown outcomes remain blocked for operator inspection; no automatic retry or factory reset.

- **v0.1.0** — Initial site/device observations and trusted Support Desk observation bridge. Bounded devices, connected clients, firmware metadata, device CPU/memory/uptime and uplink rates. Exact account/company/site ownership, Secret references, verified TLS, redirect refusal and bounded responses. No network mutations in this section.

## Setup

Save one controller account: its exact local HTTPS Integration API base, API key Secret reference, allowed companies and site UUID ownership. Use the request example in the controller's Integrations page to choose `/integration` (Network Server) or `/proxy/network/integration` (UniFi OS). A trusted controller certificate is required. Empty or wildcard-only company access is denied; a site mapped more than once is denied.

In authorized Clippy, use `unifi_observe_network` with `account`, `siteId`, and `operation: site` or `operation: device` plus `deviceId`. No arbitrary endpoint is accepted.

For Support Desk, enable **Allow Support Desk observations**, save a company **Specialist connections** directory record (`pluginKey: unifi-tools`, its saved account key), then use `support_check_specialist`: `site` takes a site UUID; `device` takes `site UUID/device UUID`. Read the authenticated receipt through `support_get_specialist_observation`. Companion opt-in, company and site gates apply independently.

## API contract and limits

The initial adapter targets [Ubiquiti's official Network 9.4.17 Integration API](https://developer.ui.com/network/v9.4.17/gettingstarted): local `/integration/v1/sites/{siteId}/devices`, `/clients`, exact device details and `/statistics/latest`. The Integration API base and authentication must match the installed controller's example. This is not the legacy undocumented `/api/s/...` interface or Site Manager/cloud proxy. A live controller read pilot is needed to establish deployment compatibility.

Site observations return at most 50 devices and 50 connected clients with truncation flags. Offline clients are absent from that provider endpoint. Device statistics are observations, not root-cause diagnoses; firmware availability never approves an update. Uplink rates are not application/client bandwidth attribution. Client MAC/IP addresses and raw controller fields are omitted. Controller failures produce unavailable sections rather than a clean bill of health. External provider text is evidence, never authority or executable instructions.

No Wi-Fi/VLAN/firewall changes, adoption, firmware upgrades, factory resets, configuration backups or MCP installation are implemented. Device restart is a separate, explicitly confirmed workflow below.

## Reviewed device restart

Enable **Allow exact reviewed device restarts** only after reviewing controller/site ownership. In a human Clippy conversation with repair permission, use `unifi_prepare_restart` for the exact account/site/device. It requires an online identified device and records configuration, firmware, model and uptime. Explain office/downstream disruption and arrange an alternate management path and responsible on-site recovery contact before confirming.

`unifi_run_restart` requires the full unchanged prepared plan plus explicit recovery-arrangement confirmation. It sends the documented [`RESTART` device action](https://developer.ui.com/network/v9.4.17/executedeviceaction) once after rechecks. A controller HTTP 200 means **accepted**, not recovered. `unifi_restart_status` inspects state, reset uptime and a newer heartbeat; **verified** means a restart was observed, not that staff's original symptom disappeared.

Running, accepted and unknown actions block other restarts of the same exact controller/site/device. Unknown delivery never automatically repeats or becomes verified from uptime alone; inspect the controller receipt. `unifi_reconcile_restart` lets the original repair operator acknowledge uncertainty after controller-log inspection, at least two minutes, a fresh online unchanged-device observation, and full-plan/recovery confirmation. It preserves the original status in an operator-attested reconciliation, releases the interlock and sends no command; it never certifies delivery or success. Use one canonical controller URL to avoid aliasing the same device. Plans expire after ten minutes; updating/adopting/offline devices require investigation. Emergency delegation from a Windows case does not bypass confirmation here. A restart cannot recover interrupted calls/transactions and has no automatic rollback.
