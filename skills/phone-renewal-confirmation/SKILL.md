---
name: phone-renewal-confirmation
description: Place an outbound call N days before a recurring contract / subscription / membership renews to confirm the customer wants to continue, capture any change requests, and surface decisions before auto-renew triggers. Examples - "your monthly retainer renews in 30 days, call to confirm continuation", "the annual maintenance contract is up for renewal next month, check in with the customer", "subscription auto-renews in 14 days, give them a courtesy heads-up". Use to reduce involuntary churn (auto-renew surprises) and to catch renegotiation opportunities early. NOT for hard-sell upselling or contract pressure.
---

# Phone Renewal Confirmation

Calls a customer ahead of a recurring renewal, gives them a courtesy heads-up, asks if they want to continue / change / cancel, and routes the answer. Designed to convert "we got auto-billed and weren't expecting it" complaints into "thanks for the heads-up" interactions — and to catch upgrade/downgrade requests while there's still time to handle them cleanly.

## When to invoke

- A scheduled routine fires N days before each contract / subscription auto-renews. Typical N: 30 days (annual contracts), 14 days (quarterly), 7 days (monthly) — calibrate by renewal cadence.
- A manual assignment: "call {customer} about the upcoming renewal of {contract}".

Do NOT invoke when:
- Customer has already confirmed the renewal in writing (email, portal click).
- Customer is on a flexible / cancel-anytime plan with no auto-renew penalty (the call is unnecessary friction).
- Contract value is below a threshold ($X/month) — use SMS or email instead; cheaper.
- Customer is in active dispute about the contract — let humans handle.
- It's less than 3 days before renewal — too late for a clean change; the auto-renew is essentially happening, just send an FYI email.

## Pre-conditions

Same as `phone-appointment-booker`:
- `phone-tools` plugin installed + ready, `allowMutations: true`, real E.164 destination, `defaultNumberId` set.

