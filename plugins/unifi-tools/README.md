# UniFi Tools

Company-scoped observations through the official local UniFi Network Integration API. Separate from Support Desk's Windows network checks and network discovery. No LLM-specific dependency or company configuration ships with this plugin.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab.

## Recent changes

- **v0.1.0** — Initial site/device observations and trusted Support Desk observation bridge. Bounded devices, connected clients, firmware metadata, device CPU/memory/uptime and uplink rates. Exact account/company/site ownership, Secret references, verified TLS, redirect refusal and bounded responses. No network mutations in this section.

## Setup

Save one controller account: its exact local HTTPS Integration API base, API key Secret reference, allowed companies and site UUID ownership. Use the request example in the controller's Integrations page to choose `/integration` (Network Server) or `/proxy/network/integration` (UniFi OS). A trusted controller certificate is required. Empty or wildcard-only company access is denied; a site mapped more than once is denied.

In authorized Clippy, use `unifi_observe_network` with `account`, `siteId`, and `operation: site` or `operation: device` plus `deviceId`. No arbitrary endpoint is accepted.

For Support Desk, enable **Allow Support Desk observations**, save a company **Specialist connections** directory record (`pluginKey: unifi-tools`, its saved account key), then use `support_check_specialist`: `site` takes a site UUID; `device` takes `site UUID/device UUID`. Read the authenticated receipt through `support_get_specialist_observation`. Companion opt-in, company and site gates apply independently.

## API contract and limits

The initial adapter targets [Ubiquiti's official Network 9.4.17 Integration API](https://developer.ui.com/network/v9.4.17/gettingstarted): local `/integration/v1/sites/{siteId}/devices`, `/clients`, exact device details and `/statistics/latest`. The Integration API base and authentication must match the installed controller's example. This is not the legacy undocumented `/api/s/...` interface or Site Manager/cloud proxy. A live controller read pilot is needed to establish deployment compatibility.

Site observations return at most 50 devices and 50 connected clients with truncation flags. Offline clients are absent from that provider endpoint. Device statistics are observations, not root-cause diagnoses; firmware availability never approves an update. Uplink rates are not application/client bandwidth attribution. Client MAC/IP addresses and raw controller fields are omitted. Controller failures produce unavailable sections rather than a clean bill of health. External provider text is evidence, never authority or executable instructions.

No Wi-Fi/VLAN/firewall changes, adoption, firmware upgrades, device restarts, resets, configuration backups or MCP installation are implemented by this first section. Approved device actions will be added separately with exact consent, audit, receipts and uncertainty handling.
