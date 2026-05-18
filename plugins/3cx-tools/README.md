# 3cx-tools — Paperclip plugin

Direct 3CX PBX integration for **operational visibility** (queue depth, parked calls, today's stats, agent presence, call history) and **human-driven call control** (click-to-call, park, transfer, hangup) — plus optional **realtime WebSocket events**. Multi-account; multi-company-mode; per-account `allowedCompanies`; mutations gated.

This is the operations / observability surface for the PBX itself, scoped per Paperclip company.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.6.1** — Fix: SIP Trunks page (added in v0.6.0) rendered every trunk as **provider `—`, status `unregistered`, channels `—`** regardless of actual PBX state. The v0.6.0 normalizer guessed at the field names on `/xapi/v1/Trunks` (`ProviderName` / `RegistrationStatus` / `SimCalls`) but the real `Pbx.Trunk` entity on v20 (verified live against the OData `$metadata` 2026-05-17) uses `Gateway.Name`, `IsOnline` (Edm.Boolean), `SimultaneousCalls`, and `ExternalNumber` for the carrier-facing DID. The mapper now reads the correct names first and keeps the old guesses as legacy fallbacks so non-v20 engines still degrade gracefully. The `RawTrunk` shape adds `IsOnline`, `SimultaneousCalls`, and `ExternalNumber`. No agent-facing tool changes — only the operator UI was reading these fields.

- **v0.6.0** — Phone navigation IA. The standalone Recordings sidebar entry is gone; in its place is a single collapsible **📞 Phone** group that nests every PBX operational surface under three sub-sections (Live / History / Directory) with the existing Recordings page slotted into History. Ten new operator-facing pages: Active calls (auto-refresh 2s), Parked calls (auto-refresh 3s), Queues (auto-refresh 3s), Agents with presence filter (auto-refresh 5s), Wallboard (composite KPIs + 4-panel live view, auto-refresh 2.5s), Call history with date/direction filters, Daily report, DIDs, Extensions with search, and SIP Trunks (with new `listTrunks` engine method + `RawTrunk` shape covering both v20 field-name conventions). Sidebar sub-section collapsed state persists in `localStorage` per company. Ten new data channels (`phone.*`) wrap the existing engine reads — the agent-facing tools are unchanged; the pages are just a new surface over the same engine. Pages share a `ui/common.tsx` primitive set (Badge, Table, EmptyState, ErrorBanner) for visual consistency.

- **v0.5.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.2** — `pbx_parked_calls` rewritten against the **actual** 3CX v20 API shape (verified live against Carr Rock PBX 2026-05-17). The v0.5.0 implementation assumed numeric park-slot extensions (`8000-8009`) and fanned out per-slot `GET /callcontrol/<slot>/participants` — but 3CX's Shared Parking uses identifiers like `SP0`/`SP1`/`*888` that aren't extensions, so the v0.5.0 path returned 404 on every probe and yielded `[]`. New approach: single query to `/xapi/v1/ActiveCalls`, identify parked calls by matching the `Callee` field's first token against the slot list from `/xapi/v1/Parkings`. Slot identifiers (`SP0`, `*888`, etc.) are auto-discovered from `Parkings` — operators no longer need to configure anything. The `parkSlotRange` field is **removed** from the per-account schema (no existing config could have been using it usefully since the v0.5.0 implementation didn't work). `originalExtension` on `NormalizedParkedCall` is now always `undefined` — XAPI's ActiveCalls view of a parked call doesn't carry the previous-leg extension. Manual-mode scoping no longer filters parked calls (park slots are explicitly shared infrastructure on 3CX). Three new live-shape smoke tests + verified end-to-end against a real parked call on SP0.

- **v0.5.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.0** — `pbx_parked_calls` is now real. Previously it always returned `[]` because XAPI doesn't expose live park-slot state. The engine now fans out `GET /callcontrol/<slot>/participants` per configured park-slot extension (default `8000-8009`) and normalizes each participant into the existing `NormalizedParkedCall` shape (`slot`, `callerNumber`, `parkedSinceSec`, `originalExtension`). New per-account config field `parkSlotRange` lets operators on non-default park ranges override the slot list; setting it to `[]` short-circuits the probe entirely. 404 on an individual slot is treated as "no calls parked there" (the common case); 403 / auth-style errors bubble up as `[E3CX_CC_NOT_ENABLED]` with operator-actionable guidance. The Call Control API path requires the second Service-Principal checkbox AND each park-slot extension added to the Extension(s) selector — same operator setup as `pbx_park_call` / `pbx_transfer_call`. Defensive about field-name variance: the participant shape is matched against both lowercase_underscore (Call Control convention) and PascalCase (XAPI convention) names so an upstream rename doesn't crash the tool.