Plus:
- Contract / subscription details accessible (what's renewing, when, at what price, what the current usage looks like).
- Defined "what changes can the AI capture" boundary — typically: continue / cancel / pause. Anything else (downgrade, scope change, price renegotiation) goes to a human.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `customer_phone` | yes (E.164) | `+15555550123` |
| `customer_name` | yes | "Pat Jones" |
| `caller_business` | yes | "Acme SaaS Co" |
| `subscription_summary` | yes | "your monthly Premium plan at $99/month" |
| `subscription_id` | yes | internal ref: "sub_abc123" |
| `renewal_date_iso` | yes | when it auto-renews |
| `current_usage_note` | recommended | one-sentence usage context: "you've used about 60% of your seats this month" — adds value to the call |
| `cancellation_friction` | yes/no | does the contract require N days notice to cancel? Surface this honestly. |
| `new_pricing_iso` | recommended | if pricing is changing on renewal, the new amount + effective date |
| `escalate_to_human_if` | recommended | conditions for warm handoff ("they want to negotiate", "they want to downgrade", "they want to add seats") |

## Step 2 — Construct the assistant config

```
You are calling {customer_name} on behalf of {caller_business} as a courtesy heads-up that {subscription_summary} is set to renew on {renewal_date_human}{if new_pricing_iso then " (note: pricing changes to " + new_pricing_human + " effective " + new_pricing_effective + ")"}.

GOAL: in under 90 seconds, give them the heads-up, capture their intent (continue / cancel / change), and route any change request to the right human. Be informative and zero-pressure.

EXPECTED FLOW:
1. Identify yourself, mention the upcoming renewal, give them context.
2. {if current_usage_note then "Briefly mention the usage context: '" + current_usage_note + "' — gives them a fact to anchor on." else ""}
3. Ask: "Just wanted to give you a heads-up before it happens. Are you all set to continue, or did you want to make any changes?"
4. Listen carefully. Branch on what you hear:
   a. CONTINUE ("yep, all good", "we're good") → confirm "great, no action needed on your end — it'll renew on {renewal_date_human}." End the call.
   b. CANCEL ("we're going to cancel", "stop the renewal") → say "totally understood. {if cancellation_friction then "Just so you know, the cancellation requires X days notice — let me have someone from " + caller_business + " send you the formal cancellation form to make sure that's processed in time." else "I'll have someone from " + caller_business + " send you the cancellation confirmation today."}" Capture cancellation reason if shared. End the call.
   c. CHANGE ("we want to add seats" / "downgrade" / "switch plans") → say "I don't have the system in front of me to make changes, but let me have {appropriate human role} reach out today to walk through the options." Capture the kind of change requested. End the call.
   d. NOT NOW / WANT TO THINK ("let me get back to you") → say "no problem — when would be a good time to circle back?" Capture. End the call.

RULES:
1. Be a courtesy heads-up, not a sales pitch. The customer is being told something useful, not being sold to.
2. NEVER apply pressure to continue. NEVER offer discounts to retain (that's a human decision with margin implications).
3. NEVER attempt to upsell ("would you like to add the Pro features?"). Capture if THEY bring it up; never initiate.
4. If they ask for pricing details you don't have OR want to renegotiate, say "let me have the right person reach out today" and capture the request.
5. If you reach voicemail, leave a SHORT message: "Hi {customer_name}, this is calling from {caller_business} just giving you a heads-up that {subscription_summary} renews on {renewal_date_human}. No action needed if you're continuing — but if you'd like to make changes or have any questions, please call us back. Thanks!" Then hang up.
6. If they're upset about the renewal pricing or terms (rare), apologize, capture the concern, escalate to a human within the hour.
7. End the call with the end-call function once you have one of the four answers above OR voicemail.

Total call should be under 90 seconds.
```

`firstMessage`:

```
Hi {customer_name}, this is calling from {caller_business} — just giving you a quick heads-up that {subscription_summary} is set to renew on {renewal_date_short}. Do you have a moment?
```

## Step 3 — Place the call

Same as `phone-appointment-booker` Step 3. `metadata.purpose = "renewal-confirmation"`, `metadata.subscription_id`. Idempotency key: `renewal:{subscription_id}:{renewal_cycle}` so a single renewal cycle never gets called twice.

## Step 4 — Wait for completion

Cap polling at **3 minutes**. Most renewal calls finish in 60–90 seconds.

## Step 5 — Read the transcript and classify

| Outcome | Signal |
|---|---|
| `confirmed-continue` | Customer affirmed renewal proceeds as planned. |
| `wants-cancel` | Customer wants to cancel. Capture `cancel_reason` if provided + `wants_cancellation_form: yes/no`. |
| `wants-change` | Customer wants to modify (add/remove seats, change plan, etc.). Capture `change_request_summary`. |
| `wants-renegotiate` | Customer wants to renegotiate pricing/terms. ESCALATE high-priority. |
| `wants-callback` | Customer wants to think about it; capture `callback_window`. |
| `upset-about-pricing-or-terms` | Customer was unhappy. ESCALATE immediately. Capture verbatim concern. |
| `voicemail-left` | (standard) |
| `unreachable` | (standard) |
| `wrong-number` | (standard) |
| `unclear` | (standard) |

## Step 6 — Report back + side effects

Comment on the subscription / customer record:

```
Renewal confirmation call to {customer_name} re: {subscription_summary} (renews {renewal_date}):
- Outcome: {outcome}
- {outcome-specific fields}
- Duration: {durationSec}s · Cost: ${costUsd}
```

Side effects per outcome:
- `confirmed-continue` — log confirmation. NO further action; the auto-renew handles itself. (Log enables future "X% of customers actively confirmed renewal" metrics.)
- `wants-cancel` — open a high-priority issue assigned to the customer-success / accounts team: "customer wants to cancel — process before {renewal_date}". Include `cancel_reason`. If `cancellation_friction` is true and there's a notice-period requirement, send the formal cancellation form via email immediately (the AI captures the request; the system sends the form per the business's workflow).
- `wants-change` — open a medium-priority issue assigned to the right human (sales rep, account manager) with the change request and a call-back-within-24h SLA. Hold the auto-renew until the change is processed (if your billing system supports renewal holds; otherwise the human handles before renewal date).
- `wants-renegotiate` — open a high-priority issue assigned to a human with pricing authority. SLA: callback within 4 business hours.
- `wants-callback` — schedule a one-off agent wakeup at the requested window. Cap retries at 1 (after that, send an email and let the customer drive).
- `upset-about-pricing-or-terms` — open a critical-priority issue assigned to a manager with the verbatim concern. SLA: callback within the hour.
- `voicemail-left` — schedule ONE retry +24h. After that, send an email reminder and let the renewal proceed.
- `unreachable` — same as voicemail-left.
- `wrong-number` — flag CRM data quality. Do NOT proceed with auto-renew silently — surface for human verification.
- `unclear` — flag for human review.

## Errors

Standard set in [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md#errors). Renewal-specific:
- Calling outside business hours is especially bad here — customers associate "got a call from the company at 9pm" with sketchy. Default to 9am–5pm in their timezone, never broader.
- A high `unreachable` rate may correlate with churn risk (disengaged customers don't pick up). Surface for analysis if it's elevated.

## Cost discipline

Per call: ~$0.05–0.20.

ROI is proven: every involuntary-churn complaint avoided saves customer-support time AND the customer's goodwill. Even at high call volume, this skill pays for itself in retention metrics.

## Cadence example

```yaml
# Scheduled — fires daily, finds renewals in the lookback window
schedule: "0 10 * * *"  # 10am daily
skill: phone-renewal-confirmation
input_query: |
  SELECT * FROM subscriptions
  WHERE renewal_date BETWEEN NOW() + INTERVAL '28 days' AND NOW() + INTERVAL '30 days'
    AND status = 'active'
    AND customer.do_not_call_renewal IS NOT TRUE
    AND auto_renew = true
    AND last_renewal_call_at IS NULL  -- only call once per cycle
batch_pacing_seconds: 60
max_calls_per_run: 25
```

## Out of scope

- Negotiating renewal prices — must be a human action.
- Selling upgrades / additional seats during the call — capture if customer raises it; never initiate.
- Multi-stakeholder accounts (calling 3 people on the buying committee) — pick the primary contact; the others can engage via the human follow-up if needed.
- Win-back calls for already-churned customers — different skill (`phone-winback`, not yet built; needs careful design re: consent and frequency).

## See also

- [`phone-followup-after-quote`](../phone-followup-after-quote/SKILL.md) — for NEW quotes (this skill is for renewals)
- [`phone-customer-satisfaction`](../phone-customer-satisfaction/SKILL.md) — proactive feedback that may reduce renewal-time surprises
