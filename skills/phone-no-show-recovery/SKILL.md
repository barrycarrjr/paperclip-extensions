---
name: phone-no-show-recovery
description: Place an immediate outbound call to a customer who just missed a scheduled appointment / pickup / service window — within minutes, while the slot is still recoverable. Examples - "the 2pm haircut customer didn't show up, call them right now", "the dental cleaning at 9am is 10 minutes overdue, call to find out where they are", "the print order pickup window closed without them showing up". Use to recover bookings that would otherwise just close as no-shows. Time-critical: most no-shows are recoverable in the first 15 minutes, almost none after 60.
---

# Phone No-Show Recovery

Calls a no-show within minutes of the missed slot, finds out what happened, and either reschedules in the same call OR gives the customer a graceful close. Designed to be brief, warm, and non-judgmental — most no-shows are honest oversights, not flake behavior.

## When to invoke

- An event-driven routine fires N minutes (typical: 5–15) after a scheduled slot's start time when the customer hasn't checked in.
- An assignment from front-desk staff: "the {time} customer is a no-show, call them."
- A scheduled sweep at the end of each appointment block to catch any slipped-through-the-cracks no-shows.

Do NOT invoke when:
- The customer has already called/texted to say they'll be late or can't make it.
- The appointment was less than 5 minutes ago — give them a real chance to walk through the door first.
- It's been more than 60 minutes since the slot — the slot is gone; treat as standard `cancellation` and let the human follow up via email or a fresh `phone-followup-after-quote` if appropriate.
- The customer's CRM record has `do_not_call_no_show: true` (some customers prefer email-only).

## Pre-conditions

Same as `phone-appointment-booker`:
- `phone-tools` plugin installed + ready, `allowMutations: true`, real E.164 destination, `defaultNumberId` set.