- **v0.4.10** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.9** — Dropped v18 support. The `pbxVersion` field is now `enum: ["20"]` (was `["20", "18"]`) — v18 was never implemented and would error with `[EENGINE_NOT_AVAILABLE]` if selected. Most v18 installs upgrade to v20 for free; if you're still on v18, upgrade before installing. README and roadmap cleaned up to match. No effect on existing v20 configs.

- **v0.4.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.7** — Fix: the v0.4.6 extension dropdown only showed "Anyone" because `engine.listExtensions` hardcoded `$top=500` on `/xapi/v1/Users` and 3CX v20 rejects any `$top > 100` with **HTTP 400** (server cap not documented in the OData `$metadata`). The worker caught the 400 and returned an empty extensions list, leaving the dropdown bare. Both `listExtensions` and the all-extensions branch of `listAgents` now paginate with `$top=100&$skip=N` until the server returns a short page (with a 5000-row safety cap). Also dropped the broken `$filter=Type eq 'User'` from `listAgents` — many Users records have no `Type` field, so the server-side filter was silently excluding them.

- **v0.4.6** — Recordings page UX: extension text input replaced with a **dropdown** (sourced from a new `recordings.pbx-extensions` data channel that returns every PBX user with display name; defaults to "Anyone"). **Date range filter** added — preset chips (Month to Date / Last 7 / Last 30 / YTD / All Time / Custom) mirroring the host's Portfolio Costs page, with from/to date inputs in custom mode; default is Month to Date. **Pagination** via a "Load more" button that accumulates pages using the worker-returned `nextCursor`. Engine: `RecordingListOpts` gains `from`/`to` (ISO 8601) ANDed into the OData `$filter` on `StartTime`; agent-facing `pbx_recording_list` tool accepts the same parameters. The PBX-extensions data channel is intentionally unscoped (calls `engine.listExtensions({mode: "single"})`) so it works on shared-extension setups where the company has no `extensionRanges` claim — recording results still apply company scope on top of whatever extension is picked, so cross-company data can't leak.

- **v0.4.5** — Fix: clicking **Play** on a recording returned `[E3CX_NOT_FOUND] Recording "<id>" not found on the PBX`. The engine's single-entity metadata fetch used `GET /xapi/v1/Recordings(<id>)`, which 3CX v20 rejects with 404 across every key-syntax variant (bare-int, quoted, slash) even though `Id` is declared as the OData entity key in `$metadata`. Switched the scope-authorization preflight to `GET /xapi/v1/Recordings?$filter=Id eq <id>&$top=1`, which is the only single-entity read shape 3CX accepts. The audio download itself (the bound function `Pbx.DownloadRecording(recId=<id>)`) already worked because it's on the collection rather than a single entity.

- **v0.4.4** — Fix: shared-extension manual-mode setups (`extensionRanges` empty per company, partitioning by DID instead) were returning **zero recordings** because `filterRecordings` only matched on extension. The filter now mirrors `filterCallHistory` / `filterActiveCalls` — accepts a recording if the internal extension is in scope OR the `FromDidNumber` / `ToDidNumber` matches one of the company's configured `dids` (`+` prefix normalized away on both sides since 3CX returns DIDs as bare digits). The OData `$filter` is also extended server-side to push the OR-of-extensions-and-DIDs into the query, so pagination doesn't waste pages on out-of-scope rows on busy PBXs. `NormalizedRecording` gained optional `fromDidNumber` and `toDidNumber` fields to support this. Audio-fetch authz now uses the same OR logic.

