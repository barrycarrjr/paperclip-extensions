import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "phone-tools";
const PLUGIN_VERSION = "0.5.2";

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
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may use this phone account. Tick 'Portfolio-wide' for ['*']; otherwise tick specific companies. Empty = unusable (fail-safe deny). A phone account typically belongs to one LLC — prefer single-company lists.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — outbound calls via Vapi

Get the plugin placing outbound AI-driven phone calls. v0.1.0 ships outbound only; inbound and the DIY (self-hosted) engine come in subsequent versions. Reckon on **about 15–20 minutes** for first-time setup.

There are two ways to run outbound:

1. **Quickstart (5 minutes)** — uses Vapi's provisioned number. Calls work immediately, but recipients see a "Spam Likely" / "Unknown" caller-ID label because the originating number is fresh and pooled across Vapi customers. Fine for smoke testing and internal demos. **Not** appropriate for production calls to real customers.
2. **Production via 3CX SIP trunk (additional ~10 minutes + 3CX admin access)** — outbound calls leave through one of your own DIDs. Recipients see your branded caller-ID, no spam tag. Required for any real customer-facing use.

Do **Quickstart** first to verify the loop works end-to-end, then layer on the 3CX trunk before going live.

---

## Quickstart — outbound via Vapi's provisioned number

### 1. Vapi account

