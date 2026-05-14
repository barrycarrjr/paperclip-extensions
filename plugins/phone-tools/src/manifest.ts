import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "phone-tools";
const PLUGIN_VERSION = "0.5.9";

const accountItemSchema = {
  type: "object",
  required: ["key", "engine", "apiKeyRef", "allowedCompanies"],
  propertyOrder: [
    "key",
    "displayName",
    "engine",
    "apiKeyRef",
    "webhookSecretRef",
    "engineConfig",
    "defaultNumberId",
    "defaultAssistantId",
    "allowedNumbers",
    "allowedAssistants",
    "recordingEnabled",
    "maxConcurrentCalls",
    "federalDncListUrl",
    "federalDncRefreshHours",
    "allowedCompanies",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass to phone tools (e.g. 'main', 'private'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it. Must be unique across accounts.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description: "Human-readable label shown on this settings page only.",
    },
    engine: {
      type: "string",
      enum: ["vapi", "diy"],
      default: "vapi",
      title: "Engine",
      description:
        "Which voice-AI backend handles this account. 'vapi' = Vapi.ai (managed, hosted; ~$0.05/min on top of model costs). 'diy' = self-hosted Jambonz + OpenAI Realtime (ships in v0.2.0; selecting it now returns [EENGINE_NOT_AVAILABLE] so the field is forward-compatible).",
    },
    apiKeyRef: {
      type: "string",
      format: "secret-ref",
      title: "Engine API key",
      description:
        "Paperclip secret holding the engine's API key. For Vapi: get a Private API Key from https://dashboard.vapi.ai → Org → API Keys (NOT the public/web key — those can't initiate calls). Create the secret first on the company's Secrets page; never paste the raw token here.",
    },
    webhookSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "Webhook signing secret",
      description:
        "Paperclip secret holding the HMAC secret used to verify inbound webhooks. For Vapi: configure under Org → Server URL (the 'serverUrlSecret' field). Set the matching value as a Paperclip secret and reference it here. Required: webhooks without a verified signature are rejected and no events are emitted. Leaving this blank disables verification (useful only for local dev — log warning emitted at startup).",
    },
    engineConfig: {
      type: "object",
      title: "Engine-specific config",
      description:
        "Engine-specific extras. For Vapi: optional `voicemailDetectionProvider` (string; one of 'google' / 'twilio' / 'openai') to override the answering-machine-detection service Vapi uses — defaults to 'google'. NOT a reference to your carrier; this is Vapi's internal AMD choice. For DIY (v0.3.0): jambonzAccountSid, jambonzApplicationSid, openaiApiKeyRef, realtimeModel, realtimeVoice.",
      additionalProperties: true,
    },
    defaultNumberId: {
      type: "string",
      title: "Default phone-number ID",
      description:
        "Engine-side phone-number ID used when phone_call_make omits `from`. Get the ID by running phone_number_list once after setup — it's the engine's UUID, NOT the E.164 number. Must be in 'Allowed phone-number IDs' if that list is set.",
    },
    defaultAssistantId: {
      type: "string",
      title: "Default assistant ID",
      description:
        "Engine-side assistant ID used when phone_call_make omits `assistant`. Get the ID by running phone_assistant_list, OR create one with phone_assistant_create and copy the returned ID. Must be in 'Allowed assistant IDs' if that list is set.",
    },
    allowedNumbers: {
      type: "array",
      items: { type: "string" },
      title: "Allowed phone-number IDs",
      description:
        "If non-empty, restricts phone_call_make to these phone-number IDs. Useful when one Vapi org has many numbers but only one should be visible to agents in this company. Empty = unrestricted within the account.",
    },
    allowedAssistants: {
      type: "array",
      items: { type: "string" },
      title: "Allowed assistant IDs",
      description:
        "If non-empty, restricts phone_call_make to these assistant IDs (and prevents phone_call_make from accepting an inline ad-hoc assistant config). Empty = all assistants under this account allowed, AND inline configs are accepted.",
    },
    recordingEnabled: {
      type: "boolean",
      default: false,
      title: "Enable call recording",
      description:
        "When true, the engine records the audio and the recording URL is available via phone_call_recording_url. CONSENT NOTICE: many jurisdictions require an audible disclosure ('this call may be recorded') at the start. The plugin does not inject this — your assistant's firstMessage must include it. Default false to be conservative.",
    },
    maxConcurrentCalls: {
      type: "number",
      default: 3,
      title: "Max concurrent outbound calls",
      description:
        "Per-account cap on simultaneous outbound calls. phone_call_make returns [ECONCURRENCY_LIMIT] if exceeded. Prevents a runaway agent from blowing through PSTN minutes. Default 3.",
    },
    federalDncListUrl: {
      type: "string",
      title: "Federal DNC list URL (optional)",
      description:
        "URL pointing at a plain-text or single-column CSV of E.164 numbers to treat as federally do-not-call. Fetched periodically and cached per-account. Use this with the FTC's National DNC Registry (after free SAN registration), a third-party scrubbing service's published list, or your own corporate suppression list. Empty = no federal check (account-local DNC still applies). Cross-checked before every campaign dial; manual phone_call_make is unaffected.",
    },
    federalDncRefreshHours: {
      type: "number",
      default: 24,
      minimum: 1,
      title: "Federal DNC refresh interval (hours)",
      description:
        "How long the cached federal DNC list may live before refresh. Default 24h (matches the FTC's daily update cadence). Stale-on-error: if a refresh fails, the previous cached set is reused and the dial proceeds against the older list rather than skipping the check.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may use this phone account. Tick 'Portfolio-wide' for ['*']; otherwise tick specific companies. Empty = unusable (fail-safe deny). A phone account typically belongs to one LLC — prefer single-company lists.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup walkthrough — phone-tools

Takes a freshly installed plugin all the way to running revenue-generating AI phone campaigns. **Plan ~30 minutes total** if you do every section; the bare minimum to make a test call is **Section A** alone (~10 min).

The setup splits into eleven sections — read them in order or jump to whichever applies:

| Section | What it covers | Required? | Time |
|---|---|---|---|
| **[A](#a-vapi-account--first-call-quickstart)** — Vapi account + first call | Sign up for Vapi, create API key + free phone number, wire to the plugin, place a test call | ✅ Required | ~10 min |
| **[B](#b-branded-caller-id-3cx-sip-trunk)** — Branded caller-ID (3CX SIP trunk) | Replace Vapi's pooled "Spam Likely" number with your own DID via a 3CX SIP trunk | ⚠️ Required for cold-call campaigns | ~15 min |
| **[C](#c-build-an-assistant)** — Build an AI assistant | 8-step wizard for the AI persona that drives calls (voice / caller-ID / daily cap) | ✅ Required | ~5 min |
| **[D](#d-configure-warm-transfer)** — Warm transfer to a human | AI hands the call off to a human DID when the prospect asks for a person | 🔶 Strongly recommended | ~3 min |
| **[E](#e-run-your-first-outbound-campaign)** — Run your first outbound campaign | Drop a CSV of leads, answer the compliance preflight, hit Start | ✅ Required for campaigns | ~10 min |
| **[F](#f-dnc-compliance)** — DNC compliance | Per-account DNC (always on) + optional Federal DNC cross-check | 🔶 Federal DNC strongly recommended | ~5 min |
| **[G](#g-export-the-audit-log)** — Export the audit log | Every dial decision is logged; CSV download for compliance evidence | 🔶 For regulated workflows | ~1 min |
| **[H](#h-predict-campaign-cost--run-time)** — Predict cost + run time | "How long will this campaign take? What will it cost?" | Optional | ~1 min |
| **[I](#i-multi-llc-portfolio-rollup)** — Multi-LLC portfolio rollup | Cross-company campaign dashboard at HQ | For multi-LLC operators | ~1 min |
| **[J](#j-troubleshooting)** — Troubleshooting | Every \`[E*]\` error code with cause + fix | Reference | — |
| **[K](#k-whats-planned-next)** — What's planned next | v0.6.x roadmap | Reference | — |

---

# A. Vapi account + first call (Quickstart)

This section gets a working AI phone call placed via Vapi's pooled number. Recipients will see "Spam Likely" / "Unknown" caller-ID until you complete Section B — that's fine for smoke testing but **not appropriate for real customer calls**. Do this section first to verify the loop works end-to-end, then layer Section B before going live.

### A1. Vapi account

Sign up at [https://dashboard.vapi.ai](https://dashboard.vapi.ai) if you don't already have one. Free tier is fine for setup.

### A2. Create a Vapi Private API Key

In the Vapi dashboard:

- Go to **Org → API Keys**
- Click **Create new key**
- Choose **Private API Key** — **NOT** the public/web key (those can't initiate calls)
- Copy the key

### A3. Provision a Vapi phone number (Quickstart only)

Still in Vapi dashboard:

- Go to **Phone Numbers → Add Phone Number**
- Choose **Vapi Phone Number** (the free one). Skip "BYO SIP Trunk" — that's Section B
- After it's created, **copy the phone-number's ID** (a UUID — NOT the E.164 number itself). You'll paste it as \`defaultNumberId\` in step A5

### A4. Create a Paperclip secret holding the Vapi API key

In Paperclip, switch to the company that should own this phone account (typically the LLC the calls are made on behalf of):

- Go to **Secrets → Add**
- Name it \`vapi-api-key\`
- Paste the Vapi Private API Key from step A2 as the value
- Save, then **copy the secret's UUID** — you'll paste it into the plugin settings next

### A5. Configure the plugin

Open the plugin's **Configuration** tab. You'll see an empty **Phone accounts** list. Click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | \`main\` |
| **Display name** | (whatever you want, e.g. "Acme Corp — main") |
| **Engine** | \`vapi\` |
| **Engine API key** | paste the secret UUID from step A4 |
| **Webhook signing secret** | leave blank for outbound-only Quickstart |
| **Default phone-number ID** | the UUID from step A3 |
| **Default assistant ID** | leave blank for now — you'll set this in Section C |
| **Enable call recording** | leave off (consent law; revisit later) |
| **Max concurrent outbound calls** | \`3\` (default) |
| **Federal DNC list URL** | leave blank — Section F covers this |
| **Allowed companies** | tick the company you want to use this account |

Then at the top of the Configuration tab:

- **Default account key:** \`main\`
- **Allow place-call / hangup / assistant mutations:** **enable** when you're ready to actually place calls

Save.

### A6. Smoke-test

Section C builds the first assistant — once that's done, the easiest smoke test is the **📲 Test on my phone** button on the agent's Phone tab.

If you'd rather smoke-test before building an assistant, the plugin ships a shell script that uses a built-in demo persona:

\`\`\`bash
cd <paperclip-extensions>/plugins/phone-tools
PAPERCLIP_COOKIE='<your-session-cookie>' \\
COMPANY_ID='<the-company-uuid-you-allow-listed>' \\
AGENT_ID='<an-agent-uuid-in-that-company>' \\
RUN_ID='<any-recent-heartbeat-run-uuid>' \\
TO='+1XXXXXXXXXX' \\
./scripts/smoke-outbound.sh
\`\`\`

~30-second test call. Costs about \\$0.07.

✅ If the call rings out and the AI speaks its first line — Section A is done.

---

# B. Branded caller-ID (3CX SIP trunk)

This is what replaces Vapi's pooled "Spam Likely" number with **your own DID**, so recipients see a branded number from your area code. **Hard prerequisite for any cold-call campaign** — pooled-number reputation tanks after 50 dials.

**Prerequisites:** 3CX **Pro** or **Enterprise** license (Standard/Free doesn't support custom SIP trunks).

There are four sub-steps. Skipping any one breaks the loop silently.

### B1. Create a SIP trunk credential in Vapi

In the Vapi dashboard:

- Go to **Settings → Integrations**
- Scroll to **Phone Number Providers** → click **SIP Trunk**
- Click **Add New SIP Trunk**
- Fill in:
  - **Name**: anything recognizable, e.g. \`3CX (main)\`
  - **Gateway #1 → IP Address / Domain**: your 3CX server's public FQDN or IP, e.g. \`pbx.example.com\`
  - **Port**: \`5060\` (or \`5061\` if your 3CX is on TLS)
  - **Netmask**: \`32\`
  - **Outbound Protocol**: \`UDP\`
  - ☑ **Allow inbound calls**, ☑ **Allow outbound calls**
  - Leave **Authentication** (Username / Password) blank — IP-based auth is recommended
  - Leave **Use SIP Registration** unchecked
- Click **Save SIP Trunk**

> **IP-based vs. registration auth.** IP-based is recommended: leave creds blank and unchecked. Vapi sends SIP traffic by source IP and 3CX accepts based on the IP allowlist you set in B3. If you'd rather Vapi register like a softphone, check **Use SIP Registration** and supply the SIP creds of a 3CX extension you create for Vapi — then B3 becomes "create an extension" instead of "create a trunk".

### B2. Attach your DID to the SIP trunk credential

Still in the Vapi dashboard:

- Go to **Phone Numbers → Create Phone Number**
- Choose **BYO SIP Trunk Number**
- Fill in:
  - **Phone Number**: the E.164 DID you want as caller-ID, e.g. \`+12155551234\`
  - **SIP Trunk Credential**: pick the trunk you saved in B1
  - **Label**: optional human-readable name
- Click **Import SIP Phone Number**

> If the **SIP Trunk Credential** dropdown shows "No SIP trunks available", the trunk from B1 wasn't actually saved — go back and save.

**Copy the phone-number UUID** from the resulting entry (shown in the URL when you click into it). You'll paste it as \`defaultNumberId\` in B5.

### B3. Create the Vapi SIP trunk in 3CX

In the 3CX Admin Console:

- Go to **Voice & Chat** in the left nav
- Click **+ Add Trunk** at the top — NOT **+ Add Gateway** (different thing)
- Choose **Generic SIP Trunk**
- Fill in:
  - **Trunk Name**: \`Vapi\`
  - **Registrar/Server/Gateway hostname or IP**: leave blank for IP-based auth (or \`sip.vapi.ai\` for registration-based)
  - **Authentication**: IP-based → add Vapi's SIP origination IP ranges to the allowed IPs list ([Vapi's published IPs](https://docs.vapi.ai/sip) — they change). Registration-based → enter the username/password
  - **Codec**: G.711 µ-law (PCMU) as primary
- Save

> If 3CX is behind NAT, enable **STUN** in the trunk's advanced settings.

### B4. Add an outbound rule in 3CX

**This step is required.** Without it, calls from Vapi hit 3CX and immediately fail — 3CX logs "no outbound rule found for the number" and drops the call.

In the 3CX Admin Console:

- Go to **Outbound Rules** → **+ Add**
- Fill in:
  - **Rule Name**: \`Vapi outbound\`
  - **Calls from**: select the Vapi trunk you created in B3
  - **Route 1**: your Flowroute (or other PSTN) trunk that owns the DID you want as caller-ID
  - **Caller ID**: set to the E.164 DID from B2, e.g. \`+12155551234\`
- Save

### B5. Update \`defaultNumberId\` and re-smoke

Back on the plugin's **Configuration** tab:

- Edit the \`main\` account
- Change **Default phone-number ID** to the UUID from **B2** (the BYO-SIP number)
- Save

Run the smoke test again — the recipient should now see your branded DID instead of "Spam Likely".

> **Fresh BYO-trunk numbers also start with no caller-ID reputation.** The label clears with use over a few days/weeks. To skip the wait, register the number with a branded-caller-ID service like **First Orion / Numeracle / Hiya Connect** (\\$10–50/month/number).

---

# C. Build an assistant

The AI persona that drives calls. Each assistant is a Paperclip agent with \`role: "assistant"\` plus a phone config (voice, caller-ID, daily cost cap).

### C1. Open the Assistants page

In Paperclip's company sidebar, click **🤖 Assistants**.

> **Don't see the sidebar entry?** Your company isn't in any phone account's \`allowedCompanies\` list. Fix on the plugin Configuration tab → edit the account → tick this company.

### C2. Run the 8-step wizard

Click **+ New assistant** and walk the wizard:

| Step | What you'll be asked |
|---|---|
| 1 | Assistant **name** — e.g. "Alex" |
| 2 | **Principal** — who Alex is calling on behalf of, e.g. your business name |
| 3 | **Tasks** — what Alex can help with (schedule meetings / take messages / confirm appointments / follow up) |
| 4 | **Custom context** *(optional)* — extra detail the AI should know |
| 5 | **Voice** — pick a voice from the list (defaults to \`alloy\` if unsure) |
| 6 | **Caller-ID** — pick a Vapi phone-number ID (the dropdown is populated from your account) |
| 7 | **Daily cost cap** — defaults to \\$10/day. Resets at UTC midnight. Hard cap — calls refuse to start if exceeded. |
| 8 | Review + save |

The wizard creates the Paperclip agent record AND the engine-side Vapi assistant in one shot. You'll land on the agent's detail page.

### C3. Optionally set this as the account's default assistant

On the plugin Configuration tab, edit the account and set **Default assistant ID** to the agent's UUID. This is the assistant used when \`phone_call_make\` is called without an explicit \`assistant\` parameter — convenient for scripts/skills.

---

# D. Configure warm transfer

**What it does:** when the AI is on a call and the prospect asks for a human, the AI invokes its \`transferCall\` tool. Vapi places an outbound leg to a configured DID on your PBX — 3CX answers via its inbound rules and routes to the human extension.

**Why it matters:** without warm transfer, qualified leads have nowhere to go. **Campaigns refuse to start if their driving assistant has no transferTarget.**

### D1. Pick a destination DID

Pick a phone number that, when dialed, rings the human(s) you want qualified leads to land on. Typically a DID on your 3CX PBX whose inbound rule routes to a sales extension or queue.

Example: \`+12155551234\` rings ext 200 (Barry's desk phone).

### D2. Configure on the assistant's Phone tab

Open the assistant's detail page → **Phone** tab → scroll to the **Warm transfer** panel → click **Configure**.

| Field | Value |
|---|---|
| **Transfer destination (E.164)** | The DID from D1 |
| **Spoken handoff line** *(optional)* | What the AI says right before the bridge. Default: "One moment, I'm transferring you to a person who can help." Override for skill-specific tone. |
| **Auto-file qualified leads to project** *(optional)* | Paperclip project UUID where a board issue with the transcript-so-far should be filed on every transfer. The human picking up sees full context. |

Save.

### D3. Smoke-test warm transfer

Same Phone tab → **📲 Test on my phone** → enter your mobile. AI calls you. Say:

> "Can you transfer me to a real person?"

The AI should announce the transfer, then your DID rings. Pick up — the call bridges.

---

# E. Run your first outbound campaign

A campaign = a CSV of leads + an assistant + pacing rules + a compliance preflight. The runner skill (fires every minute) walks the list within budget. AI-invoked opt-outs auto-add to DNC. Qualified leads warm-transfer.

### E1. Open the Campaigns page

In Paperclip's company sidebar, click **📋 Campaigns** → **+ New campaign**.

### E2. Fill in the 4-section wizard

**1. Basics**

| Field | Value |
|---|---|
| **Driving assistant** | The Paperclip agent UUID for the assistant from Section C |
| **Campaign name** | e.g. \`Sample Pack 2026Q2\` |
| **Purpose** | One sentence spliced into the AI's opener, e.g. "introduce our quarterly print sample pack to local restaurant owners" |
| **Phone account** *(optional)* | \`main\` (the default account is used if blank) |
| **Outcome issue project** *(optional)* | Paperclip project UUID for qualified-lead issues. Defaults to the assistant's \`transferIssueProjectId\`. |

**2. Lead list (CSV)**

- Drag-drop a CSV file with at minimum a \`phone\` column. Other useful columns: \`name\`, \`businessName\`, \`website\`, \`timezone\`
- Or paste CSV text directly
- Click **✨ Auto-detect columns** — fills the column-mapping inputs from the header row
- Verify the auto-detected mapping (override any wrong guess)

CSV constraints: 10k rows max per import. Phones are normalized to E.164 (accepts "+", "(555) 123-4567", "5551234567" — anything that resolves to \`+[1-9]\\d{6,14}\`). DNC-listed phones are skipped on import.

**3. Pacing**

Defaults are conservative:

| Field | Default |
|---|---|
| Max concurrent | 2 |
| Seconds between dials | 90 |
| Max calls / hour | 30 |
| Max calls / day | 200 |

Tune up only **after** a successful smoke run. Predictive pacing (Section H) auto-adjusts within bounded multipliers after 10+ calls, so don't over-tune up front.

**4. Compliance preflight** ⚠️ **non-skippable**

| Field | What to enter |
|---|---|
| **Audience kind** | b2b-businesses *(safest)* / b2b-with-soleprop / consumer |
| **Audience justification** | Free-form, e.g. "local restaurants — public business lines, B2B carve-out applies" |
| **List source** | first-party-customers / first-party-inquired / scraped-public-business / rented / purchased / other |
| **List source note** | Free-form. Required for \`purchased\` / \`rented\` lists. |
| **Geographic scope** | ISO 3166-2 codes, e.g. \`US-PA, US-NJ\`. ⚠️ **Including FL / CA / OK / TX triggers stricter opener + opt-out rules.** |
| **Caller-local business hours** | Start hour, end hour, weekends allowed? Default 9–18 weekdays. The runner converts each lead's TZ at dial time. |
| **Opening disclosure** | What the AI says first. Must self-identify ("this is …") + state purpose ("calling about …"). Default template provided. |
| **Opt-out language** | How the AI offers opt-out. Must contain an unambiguous opt-out phrase. |
| **Acknowledgements** | ☑ TCPA reviewed · ☑ DNC will be honored — both required |

Click **Create campaign (draft)** → you'll land on the detail view in \`draft\` status.

### E3. Start the campaign

Verify the leads imported (lead count > 0 on the detail view), then click **▶ Start**.

The per-minute runner picks it up within ~60s. Counters poll every 3s while \`running\`.

**Controls** on the detail view: ⏸ Pause · ▶ Resume · ⏹ Stop.

> **⏹ Stop is terminal.** Pending leads get marked disqualified. Create a new campaign to revisit the list.

---

# F. DNC compliance

Two layers. The first is always on; the second is optional but strongly recommended for any consumer-touching scope.

### F1. Per-account DNC (always on)

Every assistant gets the \`add_to_dnc\` function tool injected automatically, plus a built-in preamble teaching the AI when to invoke it:

> "When the recipient says 'don't call again' / 'stop calling' / 'remove me' / similar — invoke \`add_to_dnc\` immediately, briefly acknowledge ('you won't hear from us again'), end the call."

When invoked mid-call, the number is added to the **per-account DNC list** and never re-dialed by any campaign on that account. The runner also cross-checks DNC before every dial.

**Manual DNC management** (agent tools):

| Tool | Use |
|---|---|
| \`phone_dnc_add\` | Add a number manually (with optional \`reason\`) |
| \`phone_dnc_check\` | Is this number on DNC? |
| \`phone_dnc_list\` | List all DNC entries on an account |
| \`phone_dnc_remove\` | Remove an entry — requires audit \`note\` |

HTTP equivalent: \`GET / POST /api/plugins/phone-tools/api/dnc\`.

### F2. Federal DNC cross-check (optional, recommended for B2C scopes)

Adds a second-layer DNC check against any URL serving a plain-text or single-column CSV of E.164 numbers. Works with:

- **FTC National DNC Registry** — register for free at [telemarketing.donotcall.gov](https://telemarketing.donotcall.gov) to get a SAN (Subscription Account Number). Once approved, point this field at the registry's per-area-code download URL.
- **Third-party scrubbing service** — Numeracle / Caller ID Reputation / etc. — paste the URL they give you.
- **Self-hosted suppression list** — any plain-text file at any URL the Paperclip server can reach.

**To configure:**

Plugin Configuration tab → edit the account → fill:

| Field | Value |
|---|---|
| **Federal DNC list URL** | Any URL serving plain-text or single-column CSV of E.164 numbers |
| **Federal DNC refresh interval (hours)** | Default 24 (matches FTC's daily update cadence) |

Save. The cache populates on first use. Force-refresh anytime via the \`phone_dnc_federal_refresh\` tool or:

\`\`\`
POST /api/plugins/phone-tools/api/dnc/federal/refresh?companyId=<companyId>
\`\`\`

**Verify a single number:**

\`\`\`
phone_dnc_federal_check { "phoneE164": "+15551234567" }
\`\`\`

Or: \`GET /api/plugins/phone-tools/api/dnc/federal\` for the cache status.

> **Stale-on-error:** if a scheduled refresh fails (URL unreachable, 5xx), the previous cached set is reused and dials proceed against the older list. Better to dial through a 30h-old DNC than to silently skip the check.

---

# G. Export the audit log

Every campaign dial decision (dialed / skipped-account-dnc / skipped-federal-dnc / skipped-out-of-hours / skipped-concurrency-cap / etc.) appends to plugin state. This is the **regulatory evidence trail** — what you hand to counsel if a TCPA complaint lands.

### G1. Browser download (CSV)

\`\`\`
GET /api/plugins/phone-tools/api/audit?companyId=<companyId>&since=2026-05-01&until=2026-05-13&format=csv
\`\`\`

Returns a \`Content-Disposition: attachment\` CSV with columns:

| Column | Meaning |
|---|---|
| \`at\` | ISO 8601 timestamp of the decision |
| \`decision\` | One of: dialed · skipped-account-dnc · skipped-federal-dnc · skipped-out-of-hours · skipped-concurrency-cap · skipped-daily-cap · skipped-hourly-cap · skipped-retry-cap · skipped-duplicate · error |
| \`phoneE164\` | The number the decision applied to |
| \`campaignId\` | Source campaign |
| \`callId\` | Engine call ID (if the dial actually went out) |
| \`actor\` | Agent / actor that drove the decision |
| \`note\` | Free-form context |

### G2. Agent tool equivalent

\`\`\`
phone_audit_export { "since": "2026-05-01", "until": "2026-05-13" }
\`\`\`

Returns the same data as JSON with an embedded \`csv\` field.

### G3. Retention

Plugin state has a **30-day default TTL**. For longer-term retention (FTC suggests at least 5 years for sales-call records), run the export tool periodically and dump to external cold storage.

---

# H. Predict campaign cost + run time

**"How long will this campaign take? What will it cost?"**

\`\`\`
phone_campaign_predict { "campaignId": "c_abc123" }
\`\`\`

Returns:

| Field | Meaning |
|---|---|
| \`pendingLeads\` | Lead count remaining in \`pending\` / retry-eligible status |
| \`estimatedMinutesRemaining\` | Wall-clock minutes to drain at current pacing |
| \`estimatedRemainingCostUsd\` | Pending leads × mean cost (observed or fallback) |
| \`adjustedPacing\` | The pacing the runner is using **right now** + rationale string |
| \`basis\` | The rolling-stats snapshot the estimate was built from |
| \`notes\` | "Low confidence" warnings when sample is small |

**Confidence:**

- Fewer than **10 completed calls** → falls back to defaults (90s mean duration, \\$0.07/call) and surfaces a low-confidence note
- 10+ calls → switches to observed rolling mean over the last 30 outcomes
- Adjusted pacing applies multipliers based on the answer-rate band:
  - **Low** (<10% answered) — tighten dial spacing 0.5× + bump concurrency 1.5×
  - **Mid** (10–40%) — leave configured values alone
  - **High** (>40%) — widen dial spacing 2× + hold concurrency

---

# I. Multi-LLC portfolio rollup

If you run phone campaigns across multiple LLCs, the **🌐 Portfolio rollup** link in the Campaigns sidebar (top-right of the list view) aggregates today's dialed / qualified / transferred / cost counters across every LLC into one view. Refreshes every 30s.

**Most useful from your HQ / portfolio-root company** — non-HQ callers see only their own LLC's stats but the page renders gracefully either way.

Direct API:

\`\`\`
GET /api/plugins/phone-tools/api/campaigns/portfolio-rollup?companyId=<companyId>
\`\`\`

Returns per-company breakdown + portfolio totals.

---

# J. Troubleshooting

Every error code you might hit, in order of "how often does this happen during setup".

### Setup errors

| Code / Symptom | Cause | Fix |
|---|---|---|
| \`[EDISABLED]\` on every tool | Mutations toggle is off | Configuration tab → toggle "Allow place-call / hangup / assistant mutations" ON |
| \`[ECOMPANY_NOT_ALLOWED]\` | The calling company isn't in any account's allowedCompanies | Configuration tab → edit account → tick this company |
| \`[EVAPI_AUTH]\` | Bad API key, or stale secret cache | Toggle mutations off then on to force a fresh secret read. Confirm the secret-ref UUID matches the secret on the company's Secrets page. |
| Sidebar doesn't show Assistants or Campaigns | Same as ECOMPANY_NOT_ALLOWED at the visibility-gate level | Tick the company in allowedCompanies |
| \`[ENUMBER_NOT_ALLOWED]\` | The phone-number ID isn't in the account's allowedNumbers list | Either remove the allowlist or add the number ID |
| \`[EASSISTANT_NOT_ALLOWED]\` | Same shape but for assistants | Remove allowlist or add the assistant ID |

### Campaign errors

| Code / Symptom | Cause | Fix |
|---|---|---|
| \`[ECAMPAIGN_NO_TRANSFER]\` | Driving assistant has no \`transferTarget\` | Configure warm transfer (Section D) before starting the campaign |
| \`[ECAMPAIGN_EMPTY]\` | Campaign has zero leads | Import a CSV via the wizard, or \`phone_lead_list_append\` |
| \`[ECAMPAIGN_BAD_STATE]\` | Tried to start/pause/resume from the wrong state | Read the error — it says which states allow the action |
| \`[ECAMPAIGN_NOT_FOUND]\` | Wrong \`campaignId\` or wrong company | Confirm the UUID + the calling company owns the campaign |
| \`[ECAMPAIGN_INVALID_ASSISTANT]\` | Assistant UUID not found in this company | Verify the agent exists with role \`assistant\` |

### Compliance preflight errors

| Code | Cause | Fix |
|---|---|---|
| \`[ECOMPLIANCE_NOT_ACKNOWLEDGED]\` | Missed a TCPA or DNC ack checkbox | Tick both boxes on the wizard's Compliance section |
| \`[ECOMPLIANCE_RISK_TOO_HIGH]\` | \`consumer\` audience with a non-first-party list | Change audience to b2b-businesses, OR change list source to first-party-customers / first-party-inquired |
| \`[ECOMPLIANCE_BAD_HOURS]\` | Hours window > 14h, inverted, or out of 0–23 range | Use 9-18 weekdays for safety; max width is 14h |
| \`[ECOMPLIANCE_OPENING_DISCLOSURE]\` | Opener < 20 characters | Lengthen — must identify caller + business + purpose |
| \`[ECOMPLIANCE_OPT_OUT_LANGUAGE]\` | Opt-out language < 10 characters | Lengthen — must offer a way to revoke consent |
| \`[ECOMPLIANCE_NO_GEOGRAPHIC_SCOPE]\` | Scope is empty | List at least one ISO 3166-2 code, e.g. \`US-PA\` |
| \`[ECOMPLIANCE_LIST_SOURCE_NOTE]\` | \`purchased\` / \`rented\` list with no \`listSourceNote\` | Add vendor name + how consent was originally obtained |
| \`[ECOMPLIANCE_STRICT_STATE_OPENER]\` | Scope includes FL / CA / OK / TX, opener missing self-ID + purpose | Opener must contain a phrase like "this is …" AND "calling about …" |
| \`[ECOMPLIANCE_STRICT_STATE_OPT_OUT]\` | Strict state in scope, opt-out wording too vague | Opt-out must contain an unambiguous phrase: "don't call", "do not call", "remove me", "take off the list", or "opt out" |

### DNC errors

| Code | Cause | Fix |
|---|---|---|
| \`[EFEDERAL_DNC]\` | Destination is on the cached federal DNC list | Expected behavior — lead is skipped + audit-logged. Use \`phone_dnc_federal_check\` to verify. |
| \`[ENO_FEDERAL_DNC_URL]\` | Called \`phone_dnc_federal_refresh\` on an account without a URL | Set the federalDncListUrl on the account (Section F2) |
| \`[EFEDERAL_DNC_FETCH]\` | Refresh GET returned non-2xx | Check the URL is reachable from the Paperclip server. Stale-cache fallback means dials still happen against the old list. |
| \`[EDNC_ALREADY_LISTED]\` | Tried to add a phone that's already on DNC | No-op; just confirm it's listed |

### Call-time errors

| Code / Symptom | Cause | Fix |
|---|---|---|
| \`[ECONCURRENCY_LIMIT]\` | Hit account's \`maxConcurrentCalls\` cap | Wait for in-flight calls to finish, or bump the cap |
| \`[ECOST_CAP]\` | Assistant's daily-cost cap reached | Wait until UTC midnight, or raise the cap on the assistant's Phone tab |
| Call rings but AI doesn't speak | Voice provider error (e.g. "voice not found") | Check Vapi dashboard → Calls panel → look at the specific call's error log. Drop \`voice\` from the assistant config to use Vapi defaults. |
| Lead status stuck on \`calling\` forever | Vapi webhook not reaching the plugin | Ensure \`webhookSecretRef\` is set on the account AND Vapi's Server URL = \`https://<paperclip-host>/api/plugins/phone-tools/webhooks/vapi\` |
| Recipients see "Spam Likely" after Section B | Fresh BYO-trunk numbers start with no reputation | Use the number for a few weeks OR register with a branded-caller-ID service (First Orion / Numeracle / Hiya Connect) |

### CSV import errors

| Code | Cause | Fix |
|---|---|---|
| \`[ECSV_EMPTY]\` | CSV has no data rows | Add at least one row |
| \`[ECSV_TOO_LARGE]\` | More than 10,000 rows | Split into multiple imports |
| \`[ECSV_BAD_MAPPING]\` | \`mapping.phone\` references a header that doesn't exist | Use the actual column name from the CSV's first row (case-sensitive) |

### Operational notes

- **Predictive pacing says "low sample, using fallback"** — normal until the campaign has 10+ completed calls. Adjustment kicks in past that threshold.
- **Portfolio rollup shows only one LLC** — the SDK returned only that company. From an HQ / portfolio-root view, the call should fan out across every visible LLC. If it doesn't, check that the operator has board access to the other companies.
- **Audit export returns empty** — no dial decisions in that date range. Audit logging applies to campaign-driven dials only; manual \`phone_call_make\` calls aren't audited.

---

# K. What's planned next

| Version | What lands |
|---|---|
| **v0.6.x** | Inbound routes UI on the Phone tab (DID → assistant mapping, business hours, voicemail-drop fallback); SSE-backed live counters replacing the 3s poll on the campaign detail view |
| **v0.7.x** | DIY engine — Jambonz + Deepgram (STT) + Claude/GPT (LLM) + ElevenLabs (TTS, with Qwen-local fallback). Same \`PhoneEngine\` interface so it slots in without touching skills or wizards |
| **Later** | DTMF mid-call, voicemail-drop, mid-call function tools, deeper 3CX Call Control API integration, cross-plugin transfer (\`phone-tools\` → \`pbx_transfer_call\` on a 3CX-known callId for human-initiated mid-call handoffs) |

For the full feature roadmap + recent-changes log, see the [plugin folder README](README.md).
`;

// `setupInstructions` is recognised by the host's manifest validator
// (paperclip core packages/shared) but the field is not yet in the
// npm-published @paperclipai/plugin-sdk type. Widening the manifest type
// so this plugin can populate the field today; remove the intersection
// once the SDK ships the type.
const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Phone (AI calls via 3CX + Vapi/DIY)",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Place outbound and answer inbound AI-driven phone calls via the operator's 3CX PBX (Vapi engine; DIY engine roadmap). Includes Assistants builder, warm-transfer to a human, and outbound campaign mode with compliance preflight + DNC. Multi-account, per-account allowedCompanies, mutations gated.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "webhooks.receive",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "telemetry.track",
    "api.routes.register",
    "agents.read",
    "companies.read",
    "ui.sidebar.register",
    "ui.detailTab.register",
    "ui.page.register",
    "issues.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  webhooks: [
    {
      endpointKey: "vapi",
      displayName: "Vapi inbound webhook",
      description:
        "Configure this URL on Vapi (Org → Server URL): https://<paperclip-host>/api/plugins/phone-tools/webhooks/vapi — Vapi posts assistant-request, status-update, transcript, end-of-call-report, and function-call events here.",
    },
    {
      endpointKey: "diy",
      displayName: "DIY engine inbound webhook (v0.2.0)",
      description:
        "Reserved for the v0.2.0 DIY engine. Jambonz application URL: https://<paperclip-host>/api/plugins/phone-tools/webhooks/diy. No-op in v0.1.0 (returns 200 without emitting events).",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["allowMutations", "defaultAccount", "accounts"],
    properties: {
      allowMutations: {
        type: "boolean",
        default: false,
        title: "Allow place-call / hangup / assistant mutations",
        description:
          "Master switch for every tool that can spend money or modify the engine state: phone_call_make, phone_call_end, phone_assistant_create, phone_assistant_update, phone_assistant_delete. Off (default) = those tools return [EDISABLED]. Read tools (status, transcript, list, recording_url) are unaffected. Strongly recommended to leave OFF until you've reviewed which agents/skills can place outbound calls — PSTN minutes cost money and a misconfigured assistant can talk to anyone.",
      },
      defaultAccount: {
        type: "string",
        title: "Default account key",
        "x-paperclip-optionsFromSibling": {
          sibling: "accounts",
          valueKey: "key",
          labelKey: "displayName",
        },
        description:
          "Identifier of the account used when an agent omits the `account` parameter. Strict: if the calling company isn't in the default account's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no automatic fallback). Leave blank to require an explicit `account` per call.",
      },
      accounts: {
        type: "array",
        title: "Phone accounts",
        description:
          "One entry per backend voice engine you've set up. Most operators will have one Vapi account per LLC; later, you may add a 'private' account using the DIY engine for sensitive calls.",
        items: accountItemSchema,
      },
    },
    required: ["accounts"],
  },
  tools: [
    {
      name: "phone_call_make",
      displayName: "Place outbound phone call",
      description:
        "Place an AI-driven outbound phone call to an E.164 number. The engine connects, the assistant introduces itself with its firstMessage, and conducts the conversation. Returns immediately with a callId; use phone_call_status to poll, or subscribe to plugin.phone-tools.call.ended to be notified. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description: "Account identifier as configured on the plugin settings page. Optional — falls back to defaultAccount.",
          },
          to: {
            type: "string",
            description: "E.164 destination number (e.g. '+15551234567'). Required.",
          },
          from: {
            type: "string",
            description:
              "Engine-side phone-number ID to call from (NOT the E.164 number — the UUID returned by phone_number_list). Optional — falls back to defaultNumberId. Must be in allowedNumbers if that list is set.",
          },
          assistant: {
            description:
              "Either an assistant ID (string) referring to a saved assistant on the engine, OR an inline assistant config object. Inline configs are rejected if the account has a non-empty allowedAssistants list.",
            oneOf: [
              { type: "string", description: "Assistant ID." },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  systemPrompt: { type: "string" },
                  firstMessage: { type: "string" },
                  voice: { type: "string", description: "Engine voice spec, e.g. '11labs:rachel'." },
                  model: { type: "string", description: "Engine model spec, e.g. 'openai:gpt-4o'." },
                  voicemailMessage: {
                    type: "string",
                    description:
                      "Optional pre-recorded message played automatically when the engine detects voicemail. When set, the engine plays this message and ends the call (no AI improvisation). Leave empty to let the AI handle voicemail dynamically per its system prompt — voicemail detection is always on regardless.",
                  },
                },
                required: ["name", "systemPrompt"],
              },
            ],
          },
          metadata: {
            type: "object",
            additionalProperties: true,
            description: "Free-form metadata persisted on the engine call record. Useful for correlation back to the calling skill / issue.",
          },
          idempotencyKey: {
            type: "string",
            description:
              "Optional. Identical key within 24 h returns the existing callId rather than placing a duplicate call.",
          },
        },
        required: ["to", "assistant"],
      },
    },
    {
      name: "phone_call_status",
      displayName: "Get phone call status",
      description:
        "Poll the current status of a call (queued, ringing, in-progress, ended, failed, no-answer, busy, canceled) plus duration, cost, end reason. Cached briefly per (account, callId) for completed calls.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Engine call ID returned by phone_call_make or surfaced via the call.received event." },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_call_transcript",
      displayName: "Get phone call transcript",
      description:
        "Retrieve the dialog transcript for a call. format='plain' returns a single string; format='structured' returns role-tagged turns with timestamps. Available once the call ends; partial transcripts during the call arrive via plugin.phone-tools.call.transcript.partial events instead.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Call ID." },
          format: {
            type: "string",
            enum: ["plain", "structured"],
            default: "plain",
            description: "'plain' = single string. 'structured' = array of {role, text, ts} turns.",
          },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_call_recording_url",
      displayName: "Get phone call recording URL",
      description:
        "Return a short-lived signed URL to the call audio recording. Only available if the account has recordingEnabled=true and the call has ended. Returns [EVAPI_NOT_FOUND] otherwise.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Call ID." },
          expiresInSec: {
            type: "number",
            default: 3600,
            description: "Hint for how long the URL should remain valid. Engine may cap to its own maximum.",
          },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_call_list",
      displayName: "List phone calls",
      description:
        "List calls (inbound, outbound, or both) with optional filters. Filtered to numbers/assistants in the calling company's allow-list — calls placed/received under another company's allow-list are NOT returned.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          since: { type: "string", description: "ISO 8601 timestamp; only calls created at or after this time." },
          until: { type: "string", description: "ISO 8601 timestamp; only calls created at or before this time." },
          direction: {
            type: "string",
            enum: ["inbound", "outbound", "any"],
            default: "any",
            description: "Direction filter.",
          },
          assistant: { type: "string", description: "Filter to one assistant ID." },
          status: {
            type: "string",
            enum: ["queued", "ringing", "in-progress", "ended", "failed", "no-answer", "busy", "canceled"],
            description: "Filter to one status.",
          },
          limit: { type: "number", default: 25, description: "Page size. Max 100." },
          cursor: { type: "string", description: "Opaque cursor returned by a previous call." },
        },
      },
    },
    {
      name: "phone_call_end",
      displayName: "End phone call (force hangup)",
      description:
        "Force-end an active call. Useful if a call has gone off the rails. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Call ID." },
          reason: {
            type: "string",
            description: "Optional human-readable reason persisted on the call's metadata.",
          },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_assistant_list",
      displayName: "List phone assistants",
      description:
        "List the named, reusable AI personas configured on the engine. Filtered to allowedAssistants if the account has that list set.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },
    {
      name: "phone_assistant_create",
      displayName: "Create phone assistant",
      description:
        "Create a new named assistant on the engine. Idempotent on name within the account: calling twice with the same name returns the existing assistant. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          name: {
            type: "string",
            description: "Stable, human-readable name (e.g. 'AppointmentBookerV2'). Used for idempotency.",
          },
          systemPrompt: {
            type: "string",
            description: "The system prompt that defines the assistant's persona and rules. Be specific; voice models follow instructions less precisely than chat.",
          },
          firstMessage: {
            type: "string",
            description: "First spoken line. For recorded-call jurisdictions include the consent disclosure here, e.g. 'This call may be recorded.'",
          },
          voice: {
            type: "string",
            description: "Engine voice spec, e.g. '11labs:rachel' or 'cartesia:sonic-male'. Engine-specific format.",
          },
          model: {
            type: "string",
            description: "Engine model spec, e.g. 'openai:gpt-4o'. Engine-specific format.",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Names of plugin-internal tools the in-call assistant may invoke mid-call. v0.1.0 ships only 'take_note'; full set lands in v0.1.1.",
          },
          voicemailMessage: {
            type: "string",
            description:
              "Optional pre-recorded voicemail message. When set, the engine plays this and ends the call automatically when voicemail is detected. Leave empty for AI-handled voicemail (preserves dynamic content per call). Voicemail detection is always on regardless.",
          },
          transferTarget: {
            type: "string",
            description:
              "Optional E.164 destination for warm transfer to a human. When set, the engine gives the assistant a `transferCall` tool it may invoke when the caller asks for a person, has a problem the AI can't solve, or becomes hostile. The engine dials this number, plays the configured transfer message to the caller, then SIP-REFERs the leg. Typically this is a 3CX DID that the PBX routes to the intended extension or queue via its inbound rules (e.g. '+15555551212' for 'Sales DID that rings Someone'). Leave empty to disable warm transfer for this assistant.",
          },
          transferMessage: {
            type: "string",
            description:
              "Optional spoken line played to the caller just before the SIP leg is bridged to the transfer destination. Defaults to 'One moment, I'm transferring you to a person who can help.' Override when the default tone doesn't fit (e.g. for medical, legal, or hostile-caller contexts) or when you want to surface the destination ('transferring you to our service department').",
          },
          idempotencyKey: {
            type: "string",
            description: "Optional. Subsequent calls with the same key short-circuit to the existing assistant.",
          },
        },
        required: ["name", "systemPrompt"],
      },
    },
    {
      name: "phone_assistant_update",
      displayName: "Update phone assistant",
      description: "Patch an existing assistant. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          assistantId: { type: "string", description: "Engine assistant ID." },
          name: { type: "string" },
          systemPrompt: { type: "string" },
          firstMessage: { type: "string" },
          voice: { type: "string" },
          model: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
          voicemailMessage: { type: "string" },
          transferTarget: {
            type: "string",
            description:
              "E.164 destination for warm transfer to a human. Set to a non-empty value to enable transfer (gives the assistant a `transferCall` tool); set to empty string to disable.",
          },
          transferMessage: {
            type: "string",
            description: "Spoken line played to the caller right before the SIP leg is bridged.",
          },
        },
        required: ["assistantId"],
      },
    },
    {
      name: "phone_assistant_delete",
      displayName: "Delete phone assistant",
      description: "Remove an assistant from the engine. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          assistantId: { type: "string", description: "Engine assistant ID." },
        },
        required: ["assistantId"],
      },
    },
    {
      name: "phone_number_list",
      displayName: "List phone numbers",
      description:
        "List the engine-side phone numbers configured under the account. Returns id, e164, label, and (where applicable) the SIP-trunk identifier so you can confirm a number is bound to your 3CX trunk. Filtered to allowedNumbers if the account has that list set.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },

    // ─── v0.5.0: Outbound campaigns ──────────────────────────────
    {
      name: "phone_campaign_create",
      displayName: "Create outbound campaign",
      description:
        "Create a draft outbound campaign. Validates compliance preflight (audience, list source, hours, opening disclosure, opt-out language) and refuses to create if the assistant has no transferTarget configured. Returns campaignId in 'draft' status; call phone_campaign_start to begin dialing. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          assistantAgentId: {
            type: "string",
            description: "Paperclip assistant agent UUID that will conduct the calls. The runner resolves this to the engine-side vapiAssistantId. Must have transferTarget configured on its phone config.",
          },
          name: { type: "string", description: "Display name, e.g. 'Sample Pack 2026Q2'." },
          purpose: {
            type: "string",
            description: "One-sentence purpose of the campaign. Spliced into the assistant's opening line. Be specific: 'introduce our quarterly print sample pack to local restaurant owners' beats 'sales calls'.",
          },
          preflight: {
            type: "object",
            description: "Full CompliancePreflight object — audience, list source, geographic scope, hours, disclosure, opt-out, acknowledgements. Refuses to create if any required field is missing or any rule fails.",
          },
          pacing: {
            type: "object",
            description: "Optional pacing override. Defaults: maxConcurrent=2, secondsBetweenDials=90, maxPerHour=30, maxPerDay=200.",
          },
          retry: {
            type: "object",
            description: "Optional retry policy override. Defaults: no-answer retried after 4h up to 2x, busy retried after 10m up to 3x.",
          },
          outcomeIssueProjectId: {
            type: "string",
            description: "Optional Paperclip project UUID where qualified-lead issues should land. Defaults to the assistant's transferIssueProjectId if not set.",
          },
        },
        required: ["assistantAgentId", "name", "purpose", "preflight"],
      },
    },
    {
      name: "phone_campaign_update",
      displayName: "Update outbound campaign",
      description:
        "Patch an existing campaign. Only allowed in 'draft' or 'paused' status — refuses to mutate a running campaign. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          patch: {
            type: "object",
            description: "Partial Campaign — any of name, purpose, pacing, retry, preflight, outcomeIssueProjectId.",
          },
        },
        required: ["campaignId", "patch"],
      },
    },
    {
      name: "phone_campaign_start",
      displayName: "Start outbound campaign",
      description:
        "Move a draft or paused campaign to running status. Re-runs the full compliance preflight. The runner skill picks it up on its next tick. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: { campaignId: { type: "string" } },
        required: ["campaignId"],
      },
    },
    {
      name: "phone_campaign_pause",
      displayName: "Pause outbound campaign",
      description:
        "Pause a running campaign. In-flight calls finish on their own; no new dials. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: { campaignId: { type: "string" } },
        required: ["campaignId"],
      },
    },
    {
      name: "phone_campaign_resume",
      displayName: "Resume outbound campaign",
      description: "Resume a paused campaign. Re-evaluates business hours before each lead. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: { campaignId: { type: "string" } },
        required: ["campaignId"],
      },
    },
    {
      name: "phone_campaign_stop",
      displayName: "Stop outbound campaign (terminal)",
      description:
        "Terminal stop. Pending leads are marked disqualified with reason 'campaign-stopped'. Cannot be resumed; create a new campaign if you want to revisit the list. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          reason: { type: "string", description: "Optional human-readable reason persisted on the campaign." },
        },
        required: ["campaignId"],
      },
    },
    {
      name: "phone_campaign_status",
      displayName: "Get campaign status + counters",
      description:
        "Snapshot: campaign config, today's counters, lifetime counters, lead-status breakdown. Read.",
      parametersSchema: {
        type: "object",
        properties: { campaignId: { type: "string" } },
        required: ["campaignId"],
      },
    },
    {
      name: "phone_campaign_list",
      displayName: "List campaigns",
      description: "List campaigns owned by the calling company, optionally filtered by status. Read.",
      parametersSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["draft", "running", "paused", "stopped", "completed"] },
        },
      },
    },
    {
      name: "phone_lead_list_append",
      displayName: "Append leads to a campaign",
      description:
        "Append leads to an existing campaign's lead list. DNC-listed phones are skipped (returned in 'skipped' with reason='dnc'). Phones that fail E.164 normalization are skipped with reason='invalid-phone'. Idempotent on phoneE164: re-appending an existing lead is a no-op. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          leads: {
            type: "array",
            items: {
              type: "object",
              properties: {
                phoneE164: { type: "string" },
                name: { type: "string" },
                businessName: { type: "string" },
                websiteUrl: { type: "string" },
                meta: { type: "object" },
                timezoneHint: { type: "string", description: "IANA tz, e.g. 'America/New_York'." },
              },
              required: ["phoneE164"],
            },
          },
        },
        required: ["campaignId", "leads"],
      },
    },
    {
      name: "phone_lead_list_import_csv",
      displayName: "Import leads from CSV",
      description:
        "Parse a CSV blob and append leads. CSV is utf-8; first row is the header. Caller specifies which header is the phone column (and optionally name / businessName / website / timezone). Phones are normalized to E.164. 10k row cap. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          csvText: { type: "string", description: "Raw CSV content." },
          mapping: {
            type: "object",
            properties: {
              phone: { type: "string", description: "Column name holding the phone number. Required." },
              name: { type: "string" },
              businessName: { type: "string" },
              website: { type: "string" },
              timezone: { type: "string" },
            },
            required: ["phone"],
          },
        },
        required: ["campaignId", "csvText", "mapping"],
      },
    },
    {
      name: "phone_lead_status",
      displayName: "Get lead status in a campaign",
      description: "Read a single lead's current state. Useful for spot-checking. Read.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          phoneE164: { type: "string" },
        },
        required: ["campaignId", "phoneE164"],
      },
    },
    {
      name: "phone_dnc_add",
      displayName: "Add a phone to the do-not-call list",
      description:
        "Idempotent. Used by the in-call AI when a prospect opts out, or by the operator manually. Once added, every campaign on the same account skips this number. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional — falls back to defaultAccount." },
          phoneE164: { type: "string" },
          reason: { type: "string", description: "Free-form: 'opt-out' / 'operator-added' / 'regulatory'. For audit." },
          campaignId: { type: "string", description: "Optional source campaign — set when the AI added this entry mid-call." },
        },
        required: ["phoneE164"],
      },
    },
    {
      name: "phone_dnc_check",
      displayName: "Check if a phone is on the do-not-call list",
      description: "Returns the DNC entry if present, else null. Read.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          phoneE164: { type: "string" },
        },
        required: ["phoneE164"],
      },
    },
    {
      name: "phone_dnc_list",
      displayName: "List the do-not-call entries on an account",
      description: "Read.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          since: { type: "string", description: "ISO 8601 timestamp; only entries added at or after." },
          limit: { type: "number", default: 100 },
        },
      },
    },
    {
      name: "phone_dnc_remove",
      displayName: "Remove a phone from the do-not-call list (audit-logged)",
      description:
        "Remove an entry. Requires `note` as audit context (e.g. 'operator confirmed prospect changed mind'). Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          phoneE164: { type: "string" },
          note: { type: "string", description: "Required. Reason for removing the DNC entry. Stored in the plugin logger for audit." },
        },
        required: ["phoneE164", "note"],
      },
    },

    // ─── v0.5.4: Federal DNC + audit ───────────────────────────────
    {
      name: "phone_dnc_federal_refresh",
      displayName: "Force-refresh the federal DNC cache",
      description:
        "Fetch the configured federalDncListUrl and replace the cached set. Use when the list source has changed (e.g. after operator updates the URL or knows the registry was just dumped). No-op if the account has no federalDncListUrl. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: { account: { type: "string" } },
      },
    },
    {
      name: "phone_dnc_federal_check",
      displayName: "Check a number against the federal DNC list",
      description:
        "Returns whether a phone number appears in the cached federal DNC set. Read-only; refreshes the cache transparently if stale.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          phoneE164: { type: "string" },
        },
        required: ["phoneE164"],
      },
    },
    {
      name: "phone_audit_export",
      displayName: "Export the dial-decision audit log as CSV",
      description:
        "Returns every dial-decision entry for an account between since/until (UTC days, inclusive). Use for regulatory evidence, compliance review, or external cold-storage archival. Read.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          since: { type: "string", description: "ISO date 'YYYY-MM-DD' or full ISO timestamp." },
          until: { type: "string", description: "ISO date 'YYYY-MM-DD' or full ISO timestamp." },
        },
      },
    },
    {
      name: "phone_campaign_predict",
      displayName: "Estimate remaining time + cost for a campaign",
      description:
        "Given a campaign, returns: pending lead count, estimated wall-clock minutes to drain (using observed mean call duration / fallback when sample is small), estimated remaining cost, and the adjusted pacing the runner is using (with rationale — low/mid/high answer-rate band). Read.",
      parametersSchema: {
        type: "object",
        properties: {
          campaignId: { type: "string" },
          fallbackDurationSec: {
            type: "number",
            default: 90,
            description: "Used when the rolling window has too few samples for a reliable mean.",
          },
          fallbackCostUsd: {
            type: "number",
            default: 0.07,
            description: "Used when the rolling window has too few samples for a reliable mean.",
          },
        },
        required: ["campaignId"],
      },
    },
  ],
  apiRoutes: [
    {
      routeKey: "assistants.compose-preview",
      method: "POST",
      path: "/assistants/compose-preview",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.phone-config.get",
      method: "GET",
      path: "/assistants/:agentId/phone-config",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.phone-config.set",
      method: "POST",
      path: "/assistants/:agentId/phone-config",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.phone-config.test",
      method: "POST",
      path: "/assistants/:agentId/phone-config/test",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.calls.list",
      method: "GET",
      path: "/assistants/:agentId/calls",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.calls.place",
      method: "POST",
      path: "/assistants/:agentId/calls",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.calls.status",
      method: "GET",
      path: "/assistants/:agentId/calls/:callId/status",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.calls.transcript",
      method: "GET",
      path: "/assistants/:agentId/calls/:callId/transcript",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "assistants.calls.recording",
      method: "GET",
      path: "/assistants/:agentId/calls/:callId/recording-url",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "operator-phone.get",
      method: "GET",
      path: "/operator-phone",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "operator-phone.set",
      method: "POST",
      path: "/operator-phone",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "accounts.numbers",
      method: "GET",
      path: "/accounts/numbers",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },

    // ─── v0.5.1: Campaigns UI backing routes ───────────────────────
    {
      routeKey: "campaigns.list",
      method: "GET",
      path: "/campaigns",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.create",
      method: "POST",
      path: "/campaigns",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.get",
      method: "GET",
      path: "/campaigns/:campaignId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.start",
      method: "POST",
      path: "/campaigns/:campaignId/start",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.pause",
      method: "POST",
      path: "/campaigns/:campaignId/pause",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.resume",
      method: "POST",
      path: "/campaigns/:campaignId/resume",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.stop",
      method: "POST",
      path: "/campaigns/:campaignId/stop",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.leads",
      method: "GET",
      path: "/campaigns/:campaignId/leads",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.import-csv",
      method: "POST",
      path: "/campaigns/:campaignId/leads/import-csv",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.dnc.list",
      method: "GET",
      path: "/dnc",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.assistants",
      method: "GET",
      path: "/campaigns/eligible-assistants",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },

    // ─── v0.5.4: federal DNC + audit export ────────────────────────
    {
      routeKey: "campaigns.dnc.federal-status",
      method: "GET",
      path: "/dnc/federal",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.dnc.federal-refresh",
      method: "POST",
      path: "/dnc/federal/refresh",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "campaigns.audit.export",
      method: "GET",
      path: "/audit",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },

    // ─── v0.5.5: HQ portfolio rollup ───────────────────────────────
    {
      routeKey: "campaigns.portfolio-rollup",
      method: "GET",
      path: "/campaigns/portfolio-rollup",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "assistants-sidebar",
        displayName: "Assistants",
        exportName: "AssistantsSidebarItem",
      },
      {
        type: "sidebar",
        id: "campaigns-sidebar",
        displayName: "Campaigns",
        exportName: "CampaignsSidebarItem",
      },
      {
        type: "detailTab",
        id: "agent-phone-tab",
        displayName: "Phone",
        exportName: "AgentPhoneTab",
        entityTypes: ["agent"],
      },
      {
        type: "page",
        id: "campaigns-page",
        displayName: "Campaigns",
        exportName: "CampaignsPage",
        routePath: "campaigns",
      },
    ],
  },
};

export default manifest;