- **v0.4.3** — Breaking rename: the voicemail tools/UI/routes are now properly named after what they return. Tools `pbx_voicemail_list` / `pbx_voicemail_get` → `pbx_recording_list` / `pbx_recording_get`. The sidebar entry and page are renamed from "Voicemails" to "Recordings" with route `/<companyPrefix>/recordings`. The plugin-scoped audio endpoint moved from `/voicemails/audio` to `/recordings/audio` (`routeKey: recordings.audio`). The `unreadOnly` parameter and `isRead` field are removed entirely (recordings have no read state). UI components: `VoicemailsSidebarItem` → `RecordingsSidebarItem`, `VoicemailsPage` → `RecordingsPage`. Engine method names: `listVoicemails`/`fetchVoicemailAudio` → `listRecordings`/`fetchRecordingAudio`. No behavior changes vs. v0.4.2 — same /Recordings backend.

- **v0.4.2** — Voicemail tools retargeted to `/xapi/v1/Recordings` on the v20 engine. The previous `/xapi/v1/Voicemails` path **does not exist** on 3CX v20 (confirmed against a live v20.0.8 install via the OData `$metadata` doc — there is no Voicemail EntityType at all, and `/callcontrol/voicemails` returns 403 to even a system_owners-scoped OAuth client). Recordings is the closest queryable surface and includes voicemail-style recordings when "Record voicemail" is enabled per extension, alongside ordinary call recordings — so `pbx_voicemail_list` now returns recorded calls more broadly. Audio bytes are fetched via the bound OData function `Pbx.DownloadRecording(recId=...)` and come back as `audio/x-wav`. The `unreadOnly` parameter is now a documented no-op (Recordings have no read state on v20). For true voicemail-only inbox access, configure VMEmailOptions per user in 3CX so voicemails are delivered as email attachments and ingest via an inbox plugin.

- **v0.4.1** — Voicemails page in the Paperclip UI. Adds a sidebar entry ("🎙️ Voicemails") and a per-company page at `/<companyPrefix>/voicemails` listing voicemails with inline `<audio>` players. Filters: account (when multiple are configured), extension, unread-only. Audio loads lazily on play — the page hits the same `/voicemails/audio` route the worker tools already use and renders the bytes via a Blob URL. Sidebar item hides itself for companies that aren't in any account's `allowedCompanies`.

- **v0.4.0** — Voicemail support. Two new tools (`pbx_voicemail_list`, `pbx_voicemail_get`) and a plugin-scoped API route at `/api/plugins/3cx-tools/api/voicemails/audio` that proxies the audio bytes from 3CX so any browser surface can render them with an `<audio>` element. The list tool returns metadata + a playable `audioUrl`; `pbx_voicemail_get` optionally inlines the audio as a `data:` URL (`inlineAudio: true`). Manual-mode scoping applies: voicemails for extensions outside the calling company's range are filtered out. Voicemail deletion + read/unread mutations remain out of scope for now.

- **v0.3.14** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.13** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.12** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.11** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.10** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.9** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.6** — Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.3.5** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Two-API split — important to understand before configuring

3CX v20 splits its programmable surface into two independent API families,
each with its own enable-checkbox on the Service Principal:

| API family | Path prefix | What it covers | Enable in 3CX admin |
|---|---|---|---|
| Configuration API (XAPI) | `/xapi/v1/*` | Read system state, queues, users, trunks, active calls, call history, plus a few function-style mutations like `Pbx.DropCall` | "Enable access to the 3CX Configuration API (XAPI)" — the **first** checkbox |
| Call Control API | `/callcontrol/*` | Originate calls, park, pickup, transfer, per-device control, realtime call participants | "Enable access to the 3CX Call Control API" — the **second** checkbox |

This plugin's read tools and `pbx_hangup_call` work via XAPI; the other
mutation tools (`pbx_click_to_call`, `pbx_park_call`, `pbx_pickup_park`,
`pbx_transfer_call`) require the Call Control API to be enabled AND the
relevant extensions selected on the Service Principal. If you're starting
read-only, just enable the XAPI checkbox; come back and enable Call
Control later when you're ready to flip `allowMutations` on.

## What this plugin is, and what it is NOT

There are two phone-related plugins in this codebase. They cover different surfaces and don't overlap.

| | `phone-tools` | `3cx-tools` |
|---|---|---|
| What handles the call | An AI voice engine (Vapi today; jambonz + OpenAI Realtime in v0.3) | The 3CX PBX itself |
| Who's on the line | The agent's voice assistant | A human operator (your staff) |
| Typical use | "Call the lead and book an appointment" — fully autonomous | "Show me the support queue right now" / "click-to-call from extension 102" |
| Does it dial out? | Yes — initiates AI-driven calls | Yes — but it just rings a human's extension first; the human dials |
| 3CX's role | One possible SIP trunk underneath the AI engine (v0.2+) | The whole PBX surface |

