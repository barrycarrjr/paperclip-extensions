---
name: phone-appointment-booker
description: Place a real outbound phone call to book an appointment, reservation, or callback on the caller's behalf. Use when the assignment includes a request to call a business and arrange something — "book me a haircut at Sharp Cuts for Tuesday afternoon", "call Maple Dental and reschedule my cleaning", "phone the vet and ask if they have a Saturday opening", or any variant where the *desired outcome* is an appointment confirmation. Anchor use case for the phone-tools plugin (Vapi engine, v0.1.0).
---

# Phone Appointment Booker

Drives a real outbound PSTN call through `phone-tools` to negotiate an appointment with a human at a business. Returns either a confirmed slot, a soft "they'll call you back", or a clear "not bookable today + reason".

This skill is the in-call assistant's *operator*: it constructs the assistant config from the assignment, places the call, monitors it to completion, parses the transcript, and reports back. It does NOT implement audio handling itself — that lives in `phone-tools` + Vapi.

## When to invoke

- An assignment / issue includes a clear "call X to book/schedule/reserve/confirm Y" intent and provides (or the caller can find) a phone number.
- A scheduled routine fires it for recurring confirmations ("call dental office Mondays to confirm the week's appointments").
- An operator chat-message says "book me a haircut at Sharp Cuts for Tuesday afternoon."

Do NOT invoke when:
- The business has online booking the caller can use directly (cheaper, faster, more reliable). Verify by checking their site first if uncertain.
- The intent is "leave a voicemail" — that's a different skill (voicemail-drop, not yet built).
- The caller has not authorized AI to act on their behalf for this call.

## Pre-conditions

- `phone-tools` plugin installed + `ready`, with at least one Vapi account configured.
- The calling company is in the account's `allowedCompanies`.
- The account has `allowMutations: true` AND `defaultNumberId` set (or you must pass `from` explicitly).
- The destination phone number is a real E.164 number (e.g. `+15551234567`). If only a website is given, look up the number first via web search, then pass it.
- For US calls expect ~$0.10–0.30 per minute; budget accordingly.

## Step 1 — Resolve the brief

Pull these fields from the assignment (ask the operator if any are missing or ambiguous):

| Field | Required | Example |
|---|---|---|
| `business_name` | yes | "Sharp Cuts Barber" |
| `business_phone` | yes (E.164) | `+15555551234` |
| `caller_name` | yes | "Alex Smith" |
| `caller_callback_phone` | recommended | `+15555550000` (in case the business needs to call back) |
| `service_or_purpose` | yes | "men's haircut, no beard trim" |
| `time_preferences` | yes | "Tuesday or Wednesday afternoon, between 2pm and 5pm" |
| `time_constraints` | recommended | "must be after 1pm, can't do Mondays" |
| `fallback_acceptable` | recommended | "anything next week works if Tue/Wed don't" |
| `decline_threshold` | recommended | "decline if next opening is more than 14 days out" |

If any required field is missing, surface a question to the operator (or open an `AskUserQuestion` interaction) instead of guessing.

## Step 2 — Construct the assistant config

The assistant config is what makes the call go well or badly. The system prompt must encode the goal, constraints, and what counts as success.

Template:

```
You are calling {business_name} on behalf of {caller_name} to book {service_or_purpose}.

GOAL: secure a confirmed appointment slot that fits {caller_name}'s preferences below. Once booked, confirm the date, time, and any prep instructions, then end the call.

CALLER PREFERENCES:
- Preferred times: {time_preferences}
- Constraints: {time_constraints}
- Fallback: {fallback_acceptable}
- DECLINE if: {decline_threshold}

CALLER CALLBACK INFO (if asked):
- Name: {caller_name}
- Phone: {caller_callback_phone}

RULES:
1. Be polite, brief, and natural. Match the receptionist's pace.
2. Do NOT make commitments outside the preferences above. If they offer a slot outside the constraints, politely ask if anything closer to the preferences is available before accepting.
3. If they ask for information you don't have (insurance, member ID, special requests), say "I'll have {caller_name} confirm that directly" and move on — do NOT invent details.
4. If the line is an IVR or "press 1 for X" menu, say "I'd like to speak to a person" or wait for a live agent. If you're stuck on hold for more than 60 seconds, end the call politely.
5. Once a slot is confirmed (or definitively declined / unavailable), say a brief goodbye and END THE CALL using your end-call tool. Do not chat further.

Total call should be under 5 minutes.
```

`firstMessage` template:

```
Hi, this is calling on behalf of {caller_name}. I'd like to book {service_or_purpose} — is now a good time?
```

Keep `voice` and `model` empty unless the operator has a tested preference; Vapi's defaults are reliable.

## Step 3 — Place the call

Invoke `phone-tools:phone_call_make`:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n \
    --arg agent  "$PAPERCLIP_AGENT_ID" \
    --arg run    "$PAPERCLIP_RUN_ID" \
    --arg comp   "$PAPERCLIP_COMPANY_ID" \
    --arg to     "$BUSINESS_PHONE" \
    --arg prompt "$SYSTEM_PROMPT" \
    --arg first  "$FIRST_MESSAGE" \
    --arg name   "Booker-$ISSUE_REF" \
    --arg idem   "issue:$ISSUE_REF:booking-attempt-$ATTEMPT_N" \
    '{
      tool: "phone-tools:phone_call_make",
      runContext: { agentId: $agent, runId: $run, companyId: $comp },
      parameters: {
        to: $to,
        assistant: { name: $name, systemPrompt: $prompt, firstMessage: $first },
        metadata: { issueRef: env.ISSUE_REF, purpose: "appointment-booker" },
        idempotencyKey: $idem
      }
    }')"