Sign up at [https://dashboard.vapi.ai](https://dashboard.vapi.ai) if you don't already have an account.

### 2. Create a Vapi Private API Key

In the Vapi dashboard:

- Go to **Org → API Keys**
- Click **Create new key**
- Choose **Private API Key** (NOT the public/web key — those can't initiate calls)
- Copy the key

### 3. Provision a Vapi phone number (Quickstart only)

Still in Vapi dashboard:

- Go to **Phone Numbers → Add Phone Number**
- Choose **Vapi Phone Number** (the free one Vapi provides). Skip "BYO SIP Trunk" for now — that's the production path covered below.
- After it's created, **copy the phone-number's ID** (a UUID, NOT the E.164 number itself). You'll need it as \`defaultNumberId\` on the plugin settings page.

### 4. Create a Paperclip secret holding the Vapi API key

In Paperclip, switch to the company that should own this phone account (typically the LLC the calls are made on behalf of). Then:

- Go to **Secrets → Add**
- Name it something like \`vapi-api-key\`
- Paste the Vapi Private API Key from step 2 as the value
- Save, then **copy the secret's UUID** — you'll paste it into the plugin settings next

### 5. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above. You'll see an empty **Phone accounts** list. Click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | \`main\` |
| **Display name** | (whatever you want, e.g. "Acme Corp — main") |
| **Engine** | \`vapi\` |
| **Engine API key** | paste the secret UUID from step 4 |
| **Webhook signing secret** | leave blank for outbound-only Quickstart |
| **Default phone-number ID** | the UUID from step 3 |
| **Default assistant ID** | leave blank (agents pass inline assistant configs to \`phone_call_make\`) |
| **Enable call recording** | leave off |
| **Max concurrent outbound calls** | \`3\` (default) |
| **Allowed companies** | tick the company you want to use this account |

Then at the top:

- **Default account key:** \`main\`
- **Allow place-call / hangup / assistant mutations:** **enable** when you're ready to actually place calls

Save.

### 6. Smoke-test

From a logged-in shell session, run:

\`\`\`bash
cd <paperclip-extensions>/plugins/phone-tools
PAPERCLIP_COOKIE='<your-session-cookie>' \\
COMPANY_ID='<the-company-uuid-you-allow-listed>' \\
AGENT_ID='<an-agent-uuid-in-that-company>' \\
RUN_ID='<any-recent-heartbeat-run-uuid>' \\
TO='+1XXXXXXXXXX' \\
./scripts/smoke-outbound.sh
\`\`\`

The script does a 30-second test call with a built-in demo assistant, polls until the call ends, and prints the transcript. Costs about ¥0.10 (~$0.07) per call.

If the call rings out and the AI speaks its first line — the loop is working.

---

## Production — outbound via 3CX SIP trunk (BYO carrier)

This is what makes calls show your **branded caller-ID** instead of "Spam Likely". Do this before placing calls to real customers. There are four steps: create a SIP trunk credential in Vapi, attach a DID to it, create the matching trunk in 3CX, and add an outbound rule. All four are required — missing step 10 is the most common reason calls fail silently.

### 7. Create a SIP trunk credential in Vapi

In the Vapi dashboard:

- Go to **Settings → Integrations**
- Scroll down to the **Phone Number Providers** section and click **SIP Trunk**
- Click **Add New SIP Trunk**
- Fill in:
  - **Name**: anything recognizable, e.g. \`3CX (main)\`
  - **Gateway #1 → IP Address / Domain**: your 3CX server's public FQDN or IP, e.g. \`pbx.example.com\`
  - **Port**: \`5060\` (leave default unless your 3CX is configured for TLS on 5061)
  - **Netmask**: \`32\`
  - **Outbound Protocol**: \`UDP\`
  - ☑ **Allow inbound calls**, ☑ **Allow outbound calls**
  - Leave **Authentication** (Username / Password) blank — use IP-based auth (see note)
  - Leave **Use SIP Registration** unchecked (see note)
- Click **Save SIP Trunk**

> **IP-based vs. registration auth**: For the recommended IP-based path, leave credentials blank and unchecked. Vapi sends SIP traffic to 3CX by source IP and 3CX accepts it based on the IP you whitelist in step 9. If you prefer Vapi to register like a softphone, check **Use SIP Registration** and enter the SIP username/password of the 3CX extension you create for Vapi — but then step 9 is different (create an extension, not a trunk).

### 8. Attach your DID to the SIP trunk credential

Still in the Vapi dashboard:

- Go to **Phone Numbers → Create Phone Number**
- Choose **BYO SIP Trunk Number**
- Fill in:
  - **Phone Number**: the E.164 DID you want as caller-ID, e.g. \`+15551234567\`
  - **SIP Trunk Credential**: pick the trunk you saved in step 7 from the dropdown
  - **Label**: optional human-readable name
- Click **Import SIP Phone Number**

> If the **SIP Trunk Credential** dropdown shows "No SIP trunks available", the trunk from step 7 wasn't saved yet — go back and save it first.

**Copy the phone-number UUID** from the resulting entry (shown in the URL when you click into it). You'll paste it as \`defaultNumberId\` in step 11.

### 9. Create the Vapi SIP trunk in 3CX

(Requires 3CX **Pro** or **Enterprise** — Standard/Free doesn't support custom SIP trunks.)

In the 3CX Admin Console:

- Go to **Voice & Chat** in the left nav
- Click **+ Add Trunk** at the top of the page — NOT **+ Add Gateway** (different thing, right next to it)
- Choose **Generic SIP Trunk**
- Fill in:
  - **Trunk Name**: \`Vapi\`
  - **Registrar/Server/Gateway hostname or IP**: leave blank for IP-based auth, or \`sip.vapi.ai\` if using SIP registration
  - **Authentication**: for IP-based auth, add Vapi's SIP origination IP ranges to the allowed IPs list (check [Vapi's current IP list](https://docs.vapi.ai/sip) — they change); for registration-based, enter the username/password
  - Codec: **G.711 µ-law (PCMU)** as primary
- Save

> If 3CX is behind NAT, enable **STUN** in the trunk's advanced settings.

### 10. Add an outbound rule in 3CX

**This step is required.** Without it, calls from Vapi hit 3CX but immediately fail — 3CX logs "no outbound rule found for the number" and drops the call.

In the 3CX Admin Console:

- Go to **Outbound Rules** in the left nav
- Click **+ Add**
- Fill in:
  - **Rule Name**: \`Vapi outbound\`
  - **Calls from**: select the Vapi trunk you created in step 9
  - **Route 1**: your Flowroute (or other PSTN) trunk that owns the DID you want as caller-ID
  - **Caller ID**: set to the E.164 DID from step 8, e.g. \`+15551234567\`
- Save

Outbound calls from Vapi now route through your PSTN trunk and arrive at the recipient with your branded caller-ID.

### 11. Update \`defaultNumberId\` and re-smoke

Back on this plugin's **Configuration** tab:

- Edit the \`main\` account
- Change **Default phone-number ID** to the UUID from step 8 (the BYO-SIP number)
- Save

Run the smoke script again. Calls now leave through your 3CX trunk and arrive at the recipient with your branded caller-ID.

---

## Troubleshooting

- **\`[EVAPI_AUTH]\` errors** — the API key in the secret is wrong, or the secret-ref UUID is wrong, or the secret was rotated and the plugin is caching an old value. Toggle **Allow mutations** off then on to force a fresh secret read.
- **\`[ECOMPANY_NOT_ALLOWED]\`** — the calling company isn't ticked in the account's **Allowed companies** list. Configuration tab → edit account → fix.
- **\`[ECONCURRENCY_LIMIT]\`** — you've hit \`maxConcurrentCalls\`. Either bump the cap or wait for in-flight calls to finish.
- **Call rings but AI doesn't speak** — check the Vapi dashboard's Calls panel for the specific call. Common cause: a voice provider error (e.g. "voice not found"). Drop \`voice\` from the assistant config so Vapi uses its defaults.
- **Recipients still see "Spam Likely" after step 11** — fresh BYO trunk numbers also start with no reputation. The label clears with use over a few days/weeks. To skip the wait, register the number with a branded-caller-ID service like First Orion, Numeracle, or Hiya Connect (~$10–50/month per number).

## What's not in v0.1.0

| Capability | Status |
|---|---|
| Inbound calls (someone calls *you*, AI answers) | Code shipped, not yet smoke-tested. First-class in **v0.2.0**. Requires \`webhookSecretRef\` and a 3CX inbound rule routing a DID to the Vapi trunk. |
| Force-hangup / recording-URL retrieval | Code shipped, not yet smoke-tested. **v0.2.0**. |
| DIY engine (Jambonz + ElevenLabs primary + local Qwen TTS fallback) — fully self-hosted | Placeholder in v0.1.0. **v0.3.0**. |
| DTMF mid-call, warm transfer, voicemail-drop, multi-party | Future versions. |

If you need any of those today, check the [plugin folder README](README.md) for the broader feature roadmap.
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
    "Place outbound and answer inbound AI-driven phone calls via the operator's 3CX PBX. Backs onto Vapi.ai (DIY engine future). v0.4.0 adds warm transfer: when an assistant has a transferTarget, the engine injects a transferCall tool so the AI can hand off to a human destination DID — 3CX answers and routes via its inbound rules. v0.5.0 adds outbound campaign mode: drop a CSV of leads into a campaign, answer a hard compliance preflight (TCPA / DNC / hours / opt-out language), click start, watch the per-minute runner work the list within budget. Multi-account, per-account allowedCompanies, mutations gated, optional call recording per account.",
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
              "Optional E.164 destination for warm transfer to a human. When set, the engine gives the assistant a `transferCall` tool it may invoke when the caller asks for a person, has a problem the AI can't solve, or becomes hostile. The engine dials this number, plays the configured transfer message to the caller, then SIP-REFERs the leg. Typically this is a 3CX DID that the PBX routes to the intended extension or queue via its inbound rules (e.g. '+12154636348' for 'Sales DID that rings Barry'). Leave empty to disable warm transfer for this assistant.",
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
      },
    ],
  },
};

export default manifest;