If you want an AI to talk to someone, use `phone-tools`. If you want to query or control the PBX itself, use `3cx-tools`. They're complementary; a future `pbx_transfer_call`-meets-`phone-tools`-callId bridge will let the AI hand off to a human, but that's not in this version.

## Tools registered

### Reads (Phase 1, v0.1.0 — read-only-safe)

| Tool | Returns |
|---|---|
| `pbx_queue_list` | Queues in scope: id, name, extension, agentsOn, depth, longestWaitSec |
| `pbx_queue_status` | Snapshot for one queue: depth, longestWaitSec, agentsOn, agentsAvailable, callsToday {offered, answered, abandoned}, avgHandleSec |
| `pbx_parked_calls` | Calls in park slots: slot, callerNumber, parkedSinceSec, originalExtension |
| `pbx_active_calls` | Calls in progress: callId, fromNumber, toNumber, extension, queue, startedAt, durationSec, direction |
| `pbx_agent_status` | Agents (presence, in-call, queue memberships) — pass `extension` to narrow to one |
| `pbx_today_stats` | Today's call volumes: offered, answered, abandoned, internalCalls, avgWaitSec, avgHandleSec, peakDepth, abandonRate, sla |
| `pbx_call_history` | Paginated call records: callId, fromNumber, toNumber, extension, queue, startedAt, endedAt, durationSec, direction, disposition, recordingUrl (if exposeRecordings) |
| `pbx_did_list` | DIDs (E.164) routed to the company |
| `pbx_extension_list` | Extensions visible to the company: number, displayName, type, email |

### Call recordings (Phase 4, v0.4.0; retargeted v0.4.2, renamed v0.4.3)

| Tool | Returns |
|---|---|
| `pbx_recording_list` | Recordings in scope: `id`, `extension`, `from`, `receivedAt`, `durationSec`, `audioContentType`, `audioUrl`. Filters: `extension` (matches both FromDn and ToDn), paginated via `cursor` |
| `pbx_recording_get` | One recording by `id`. Pass `inlineAudio: true` to also receive `audioBase64` + `audioDataUrl` (a `data:audio/x-wav;base64,…` URL slot-able into `<audio src>`) |

Backed by `/xapi/v1/Recordings` on the v20 engine, which holds call recordings plus any voicemail-style recordings when "Record voicemail" is enabled per extension. 3CX v20 doesn't expose a dedicated voicemail collection to OAuth clients — for voicemail-only access, configure VMEmailOptions per user so voicemails are emailed and ingest via an inbox plugin.

`audioUrl` resolves to `GET /api/plugins/3cx-tools/api/recordings/audio?companyId=<id>&account=<key>&id=<rec-id>`. The route is `board`-auth, returns `{ contentType, base64 }`, and is the recommended path for browser playback — the UI base64-decodes into a `Blob` and uses `URL.createObjectURL` for `<audio>`. The 3CX bearer token never leaves the plugin worker; the browser only ever talks to Paperclip.

`inlineAudio: true` on `pbx_recording_get` is opt-in because recordings routinely run several MB; the default flow returns metadata only and lets the UI request audio lazily.

### User-aware click-to-call

`pbx_click_to_call` accepts three forms of "who originates the call":

- **`fromExtension`** — explicit extension number (e.g. `"200"`). Always works.
- **`fromUserId`** — Paperclip user UUID. Resolved to an extension via the plugin's **User → Extension map**.
- **`fromUserEmail`** — case-insensitive email match against the same map.

The map lives in instance settings (`/instance/settings/plugins/3cx-tools` → "User → extension map") with one row per user: `userId` and/or `userEmail` plus their `extension`. This lets a user say "call X from my extension" via Clippy or an agent chat without typing the extension number — see the [`pbx-call-from-my-extension`](../../skills/pbx-call-from-my-extension/SKILL.md) skill for the canonical agent-side flow.

`toNumber` accepts any common phone format. The plugin normalizes:

| Input | Becomes |
|---|---|
| `555.123.4567` | `+15551234567` |
| `(555) 123-4567` | `+15551234567` |
| `5551234567` | `+15551234567` |
| `15551234567` | `+15551234567` |
| `+15551234567` | `+15551234567` (passthrough) |
| `+44 20 7946 0958` | `+442079460958` |
| `200` (3-5 digits) | `200` (passthrough — internal extension) |

The normalized number then has the company's `outboundDialPrefix` applied (with the leading `+` stripped) so the final dial string matches what 3CX's outbound rules expect.

### Mutations (Phase 2 — gated behind `allowMutations`)

| Tool | Effect | Underlying API |
|---|---|---|
| `pbx_hangup_call` | Force-end an active call | XAPI `Pbx.DropCall` |
| `pbx_click_to_call` | Originate from an extension | Call Control API `/callcontrol/<ext>/devices/<deviceId>/makecall` |
| `pbx_park_call` | Park an active call into a park slot | Call Control API `/callcontrol/<ext>/participants/<callId>/routeto` (destination = slot) |
| `pbx_pickup_park` | Pick up a parked call to an extension | Call Control API `MakeCall` from the at-extension to the park slot |
| `pbx_transfer_call` | Transfer an active call (blind) | Call Control API `/callcontrol/<ext>/participants/<callId>/transferto` |

All Call Control API mutations require the **second** checkbox on the Service Principal ("Enable access to the 3CX Call Control API") AND the operating extension(s) added to the Service Principal's Extension(s) selector.

`pbx_parked_calls` (read-side park-slot enumeration) makes one `GET /xapi/v1/ActiveCalls` call and identifies parked calls by matching the `Callee` field's first token against the slot identifiers from `/xapi/v1/Parkings` (auto-discovered — operators don't need to configure anything). Each parked call is normalized into `{ slot, callerNumber, parkedSinceSec, originalExtension }`. Slot identifiers can be either Shared Parking style (`SP0`, `SP1`, …) or dial-code style (`*0`, `*888`, …) — whatever the PBX has configured under Settings → Call Parking. `originalExtension` is undefined because 3CX's ActiveCalls view of a parked call doesn't carry the previous-leg extension; manual-mode scoping doesn't filter parked calls (park slots are explicitly shared infrastructure).

### Notes on park / transfer behavior

- **Park slot**: `pbx_park_call` defaults to slot `8000` (the conventional first 3CX park-slot extension). If your install uses a different range, pass `slot` explicitly. Future v0.3 will probe `CallParkingSettings` to auto-discover.
- **Transfer mode**: 3CX v20 Call Control API doesn't expose attended transfer — `transferto` is effectively blind. The `mode: "attended"` parameter is accepted for forward-compat but currently has no on-PBX effect.
- **Owner extension lookup**: park/transfer take a `callId` and resolve the owning extension server-side via `/xapi/v1/ActiveCalls`. If you already know the owner, the tool will trust the lookup and validate against company scope.

### Realtime events (Phase 3, v0.3.0)

The plugin opens one long-lived WebSocket per configured account in `setup()`. Events are normalized and emitted as `plugin.3cx-tools.<kind>` per the matching company:

- `plugin.3cx-tools.call.started` — `{ callId, from, to, extension?, queue?, direction, startedAt, account }`
- `plugin.3cx-tools.call.ended` — `{ callId, durationSec, disposition, endedAt, account }`
- `plugin.3cx-tools.queue.depth` — `{ queueId, depth, longestWaitSec, account }`
- `plugin.3cx-tools.agent.presence_changed` — `{ extension, presence, account }`

The WebSocket reconnects with exponential backoff on disconnect and refreshes the OAuth token transparently. WS lifecycle: opened in `setup()`, closed in `onShutdown()`.

## Setup walkthrough

### 1. Create the Service Principal in 3CX admin

