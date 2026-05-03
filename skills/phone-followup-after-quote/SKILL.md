---
name: phone-followup-after-quote
description: Place a brief outbound call N days after a quote, proposal, or estimate was sent — to ask if the customer had a chance to review and capture their decision (or specific objection) without pestering. Examples - "call the lead three days after we sent the print quote and ask where they're at", "follow up on the contractor estimate from last week", "check in on the proposal we sent to {customer} two weeks ago". Use to keep deals from going silent and to capture lost-deal feedback. Typically runs as a routine fired by a quote-sent timer (e.g. T+3 business days).
---

# Phone Follow-Up After Quote

Calls a customer who received a quote/proposal/estimate, asks whether they've had a chance to look at it, listens for the actual answer (yes / no / objection / need more time), and routes from there. Designed to be polite, brief, and zero-pressure — the goal is *information*, not a hard close.

## When to invoke

- A scheduled routine fires N business days after a quote-sent timestamp (typical: 3 days for small jobs, 5–7 for larger proposals).
- An assignment says "follow up on the {customer} quote from {date}".
- A sales-rep dashboard sweep flags quotes with no customer activity in N days.

Do NOT invoke when:
- The customer has already responded to the quote (accepted / declined / asked questions). The conversation is already live; AI shouldn't barge in.
- The customer's CRM record has `do_not_call_followup: true`.
- It's been more than 30 days since the quote was sent — the quote is stale; needs a fresh send, not a follow-up call. Use `phone-quote-request` or a re-quote workflow instead.
- A human sales rep is actively working the deal (check the CRM activity log; don't step on their toes).

## Pre-conditions

Same as `phone-appointment-booker`:
- `phone-tools` plugin installed + ready for the calling company.
- `allowMutations: true`.
- Real E.164 destination number.
- `defaultNumberId` set OR `from` passed explicitly.

Plus:
- The quote details are accessible to the agent (quote_id, summary, total, sent date, validity window) — usually pulled from a CRM or accounting plugin.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `customer_phone` | yes (E.164) | `+15555550123` |
| `customer_name` | yes | "Pat Jones" |
| `caller_business` | yes | "Acme Print Shop" |
| `caller_rep_name` | recommended | the name of the human rep on the deal — adds warmth |
| `quote_summary` | yes | one-sentence description: "500 business cards, matte finish, 14-day turnaround, $312" |
| `quote_id` | yes | internal ref the agent can quote back if asked: "estimate #4827" |
| `quote_sent_date` | yes (ISO) | when the quote was sent |
| `quote_valid_until` | recommended (ISO) | when the quoted price expires |
| `urgency_signal` | recommended | `none` (default) / `expiring_soon` / `competitor_active` (be slightly more direct without being pushy) |
| `acceptable_objections` | recommended | known reasons the AI should accept gracefully ("price too high", "need more time", "going with another vendor") |
| `escalate_to_human_if` | recommended | conditions for warm handoff ("they ask about discounts", "they want to negotiate scope", "they have technical questions") |

## Step 2 — Construct the assistant config

```
You are calling {customer_name} on behalf of {caller_business} to follow up on a quote we sent on {quote_sent_date_human}. {if caller_rep_name then "The quote was put together by {caller_rep_name}." else ""}

QUOTE WE'RE FOLLOWING UP ON:
{quote_summary}
Reference: {quote_id}{if quote_valid_until then ", valid until " + quote_valid_until_human}

GOAL: in 60–90 seconds, find out where {customer_name} is at on the quote — accepted, declined, still thinking, or has a specific question/concern. Capture the answer. Do NOT close the deal on the call; that's not your job.

EXPECTED FLOW:
1. Identify yourself, mention the quote and the date, ask if they had a chance to review it.
2. Listen carefully to the answer. Don't pre-judge.
3. Branch on what you hear:
   a. ACCEPTED ("we're good with it", "let's move forward") → confirm enthusiasm, say "great — I'll have {caller_rep_name or "someone from our team"} reach out with next steps today." End the call.
   b. DECLINED ("we went with someone else", "not going to happen") → thank them, ask one polite question: "If you don't mind sharing, was it price, timing, or something else?" Capture the answer. End the call.
   c. NEEDS MORE TIME ("haven't looked yet", "still discussing") → "no problem, when would be a good time to circle back?" Capture the date/window. End the call.
   d. QUESTION/OBJECTION ("we want to know if X is possible", "the price is high") → say "good question — let me have {caller_rep_name or "the right person"} get you a real answer on that. Best number and time?" Capture. End the call. Do NOT try to answer pricing or scope questions yourself.

RULES:
1. Be conversational, not script-y. You sound like a human checking in, not a robot reading a form.
2. NEVER push for a decision. If they're undecided, accept that gracefully.
3. NEVER discount, negotiate scope, or commit to anything. Your job is to capture, not to close.
4. {if urgency_signal == "expiring_soon" then "If they're undecided, you may mention 'just so you know, the pricing in this quote is good through " + quote_valid_until_human + "' — say it ONCE, do not repeat. Do not pressure." else ""}
5. If they're hostile or annoyed by the call, apologize sincerely, mark as "declined-do-not-followup" and end the call quickly.
6. If you reach voicemail, leave a SHORT message: "Hi {customer_name}, it's calling from {caller_business} just checking in on the quote we sent {quote_sent_date_human}. No rush — just wanted to see if you had any questions. Give us a call back when you have a moment. Thanks!" Then hang up.
7. End the call with the end-call function once the answer (any of the four branches OR voicemail) is captured.

Total call should be under 2 minutes.
```

`firstMessage`:

```
Hi {customer_name}, this is calling from {caller_business} — I'm following up on the quote we sent over on {quote_sent_date_short}. Did you have a chance to take a look?
```

## Step 3 — Place the call

Same as `phone-appointment-booker` Step 3. `metadata.purpose = "followup-after-quote"`, `metadata.quote_id = <id>`. Idempotency key: `quote-followup:{quote_id}:{attempt_n}` so the same quote isn't followed-up twice in the same window.

## Step 4 — Wait for completion

Cap polling at 4 minutes. Most calls finish in 60–120 seconds.

## Step 5 — Read the transcript and classify

| Outcome | Signal |
|---|---|
| `accepted` | Customer affirmed they want to move forward. |
| `declined-with-reason` | Customer declined; reason captured (`reason: "price"` / `"timing"` / `"competitor"` / `"scope"` / `"other"` + verbatim quote). |
| `declined-no-reason` | Customer declined; no reason given when politely asked. |
| `needs-more-time` | Customer wants more time; capture the callback window. |
| `question-or-objection` | Customer raised a specific question/objection that needs a human; capture the question verbatim. |
| `voicemail-left` | Reached voicemail; standard message left. |
| `unreachable` | No-answer / busy / disconnected. |
| `wrong-number` | Customer says "you have the wrong number" or doesn't know the deal — flag to verify CRM data. |
| `unclear` | Conversation ambiguous; flag for human review. |

Extract:
- `decision_summary` — 1-sentence plain-English summary
- `next_action_hint` — what the human rep should do next ("call within the hour about pricing question", "no further action — they declined")
- `transcript_excerpt` — the 1–3 turns containing the answer

## Step 6 — Report back + side effects

Comment on the deal record / parent issue:

```
Quote follow-up call — {customer_name} ({quote_id}):
- Outcome: {outcome}
- Decision: {decision_summary}
- Next action: {next_action_hint}
- Duration: {durationSec}s · Cost: ${costUsd}
- Transcript excerpt: ...
```

Side effects per outcome:
- `accepted` — assign a high-priority follow-up issue to the named rep with "they accepted, send next steps today" + the captured wording. Update CRM deal stage to `verbal-yes` (formalize once paperwork is signed).
- `declined-with-reason` — update CRM deal stage to `lost`, set `lost_reason` field. Trigger lost-deal nurture sequence if reason was `price` (room to revisit later) or `timing` (revisit in 90 days). For `competitor` / `scope`, just log and move on.
- `declined-no-reason` — same as above with `lost_reason: unknown`.
- `needs-more-time` — schedule a one-off agent wakeup for the requested time. Cap retries at 2 per quote (after that, mark as `stalled` and let humans decide).
- `question-or-objection` — open a high-priority issue assigned to the named rep with "call within the hour, customer has a question: <verbatim>". Do NOT auto-respond.
- `voicemail-left` — schedule one retry +48h (different time of day). After 2 voicemails, mark as `stalled-voicemail` for human review.
- `unreachable` — schedule retry +24h. After 3 unreachables, mark as `stalled-unreachable` for human review.
- `wrong-number` — flag the CRM record for data quality review. Don't retry until the number is verified.
- `unclear` — flag for human review immediately.

## Errors

Same shapes as `phone-appointment-booker`. Quote-followup-specific:
- If you accidentally call a customer who already responded ("we accepted yesterday"), the AI should detect that quickly ("oh great — I'll let the team know"), and the report-back should flag the CRM as out-of-sync.
- Calling outside business hours is especially bad here — the customer associates the bad-timing call with your brand. Default to 9am–5pm in the customer's timezone unless explicitly opted-in to broader hours.

## Cost discipline

Per call: ~$0.10–0.25. For most businesses, even a 5% lift in close rate from "follow up at T+3 instead of letting it die" pays for the entire follow-up program many times over.

## Cadence example

```yaml
# Routine fires once per day
schedule: "0 14 * * 1-5"  # weekday afternoons 2pm
skill: phone-followup-after-quote
input_query: |
  SELECT * FROM quotes
  WHERE sent_at <= NOW() - INTERVAL '3 business days'
    AND status = 'sent'
    AND last_followup_call_at IS NULL
    AND customer.do_not_call_followup IS NOT TRUE
batch_pacing_seconds: 60
max_calls_per_run: 15
```

## Out of scope

- Re-quoting (changing scope or price during the call) — must be a human action.
- Negotiating discounts — must be a human action.
- Cold outreach to customers who didn't request a quote — different skill (and different regulatory situation).
- Multi-stakeholder deals (calling 3 people on the buying committee separately) — needs orchestration; chain `phone-followup-after-quote` calls deliberately, don't loop.

## See also

- [`phone-lead-qualification`](../phone-lead-qualification/SKILL.md) — for qualifying NEW leads (before a quote)
- [`phone-confirmation-call`](../phone-confirmation-call/SKILL.md) — for confirming the work AFTER a quote is accepted
- [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md) — for booking the next-step meeting if the customer wants to discuss
