# `phone-tools`

Paperclip plugin that lets agents and operators place AI-driven phone calls through Vapi.ai. **v0.3.0 ships the Assistants UI** — a top-level "Assistants" sidebar entry, an 8-step builder wizard, a Phone tab on the agent detail page, "Place call" / "Test on my phone" modals, and a hard daily cost cap per assistant. The agent-tool surface from v0.1.0 still works the same way for skill / heartbeat consumers; the new UI is operator-facing.

## Quick start (do these once after install)

This walkthrough takes a fresh phone-tools install to a working warm-transfer + campaign setup. **Pre-req:** you've already wired the plugin to a Vapi account on the plugin settings page (see "Setup" tab, or the bigger walkthrough in [Setup section](#setup--outbound-calls-via-vapi) below).

### 1. Enable mutations

On `/instance/settings/plugins/phone-tools` → **Configuration** tab → toggle **"Allow place-call / hangup / assistant mutations"** ON.

Without this, every tool that places or controls a call returns `[EDISABLED]`. Default is OFF so a fresh install can't accidentally spend money.

### 2. Build at least one assistant

Navigate to the **Assistants** sidebar entry → **+ New assistant** → run the 8-step wizard. You'll be asked for voice, caller-ID, and a daily cost cap. Save.

If you don't see the Assistants sidebar entry, your company isn't in any account's `allowedCompanies` list — fix that on the plugin settings page first.

### 3. Configure warm transfer on the assistant

Open the assistant's detail page → **Phone** tab → scroll to the **Warm transfer** panel → click **Configure**.

Fill in:
- **Transfer destination (E.164)** — a number Vapi can dial that 3CX answers, e.g. `+15551234567`. This is typically a DID on your PBX whose inbound rule routes to the human extension or queue you want qualified leads to land on.
- **Spoken handoff line** *(optional)* — what the AI says right before the SIP bridge. Default is "One moment, I'm transferring you to a person who can help."
- **Auto-file qualified leads to project** *(optional)* — Paperclip project UUID where transferred-call issues should land. The human picking up sees the transcript-so-far as a board issue.

Save. The assistant now has the `transferCall` tool — it will hand off to your DID when a caller asks for a person, hits a problem the AI can't solve, or escalates.

### 4. Smoke-test the assistant

Same Phone tab → click **📲 Test on my phone**. Enter your mobile in E.164. The AI calls you within a few seconds. Try saying "transfer me to a real person" — your DID should ring.

If the AI's caller-ID shows as "Spam Likely" or "Unknown", you're still on Vapi's pooled number. Wire the 3CX SIP trunk per the [3CX SIP-trunk binding](#production--outbound-via-3cx-sip-trunk-byo-carrier) section below to get your own branded caller-ID. **This is a hard prerequisite for cold-call campaigns** — pooled numbers spam-flag fast.

### 5. Run your first campaign

Navigate to the **📋 Campaigns** sidebar entry → **+ New campaign**. Fill in the wizard:

| Section | What to enter |
|---|---|
| **1. Basics** | Driving assistant agent UUID (from step 2), campaign name, one-sentence purpose |
| **2. Lead list (CSV)** | Drag-drop a CSV with at minimum a `phone` column. Other useful columns: `name`, `businessName`, `website`. After loading the CSV, click **✨ Auto-detect columns** to fill the mapping from the header row — verify the result before continuing. |
| **3. Pacing** | Defaults are conservative (2 concurrent, 90s between dials, 30/hr, 200/day). Tune up only after a successful smoke run — predictive pacing (v0.5.5) auto-adjusts within bounded multipliers once 10+ calls complete, so you don't need to over-tune up-front. |
| **4. Compliance preflight** | Audience kind, list source, geographic scope (e.g. `US-PA, US-NJ`), business hours, opening disclosure, opt-out language. Tick both ack boxes. If your scope includes **FL / CA / OK / TX**, the opener must self-identify ("this is …") + state purpose ("calling about …") and your opt-out wording must contain an unambiguous opt-out phrase. |

Click **Create campaign (draft)** → you'll land on the detail view in `draft` status. Verify the leads imported correctly, then click **▶ Start**. The per-minute runner picks it up within ~60s; counters poll every 3s while the campaign is `running`.

**Pause / Resume / Stop** any time from the detail view. **Stop is terminal** — pending leads get marked disqualified.

### 6. Opt-outs (always-on)

The AI is taught (via the built-in `PHONE_DNC_PREAMBLE`) to invoke `add_to_dnc` whenever a recipient says "don't call again" / "remove me from your list" / similar. The number is added to the **per-account DNC list** automatically and never re-dialed by any campaign on that account.

The runner also cross-checks DNC before every dial. To inspect or manually add/remove DNC entries, agents can use the `phone_dnc_list` / `phone_dnc_add` / `phone_dnc_remove` tools (or the `/api/plugins/phone-tools/api/dnc` HTTP route).

