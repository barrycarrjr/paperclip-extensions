# `phone-tools`

Paperclip plugin that lets agents and operators place AI-driven phone calls through Vapi.ai. **v0.3.0 ships the Assistants UI** — a top-level "Assistants" sidebar entry, an 8-step builder wizard, a Phone tab on the agent detail page, "Place call" / "Test on my phone" modals, and a hard daily cost cap per assistant. The agent-tool surface from v0.1.0 still works the same way for skill / heartbeat consumers; the new UI is operator-facing.

## Recent changes

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
| v0.4.0 | Inbound routes UI on the Phone tab (DID → Assistant mapping, business hours, voicemail-drop fallback). Assistant phone capability for executive-role agents (currently Phone tab is only meaningful for `role: "assistant"`). |
| v0.5.0 | DIY engine — Jambonz + Deepgram (STT) + Claude/GPT (LLM) + ElevenLabs (TTS, with Qwen-local fallback). Same `PhoneEngine` interface so it slots in without touching skills or wizards. Same engine dropdown on the account config. |
| Later | DTMF mid-call, warm transfer to a human extension, voicemail-drop, mid-call function tools, deeper 3CX Call Control API integration |

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