1. Log in to 3CX admin (Management Console).
2. Go to **Integrations → API**.
3. Click **Add** to create a new Service Principal.
4. Set the **Client ID** field to a memorable name (e.g. `paperclip-3cx`). This becomes the OAuth `client_id` literal — the plugin uses it as-is.
5. **Tick "Enable access to the 3CX Configuration API (XAPI)"** — required for every read tool and for `pbx_hangup_call`.
6. **Department**: must be a real department (not "System Wide", which auto-locks Role to User). Pick any (e.g. your parent entity), then set **Role** to `System Owner`. "System Wide + User" returns 403 on collection reads.
7. **Tick "Enable access to the 3CX Call Control API"** ONLY if you intend to use `pbx_click_to_call` or future v0.2 park/transfer mutations. If you do, also click **Select Extensions** and add every extension that should be allowed to originate calls.
8. Click **Generate API Key** — 3CX displays the secret once. Copy it immediately. This is the OAuth `client_secret` for the `/connect/token` flow. (Re-generating later rotates the secret and immediately invalidates the previous one — update the Paperclip secret + your local PowerShell `$ClientSecret` together.)
9. **Save** at the top of the form to commit. Without Save the client is not active.

### 2. Store the credentials as Paperclip secrets

For **each** Paperclip company that uses the PBX (or a single shared company if all extensions live on one PBX):

1. Open the company's **Secrets** page in Paperclip.
2. Create a secret: `3cx_xapi_client_id` → paste the Client ID. Copy the secret's UUID.
3. Create a secret: `3cx_xapi_client_secret` → paste the Client Secret. Copy the secret's UUID.

Note: in `manual` mode the same XAPI client is shared by every Paperclip company on the PBX, so you only need one set of secrets. In `native` mode (3CX Multi-Company license) you may want one client per tenant.

### 3. Configure the plugin

Open `/instance/settings/plugins/3cx-tools` and fill in the settings form.

#### Top-level fields

- **Allow click-to-call / park / transfer / hangup** — leave **off** until you've decided which agents and skills are allowed to originate calls. PSTN minutes cost real money and a misrouted call disturbs a real human.
- **Default account key** — the account name used when an agent omits the `account` parameter (e.g. `main`).
- **3CX accounts** — one entry per PBX. Most operators have one.

#### Per-account fields

- **Identifier** — short stable ID agents pass to tools (e.g. `main`).
- **Display name** — free-form label for this settings page.
- **PBX base URL** — fully qualified, scheme included (e.g. `https://pbx.example.com`). No trailing path.
- **3CX version** — `20` (only supported value). v18 is not supported; upgrade the PBX (v20 is a free upgrade for v18 licensees).
- **XAPI client_id** — paste the Paperclip secret UUID, NOT the raw client_id.
- **XAPI client_secret** — paste the Paperclip secret UUID, NOT the raw secret.
- **Multi-company mode** — `single` / `manual` / `native` (see below).
- **Per-company routing (manual mode)** OR **Per-company tenants (native mode)** — populated based on the mode.
- **Allowed companies** — Paperclip company UUIDs whose agents may use this account at all. **Empty = unusable**. Use `["*"]` for portfolio-wide (only meaningful in single mode).
- **Expose call recording URLs** — default off. Many jurisdictions require an audible "this call may be recorded" disclosure; flip on only after your IVR/queue greeting handles consent.
- **Max click-to-call per day per company** — hard cap, default 50. Set 0 to disable click-to-call for the account regardless of the master mutation switch.

### 4. Pick the right mode

| Mode | Topology | Per-company filter source |
|---|---|---|
| `single` | One PBX, one Paperclip company. The whole PBX = one tenant. | None. `allowedCompanies` is the entire access list. |
| `manual` | One PBX shared across multiple Paperclip companies (no 3CX multi-company license). | You declare `extensionRanges` / `queueIds` / `dids` per company in the routing table. Plugin filters every result client-side. |
| `native` | One PBX with 3CX's Multi-Company license enabled. | You map each Paperclip company to a 3CX `tenantId`. The plugin sends `X-3CX-Tenant: <tenantId>` and 3CX scopes server-side. |

#### Manual-mode routing — worked example

A single shared PBX (single license) split by-convention across multiple Paperclip companies. The routing table on the account looks like:

```
Per-company routing:
  • Company A   ext: 100-119          queues: 800       dids: +1XXXXXXXXXX
  • Company B   ext: 200-219          queues: 810       dids: +1YYYYYYYYYY
  • Company C   ext: 300-319, 401     queues: 820       dids: +1ZZZZZZZZZZ
  ...
```

When an agent in Company A calls `pbx_active_calls`, the plugin filters to extensions 100–119 / queue 800 / DID +1XXXXXXXXXX. An agent in Company B doesn't see Company A's calls — even though they share a PBX.

