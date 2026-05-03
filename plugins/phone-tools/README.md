# `phone-tools`

Paperclip plugin that lets agents place AI-driven phone calls. **v0.1.0 ships outbound calling via Vapi.ai**, smoke-tested end-to-end. Inbound, the DIY engine (self-hosted Jambonz + modular STT/LLM/TTS pipeline), and 3CX SIP-trunk routing land in subsequent versions — all share the same plugin tool surface, so consuming skills don't need to change when capabilities are added.

## What's supported in v0.1.0

| Capability | Status |
|---|---|
| Outbound calls via Vapi (`phone_call_make`) | ✅ shipped, smoke-tested |
| Call status / transcript / list | ✅ shipped, smoke-tested |
| List Vapi assistants & phone numbers | ✅ shipped, smoke-tested |
| Create / update / delete Vapi assistants (`phone_assistant_create/update/delete`) | ✅ shipped, smoke-tested (full CRUD round-trip) |
| AI self-hangup (assistant ends call when goal is met) | ✅ shipped, verified live |
| Multi-account, per-account `allowedCompanies` isolation, fail-safe deny | ✅ shipped |
| Mutations gated by `allowMutations` (live toggle, no restart) | ✅ shipped |
| Account / allowedCompanies / engineConfig edits hot-reload (no worker restart) | ✅ shipped (`onConfigChanged` clears engine cache) |
| Per-account concurrency cap (`maxConcurrentCalls`) | ✅ shipped |
| Safety preamble (identity-claim resistance, PII refusal, anti-injection, AI-honesty) auto-prepended to every assistant prompt | ✅ shipped |
| First consuming skill: `phone-appointment-booker` | ✅ shipped (markdown procedure in `extensions/skills/`) |

## Preview in v0.1.0 (code shipped, not yet smoke-tested — first-class in v0.2.0)

The code paths exist in the worker — they're just not exercised by v0.1.0's smoke suite, so consider them best-effort until v0.2 lands.

| Capability | Why preview |
|---|---|
| Inbound calls (webhook → `plugin.phone-tools.call.received` event) | Needs `webhookSecretRef` populated, Vapi Server URL set, and a real DID routed to Vapi |
| `phone_call_end` (force-hangup) | Untested live |
| `phone_call_recording_url` | Needs `recordingEnabled` per account + a completed call with a recording |
| Cost telemetry on `call.ended` | Fires from inbound webhook handler; requires inbound to be wired |
| 3CX SIP-trunk routing (calls leave through your own DID) | Requires Vapi-side BYO SIP config; v0.1.0 uses Vapi's provisioned number |

## Future versions (planned)

| Version | What lands |
|---|---|
| v0.2.0 | Full inbound (real DID + 3CX SIP trunk + webhook signature verify), recording-URL smoke, force-hangup smoke, additional consuming skills (no-show-recovery, customer-satisfaction, renewal-confirmation chained into real CRM/calendar workflows) |
| v0.3.0 | DIY engine — see "v0.3.0 DIY engine architecture" section below. Modular STT/LLM/TTS pipeline with **ElevenLabs TTS primary, local Qwen TTS fallback** (for cost floor + privacy mode). Same `PhoneEngine` interface so it slots in without touching skills. |
| Later | DTMF mid-call, warm transfer to a human extension, voicemail-drop, mid-call function tools (in-call assistant invokes Paperclip tools), deeper 3CX Call Control API integration |

## What it does

Tools registered:

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
| `phone_assistant_update` | n/a | mutation | Patch an assistant. |
| `phone_assistant_delete` | n/a | mutation | Remove an assistant. |
| `phone_number_list` | n/a | read | List engine-side phone numbers. |

Events emitted (subscribe with `ctx.events.on("plugin.phone-tools.<event>", ...)`):

| Event | Payload kind | When |
|---|---|---|
| `plugin.phone-tools.call.received` | inbound webhook | Inbound call rings; engine asks who should answer. |
| `plugin.phone-tools.call.started` | both | Call connected. |
| `plugin.phone-tools.call.transcript.partial` | both | Live transcript chunk during call. |
| `plugin.phone-tools.call.transcript.final` | both | Full transcript after call ends. |
| `plugin.phone-tools.call.ended` | both | Call terminated; payload includes durationSec, costUsd, endReason. |
| `plugin.phone-tools.call.function_call` | both | The in-call assistant invoked one of its tools. |

## Setup walkthrough — Vapi engine + 3CX

You'll need to configure things in three places, in this order:

1. **Vapi.ai** — sign up, get an API key, configure a SIP trunk pointing at your 3CX
2. **3CX** — accept the SIP trunk from Vapi, set up an inbound route + an outbound rule
3. **Paperclip** — install the plugin, create the secrets, fill in the settings page

### 1. Vapi.ai

1. Sign up at https://dashboard.vapi.ai. Create an Org if needed.
2. **API key:** Org → API Keys → create a **Private API Key** (NOT the public/web key). Copy it.
3. **Webhook secret:** Org → Server URL → set Server URL to `https://<your-paperclip-host>/api/plugins/phone-tools/webhooks/vapi`. Set "Server URL Secret" to a strong random string. Copy it. Vapi signs every webhook with HMAC-SHA256 using this secret.
4. **SIP trunk to 3CX (for inbound):** Phone Numbers → Add Phone Number → choose **BYO SIP Trunk**. Configure it with your 3CX SIP credentials so Vapi can register against your 3CX as a SIP user. Note the number's `id` (UUID) — you'll need it as `defaultNumberId`.
5. **Outbound numbers:** Same panel. Vapi can dial out via the same BYO trunk, in which case 3CX is the carrier and the call originates from one of your DIDs.
6. **(Optional) Create an assistant** in the dashboard to get an `assistantId` for `defaultAssistantId`. Or skip — agents can pass an inline assistant config to `phone_call_make` without one saved.

### 2. 3CX (Enterprise edition required for SIP trunks)

Reference: https://www.3cx.com/docs/manual/sip-trunks/.

1. **Add SIP Trunk:** Admin → SIP Trunks → Add → Generic SIP Trunk. Name it "Vapi". Use the registration credentials Vapi gave you.
2. **Codec:** Set to **G.711 µ-law (PCMU)** as primary. Vapi supports both PCMU and Opus; PCMU has the broadest compat with PSTN trunks.
3. **NAT:** if 3CX is behind NAT, enable **STUN** in the trunk's advanced settings. Vapi's media servers expect to reach you on the SIP-advertised IP.
4. **Inbound route:** Admin → Inbound Rules → Add. Match a DID you own → Route to the Vapi trunk. This makes external calls to that DID hit Vapi → trigger the `assistant-request` webhook → emit `plugin.phone-tools.call.received`.
5. **Outbound rule (optional):** Admin → Outbound Rules → Add. Pattern: any outbound number Vapi dials uses the Vapi trunk as the gateway. This makes Vapi-initiated calls leave through one of your 3CX DIDs.
6. **Test:** Call the inbound DID from a cell phone. You should see the call hit Vapi (Vapi dashboard → Calls). If 3CX rejects with "no route", check the trunk registration status.

### 3. Paperclip

Replace `<extensions>` with the path to your `paperclip-extensions` checkout and `<paperclip>` with your `paperclip` checkout. On Windows these typically live under `%USERPROFILE%\` (e.g. `%USERPROFILE%\paperclip-extensions`); on macOS/Linux under `$HOME/`.

```bash
# Build the plugin
cd <extensions>/plugins/phone-tools
pnpm install && pnpm build

