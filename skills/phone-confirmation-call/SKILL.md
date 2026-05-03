---
name: phone-confirmation-call
description: Place a brief outbound call to confirm an existing scheduled item — appointment, delivery, pickup, service window, reservation. Examples - "call the customer to confirm tomorrow's 2pm pickup", "call ahead to confirm the contractor still arrives Thursday morning", "phone the dental office to confirm Saturday's cleaning is still on the books". Use when the goal is verification of an already-booked item, NOT booking a new one (use phone-appointment-booker for new bookings). Often runs as a recurring routine (e.g. "confirm tomorrow's pickups every weekday at 4pm").
---

# Phone Confirmation Call

Verifies an already-scheduled item is still happening as planned, captures any drift (time changed, rescheduled, canceled, no-show risk), and reports back. Designed to be cheap and fast — usually 30–60 seconds, $0.05–0.15 per call.

## When to invoke

- A scheduled routine fires confirmation calls before a known service window — e.g. "every weekday at 4pm, call tomorrow's appointments to confirm" for a dental practice, salon, repair shop.
- An assignment says "call X and make sure Y is still on for Z." Outbound, single business or customer.
- Before a high-stakes pickup or delivery where a no-show is expensive (large print order, real-estate showing, contractor onsite).

Do NOT invoke when:
- Booking something new — use [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md) instead.
- The item was already confirmed within the last 24 hours (avoid pestering).
- The recipient has explicitly opted out of confirmation calls (check `customer.preferences.no_confirmation_calls` in CRM if you have one).

## Pre-conditions

Same as `phone-appointment-booker`:
- `phone-tools` plugin installed + `ready` for the calling company.
- `allowMutations: true`.
- Real E.164 destination number.
- `defaultNumberId` set OR `from` passed explicitly.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `recipient_phone` | yes (E.164) | `+15555550123` |
| `recipient_name` | yes | "Maple Dental" or "Jane Smith" |
| `caller_identity` | yes | "Sharp Cuts Barber" (you, calling on behalf of your business) |
| `item_description` | yes | "your 2pm cleaning tomorrow" / "tomorrow's pickup of your business cards" |
| `item_datetime_iso` | yes | `2026-05-04T14:00:00-04:00` |
| `verification_questions` | recommended | optional second-touch questions: "any allergies we should know about?", "the order is 250 cards in matte finish — still correct?" |
| `cancellation_policy` | recommended | what to say if they cancel: "we'll release the slot — let us know if you'd like to reschedule" |
| `reschedule_authority` | yes/no | can the AI offer alternative slots if they want to reschedule? Default: NO (kicks back to a human). |

If `reschedule_authority` is `yes`, attach a list of alternative slots the AI may offer. Don't let the AI invent slots.

## Step 2 — Construct the assistant config

```
You are calling {recipient_name} on behalf of {caller_identity} to confirm {item_description} scheduled for {item_datetime_human}.

GOAL: confirm the recipient is still planning to attend / be present / accept delivery as scheduled. Capture any drift (time change, cancellation, partial change to the item).

EXPECTED FLOW:
1. Greet by name, identify yourself, state the purpose and the time you're confirming.
2. Wait for confirmation. Most calls end here — say goodbye and hang up.
3. If they want to RESCHEDULE: {reschedule_branch}
4. If they want to CANCEL: acknowledge briefly, mention {cancellation_policy_text}, then end the call.
5. If they have QUESTIONS you can answer from the brief, answer them. If you don't have the answer, say "I'll have someone from {caller_identity} follow up on that" — do NOT invent details.

VERIFICATION QUESTIONS (ask only if natural to do so, not as a list):
{verification_questions_block}

RULES:
1. Keep it brief — the customer is being interrupted by a robocall; respect their time.
2. If they're hostile or busy, apologize, mark the appointment as "unconfirmed-no-issue" and end the call quickly.
3. If they don't answer or it's a voicemail: leave a short message - "Hi, this is calling from {caller_identity} to confirm {item_description} for {item_datetime_human}. If anything has changed, please give us a call back. Thanks." Then hang up.
4. End the call with the end-call function once you have a clear answer (confirmed / canceled / rescheduled / unreachable).
```

`{reschedule_branch}` is one of:
- (no authority) "Tell them: 'I don't have the schedule in front of me — let me have someone from {caller_identity} call you back to find a new slot.' Then end the call."
- (with authority) "Offer the following alternative slots in order: {alt_slots_list}. If they accept one, confirm it back to them. If none work, say 'let me have someone from {caller_identity} call you with more options.'"

