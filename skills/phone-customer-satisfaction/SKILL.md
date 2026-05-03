---
name: phone-customer-satisfaction
description: Place a brief outbound call 1–3 days after a service was rendered or product was delivered, to ask how it went, capture sentiment, and surface specific feedback. Examples - "call yesterday's haircut customer to ask how it went", "follow up with the print job we delivered Tuesday and ask if everything was correct", "check in with the contractor's last week's job and capture any feedback". Use to drive review-and-improve loops, catch issues before they become public complaints, and identify upsell / referral opportunities. NOT for cold marketing or upsell pushes.
---

# Phone Customer Satisfaction

Calls a recent customer, asks 1–3 short feedback questions, captures sentiment + specifics, and routes anything actionable. Designed to be brief and respectful — most customers don't want to spend 5 minutes on a feedback call, but they'll happily give you 60 seconds.

## When to invoke

- A scheduled routine fires N days after a completed service / delivery (typical: 1 day for short-cycle businesses, 3–5 days for projects).
- An assignment from a manager: "follow up with {customer} about the {job} we did".
- Conditional trigger: customers above a value threshold get the call; below get an SMS or email instead.

Do NOT invoke when:
- Customer has already provided feedback (online review, response to an email survey, mentioned in a thread).
- Customer record has `do_not_call_feedback: true`.
- It's been more than 14 days since the service — too late, the memory is stale.
- The customer relationship is in active dispute or has unresolved complaints — let humans handle it.

## Pre-conditions

Same as `phone-appointment-booker`:
- `phone-tools` plugin installed + ready, `allowMutations: true`, real E.164 destination, `defaultNumberId` set.

Plus:
- The service / delivery details are accessible (what was done, when, by whom).
- The business has defined what "actionable feedback" looks like — what triggers a manager callback, a refund consideration, a public-review request.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `customer_phone` | yes (E.164) | `+15555550123` |
| `customer_name` | yes | "Pat Jones" |
| `caller_business` | yes | "Acme Print Shop" |
| `service_summary` | yes | "the 500 business cards we printed for you on Tuesday" |
| `service_provider_name` | recommended | "Sam (your designer)" — adds warmth, mention only if natural |
| `service_completed_date_iso` | yes | when the service was completed |
| `feedback_questions` | yes | 1–3 questions max — see below |
| `request_review_if_satisfied` | yes/no | if customer is happy, ask if they'd leave an online review |
| `review_link` | required if request_review_if_satisfied=yes | URL to the review platform |
| `escalate_to_human_if` | recommended | conditions for warm handoff ("they want a refund", "they're upset", "they have a specific complaint about a person") |

`feedback_questions` — keep tight, max 3, mix of types:

```json
[
  { "id": "overall", "ask": "Overall, how was your experience?", "answer_type": "sentiment", "follow_up_if_negative": "I'd love to hear more — what could we have done better?" },
  { "id": "quality", "ask": "Were you happy with the quality of the work?", "answer_type": "yes_no_with_detail" },
  { "id": "would_recommend", "ask": "Would you use us again or recommend us to a friend?", "answer_type": "yes_no" }
]
```

`answer_type` hints:
- `sentiment` — positive / neutral / negative + verbatim quote
- `yes_no` — boolean
- `yes_no_with_detail` — boolean + optional context
- `nps_0_to_10` — number; map to detractor/passive/promoter
- `free_text` — capture verbatim

## Step 2 — Construct the assistant config

```
You are calling {customer_name} on behalf of {caller_business} to follow up on {service_summary}{if service_provider_name then " — handled by " + service_provider_name}.

GOAL: in under 90 seconds, ask {N} short feedback questions, capture the answers, and {if request_review_if_satisfied then "if they're happy, kindly ask if they'd consider leaving an online review at " + review_link + ""}. Be warm and brief.

QUESTIONS (in order, ONE at a time, with the listed follow-ups if applicable):
{numbered_questions_with_followups}

REVIEW REQUEST (only if their overall sentiment was positive — neutral or negative gets NO review request):
"It would mean a lot if you'd consider leaving us a quick review at {review_link}. No pressure either way — just appreciated if you have a moment."

ESCALATE (transfer to human consideration):
{escalation_list_or_none}

RULES:
1. Lead with: "Hi {customer_name}, it's calling from {caller_business} just following up on {service_summary}. Do you have 60 seconds for a quick check-in?"
2. If they say "no", thank them, do NOT push, end the call.
3. If they say "yes", thank them and proceed to questions ONE at a time. Do NOT batch.
4. Listen for the SUBSTANCE of the answer, not just yes/no. "Yeah, it was fine" with no enthusiasm is a soft-negative; capture it.
5. NEVER push for a review if sentiment is anything less than clearly positive. A negative customer asked for a review is how you get a 1-star.
6. If they have a specific complaint, listen FULLY, then say "I really appreciate you telling me. I'll have {service_provider_name or "someone from the team"} reach out about that today." Do NOT promise specific remedies (refunds, redos, etc.) — that's a human decision.
7. NEVER offer discounts, refunds, or compensation during the call. Defer to a human.
8. Voicemail: leave a SHORT message: "Hi {customer_name}, this is calling from {caller_business} just checking in on {service_summary}. We'd love to hear how it went — give us a call back when you have a moment, or feel free to email feedback to [email]. Thanks!"
9. End the call with the end-call function once questions are done OR voicemail.

Total call should be under 2 minutes.
```