# Install it into your local Paperclip
cd <paperclip>
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local <extensions>/plugins/phone-tools
```

> **Dev-loop tip:** after `pnpm build`, use `scripts/dev-redeploy.sh` (which runs `paperclipai plugin reinstall phone-tools` under the hood) to push the new `dist/` into `~/.paperclip/installed-plugins/` and reload the worker in one shot. Subsequent `pnpm build` does NOT auto-refresh the installed copy on its own — `paperclipai plugin reinstall <key>` is what bridges the two.

Then in the Paperclip UI:

1. **Create the two secrets** (per company that will use phone tools):
   - Secrets page → Add → name `vapi-api-key`, value = the Private API Key from step 1.2. Copy the secret UUID.
   - Add → name `vapi-webhook-secret`, value = the Server URL Secret from step 1.3. Copy that UUID.
2. **Open the plugin settings:** `/instance/settings/plugins/phone-tools`.
3. **Add an account:**
   - Identifier: `main` (or per-company: `c3-main`, `m3-main`, etc.)
   - Engine: `vapi`
   - Engine API key: paste the `vapi-api-key` secret UUID
   - Webhook signing secret: paste the `vapi-webhook-secret` secret UUID
   - Default phone-number ID: the UUID from step 1.4 (run `phone_number_list` once if you forgot)
   - Default assistant ID: leave blank if you didn't pre-create one in Vapi
   - Allowed companies: tick the company that owns these calls (single-company recommended)
   - Recording enabled: leave **off** unless you've added a consent disclosure to your assistant's first message
   - Max concurrent calls: 3 (default)
4. **Set Default account key** to `main` (or whatever you named it).
5. **Allow mutations:** leave **off** until you've placed at least one test call manually via `phone_call_make` and reviewed the transcript.

## Sample tool invocations

Place an outbound call:

```json
{
  "tool": "phone_call_make",
  "params": {
    "to": "+15551234567",
    "assistant": {
      "name": "AppointmentBooker",
      "systemPrompt": "You are calling on behalf of <CALLER NAME> to book a haircut. The shop is 'Sharp Cuts'. Preferred times: Tuesday or Wednesday afternoon, between 2pm and 5pm. Be polite, brief, and confirm the booking time before hanging up.",
      "firstMessage": "Hi, this is an automated assistant calling on behalf of <CALLER NAME>. I'd like to book a haircut. Is this a good time to chat?",
      "voice": "11labs:rachel",
      "model": "openai:gpt-4o"
    },
    "metadata": { "issueRef": "iss_abc123" },
    "idempotencyKey": "issue:iss_abc123:booking-attempt"
  }
}
```

Get status:

```json
{ "tool": "phone_call_status", "params": { "callId": "<callId from above>" } }
```

Subscribe to inbound calls (in your skill / heartbeat):

```ts
ctx.events.on("plugin.phone-tools.call.received", async (event) => {
  // event.payload = { kind, callId, from, to, numberId, assistantId?, startedAt, accountKey, engine }
  // … decide who/what should handle it; e.g. find the customer by `from`
});
```

## Error codes

| Code | Meaning |
|---|---|
| `[EACCOUNT_REQUIRED]` | Tool was called without `account` and there's no `defaultAccount`. |
| `[EACCOUNT_NOT_FOUND]` | The named account doesn't exist on the settings page. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in the account's `allowedCompanies`. |
| `[ENUMBER_NOT_ALLOWED]` | The phone-number ID isn't in the account's `allowedNumbers`. |
| `[EASSISTANT_NOT_ALLOWED]` | The assistant ID isn't in the account's `allowedAssistants`, OR an inline assistant was passed when only ID-based assistants are allowed. |
| `[ECONCURRENCY_LIMIT]` | Account already has `maxConcurrentCalls` outbound calls in flight. |
| `[ERECORDING_DISABLED]` | `phone_call_recording_url` was called on an account that has `recordingEnabled=false`. |
| `[EDISABLED]` | A mutation tool was called while the master `allowMutations` switch is off. |
| `[EENGINE_NOT_AVAILABLE]` | Account selected `engine: "diy"` but DIY ships in v0.3.0. |
| `[EENGINE_UNKNOWN]` | Account selected an engine kind that isn't recognized. |
| `[EINVALID_INPUT]` | A required parameter was missing/empty. |
| `[ECONFIG]` | Plugin config is wrong (missing apiKeyRef, secret didn't resolve, etc.). |
| `[EVAPI_AUTH]` / `[EVAPI_FORBIDDEN]` / `[EVAPI_NOT_FOUND]` / `[EVAPI_INVALID]` / `[EVAPI_RATE_LIMIT]` / `[EVAPI_NETWORK]` / `[EVAPI_<status>]` | Upstream Vapi errors mapped from HTTP status. |

## Company-isolation contract

Every account carries `allowedCompanies`. Default is **deny**: a missing or empty list = unusable. `["*"]` = portfolio-wide. Per the Paperclip plugin convention, every tool reads `runCtx.companyId` and refuses to operate against an account whose allow-list excludes it.

In addition to the account-level check, individual phone numbers and assistants can be further restricted via `allowedNumbers` / `allowedAssistants`. Tools enforce these; `phone_number_list` and `phone_assistant_list` filter the response so an agent in company A doesn't even *see* numbers / assistants scoped to company B.

**Inbound webhooks** are emitted per-company. The plugin fans out the event to every company in the receiving account's `allowedCompanies`. Accounts using `["*"]` portfolio-wide do **not** emit inbound events (no obvious target); narrow the allow-list to specific company UUIDs to enable inbound.

## Cost considerations

- Vapi: ~$0.05/min on top of underlying model + voice provider costs (typically $0.10–0.25/min total).
- 3CX SIP trunk to PSTN: whatever your trunk provider charges (Twilio, Telnyx, your local CLEC, etc.). Usually $0.01–0.02/min.
- Total: rough order of magnitude **$0.10–0.30 per minute** of conversation.
- The `maxConcurrentCalls` per-account cap (default 3) is a guardrail against runaway costs from a misbehaving agent.
- `ctx.telemetry.track("phone-tools.call.vapi", { durationSec, costUsd, … })` fires on every `call.ended`, so the cost-events service aggregates it.

## Recording + consent

Leave `recordingEnabled` **off** unless you've added an audible consent disclosure to your assistant's `firstMessage`. Many US states (and most of Canada / EU) require explicit two-party consent. The plugin does not auto-inject the disclosure — that's intentionally on the operator so the wording fits the use case.

## Limitations / out of scope (v0.1.0)

- DTMF mid-call (`phone_dtmf_send`) — punted.
- Warm transfer to a human extension (`phone_call_transfer`) — punted.
- Voicemail-drop (record + leave without ringing) — punted.
- Multi-party conferencing — punted.
- Direct integration with the 3CX Call Control API for richer routing decisions ("if AI flags angry caller, transfer to extension 200") — consider after v0.2 if there's demand.
- Per-call budget enforcement — handled at the `cost-events` service layer once the cross-plugin budget API lands.

## v0.3.0 DIY engine architecture (planned)

Same `PhoneEngine` interface as the Vapi engine — drop-in from the consuming skill's perspective — but the audio loop is assembled from independent components instead of a single hosted service. Audio + transcripts stay on operator-controlled infrastructure (or operator-chosen vendors), giving a cost floor and a privacy mode.

**Pipeline:**

| Layer | Default | Fallback / Alternative | Why |
|---|---|---|---|
| SIP gateway | **Jambonz** (self-hosted on a small VM) | — | Open source, designed for AI voice agents, speaks SIP natively, exposes calls as WebSocket events |
| STT | **Deepgram** (streaming, sub-200ms) | local **Whisper** (eventually) for full air-gap mode | Cloud STT is meaningfully better today; local Whisper is the privacy floor when needed |
| LLM | per-account config (Claude default; GPT / Gemini / local options) | — | Already plugin-LLM-agnostic; the engine just streams text in/out |
| TTS | **ElevenLabs** (primary) | **Qwen TTS local** (fallback) | ElevenLabs has best-in-class quality + sub-300ms streaming; Qwen TTS runs locally for (a) ElevenLabs API failure, (b) ElevenLabs rate limit, (c) per-account "always local" privacy mode |
| Audio relay | per-call WebSocket bridge inside the plugin worker | — | Glues Jambonz audio frames to STT input and TTS output to Jambonz audio frames |

**TTS fallback behaviour:**

The TTS layer is the operator's biggest privacy/cost lever, so it gets explicit fallback machinery:

1. **Primary:** ElevenLabs — best voice quality, fast streaming, ~$0.05–0.10/min.
2. **Fallback to Qwen TTS local on:**
   - ElevenLabs API returns 5xx for >2 consecutive chunks
   - ElevenLabs API returns 429 (rate limit)
   - Account is configured with `ttsMode: "always-local"` (per-account opt-in for sensitive calls — e.g. medical, financial, legal)
3. **Per-account choice:** the engineConfig can pin to one TTS provider only (`tts: "elevenlabs"` or `tts: "qwen-local"`) for operators who want predictable behaviour.

When fallback fires mid-call, the call continues without interruption — the operator gets a slightly different voice for the remainder. A `tts.fallback_engaged` event fires so the operator knows.

**Why this architecture (vs. the original "OpenAI Realtime in one connection" sketch):**

The first DIY draft was "Jambonz + OpenAI Realtime — one streaming connection does STT+LLM+TTS." Simpler but locks you to OpenAI's voices and models. Splitting into Deepgram (STT) + LLM-of-choice + ElevenLabs/Qwen (TTS) costs slightly more orchestration code in the engine but:
- Lets you use Claude (which Paperclip is already built on) instead of being forced to GPT
- Lets you swap TTS providers per-account without code changes
- Gives you a real local-fallback path so a privacy-mode account can keep audio entirely on-prem
- Matches the "image-tools provider config" pattern the rest of the plugin ecosystem uses

The plugin spec for this is in [plugin-plans/09-phone-tools.md](../../plugin-plans/09-phone-tools.md) §Phase 2 (DIY engine).

Switching one account from `vapi` to `diy` will only require changing the engine dropdown and supplying the DIY-specific secrets — no code changes in skills that consume the plugin.