`firstMessage` template:

```
Hi, may I speak with {recipient_name}? This is {caller_identity} calling to confirm {item_description} for {item_datetime_human}.
```

If `recipient_name` is a business (not a person), drop the "may I speak with" — just lead with the calling identity.

## Step 3 — Place the call

Same as `phone-appointment-booker` Step 3. Use `metadata.purpose = "confirmation-call"` so the cost-events service can aggregate by skill. Idempotency key: `confirmation:{item_id}:{ymd}`.

## Step 4 — Wait for completion

Same polling pattern. Confirmation calls end fast — 90% complete inside 60 seconds. Cap polling at 3 minutes.

## Step 5 — Read the transcript and classify

Outcomes to detect:

| Outcome | Signal in transcript |
|---|---|
| `confirmed` | Recipient affirmed the time / arrival / pickup. |
| `canceled` | Recipient said they can't make it, no reschedule requested. |
| `reschedule-requested` | Recipient wants a different time; AI either booked one (if authority granted + a slot was accepted) or kicked to human (no authority). |
| `time-changed` | Recipient is coming at a different time (e.g. "I'll actually be there at 3 instead of 2"). Capture the new time. |
| `voicemail-left` | Reached voicemail; left the standard message. Treat as soft-confirm — they'll call back if it's wrong. |
| `unreachable` | No-answer / busy / went straight to voicemail without leaving a message. |
| `unclear` | Conversation ambiguous — flag for human review. |
| `unconfirmed-no-issue` | Recipient was hostile or in a hurry but no actual issue. Treat as unconfirmed but don't escalate. |

Extract:
- `final_datetime` — ISO of confirmed/changed time (defaults to original if `confirmed`)
- `notes` — any verification answers or relevant comments
- `transcript_excerpt` — the 1–3 turns containing the decision

## Step 6 — Report back + side effects

Comment on the parent issue / routine run:

```
Confirmation call to {recipient_name} for {item_description}:
- Outcome: {outcome}
- Final time: {final_datetime}
- Duration: {durationSec}s · Cost: ${costUsd}
- Notes: {notes or "none"}
```

Side effects per outcome:
- `confirmed` / `voicemail-left` — mark item as `confirmed`. No further action.
- `canceled` — mark item as `canceled` in the source system (calendar, CRM). If `auto_release_slot: true` on the brief, release the time slot. Notify the human owner of the appointment.
- `reschedule-requested` (no authority) — open a `phone-appointment-booker` follow-up issue OR a manual task for a human to call back. Do NOT auto-book.
- `reschedule-requested` (with authority + slot accepted) — update the source system to the new time; send a calendar update if applicable.
- `time-changed` — update the source system to the new time. Notify the human owner.
- `unreachable` — schedule one retry in 4 hours. After 2 unreachables, mark as `unconfirmed-unreachable` and leave for human triage.
- `unclear` — flag for human review; do NOT auto-act.

## Errors

Same as `phone-appointment-booker`. The most common one for confirmation calls is `[ECONCURRENCY_LIMIT]` when the routine fires for a busy day — solve by either (a) raising `maxConcurrentCalls` for this account, or (b) processing the day's confirmations sequentially with 60-second pacing.

## Cost discipline

Per call: ~$0.05–0.15. Per-day for a busy practice (50 confirmations) = ~$5–8. Less than a single missed appointment usually costs.

## Cadence example (recurring routine)

```yaml
# In Paperclip routine config
schedule: "0 16 * * 1-5"  # weekday afternoons 4pm
skill: phone-confirmation-call
input_source: tomorrow's appointments from {calendar | crm | scheduler}
batch_pacing_seconds: 30  # 30s gap between calls so the account's concurrency cap doesn't trip
```

## Out of scope

- Multi-recipient calls (one call per recipient; if you want to confirm a household, pick the primary contact).
- Negotiating new bookings — that's `phone-appointment-booker`.
- Outbound marketing / promo calls — different skill (TBD), strict regulatory considerations.
- SMS confirmations — different (future) plugin (`sms-tools`); SMS is often cheaper and less intrusive for routine confirmations, consider it as the primary channel and use phone confirmation only for high-value items or when SMS hasn't been responded to.

## See also

- [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md) — for booking new items
- (future) `phone-callback-handler` — for inbound returns on this confirmation