Plus:
- The agent has access to the missed appointment's details (when, what for, with whom) — usually from a calendar / scheduler / CRM integration.
- If the brief includes `reschedule_authority: yes`, the agent must also have access to a list of available alternative slots for the same service (don't let the AI invent slots).

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `customer_phone` | yes (E.164) | `+15555550123` |
| `customer_name` | yes | "Pat Jones" |
| `caller_business` | yes | "Acme Dental" |
| `missed_appointment_summary` | yes | "your 2pm cleaning today with Dr. Lee" |
| `missed_appointment_datetime_iso` | yes | `2026-05-03T14:00:00-04:00` |
| `minutes_late` | yes | how late they are right now |
| `reschedule_authority` | yes/no | can the AI offer alternative slots? |
| `alternative_slots` | required if reschedule_authority=yes | list of `{datetime_iso, label}` slots in the next 7 days |
| `cancellation_fee_policy` | recommended | what to say if they ask: "no fee for first no-show; second is $25" — DO NOT charge anything during the call |
| `escalate_to_human_if` | recommended | conditions for warm handoff ("they're upset", "they want a different provider", "they want a refund") |

## Step 2 — Construct the assistant config

```
You are calling {customer_name} on behalf of {caller_business} because they missed {missed_appointment_summary} which was scheduled for {missed_time_human} — about {minutes_late} minutes ago.

GOAL: find out what happened and, if appropriate, reschedule them right now. Be warm, never accusatory. Most no-shows are honest mistakes — assume the best.

EXPECTED FLOW:
1. Identify yourself, mention the missed appointment in a friendly tone, ask if everything is okay.
2. Listen carefully. Branch on what you hear:
   a. ON THE WAY ("I'm 5 minutes out", "stuck in traffic but coming") → say "great, we'll see you when you get here" — capture ETA — end the call. (Note: the human needs to verify the slot is still available; you're just confirming intent.)
   b. FORGOT / CAN'T MAKE IT TODAY ("I totally forgot", "something came up") → {if reschedule_authority then "offer to reschedule right now: 'No problem at all. I have these openings — would any of these work?' Read the alternative_slots conversationally." else "say 'No worries — I'll have someone from " + caller_business + " text you to find a new time.'"}
   c. DECIDED NOT TO COME ("I changed my mind", "we cancelled") → say "got it, no problem. We'll mark today's slot as cancelled. Is there anything we can do for you in the future, or should we close out the appointment entirely?" Capture answer. End the call.
   d. NO LONGER A CUSTOMER ("we don't need this anymore") → acknowledge gracefully, ask if they'd like a feedback note recorded for the team. End the call.

RULES:
1. NEVER make them feel guilty. People miss things. The call should feel like a friendly check-in, not a rebuke.
2. Do NOT charge a no-show fee during the call. Even if a fee policy exists, only mention it if they ASK ("will I be charged?"). Defer the actual charge to a human.
3. NEVER imply they're the problem. "Things happen" / "no worries" / "totally understandable" — language that releases pressure.
4. If they're hostile or upset, apologize sincerely, mark for human escalation, end the call quickly.
5. If you reach voicemail, leave a SHORT message: "Hi {customer_name}, this is calling from {caller_business} just checking in on {missed_appointment_summary}. No worries if today doesn't work — give us a call back when you have a moment to find a new time. Thanks!" Then hang up.
6. End the call with the end-call function once you have one of the four answers above OR voicemail.

Total call should be under 90 seconds.
```

`firstMessage`:

```
Hi {customer_name}, it's calling from {caller_business} — I'm reaching out about {missed_appointment_summary}. Just wanted to check in and make sure everything's okay.
```

## Step 3 — Place the call

Same as `phone-appointment-booker` Step 3. `metadata.purpose = "no-show-recovery"`, `metadata.appointment_id = <id>`. Idempotency key: `no-show-recovery:{appointment_id}` so a retry storm doesn't double-call.

## Step 4 — Wait for completion

Cap polling at **2 minutes** — these calls are fast or they're voicemail. If a call goes longer than 90s the AI is probably stuck; treat as `unclear` and review.

## Step 5 — Read the transcript and classify

| Outcome | Signal |
|---|---|
| `on-the-way` | Customer is en route, capture `eta_minutes` if mentioned. |
| `rescheduled-same-call` | Customer accepted one of the offered alternative slots; capture `new_appointment_datetime`. |
| `wants-reschedule-needs-human` | Customer wants to reschedule but no authority OR none of the offered slots worked. |
| `decided-not-to-come` | Customer is cancelling today's slot specifically; may or may not want to re-engage. Capture `wants_future_engagement: yes/no`. |
| `no-longer-customer` | Customer is closing the relationship. Capture `feedback_note` if provided. |
| `voicemail-left` | Reached voicemail; standard message left. |
| `unreachable` | No-answer / busy / disconnected. |
| `wrong-number` | Customer doesn't recognize the appointment. Flag CRM data quality. |
| `hostile` | Customer was upset; flag for human follow-up + culture / process review. |
| `unclear` | Conversation ambiguous; flag for human review. |

## Step 6 — Report back + side effects

Comment on the appointment record / parent issue:

```
No-show recovery call to {customer_name} ({appointment_id}):
- Outcome: {outcome}
- {outcome-specific fields, e.g. "ETA: 8 minutes" or "Rescheduled to 2026-05-04 10am"}
- Duration: {durationSec}s · Cost: ${costUsd}
```

Side effects per outcome:
- `on-the-way` — flag the appointment as `late-arriving` with the ETA. Notify the front-desk / provider so they can wait. Do NOT release the slot.
- `rescheduled-same-call` — update the calendar/scheduler with the new slot. Send a confirmation (email / SMS) per the business's standard practice. Cancel the original slot.
- `wants-reschedule-needs-human` — cancel the original slot. Open a `phone-appointment-booker` follow-up issue OR queue a human callback within 24h.
- `decided-not-to-come` — cancel the original slot and release it. If `wants_future_engagement: no`, set CRM flag `no-active-relationship` (does NOT mean blacklisted; just not currently engaged).
- `no-longer-customer` — mark the customer record `inactive`. If `feedback_note` was provided, route it to the appropriate human (manager, owner) for review. Do NOT auto-respond to the feedback.
- `voicemail-left` — mark the appointment as `no-show-voicemail`. Do NOT auto-retry — one voicemail is enough; let the customer call back if they want.
- `unreachable` — mark as `no-show-unreachable`. Same: do NOT auto-retry; the slot is closed.
- `wrong-number` — flag CRM record for verification. Mark appointment as `no-show-wrong-number`.
- `hostile` — flag for human follow-up immediately + log for process review (was the no-show actually our scheduling error?).
- `unclear` — flag for human review.

## Errors

Standard set documented in [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md#errors). No-show-specific:
- `[ECONCURRENCY_LIMIT]` is more likely if multiple no-shows happen at the same hour (busy clinic, multi-chair salon). Either raise `maxConcurrentCalls` for the no-show account OR queue with priority by appointment value.

## Cost discipline

Per call: ~$0.05–0.15.

ROI is enormous if the business charges per slot. A $50 dental cleaning recovered = 300+ no-show calls covered. Even at $200/hour for a contractor, ONE recovered slot pays for a year of recovery calls.

## Cadence example (event-driven, not scheduled)

```yaml
# In Paperclip routine config
trigger: event
event: appointment.window_closed_no_check_in
filter:
  minutes_past_start: { gte: 5, lte: 15 }
  customer.do_not_call_no_show: not_true
  appointment.status: scheduled  # not already cancelled
delay_seconds: 60   # tiny delay so a walk-in arrival can be detected first
skill: phone-no-show-recovery
```

## Out of scope

- Charging cancellation fees during the call — never. Defer to human.
- Repeated no-show recovery (same customer, multiple cancellations) — chain of skills handles the third+ no-show differently (sometimes the right answer is to drop them as a customer; that's a human decision).
- Multi-slot recovery ("you missed 2pm AND 3pm") — handle one missed slot per call; don't make the call more painful than it needs to be.

## See also

- [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md) — for the original booking and any rebooking
- [`phone-confirmation-call`](../phone-confirmation-call/SKILL.md) — the proactive version that should reduce no-show rates in the first place