For shared-extension setups (one physical extension serves multiple companies; the LLC for an outbound call is selected via 3CX's outbound-prefix-to-trunk mapping), leave `Extension ranges` empty. Inbound attribution still works via DIDs and queues.

For outbound attribution, set the per-company **`Outbound dial prefix`** field to the digit a human at this company would press before dialing externally (e.g. `9` for one LLC, `8` for another). When `pbx_click_to_call` originates from an agent in this company, the plugin prepends the prefix to the destination so 3CX's outbound rules pick the right trunk — same effect as a human pressing the digit at the desk phone. The plugin strips any leading `+` from the destination before prepending, so `+18005551212` with prefix `9` sends `918005551212` to 3CX. Leave blank if 3CX's default outbound rule for the originating extension is already correct (typical for single-LLC PBXes).

Click-to-call is doubly checked: `fromExtension` must be in the calling company's `extensionRanges` or the call returns `[ESCOPE_VIOLATION]` before any 3CX API call.

### 5. Test the connection

The first `pbx_*` tool call from an authorized company will authenticate, cache a token (~1h TTL, refreshed at 80% TTL), and return data. Failures surface as `[E3CX_AUTH]` (credential issue), `[E3CX_NOT_FOUND]` (queue/extension missing), `[E3CX_NETWORK]` (PBX unreachable), or `[ECOMPANY_NOT_ALLOWED]` / `[ECOMPANY_NOT_ROUTED]` (Paperclip-side scope check).

You can also trigger the smoke-test suite with `pnpm smoke` from the plugin directory — it exercises every guard against an in-memory test harness.

## Sample invocations

```jsonc
// Read: list queues for the calling company
POST /api/plugins/tools/execute
{
  "tool": "3cx-tools:pbx_queue_list",
  "parameters": { "account": "main" },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "...", "projectId": "..." }
}

// Read: today's support-queue stats
POST /api/plugins/tools/execute
{
  "tool": "3cx-tools:pbx_today_stats",
  "parameters": { "account": "main", "queue": "800" },
  ...
}

// Mutation: ring extension 102 first, then dial out
POST /api/plugins/tools/execute
{
  "tool": "3cx-tools:pbx_click_to_call",
  "parameters": {
    "account": "main",
    "fromExtension": "102",
    "toNumber": "+18005551212",
    "idempotencyKey": "lead-7842-2026-05-03"
  },
  ...
}
```

## Error-code reference

Every error follows `[ECODE_<...>] human message` so skills can pattern-match.

### Paperclip-side guards (no upstream call)

| Code | When |
|---|---|
| `ECOMPANY_NOT_ALLOWED` | Calling company isn't listed in the account's `allowedCompanies`, or the list is empty. |
| `ECOMPANY_NOT_ROUTED` | Manual mode and no `companyRouting` entry for the calling company. Native mode and no `companyTenants` entry. |
| `EACCOUNT_REQUIRED` | No `account` parameter and no `defaultAccount` configured. |
| `EACCOUNT_NOT_FOUND` | The provided account key isn't in the configured accounts list. |
| `ECONFIG` | Missing `clientIdRef` / `clientSecretRef`, or a secret reference didn't resolve. |
| `EVALIDATION` | Required tool parameter missing or wrong shape. |
| `EDISABLED` | Tool is a mutation and `allowMutations` is off, or `maxClickToCallPerDay` is 0. |
| `ESCOPE_VIOLATION` | Mutation targets an extension/call outside the calling company's manual-mode scope. |
| `ECONCURRENCY_LIMIT` | Per-(company, day, account) click-to-call cap reached. |
| `EENGINE_NOT_AVAILABLE` | `pbxVersion` is set to a value other than `20`. Only v20 is supported. |

### 3CX upstream

| Code | Meaning |
|---|---|
| `E3CX_AUTH` | OAuth token request rejected, or 401/403 after a refresh. |
| `E3CX_NOT_FOUND` | 3CX returned 404 for a resource (queue, extension, callId). |
| `E3CX_CONFLICT` | 3CX returned 409 (e.g. trying to park a call already parked). |
| `E3CX_RATE_LIMITED` | 3CX returned 429 even after retry. The plugin auto-retries once with `Retry-After`. |
| `E3CX_UPSTREAM` | 3CX returned 5xx. Often transient. |
| `E3CX_NETWORK` | TCP/DNS failure reaching the PBX. |
| `E3CX_HTTP_<status>` | Generic HTTP error not covered above. |
| `E3CX_CONFIG` | Misconfigured account (e.g. unknown mode). |
| `E3CX_CC_NOT_ENABLED` | The Call Control API checkbox isn't enabled on the Service Principal, or the originating extension isn't in the Service Principal's "Extension(s)" selector. Affects `pbx_click_to_call` only. |
| `E3CX_CC_NOT_IMPLEMENTED` | Tool requires the Call Control API engine which v0.1.0 only stubs. Ships in v0.2.0. Affects `pbx_park_call`, `pbx_pickup_park`, `pbx_transfer_call`. |
| `E3CX_NO_DEVICE` | The originating extension has no registered devices listed via `/callcontrol/{ext}/devices`. The agent must have at least one phone (deskphone, app, soft-client) registered. |
| `EUSER_NOT_MAPPED` | `pbx_click_to_call` was invoked with `fromUserId` / `fromUserEmail` but no matching entry exists in the User → Extension map. Add the user on the plugin settings page. |

## allowedCompanies — non-negotiable

Every account entry has an `allowedCompanies` array. The worker calls `assertCompanyAccess` on every tool invocation:

- Empty / missing → `ECOMPANY_NOT_ALLOWED`. **This is the fail-safe default**.
- `["*"]` → portfolio-wide (only meaningful in `single` mode; manual/native still need per-company routing entries).
- `[<companyId>, <companyId>, …]` → only those companies pass the gate.

Even after passing the access gate, in `manual` mode the company **also** needs a `companyRouting` entry, and in `native` mode it needs a `companyTenants` entry, or the call returns `ECOMPANY_NOT_ROUTED`.

## Telemetry

Every successful tool call emits `plugin.3cx-tools.<tool>` to the host telemetry pipeline with dimensions: `companyId`, `account`, `runId`, plus tool-specific dims (queue, slot, count). Use the cost-events service to aggregate and watch for runaway invocation patterns.

## State scopes used

The plugin writes to `instance`-scoped state with these keys:

- `clickToCallCounter:<companyId>:<YYYY-MM-DD>:<accountKey>` — daily counter for `maxClickToCallPerDay` enforcement.

(The OAuth token cache is held in process memory only — never persisted.)

## Validation against a real PBX

A standalone PowerShell suite lives at `scripts/live-test.ps1`. It mirrors
what each plugin tool does internally and probes your 3CX install
directly — no Paperclip server required. Run it after any change to your
Service Principal config or after upgrading 3CX:

```powershell
$env:XAPI_3CX_CLIENT_SECRET = '<the-rotated-secret>'
powershell -ExecutionPolicy Bypass -File scripts/live-test.ps1
```

It runs 11 numbered probes (OAuth → Defs → Queues → Users → Trunks →
ActiveCalls → CallHistoryView → ParkedCalls → today-stats → Call
Control devices → DropCall path) and prints PASS / FAIL / SKIP per probe.
Probe #11 is a guarded real outbound test (commented out) that you can
flip on to dial your mobile from a chosen extension.

## Local development loop

```bash
# from this folder:
pnpm install
pnpm typecheck
pnpm build
pnpm smoke      # runs the in-memory rejection + shape suite (12 cases)

# from your paperclip checkout:
pnpm --filter paperclipai exec tsx cli/src/index.ts plugin install --local <path-to>/paperclip-extensions/plugins/3cx-tools
# then after edits + pnpm build:
pnpm --filter paperclipai exec tsx cli/src/index.ts plugin reinstall 3cx-tools
```

## Roadmap

- **v0.5** — `pbx_trunk_status` for SIP-trunk registration health.
- **v0.6** — bridge with `phone-tools`: `pbx_transfer_call` accepting a `phone-tools` callId for AI→human hand-off.

## Out of scope

- Recording mutations (deleting, archiving). `pbx_recording_*` is read-only by design — a misbehaving agent deleting recordings is a worse failure mode than not having delete.
- Recording bulk export (per-call URLs are exposed via `pbx_call_history` when `exposeRecordings` is on).
- Agent login/logout via API.
- IVR / call-flow / queue config edits — manage in 3CX admin.
- SMS — closer to a separate `sms-tools` plugin shape.
