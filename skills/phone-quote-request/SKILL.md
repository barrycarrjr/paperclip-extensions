---
name: phone-quote-request
description: Place outbound calls to one or more vendors to request quotes for a defined need — quantity, specs, timeline, delivery — and aggregate their responses. Examples - "call three paper suppliers for a 5,000-sheet quote on 100lb cardstock, delivered within 10 days", "phone two contractors and ask what they'd charge for the kitchen reno project we wrote up", "get rough quotes from a few printers for 10,000 trifold brochures". Use for procurement decisions where vendor responsiveness or rough numbers are what you actually need; defer formal RFQs to humans.
---

# Phone Quote Request

Calls one or more vendors to request quotes for a clearly-defined need, captures their answers in structured form, and produces a side-by-side comparison. Designed to bridge the gap between "I'll just google a few prices" and "let's run a formal procurement process" — fast, lightweight, with enough rigor to make a decision.

When the brief includes multiple vendors, this skill fans out (one call per vendor) and aggregates after all complete.

## When to invoke

- An assignment says "get quotes from X, Y, Z for {need}" and the vendors don't have public pricing or web-based quote forms.
- A purchasing routine fires for high-frequency commodity items (e.g. weekly paper restock) where vendor pricing fluctuates and you want fresh numbers.
- An ad-hoc need arises and the operator wants a quick read on the market before committing time to a formal procurement.

Do NOT invoke when:
- Public pricing exists for the items — use the website, much cheaper.
- The decision is high-stakes enough to need formal RFQ paperwork — escalate to a human procurement workflow instead.
- The vendors have explicitly asked you to email instead of calling — respect that.
- The need is time-sensitive (need quote in next 30 minutes) — phone calls are fast but not THAT fast; consider parallel email + phone.

## Pre-conditions

Same as `phone-appointment-booker`:
- `phone-tools` plugin installed + ready, `allowMutations: true`, real E.164 destination(s), `defaultNumberId` set.

Plus:
- A clearly-defined need spec — quantity, specs, timeline. Vague needs ("we need some printing") get vague quotes.
- Vendor records with phone numbers (and ideally an account number / "you know us as" identifier).
- A target number of vendors to call. Recommended: 3. Fewer = no comparison; more = annoying for both you and the vendors.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `vendors` | yes | array of `{ name, phone, account_id?, last_quote_date? }` |
| `caller_business` | yes | "Acme Print Shop" |
| `need_summary` | yes | "5,000 sheets of 100lb white cardstock, delivered to Acme Print Shop within 10 business days" |
| `need_specs` | yes | structured: `{ item: "100lb cardstock", color: "white", quantity: 5000, delivery_window_days: 10, delivery_address: "Acme Print Shop, [city]" }` |
| `request_followup_quote` | yes/no | should the AI ask for a written quote to be emailed? Default: yes |
| `our_email` | required if request_followup_quote=yes | the email vendors should send written quotes to |
| `urgency` | recommended | `low` / `medium` / `high` (controls whether the AI mentions a decision deadline) |
| `decision_deadline_iso` | recommended | when you need a decision by; AI mentions it if `urgency` is high |

## Step 2 — Construct the assistant config (per vendor)

The skill places ONE call per vendor; each call uses this prompt with vendor-specific values plugged in.

```
You are calling {vendor_name} on behalf of {caller_business}{if account_id then ", our account number with you is " + account_id}. We need a rough quote for the following.

NEED:
{need_summary}

DETAILS:
- Item: {item}
- Quantity: {quantity}
- Specifications: {specs_human}
- Delivery: {delivery_window_days} business days, to {delivery_address}

GOAL: in under 2 minutes, get the vendor to quote a price (rough is fine), confirm whether they can hit the delivery timeline, and {if request_followup_quote then "ask them to email a written quote to " + our_email else "capture the verbal quote for our records"}.

EXPECTED FLOW:
1. Greet, identify yourself, briefly state what you're calling about.
2. Read the need summary in one sentence — give them a moment to absorb.
3. Ask: "Can you give me a rough price on that?" Listen.
4. Ask: "And can you hit the {delivery_window_days}-day timeline?" Listen.
5. {if request_followup_quote then "Ask: 'Can you email a written quote to " + our_email + " when you have it?' Listen — capture their commitment (yes / no / it'll take N days)." else ""}
6. {if urgency == "high" then "Briefly mention: 'We're looking to make a decision by " + decision_deadline_human + " — does that work for you?' Capture answer." else ""}
7. Thank them and end the call.

RULES:
1. Be conversational. Vendors get a lot of price-shopping calls; warmth helps.
2. Do NOT haggle, negotiate, or commit to placing an order. You're collecting information.
3. If they ask "are you also calling competitors?" — be honest: "Yes, we're getting a few quotes." Most vendors expect this.
4. If they say "I need to put together a real quote and email it" — that's a yes; capture it as `quote_via_email: true, eta_days: <N>`.
5. If they don't have the info handy, ask "Is there someone there I could speak with who would?" — but cap at one transfer attempt; don't chase forever.
6. If they're rude or hostile, thank them, end the call, and report demeanor in the structured output.
7. End the call with the end-call function once you have answers (or a clear "we can't help") OR voicemail.
```

