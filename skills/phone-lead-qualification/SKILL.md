---
name: phone-lead-qualification
description: Place a fast outbound call to a fresh inbound lead to qualify them and either book a follow-up or disqualify, before the lead goes cold. Examples - "a web form lead just came in for the real estate site, call them within 5 minutes", "a contact form just submitted on the print shop, qualify size of order and decision-maker, book a quote call", "a quote-request email just hit the inbox, call to verify scope before drafting". Use for warm inbound leads where the cost of a 90-second call is dwarfed by the cost of letting the lead go stale (industry research: lead conversion drops ~80% after the first hour without contact).
---

# Phone Lead Qualification

Calls a fresh inbound lead, asks the few questions needed to determine whether the lead is real, what they want, and whether they're decision-ready. Books a follow-up call/meeting if the lead is qualified, otherwise logs the disqualification reason.

## When to invoke

- An inbound lead arrives via web form, email, or chat AND the lead included a phone number AND the lead has not yet been called.
- An event-driven routine fires this within 2–10 minutes of lead arrival (the speed-to-lead window matters more than perfect script).
- An operator asks "call back the lead from <source> that came in <time>".

Do NOT invoke when:
- The lead explicitly opted out of phone contact (check `lead.contact_preference` if you have a CRM).
- The phone number is on the DNC (Do Not Call) list — verify before calling, especially for cold-style outreach. Inbound leads who provided their number consenting to follow-up are fine; "harvested" numbers are not.
- It's outside reasonable business hours in the lead's timezone (default: 8am–8pm local; configurable per-business).
- A human has already started working the lead (check the CRM lead-activity log).

## Pre-conditions

Same plugin pre-conditions as `phone-appointment-booker`. Plus:
- The calling business has a defined "qualifying questions" set (see Step 1 below). Without this the call is unfocused and the lead will drop off.
- The calling business has a defined "next step" — what happens if the lead is qualified (book a quote call? send a brochure? schedule a showing?). The AI must be able to *do* the next step or the call lands flat.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `lead_phone` | yes (E.164) | `+15555550123` |
| `lead_name` | yes | "Pat Jones" (from the form) |
| `caller_business` | yes | "Acme Print Shop" |
| `lead_source` | yes | "web form on acmeprint.com/contact" |
| `lead_message` | yes | the actual text the lead submitted, verbatim — gives the AI context |
| `qualifying_questions` | yes | structured list — see below |
| `next_step_if_qualified` | yes | "book a 15-minute quote call with Sam (sales rep) at one of these slots: ..." OR "send our pricing PDF to their email" |
| `disqualifier_reasons` | recommended | known reasons to politely close the call early ("we don't ship internationally", "minimum order is 500 units") |
| `escalate_to_human_if` | recommended | conditions that warrant a same-day human callback ("budget over $X", "needs answer today", "asked for the owner") |

`qualifying_questions` shape — small, focused, with branching:

```json
[
  {
    "id": "size",
    "ask": "Roughly how many units are you thinking — under 100, a few hundred, or thousands?",
    "answer_type": "category",
    "categories": ["under_100", "100_to_999", "1000_plus", "unsure"],
    "disqualify_if": ["under_100"]
  },
  {
    "id": "timing",
    "ask": "When would you need this by?",
    "answer_type": "date_or_relative",
    "escalate_if_within_days": 3
  },
  {
    "id": "decision_maker",
    "ask": "Are you the one making the decision, or is there someone else I'd want to loop in?",
    "answer_type": "free_text"
  }
]
```

Cap qualifying_questions at 3–4. Past that, you're in interview territory and the lead will check out.

## Step 2 — Construct the assistant config

```
You are calling {lead_name} on behalf of {caller_business}. They submitted an inquiry via {lead_source} and we want to qualify the lead and, if it makes sense, book the next step.

WHAT THEY SAID (the message they submitted):
"{lead_message}"

GOAL: in under 2 minutes, (a) confirm this is a real lead, (b) gather answers to the qualifying questions below, (c) if qualified, set up the next step.

QUALIFYING QUESTIONS (in order, ONE at a time, branching as noted):
{numbered_questions_with_branches}

NEXT STEP IF QUALIFIED:
{next_step_human_readable}

DISQUALIFIERS (politely close out if any apply):
{disqualifier_list_or_none}

ESCALATE TO A HUMAN (don't try to handle yourself, instead say "let me have someone from our team call you within the hour" and end the call):
{escalation_list_or_none}

RULES:
1. Lead with: "Hi {lead_name}, this is calling from {caller_business} — you reached out about {brief_summary_of_lead_message}. Do you have a couple minutes to chat about it?"
2. If "no", ask "When's a better time?" — capture, log it, end the call.
3. If "yes", thank them and proceed to questions one at a time.
4. Reference what THEY said back to them — shows you read it. Don't make them re-explain.
5. If they ask for pricing or specifics you don't have, say "I'll have someone with the details follow up — that's actually why I'm calling, to set that up." Do NOT invent prices.
6. If qualified, propose the next step naturally and confirm. If they accept, briefly recap.
7. If disqualified, thank them politely and explain the mismatch in one sentence ("we focus on orders of 500+, but I appreciate you reaching out").
8. End the call with the end-call function once the next step is set OR the lead is disqualified OR they've asked you to call back later.
9. NEVER pressure. NEVER push. They reached out to us; we're confirming, not selling.

Total call should be under 3 minutes.
```