### 7. Federal DNC cross-check (optional but recommended for B2C scopes)

Add a federal DNC URL on the plugin settings page so every campaign dial is cross-checked against the FTC registry (or a third-party scrubbing list, or your own corporate suppression list — any plain-text or single-column CSV of E.164 numbers works).

`/instance/settings/plugins/phone-tools` → **Configuration** tab → edit the account → fill:

| Field | What to enter |
|---|---|
| **Federal DNC list URL** | Any URL serving the list. For the FTC's National DNC Registry you need free **SAN registration** at [telemarketing.donotcall.gov](https://telemarketing.donotcall.gov); once approved you can point this field at the registry's per-area-code download URL. Alternatives: any DNC scrubbing service's published list, or a self-hosted text file. |
| **Federal DNC refresh interval (hours)** | Default 24 (matches the FTC's daily update cadence). |

Save. The cache populates on first use; force-refresh anytime with the `phone_dnc_federal_refresh` tool or `POST /api/plugins/phone-tools/api/dnc/federal/refresh`. Stale-on-error: if a refresh fails, the previous cache is reused — campaigns never silently lose the check.

To verify: `phone_dnc_federal_check { "phoneE164": "+15551234567" }` returns whether a number is on the cached list. Or visit `GET /api/plugins/phone-tools/api/dnc/federal` for the cache status.

### 8. Export the audit log (for compliance evidence)

Every campaign dial decision (dialed / skipped-account-dnc / skipped-federal-dnc / skipped-out-of-hours / skipped-concurrency-cap / etc.) appends to `audit:<accountKey>:<YYYY-MM-DD>` in plugin state. This is the regulatory evidence trail — what you hand to counsel if a TCPA complaint lands.

**Browser download (CSV):**
```
GET /api/plugins/phone-tools/api/audit?companyId=<companyId>&since=2026-05-01&until=2026-05-13&format=csv
```
Returns a `Content-Disposition: attachment` CSV with columns `at,decision,phoneE164,campaignId,callId,actor,note`.

**Agent tool:** `phone_audit_export { "since": "2026-05-01", "until": "2026-05-13" }` returns the same data as JSON with an embedded `csv` field.

Plugin state has a 30-day default TTL. For longer-term retention (FTC suggests at least 5 years for sales-call records), run the export tool periodically and dump to external cold storage.

### 9. Predict campaign cost + run time

Before / during a campaign, the `phone_campaign_predict` tool answers "how long will this take and what will it cost?":

```
phone_campaign_predict { "campaignId": "c_abc123" }
```

Returns: pending lead count, estimated wall-clock minutes to drain, estimated remaining cost, plus the adjusted pacing the runner is using this tick (with a rationale string explaining why — low/mid/high answer-rate band).

When the campaign has fewer than 10 completed calls, the prediction uses fallbacks (90s mean duration, $0.07/call) and surfaces a "low confidence" note. After 10+ calls, the estimate switches to the observed rolling mean.

### 10. Multi-company portfolio rollup (HQ view)

If you run phone campaigns across multiple LLCs, the **🌐 Portfolio rollup** link in the Campaigns sidebar (top-right of the list view) aggregates today's dialed / qualified / transferred / cost counters across every LLC into one view. Refreshes every 30s.

Most useful when viewed from your **HQ / portfolio-root** company — non-HQ callers see only their own LLC's stats but the page still renders gracefully.

Direct API: `GET /api/plugins/phone-tools/api/campaigns/portfolio-rollup?companyId=<companyId>`.

---

## Troubleshooting cheat sheet

| Symptom | Likely cause |
|---|---|
| `[EDISABLED]` on every tool | Step 1 — toggle mutations on |
| `[ECAMPAIGN_NO_TRANSFER]` when starting a campaign | Step 3 — assistant has no `transferTarget` |
| `[ECOMPLIANCE_NOT_ACKNOWLEDGED]` | Step 5 — both ack boxes must be ticked |
| `[ECOMPLIANCE_RISK_TOO_HIGH]` | You picked `consumer` audience with a non-first-party list. Change audience or list source |
| `[ECOMPLIANCE_STRICT_STATE_OPENER]` | Step 5 — scope includes FL/CA/OK/TX; opener must self-identify (e.g. "this is …") AND state purpose (e.g. "calling about …") |
| `[ECOMPLIANCE_STRICT_STATE_OPT_OUT]` | Step 5 — scope includes a strict state; opt-out must contain an unambiguous opt-out phrase ("don't call", "remove me", "take off the list", "opt out") |
| `[EFEDERAL_DNC]` on a dial | Step 7 — the destination is on the cached federal DNC list. Lead is skipped + audit-logged. Use `phone_dnc_federal_check` to verify. |
| `[ENO_FEDERAL_DNC_URL]` | You called `phone_dnc_federal_refresh` but the account has no `federalDncListUrl` configured — set it on the plugin settings page first (Step 7) |
| `[EFEDERAL_DNC_FETCH]` | Refresh GET to your `federalDncListUrl` returned non-2xx. Check the URL is reachable from the Paperclip server; stale-cache fallback means dials still happen against the old list. |
| Caller sees "Spam Likely" / unknown number | Step 4 — wire the 3CX SIP trunk for branded caller-ID |
| Sidebar doesn't show Assistants or Campaigns | Plugin settings → tick this company in `allowedCompanies` on the account |
| Lead status stuck on "calling" forever | Vapi webhook not reaching the plugin. Check `webhookSecretRef` is set + Vapi Server URL points at `/api/plugins/phone-tools/webhooks/vapi` |
| Campaign won't start: `[ECAMPAIGN_EMPTY]` | Import leads via the wizard's CSV step or `phone_lead_list_append` before clicking Start |
| Predictive pacing says "low sample; using fallback" | Normal until the campaign has 10+ completed calls. Adjustment kicks in past that threshold. |
| Portfolio rollup shows only one LLC | The plugin SDK's `ctx.companies.list` returned only that company. From an HQ / portfolio-root view, the call should fan out across every visible LLC. |
| Audit export returns empty | No dial decisions logged on the requested date range. Audit logging applies to campaign-driven dials only; manual `phone_call_make` calls aren't audited. |

---

## Recent changes

- **v0.5.9** — **Comprehensive Setup tab walkthrough.** The in-Paperclip Setup tab on `/instance/settings/plugins/phone-tools` previously stopped at the v0.1.0 Vapi onboarding + 3CX SIP trunk steps — nothing about warm transfer, campaigns, federal DNC, audit export, predictive pacing, or portfolio rollup. Rewritten as 11 sections (A–K) with a TOC table at the top showing time-to-complete and required-vs-optional for each: A. Vapi quickstart · B. Branded caller-ID via 3CX trunk · C. Build an assistant · D. Configure warm transfer · E. Run your first campaign (with the v0.5.4 ✨ Auto-detect callout and the strict-state opener/opt-out rules) · F. DNC compliance (per-account + federal) · G. Audit log export (CSV + agent-tool paths + retention note) · H. Predict cost + run time · I. Multi-LLC portfolio rollup · J. Troubleshooting (every `[E*]` code categorized by setup/campaign/compliance/DNC/call-time/CSV) · K. What's planned next. Pure docs-in-manifest change — no behavioral change, no new tools. Setup tab now stays in sync with the README's Quick Start.

- **v0.5.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.6** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.5** — **Predictive pacing + HQ portfolio rollup + faster live counters.** Closes Plan 14 Phase 4. (1) **Predictive pacing** — new `src/campaigns/pacing.ts` module computes a rolling answer-rate over the last 30 completed calls per campaign and adjusts effective `secondsBetweenDials` + `maxConcurrent` within bounded multipliers. Bands: low (<10% answered) tightens spacing 0.5× and bumps concurrency 1.5×; high (>40% answered) widens spacing 2× and holds concurrency; mid stays at configured values. Adjustments only apply once the sample reaches 10+ calls (early-campaign noise stays out). New tool `phone_campaign_predict` returns pending leads × estimated minutes-remaining + cost + the adjusted pacing the runner would use this tick. The webhook handler now appends every terminal call to the campaign's pacing window automatically. (2) **HQ portfolio rollup** — new top-right "🌐 Portfolio rollup" link from the Campaigns list view. New `PortfolioRollup` page-sub-view fetches `/api/plugins/phone-tools/api/campaigns/portfolio-rollup` which fans out across every visible company and aggregates today's dialed/qualified/transferred/cost counters. Most useful from HQ (the portfolio root) but degrades gracefully to single-company view from any LLC. New API route `campaigns.portfolio-rollup` backs it. (3) **Faster live counters** — CampaignDetail polling tightened from 10s to 3s while a campaign is `running` (idle campaigns don't poll). True SSE on `/campaigns/:id/events` deferred to v0.6.x. 10 new tests cover the pacing module (window CRUD, band classification, bounded multipliers, fallback estimates).

- **v0.5.4** — **Federal DNC + per-state TCPA presets + dial-decision audit log + CSV column auto-detect.** Closes Plan 14 Phase 3. (1) **Federal DNC** — new per-account `federalDncListUrl` field (any URL serving plain-text or single-column CSV of E.164 numbers; works with the FTC registry after SAN registration, third-party scrubbing services, or your own corporate suppression list). Cached per account with 24h refresh default; stale-on-error so a bad refresh never silently disables the check. Cross-checked before every campaign dial. New tools: `phone_dnc_federal_refresh`, `phone_dnc_federal_check`. New API routes: `GET /api/plugins/phone-tools/api/dnc/federal`, `POST /api/plugins/phone-tools/api/dnc/federal/refresh`. (2) **Per-state TCPA presets** — when geographic scope includes FL/CA/OK/TX (private-right-of-action / stricter-rules states), the preflight enforces additional opener requirements (clear self-identification + purpose disclosure) plus an unambiguous opt-out phrase in `optOutLanguage`. (3) **Audit log** — every campaign dial decision (dialed / skipped-account-dnc / skipped-federal-dnc / skipped-out-of-hours / skipped-concurrency-cap / skipped-daily-cap / skipped-hourly-cap / skipped-retry-cap / skipped-duplicate / error) appends to `audit:<accountKey>:<YYYY-MM-DD>` in `ctx.state`. New tool `phone_audit_export` returns the JSON or CSV; new API route `GET /api/plugins/phone-tools/api/audit?since=&until=&format=csv` for downloadable evidence. (4) **CSV column auto-detect** — a new `autoDetectMapping` helper (header keyword + data-shape scoring) suggests the column mapping; new "✨ Auto-detect columns" button in the campaign wizard fills the column inputs from the pasted CSV's first row. README also gains a top-of-file Quick Start so anyone reinstalling can get from zero to a running campaign without reading further.

- **v0.5.3** — Shortened the manifest `description` to fit Paperclip's 500-char cap. Release-notes content moved fully into this log. Fixes the "Invalid plugin manifest: description: String must contain at most 500 character(s)" install failure that blocked upgrading from v0.3.7 → v0.5.2.

- **v0.5.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.1** — **Campaigns UI page + 11 backing HTTP routes.** Closes the v0.5.0 UX gap where operators had to drive campaigns via curl/agent-tool calls only. New full-page extension at `/<companyPrefix>/plugins/phone-tools` with three sub-views routed via query params: **list** (filterable table of campaigns with progress + cost-today + status badge), **detail** (counters + leads table + start/pause/resume/stop buttons + compliance footer + 10s live-poll while running), **new** (4-section inline wizard with CSV-file-upload OR paste, all compliance preflight fields, TCPA/DNC ack checkboxes). New sidebar entry "📋 Campaigns" alongside "🤖 Assistants", visibility-gated by the same `assistants.sidebar-visible` rule. New module `src/api/campaigns-routes.ts` wraps the same `campaigns/state.ts` helpers the agent tools use — single source of truth for business logic, two transports (board-authed HTTP for UI, agent-runtime tools for skills). New capabilities: `ui.page.register`, `issues.create`. Federal DNC + per-state TCPA presets + predictive pacing land in v0.5.2.

- **v0.5.0** — **Outbound campaign mode (worker-only ship; UI in v0.5.1).** Implements [Plan 14](../../plugin-plans/14-phone-campaigns.md) Phase 1: campaign + lead + DNC primitives, 16 new tools, runner skill + per-minute routine. Cold-call lists with branded caller-ID become a real product surface — drop a CSV into a campaign, answer a 6-question compliance preflight, click start, watch the runner work the list within concurrency / pacing / business-hours / DNC budget. AI-invoked `add_to_dnc` mid-call is the opt-out path; warm transfer (v0.4.0) is what makes qualified leads actionable. Highlights: (1) **CompliancePreflight** is a non-skippable hard gate — refuses to start campaigns that lack TCPA/DNC ack, an assistant with `transferTarget`, a non-empty lead list, valid hours, opening disclosure, opt-out language, geographic scope; consumer audience requires a first-party list. (2) **Per-account DNC list** — every dial cross-checks before going out; skipped phones never leak into any campaign on the same account. (3) **Always-on `add_to_dnc` tool** auto-injected into every assistant (campaign or not) plus the `PHONE_DNC_PREAMBLE` so opt-out compliance is a baseline obligation. (4) **CSV import** with strict column mapping, BOM-handling, quoted fields, 10k-row cap. (5) **Lead-state machine** updates automatically via existing webhook path: `call.ended` / `call.transferred` / function-call `add_to_dnc` → status transitions + retry scheduling for no-answer/busy. (6) **Per-minute runner skill** at `skills/phone-campaign-runner/` paced by `pacing.secondsBetweenDials` and gated by `pacing.maxConcurrent` / `maxPerHour` / `maxPerDay`. New tools: `phone_campaign_create`/`update`/`start`/`pause`/`resume`/`stop`/`status`/`list`, `phone_lead_list_append`/`import_csv`/`status`, `phone_dnc_add`/`check`/`list`/`remove`. Compliance reference + per-state TCPA notes, federal DNC cross-check, and the Campaigns UI tab all land in v0.5.1.

- **v0.4.1** — **AgentPhoneTab UI for warm transfer.** New "Warm transfer" panel on the agent's Phone tab shows current `transferTarget` / `transferMessage` / `transferIssueProjectId` and an enabled/disabled badge. Click **Configure** (or **Edit**) to open a modal that validates the destination as E.164 and POSTs to the existing `assistants.phone-config.set` API — no curl required. **Disable** clears all three fields and removes the `transferCall` tool from the engine-side assistant on the next save. Closes the v0.4.0 UI gap (warm-transfer was API-only at ship time). No worker / engine changes — pure UI bundle additions, all writes route through the same three-state-semantics path the API already supports.

- **v0.4.0** — **Warm transfer to a human.** When an assistant has a `transferTarget` (E.164) set on its phone config, the engine injects Vapi's `transferCall` tool into the assistant — the AI can hand the leg off to a configured destination when the caller asks for a person, hits a problem the AI can't resolve, or escalates. Vapi handles the SIP REFER directly (no `3cx-tools` coupling needed); 3CX answers the destination DID via its normal inbound rules and routes to the human extension. New `call.transferred` event normalizes the handoff with destination, duration, AI's parting line, and cost. The webhook handler also runs terminal-state bookkeeping (concurrency slot release + cost telemetry, deduped against polling) and best-effort posts a Paperclip board issue under `transferIssueProjectId` containing the transcript-so-far so the human picking up sees full context. New per-assistant config fields: `transferTarget`, `transferMessage`, `transferIssueProjectId`, `transferIssueAssigneeAgentId` (set via the `phone_assistant_create`/`_update` tools or the `assistants.phone-config.set` API). A new transfer preamble is auto-appended to the safety preamble whenever `transferTarget` is set, telling the AI when to use the tool and when NOT to (don't transfer on first sign of mild frustration, don't transfer voicemail). Skills wanting custom routing can subscribe to `plugin.phone-tools.call.transferred` and file their own issues; the built-in auto-issue is opt-in via the project-id field.

- **v0.3.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.6** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.5** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.2** — Sidebar `Assistants` link no longer lower-cases the company prefix. The href used to render `/mme/assistants` while every other Paperclip route uses `/MME/...`; the `toLowerCase()` call was unnecessary and inconsistent with the rest of the app. Some route configurations are case-sensitive, so the bad casing could 404.
- **v0.3.1** — Patch bump. Includes the post-v0.3.0 voice-id qualification fix — bare OpenAI voice IDs (`alloy`/`echo`/`shimmer`/`onyx`/etc.) sent by the Assistant Builder wizard are now auto-qualified to `openai:<id>` server-side before they reach Vapi, fixing an `[EVAPI_400] voice.provider must be one of …` rejection.

## What's in v0.3.0

| Capability | Status |
|---|---|
| Outbound calls via Vapi (`phone_call_make`) | ✅ shipped, smoke-tested (12+ PSTN calls) |
| Call status / transcript / list / recording-URL | ✅ shipped |
| Vapi assistant CRUD with partial PATCH on update | ✅ shipped |
| AI self-hangup when goal is met | ✅ shipped, verified live |
| Multi-account, per-account `allowedCompanies` isolation, fail-safe deny | ✅ shipped |
| Mutations gated by `allowMutations` (live toggle, no restart) | ✅ shipped |
| Account / allowedCompanies / engineConfig edits hot-reload (no worker restart) | ✅ shipped |
| Per-account concurrency cap (`maxConcurrentCalls`) | ✅ shipped |
| Safety preamble auto-prepended to every assistant prompt (identity-claim resistance, PII refusal, anti-injection, AI-honesty) — survived adversarial prompt-injection in production | ✅ shipped |
| Cost telemetry on call termination (works for outbound-only setups via polling, dedup-protected from inbound webhook fan-out) | ✅ shipped |
| **Assistants sidebar entry** — visibility-gated to companies in any account's `allowedCompanies` | ✅ new in v0.3.0 |
| **Assistant Builder wizard** — 8 questions, no prompt-writing required, ~5 min from install to first real call | ✅ new in v0.3.0 |
| **Phone tab on Agent detail** — voice / caller ID / daily cap / today's spend bar / Place-call + Test-on-my-phone buttons / recent calls | ✅ new in v0.3.0 |
| **Per-assistant daily cost cap** (default $10/day, resets at UTC midnight) | ✅ new in v0.3.0 |
| **Operator's verified test number** (one-time, reused across all assistants) | ✅ new in v0.3.0 |

## Preview / partial (code shipped, not yet first-class)

| Capability | Why preview |
|---|---|
| Inbound calls (webhook → `plugin.phone-tools.call.received` event) | Needs `webhookSecretRef` populated, Vapi Server URL set, and a real DID routed to Vapi. Outbound is the verified path today. |
| `phone_call_end` (force-hangup) | Code path exists; not in regular smoke. |
| 3CX SIP-trunk routing | Needs Vapi-side BYO SIP config; quickstart uses Vapi's provisioned number, which carries fresh-VoIP / pooled-number reputation. The plugin's Setup tab walks you through it. |

## Future versions (planned)

| Version | What lands |
|---|---|
| v0.6.x | Inbound routes UI on the Phone tab (DID → Assistant mapping, business hours, voicemail-drop fallback); SSE live counters replacing the 3s poll on the campaign detail view. |
| v0.5.0 | DIY engine — Jambonz + Deepgram (STT) + Claude/GPT (LLM) + ElevenLabs (TTS, with Qwen-local fallback). Same `PhoneEngine` interface so it slots in without touching skills or wizards. Same engine dropdown on the account config. |
| Later | DTMF mid-call, voicemail-drop, mid-call function tools, deeper 3CX Call Control API integration, cross-plugin transfer (`phone-tools` → `pbx_transfer_call` on a 3CX-known callId for human-initiated mid-call handoffs) |

## Tools

Tools registered (agent-facing):

| Tool | Direction | Reads/Writes | Notes |
|---|---|---|---|
| `phone_call_make` | outbound | mutation | Place AI call to an E.164 number. |
| `phone_call_end` | both | mutation | Force-hangup an active call. |
| `phone_call_status` | both | read | Current status, duration, cost, end reason. |
| `phone_call_transcript` | both | read | Plain or structured transcript after call ends. |
| `phone_call_recording_url` | both | read | Signed URL to call audio (if recording enabled). |
| `phone_call_list` | both | read | List recent calls with filters. |
| `phone_assistant_list` | n/a | read | List configured assistants. |
| `phone_assistant_create` | n/a | mutation | Create a named assistant (idempotent on name). |
| `phone_assistant_update` | n/a | mutation | Patch an assistant (partial PATCH). |
| `phone_assistant_delete` | n/a | mutation | Remove an assistant. |
| `phone_number_list` | n/a | read | List engine-side phone numbers. |

## Scoped HTTP API (operator-facing, used by the Assistants UI)

Mounted under `/api/plugins/phone-tools/api/*`:

| Method | Path | What it does |
|---|---|---|
| `POST` | `/assistants/compose-preview` | Pure prompt composition from wizard answers. Returns `{firstMessage, systemPrompt}`. |
| `GET` | `/assistants/:agentId/phone-config` | Read per-assistant phone config + today's cost window. |
| `POST` | `/assistants/:agentId/phone-config` | Create or update per-assistant phone config. Mirrors the assistant onto Vapi. |
| `POST` | `/assistants/:agentId/phone-config/test` | Place a one-off test call to the operator's verified phone. |
| `GET` | `/assistants/:agentId/calls` | List the assistant's recent calls (last 7 days, max 25). |
| `POST` | `/assistants/:agentId/calls` | Place a one-off call (used by the "Have <name> call someone" modal). |
| `GET` | `/assistants/:agentId/calls/:callId/status` | Status snapshot for the live-transcript modal. |
| `GET` | `/assistants/:agentId/calls/:callId/transcript` | Structured transcript turns for the live-transcript modal. |
| `GET` | `/assistants/:agentId/calls/:callId/recording-url` | Short-lived signed URL to the call recording (if account has `recordingEnabled`). |
| `GET` | `/operator-phone` | The operator's verified test-call number, scoped per user. |
| `POST` | `/operator-phone` | Set/update the operator's verified test-call number. |
| `GET` | `/accounts/numbers` | List allow-listed phone-number IDs for the caller-ID dropdown. |

All routes are board-auth and resolve company via `?companyId=<uuid>`. Mutations on `:agentId` enforce the same `allowedCompanies` check as the agent tools — an assistant in company A can't be configured / called from company B.

## Events

Subscribe with `ctx.events.on("plugin.phone-tools.<event>", ...)`:

| Event | When |
|---|---|
| `plugin.phone-tools.call.received` | Inbound call rings; engine asks who should answer (preview path; needs webhooks). |
| `plugin.phone-tools.call.started` | Call connected. |
| `plugin.phone-tools.call.transcript.partial` | Live transcript chunk during call. |
| `plugin.phone-tools.call.transcript.final` | Full transcript after call ends. |
| `plugin.phone-tools.call.ended` | Call terminated; payload includes `durationSec`, `costUsd`, `endReason`. The plugin also accumulates the call's cost into the originating assistant's daily cap window at this point. |
| `plugin.phone-tools.call.function_call` | The in-call assistant invoked one of its tools. |

## Setup

The full operator-walkthrough lives on the **Setup** tab of the plugin's settings page in Paperclip — that's the authoritative source and includes screenshots of every Vapi / 3CX panel. **About 15–20 minutes** for first-time setup.

Quick orientation before you click in:

1. **Vapi.ai** — sign up, create a Private API Key, optionally provision a phone number for the quickstart path (Vapi's provisioned number works but recipients see "Spam Likely" — fine for smoke tests, not for real customer calls).
2. **Paperclip secret** — create a secret holding the Vapi Private API Key. Per company that will use phone tools.
3. **Plugin settings → Configuration tab** — add an account: `key=main`, `engine=vapi`, paste the secret UUID, set `defaultNumberId` to the Vapi number's UUID (run `phone_number_list` once if you forgot), tick the company under `allowedCompanies`. Save.
4. **(Optional, for production)** — follow the **Setup** tab's "Production via 3CX SIP trunk" section to route calls through your own DID for branded caller-ID. Skips the "Spam Likely" label.
5. **Flip `allowMutations` on** when you're ready to actually place calls.

Smoke-test with `scripts/smoke-outbound.sh` (Bash) or `scripts/smoke-outbound.ps1` (PowerShell) — places a 30-second test call with a built-in demo assistant and prints the transcript. Cost: ~$0.07.

### Dev-redeploy loop

After `pnpm build`, push the new `dist/` into the running plugin and cycle the worker in one shot:

```bash
bash scripts/dev-redeploy.sh
```

The script calls `paperclipai plugin reinstall phone-tools --local-path <dir>`. Plain `pnpm build` does NOT auto-refresh the installed copy — `paperclipai plugin reinstall` is what bridges source → installed copy.

## Operator-facing UI surface

When the plugin is installed AND the current company is in any account's `allowedCompanies` list, the operator sees:

- **Assistants** entry in the company sidebar, right under the Agents section. (Hidden otherwise — fail-safe deny.)
- **Assistants list page** at `/:companyPrefix/assistants` — filtered to agents with `role: "assistant"`. Empty state has "+ Create your first Assistant" CTA.
- **Assistant Builder wizard** at `/:companyPrefix/assistants/new` — 8 steps: type (Personal EA / Custom), name, principal, capability tasks, capability checklist (Phone enabled, Email/Calendar/SMS coming soon), voice (with inline play buttons backed by the OpenAI CDN voice samples), caller ID, and review-with-Test-on-my-phone.
- **Phone tab on AgentDetail** for any agent with `role: "assistant"` — voice, caller ID, daily cap with today's-spend bar, Place-call modal, Test-on-my-phone modal, recent calls list. The tab pane is empty for non-assistant roles (CEO/CFO/etc.) — the manifest can't filter by role today, only by entity type.

The wizard creates the Agent via `POST /api/companies/:id/agent-hires` (so companies that require board approval go through the approval queue; the wizard auto-approves on personal-fork setups). It writes the composed system prompt into the agent's instructions bundle (`AGENTS.md`) using the same write path the existing Instructions tab uses, so the operator can later edit the prompt freely.

## Sample agent-tool invocations

The agent tools haven't changed; existing skills/heartbeats work the same. Place an outbound call:

```json
{
  "tool": "phone_call_make",
  "params": {
    "to": "+15551234567",
    "assistant": {
      "name": "AppointmentBooker",
      "systemPrompt": "You are calling on behalf of <CALLER NAME> to book a haircut. The shop is 'Sharp Cuts'. Preferred times: Tuesday or Wednesday afternoon, between 2pm and 5pm. Be polite, brief, and confirm the booking time before hanging up.",
      "firstMessage": "Hi, this is an automated assistant calling on behalf of <CALLER NAME>. I'd like to book a haircut. Is this a good time to chat?",
      "voice": "openai:alloy",
      "model": "openai:gpt-4o"
    },
    "metadata": { "issueRef": "iss_abc123" },
    "idempotencyKey": "issue:iss_abc123:booking-attempt"
  }
}
```

Voice spec is `provider:voiceId`. The Assistants wizard handles this automatically — bare OpenAI voice IDs (`alloy`, `echo`, `shimmer`, `onyx`, etc.) get qualified to `openai:<id>` server-side. Tool callers that pass a fully qualified `provider:voiceId` work unchanged.

Subscribe to inbound calls (in your skill / heartbeat):

```ts
ctx.events.on("plugin.phone-tools.call.received", async (event) => {
  // event.payload = { kind, callId, from, to, numberId, assistantId?, startedAt, accountKey, engine }
});
```

## Cost cap (Assistants only)

Every assistant has a daily USD cap. Defaults to `$10/day`. Stored per-agent in plugin state under `assistants:cost-window:<agentId>:<YYYY-MM-DD>`.

- The cap fires inside the wrapper around `phone_call_make` paths used by the Assistants UI (the `/assistants/:agentId/calls` and `/assistants/:agentId/phone-config/test` routes). Calls over the cap return `[ECOST_CAP]` with a message and the cap resets at UTC midnight.
- The cost is accumulated when each call's terminal state is observed (poll OR webhook, whichever fires first — dedup-protected).
- Operator can change the cap on the Phone tab → Daily cap input. Setting to `0` disables the gate (operator opt-out; plugin doesn't enforce).
- Direct `phone_call_make` invocations from agent runs (not via the Assistants UI) bypass the cap today — they're governed by the per-account `maxConcurrentCalls` and the cross-plugin budget service. Routing those through the cap too is a v0.4 enhancement.

## Error codes

| Code | Meaning |
|---|---|
| `[EACCOUNT_REQUIRED]` | Tool was called without `account` and there's no `defaultAccount`. |
| `[EACCOUNT_NOT_FOUND]` | The named account doesn't exist on the settings page. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in the account's `allowedCompanies`. |
| `[ENUMBER_NOT_ALLOWED]` | The phone-number ID isn't in the account's `allowedNumbers`. |
| `[EASSISTANT_NOT_ALLOWED]` | The assistant ID isn't in the account's `allowedAssistants`, OR an inline assistant was passed when only ID-based assistants are allowed. |
| `[ECONCURRENCY_LIMIT]` | Account already has `maxConcurrentCalls` outbound calls in flight. |
| `[ECOST_CAP]` | Per-assistant daily USD cap reached. Resets at UTC midnight (operator-timezone reset is a future enhancement). |
| `[ERECORDING_DISABLED]` | `phone_call_recording_url` was called on an account with `recordingEnabled=false`. |
| `[EDISABLED]` | A mutation tool was called while the master `allowMutations` switch is off. |
| `[EENGINE_NOT_AVAILABLE]` | Account selected `engine: "diy"` but DIY ships in v0.5.0. |
| `[EENGINE_UNKNOWN]` | Account selected an engine kind that isn't recognized. |
| `[EINVALID_INPUT]` | A required parameter was missing/empty. |
| `[ECONFIG]` | Plugin config is wrong (missing apiKeyRef, secret didn't resolve, etc.). |
| `[EVAPI_AUTH]` / `[EVAPI_FORBIDDEN]` / `[EVAPI_NOT_FOUND]` / `[EVAPI_INVALID]` / `[EVAPI_RATE_LIMIT]` / `[EVAPI_NETWORK]` / `[EVAPI_<status>]` | Upstream Vapi errors mapped from HTTP status. |

## Company-isolation contract

Every account carries `allowedCompanies`. Default is **deny**: a missing or empty list = unusable. `["*"]` = portfolio-wide. Per the Paperclip plugin convention, every tool reads `runCtx.companyId` and refuses to operate against an account whose allow-list excludes it.

In addition to the account-level check, individual phone numbers and assistants can be further restricted via `allowedNumbers` / `allowedAssistants`. Tools enforce these; `phone_number_list` and `phone_assistant_list` filter the response so an agent in company A doesn't even *see* numbers / assistants scoped to company B.

The Assistants sidebar and Phone tab apply the same gate — they don't render for companies that aren't allow-listed in any account.

**Inbound webhooks** are emitted per-company. The plugin fans out the event to every company in the receiving account's `allowedCompanies`. Accounts using `["*"]` portfolio-wide do **not** emit inbound events (no obvious target); narrow the allow-list to specific company UUIDs to enable inbound.

## Cost considerations

- Vapi: ~$0.05/min on top of underlying model + voice provider costs (typically $0.10–0.25/min total).
- 3CX SIP trunk to PSTN: whatever your trunk provider charges (Twilio, Telnyx, your local CLEC, etc.). Usually $0.01–0.02/min.
- Total: rough order of magnitude **$0.10–0.30 per minute** of conversation.
- The `maxConcurrentCalls` per-account cap (default 3) is the per-account guardrail.
- The per-assistant daily `costCapDailyUsd` (default $10) is the per-assistant guardrail.
- `ctx.telemetry.track("phone-tools.call.vapi", { durationSec, costUsd, … })` fires on every `call.ended`, so the cost-events service aggregates it.

## Recording + consent

Leave `recordingEnabled` **off** unless you've added an audible consent disclosure to your assistant's `firstMessage`. Many US states (and most of Canada / EU) require explicit two-party consent. The plugin does not auto-inject the disclosure — that's intentionally on the operator so the wording fits the use case.

## Tests

Pure-function unit tests live alongside the implementation:

- `src/assistants/compose.test.ts` — prompt composition (10 cases)
- `src/assistants/cost-cap.test.ts` — daily-cap accounting (10 cases)
- `src/assistants/sidebar-visibility.test.ts` — sidebar visibility predicate (7 cases — including the three the Phase A plan calls out manually)

Run with `pnpm test` (uses `node --test --import tsx`).

## Limitations / out of scope (today)

- DTMF mid-call (`phone_dtmf_send`).
- Warm transfer to a human extension (`phone_call_transfer`).
- Voicemail-drop (record + leave without ringing).
- Multi-party conferencing.
- Direct integration with the 3CX Call Control API for richer routing.
- Per-call budget enforcement at the `cost-events` service layer (separate cross-plugin budget API; today the per-assistant daily cap is the closest thing).
- Cost cap on direct `phone_call_make` invocations from agent runs (Assistants UI flows are gated; agent-tool flows aren't yet).
- Operator-timezone cap reset (cap currently rolls over at UTC midnight).
- Voice cloning, multi-language assistants, A/B prompt testing — out of scope until further notice.