`firstMessage`:

```
Hi, this is calling on behalf of {caller_business}. I'm getting some quotes for {need_summary_short} — do you have a quick minute?
```

## Step 3 — Place the calls

For each vendor in the `vendors` array, place a separate call. Either:
- **Sequential:** call vendors one at a time, wait for each to complete (safer with concurrency cap, slower)
- **Parallel:** place all calls at once (faster, may trip `[ECONCURRENCY_LIMIT]` if vendors > maxConcurrentCalls)

Default: parallel up to `maxConcurrentCalls`, then queue. Track each call's `callId` against the vendor.

`metadata.purpose = "quote-request"`, `metadata.vendor_id`, `metadata.need_id` (so the aggregation step can match calls back). Idempotency key: `quote-request:{need_id}:{vendor_id}`.

## Step 4 — Wait for all completions

Poll each call independently. Cap each at 4 minutes. Aggregate when ALL calls have terminated (or hit timeout).

If one vendor takes a really long time (transferred multiple times, on hold) and others are done, don't wait for them — proceed with what you have and mark the slow vendor as `still-pending` for human follow-up.

## Step 5 — Per-call: read transcript and classify

| Outcome | Signal |
|---|---|
| `quoted` | Vendor gave a price (rough or precise) AND a delivery commitment. Capture `price`, `delivery_commitment`, `quote_via_email`. |
| `partial-quote` | Got price OR delivery but not both. Capture what you got. |
| `cant-help` | Vendor doesn't carry the item / can't hit the timeline / outside their wheelhouse. |
| `needs-time-to-quote` | Vendor will follow up with a written quote in N days. Capture `eta_days`. |
| `voicemail-left` | Reached voicemail; standard message asking for a callback. |
| `unreachable` | No-answer / busy / disconnected. |
| `transferred-stuck` | Got transferred to someone who never picked up. |
| `unclear` | Conversation ambiguous; flag for human follow-up. |

For `quoted` / `partial-quote`, extract the structured numbers carefully — vendors often quote in unit-prices ("$15 per ream") that need to be multiplied to get the total.

## Step 6 — Aggregate + report

After all calls complete (or time out), build a comparison table:

```
Quote request — {need_summary_short}
Vendors called: {N}, quoted: {M}

| Vendor          | Price       | Delivery       | Email quote? | Notes              |
|-----------------|-------------|----------------|--------------|--------------------|
| Vendor A        | $1,250      | 8 days ✓       | yes (~2 days)| Friendly           |
| Vendor B        | $1,180      | 12 days ✗      | no           | Too long           |
| Vendor C        | needs-time  | TBD            | yes (~5 days)| Will follow up     |

Recommendation: Vendor A best fit (price + delivery). Vendor C may be cheaper — wait for written quote.
Total cost: $X.XX across N calls.
```

Side effects per overall outcome:
- All quoted, clear winner — open a follow-up issue assigned to the human procurement person with the recommendation. Do NOT auto-place the order.
- Mixed / unclear — same, but flag for human review.
- All `cant-help` — flag the need spec for review (maybe the spec is wrong, or these vendors aren't the right pool).
- All `voicemail-left` / `unreachable` — flag for retry tomorrow OR escalate to email.

For `needs-time-to-quote` vendors specifically, schedule a one-off agent wakeup at the promised ETA + 1 day to check whether the written quote arrived (via email integration), and if not, follow up.

## Errors

Standard set in [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md#errors). Quote-request-specific:
- Vendor blocklists (your number gets flagged as "spammy price-shopper") — surface if more than 30% of vendors fail to pick up; may need to switch caller-ID or use a different account.
- Some industries have informal "don't price-shop us" cultures (small specialty suppliers especially); when in doubt, the operator should establish the relationship by hand first, then automate.

## Cost discipline

Per call: ~$0.10–0.30. Per quote-request (3 vendors): ~$0.30–0.90.

If your average procurement decision is even $500, the math always works out for getting comparison quotes. The real question is whether phone is the right channel — for repeat purchases from established vendors, just emailing is often equally fast and cheaper.

## Cadence example (typically event-driven, sometimes scheduled)

```yaml
# Scheduled weekly commodity quote
schedule: "0 9 * * 1"   # Monday 9am
skill: phone-quote-request
input_brief: weekly_paper_restock_need_template  # references a saved need template
vendors_resolver: top_3_active_paper_suppliers
batch_strategy: parallel
```

## Out of scope

- Negotiating prices — must be a human action.
- Placing actual orders — definitely a human action.
- Calling 10+ vendors in a sweep — that's spammy procurement; cap at 3–5 vendors per request.
- "Anonymous shopping" (don't tell vendors who you are) — never. Always identify the calling business; vendor relationships matter.

## See also

- [`phone-vendor-status-check`](../phone-vendor-status-check/SKILL.md) — for ongoing status (in-stock, hours), not full quotes
- [`phone-followup-after-quote`](../phone-followup-after-quote/SKILL.md) — for the OPPOSITE direction: when YOU sent a quote and want to know if it landed