`firstMessage`:

```
Hi, is this {lead_name}? This is calling from {caller_business} — you reached out about {brief_summary}. Do you have a couple minutes?
```

(Use the lead's first name. Don't say "this is the AI assistant from..." — they'll hang up. The AI is calling on behalf of the business; identifying as the business is correct framing.)

## Step 3 — Place the call

Same as `phone-appointment-booker`. `metadata.purpose = "lead-qualification"`, `metadata.lead_id = <crm-id>`. Idempotency key: `lead-qualification:{lead_id}` so the same lead never gets called twice within 24h even on retries.

## Step 4 — Wait for completion

Cap polling at 4 minutes. Most calls finish inside 90–150 seconds.

## Step 5 — Read the transcript and classify

Outcomes:

| Outcome | Signal |
|---|---|
| `qualified-next-step-booked` | All qualifiers passed AND lead accepted the next step. |
| `qualified-needs-human` | Lead qualified BUT triggered an escalation condition; human callback needed. |
| `disqualified-mismatch` | Lead failed a disqualifier (e.g. order too small). Polite close. |
| `not-decision-maker` | Reached the right person but they're not the one deciding. Capture the actual decision-maker's contact if shared. |
| `not-interested` | Lead is no longer interested ("I already got a quote elsewhere", "we decided not to proceed"). |
| `callback-requested` | Lead wants to be called back at a specific later time. |
| `voicemail-left` | Reached voicemail; left a brief callback message. |
| `unreachable` | No-answer / busy / disconnected / wrong number. |
| `unclear` | Conversation was confused; flag for human triage. |

For each qualifying question, build the structured answer (same shape as `phone-vendor-status-check`).

## Step 6 — Report back + side effects

Comment on the lead's CRM record / parent issue:

```
Lead qualification call to {lead_name}:
- Outcome: {outcome}
- Qualifiers: {q.id}: {q.value} | {q.id}: {q.value} | ...
- Next step: {what_was_booked or "n/a"}
- Duration: {durationSec}s · Cost: ${costUsd}
- Transcript excerpt: ...
```

Side effects per outcome:
- `qualified-next-step-booked` — create the calendar event / send the email / open the work item per the next-step definition. Update lead status to `qualified-active`.
- `qualified-needs-human` — open a high-priority issue assigned to the appropriate human role with "call within the hour" SLA. Include all captured context.
- `disqualified-mismatch` — update lead status to `disqualified-{reason}`. If the brief defined a "courtesy referral" (e.g. competitor that handles small orders), send the referral email per the brief.
- `not-decision-maker` — update lead with the new contact info; queue a `phone-lead-qualification` retry against the actual decision-maker (with a brief "you were referred by {original_lead}" preamble).
- `not-interested` — update lead status to `closed-not-interested`. If `nurture_campaign_eligible: true`, enroll in long-term nurture sequence.
- `callback-requested` — schedule one-off agent wakeup at the requested time to retry. Cap retries at 2 (after that, mark as `unreachable` and let humans decide).
- `voicemail-left` — mark `attempted-voicemail-1`. Schedule retry +24h (with `attempted-voicemail-2` cap; after 2 voicemails, hand off to human).
- `unreachable` — schedule retry +4h. After 3 unreachables, flag for human triage.
- `unclear` — flag for human review immediately. Don't loop.

## Errors

Same shapes as `phone-appointment-booker`. Lead-specific:
- `[ECONCURRENCY_LIMIT]` is more likely here because lead floods can be bursty (paid ad campaign launch, viral moment). Either raise the cap for the lead-handling account OR queue with priority by lead score.
- DNC violations — if you somehow dial a DNC number, the carrier may flag the call AND you may face fines. Implement DNC check upstream of `phone_call_make`, not inside this skill.

## Cost discipline

Per call: ~$0.15–0.40 (3-question qual = 90–180s). For most businesses, the cost-per-acquisition delta from "called within 5 minutes" vs. "called next day" makes this a no-brainer (industry data: 5-min response = 21x conversion vs. 30-min response).

Budget guard: cap total daily lead-qual spend per company. If you blow through $X in lead-qual calls in a day, alert the operator — that usually means a campaign is mis-targeted.

## Cadence example (event-driven, not scheduled)

```yaml
# In Paperclip routine config
trigger: event
event: lead.created
filter:
  source_in: ["web_form", "chat", "email"]
  has_phone: true
  not_dnc: true
  hours_local: [8, 20]
delay_seconds: 60   # tiny delay so the lead notification reaches the human team first; AI calls only if no human picked it up
skill: phone-lead-qualification
```

## Out of scope

- Cold outbound to people who didn't ask to be contacted — different skill (and different legal/regulatory situation; needs explicit operator authorization per campaign).
- Closing sales over the phone — qualification only. AI never quotes price, never takes payment, never commits to terms.
- Re-qualification of existing leads / accounts — different skill (`phone-account-checkin`, not yet built).
- Inbound lead intake (lead calls YOU) — different skill (`phone-receptionist`, requires v0.2 inbound).

## See also

- [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md) — for scheduling the qualified next-step call
- [`phone-confirmation-call`](../phone-confirmation-call/SKILL.md) — for confirming the booked next-step