`firstMessage`:

```
Hi {customer_name}, it's calling from {caller_business} — I'm just following up on {service_summary}. Do you have 60 seconds for a quick check-in?
```

## Step 3 — Place the call

Same as `phone-appointment-booker`. `metadata.purpose = "customer-satisfaction"`, `metadata.service_id`. Idempotency: `csat:{service_id}` so a service is only checked-in-on once.

## Step 4 — Wait for completion

Cap polling at **3 minutes**. Most CSAT calls finish in 60–90 seconds.

## Step 5 — Read the transcript and classify

Outcomes (in addition to the standard set):

| Outcome | Signal |
|---|---|
| `positive-no-review-asked` | Customer was satisfied, but `request_review_if_satisfied` was false. |
| `positive-review-requested` | Customer was satisfied, AI asked for a review. |
| `neutral` | Customer's response was lukewarm — "it was fine" or shrugged. NO review request. |
| `negative-no-specific-issue` | Customer wasn't satisfied but didn't cite a specific reason. Flag for follow-up. |
| `negative-with-issue` | Customer cited a specific issue (quality, timing, person, communication). HIGH-PRIORITY human follow-up. Capture issue verbatim. |
| `wants-refund-or-redo` | Customer asked for a refund / redo / make-good. ESCALATE immediately to a manager. |
| `voicemail-left` | (standard) |
| `unreachable` | (standard) |
| `wrong-number` | (standard) |
| `unclear` | (standard) |

Per question, capture:
- `answered: yes/no`
- `value` (per `answer_type`)
- `verbatim_quote` if substantive

Sentiment scoring: classify overall as positive / neutral / negative based on the AI's reading. If unclear, default to `neutral`.

## Step 6 — Report back + side effects

Comment on the customer / service record:

```
CSAT call to {customer_name} re: {service_summary}:
- Overall: {sentiment}
- {q.id}: {q.value} {if verbatim then "— " + verbatim}
- {q.id}: ...
- Review requested: {yes/no} ({outcome of ask if applicable})
- Duration: {durationSec}s · Cost: ${costUsd}
```

Side effects per outcome:
- `positive-no-review-asked` / `positive-review-requested` — log positive sentiment in CRM. Increment customer's NPS-promoter counter. If a review URL was asked, schedule a +24h follow-up to check whether a review actually got posted (via integration with the review platform if available; manual check otherwise).
- `neutral` — log neutral. Do not push further. Consider including this customer in next month's neutral-customer outreach (a manager-driven re-engagement, NOT auto-call).
- `negative-no-specific-issue` — open a medium-priority issue assigned to a manager: "lukewarm CSAT, no specific issue — call to learn more". Do NOT auto-retry the call.
- `negative-with-issue` — open a high-priority issue assigned to a manager AND the service provider (if applicable) with the verbatim issue quote, "call within 4 business hours". Mark CSAT score as detractor.
- `wants-refund-or-redo` — open a critical-priority issue assigned to a manager (NOT the service provider, who has a conflict of interest), "call within the hour, customer is asking for a remedy". Hold the customer record from any further auto-CSAT calls until the issue is resolved.
- `voicemail-left` / `unreachable` — schedule ONE retry +48h. After that, mark `csat-no-response`. Do NOT spam.
- `wrong-number` — flag CRM data quality.
- `unclear` — flag for human review.

## Errors

Standard set in [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md#errors). CSAT-specific:
- This skill is non-essential — if rate-limited or concurrency-capped, just defer; the world doesn't end if a CSAT call gets postponed by a day.

## Cost discipline

Per call: ~$0.05–0.20.

For typical small businesses, weekly CSAT runs over 30–50 customers cost ~$3–10 — minor. The expensive failure mode is asking unhappy customers to leave a review (1-stars) or being annoying (over-frequent calls). Conservative cadence > aggressive.

## Cadence example

```yaml
# Daily — call yesterday's completed services
schedule: "0 11 * * *"  # 11am daily, after most customers are awake
skill: phone-customer-satisfaction
input_query: |
  SELECT * FROM completed_services
  WHERE completed_at::date = CURRENT_DATE - INTERVAL '1 day'
    AND customer.do_not_call_feedback IS NOT TRUE
    AND service_value >= 100  -- only call-worthy services; SMS/email lower-value
batch_pacing_seconds: 60
max_calls_per_run: 20
```

## Out of scope

- Long-form NPS surveys (10+ questions) — won't complete; use email/web survey instead.
- Cold customers (haven't engaged in months) — different skill (re-engagement; needs human design).
- Repeated CSAT calls to the same customer (more than once per service) — annoying. Cap at one per service.
- Negotiating remedies during the call — never. Capture and escalate.

## See also

- [`phone-confirmation-call`](../phone-confirmation-call/SKILL.md) — proactive; reduces the issues this skill discovers
- [`phone-no-show-recovery`](../phone-no-show-recovery/SKILL.md) — for the OPPOSITE failure mode: customer didn't show