```

Capture `data.callId` from the response. Use the `idempotencyKey` to prevent duplicate calls if the skill is retried within 24h.

## Step 4 — Wait for completion

Poll `phone-tools:phone_call_status` every 5–10 seconds (most calls finish in 30–180 seconds). A typical completion produces:

```json
{ "data": { "status": "ended", "endReason": "assistant-said-end-call-phrase",
            "durationSec": 87, "costUsd": 0.183 } }
```

Stop polling on terminal states: `ended`, `failed`, `no-answer`, `busy`, `canceled`. Cap polling at 6 minutes (the assistant has a 5-minute hard cap; +1 minute for slack).

If `status === "no-answer"` or `"busy"`: the business didn't pick up. Decide whether to retry now (probably not — they're closed or slammed), schedule a retry for later, or surface "couldn't reach them" to the operator.

If `status === "failed"`: read `endReason`. Common causes: bad number format, line disconnected, Vapi-side outage. Surface the reason; do NOT auto-retry without operator confirmation.

## Step 5 — Read the transcript

```bash
TRANSCRIPT=$(curl -sS -X POST ... -d '{
  "tool": "phone-tools:phone_call_transcript",
  "runContext": {...},
  "parameters": { "callId": "<callId>", "format": "structured" }
}')
```

Use `format: "structured"` to get role-tagged turns (`agent` / `caller`). Parse the AI's confirmations to extract the booked slot.

A typical successful turn from the AI:

> "Great, I have you down for Tuesday the 7th at 3:30 PM with David. Anything I should let {caller_name} know about prep?"

Extract:
- `booked_at: "2026-05-07T15:30:00-04:00"` (ISO, with the operator's TZ)
- `provider_name: "David"` (if mentioned)
- `prep_notes: "<any instructions>"` (if mentioned)
- `outcome: "booked"`

If no slot was secured, classify the outcome:
- `outcome: "declined-out-of-window"` — they offered slots that don't match preferences and nothing closer is available.
- `outcome: "callback-promised"` — they need to check the schedule and will call back.
- `outcome: "voicemail"` — went to voicemail; no human reached.
- `outcome: "ivr-stuck"` — never reached a human.
- `outcome: "unclear"` — call ended ambiguously; flag for human review.

## Step 6 — Report back

Post a comment on the parent issue with the result:

```
Appointment booking attempt for {service_or_purpose} at {business_name}:
- Outcome: {outcome}
- Booked slot: {booked_at} (if applicable)
- Duration: {durationSec}s · Cost: ${costUsd}
- callId: {callId}

Transcript excerpt:
> AI: ...
> Caller: ...
> AI: ...
```

If `outcome === "booked"`, ALSO:
- Create a Google Calendar event via `google-workspace:gcal_create_event` (if the calendar plugin is wired) so the slot lands in the operator's calendar.
- Set the issue status to `done` if it was opened specifically for this booking.

If `outcome === "callback-promised"`, ALSO:
- Subscribe a one-off agent wakeup for ~24 hours from now to check whether the callback came through (via `phone-tools` inbound `call.received` event, when v0.2.0 lands).
- For now, just leave the issue in `pending` with a note.

If `outcome` is anything else, leave the issue in `pending` and let a human triage.

## Errors

- `[EDISABLED] phone_call_make is disabled` — operator hasn't flipped `allowMutations` on for the phone-tools account. Surface; don't retry.
- `[ECOMPANY_NOT_ALLOWED]` — calling company isn't in the account's allow-list. Surface; this is a config issue, not a transient one.
- `[ECONCURRENCY_LIMIT]` — account already has `maxConcurrentCalls` outbound calls in flight. Wait 30 seconds and retry once; if still hits, queue for later.
- `[ENUMBER_NOT_ALLOWED]` — the `from` number isn't in `allowedNumbers`. Surface as a config issue.
- `[EVAPI_INVALID]` — usually a malformed E.164 destination. Recheck the number, surface for human review.
- `[EVAPI_RATE_LIMIT]` — exponential backoff (30s, 2m, 10m). Don't loop forever.

## Cost discipline

- Each call costs roughly $0.10–0.30 depending on duration. Set `metadata.purpose = "appointment-booker"` so the cost-events service can aggregate by skill.
- If the business is on a "press 1 for English, press 2 for ..." IVR forever, the assistant will bail at 60s of hold and the call costs ~$0.10 for nothing — that's the right behavior, don't tune it lower.
- Cap the assistant's `maxDurationSeconds` at 5 minutes (already set in the engine defaults).
- Don't auto-retry failed calls without operator confirmation — silent retries are how you accidentally call the same business 12 times.

## Out of scope

- Multi-leg coordination ("call dentist AND get authorization from insurance first") — split into separate skills/calls; this skill does ONE call against ONE business.
- Negotiating price, services, or terms — this skill books appointments only. Use a different skill (not yet built) for sales-style calls.
- Any call to a personal/residential number on behalf of someone else — appointment booking against businesses only. The assistant prompt assumes a business reception context.
- Inbound callbacks — covered by the `phone-tools` `call.received` event and a separate (future) `phone-callback-handler` skill (lands with v0.2.0).

## See also

- [`plugins/phone-tools/`](../../plugins/phone-tools/) — the plugin this skill drives
- Future siblings: `phone-vendor-status-check`, `phone-callback-agent`, `phone-followup-after-quote`
