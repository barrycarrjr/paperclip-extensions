---
name: phone-vendor-status-check
description: Place a brief outbound call to a vendor / supplier / contractor to verify status — open hours, lead times, inventory availability, delivery ETA, service availability. Examples - "call the paper supplier and ask if they have 100lb cardstock in stock", "phone the printer and find out their lead time on rush jobs this week", "call the contractor and check if Thursday's install is still on schedule". Use for vendor relationships where there's no API and the human-readable answer is what you actually need. Often runs as a recurring routine (weekly inventory check, monthly hours-of-operation refresh).
---

# Phone Vendor Status Check

Calls a vendor and asks one or two specific questions, captures the answer in structured form, and reports back. Designed for the long tail of vendor relationships where the only reliable channel is "talk to the person who answers the phone."

## When to invoke

- Recurring routine: e.g. "every Monday at 9am, call the top 5 paper suppliers and ask current lead times for our standard SKUs."
- Ad-hoc: an agent needs a piece of info that's only available by phone (small-shop vendor, no website, no email response).
- Pre-order verification: before placing a large order with a vendor, confirm hours / capacity / current backlog.
- Hours/availability sweep: verify a list of vendors' open hours are still as recorded in the CRM (tends to drift).

Do NOT invoke when:
- The vendor has a public website or API with the info — use that instead, much cheaper.
- The question is open-ended sales/negotiation — needs a human.
- The vendor has explicitly asked you to email instead of calling — respect that.

## Pre-conditions

Same as `phone-appointment-booker`:
- `phone-tools` plugin installed + ready for the calling company.
- `allowMutations: true`.
- Real E.164 destination number.
- `defaultNumberId` set OR `from` passed explicitly.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `vendor_name` | yes | "Acme Paper Supply" |
| `vendor_phone` | yes (E.164) | `+15555550123` |
| `caller_identity` | yes | "Acme Print Shop" (the LLC making the inquiry) |
| `caller_account_id` | recommended | the account number the vendor knows you by, if any |
| `questions` | yes | structured list — see below |
| `urgency` | recommended | `low` (purely informational), `medium` (planning), `high` (blocking a customer order) |

`questions` shape — each is one specific thing to ask, with the expected answer type:

```json
[
  { "id": "q1", "ask": "Do you currently have 100lb white cardstock in stock?", "answer_type": "yes_no_quantity", "follow_up_if_no": "When do you expect to restock?" },
  { "id": "q2", "ask": "What is your current lead time for a 500-sheet order?", "answer_type": "duration_days" },
  { "id": "q3", "ask": "What are your hours this Saturday?", "answer_type": "hours_string" }
]
```

Cap `questions` at 3 per call. More than that and the receptionist gets impatient. Split into multiple calls if you need more.

`answer_type` hints (string) help the parser:
- `yes_no` — boolean
- `yes_no_quantity` — boolean + optional quantity
- `duration_days` — integer days (parse "two weeks" → 14)
- `duration_hours` — integer hours
- `hours_string` — open/close times, e.g. "9am to 5pm Mon-Fri, closed weekends"
- `price_usd` — dollar amount
- `free_text` — whatever they said, captured verbatim

## Step 2 — Construct the assistant config

```
You are calling {vendor_name} on behalf of {caller_identity} to ask a few quick questions. {if caller_account_id then "Our account number with them is {caller_account_id}." else ""}

GOAL: get clear answers to the {N} questions below. Be brief and respectful — vendor receptionists are often busy and you're an interruption.

QUESTIONS (ask in order, listen carefully, do NOT skip any):
{numbered_questions_with_followups}

RULES:
1. Lead with: "Hi, this is calling on behalf of {caller_identity}. I have a couple of quick questions if now is an okay time. Should take less than a minute."
2. If they say it's not a good time, ask "When would be a better time to call back?" — capture the answer, then end the call.
3. Ask one question at a time. Wait for the answer before moving on. Don't read the whole list at once.
4. If they don't know the answer to a question, ask "Is there someone I could speak with who would?" — but don't transfer chase forever, max one transfer attempt.
5. If you get all answers OR they get impatient, thank them and end the call using the end-call function.
6. Do NOT discuss pricing, place orders, or commit to anything beyond asking the questions. If they ask "do you want to place an order?" say "Not today — just gathering information for now. I'll have someone follow up if we want to proceed." Then move on.
```

`firstMessage`:

```
Hi, this is calling on behalf of {caller_identity}. I have a couple of quick questions for {vendor_name} if now is an okay time. Should take less than a minute.
```

## Step 3 — Place the call

Same as `phone-appointment-booker` Step 3. `metadata.purpose = "vendor-status-check"` and `metadata.questions` = the question IDs you asked. Idempotency key: `vendor-status:{vendor_id}:{ymd}:{question_set_hash}`.

## Step 4 — Wait for completion

Cap polling at 4 minutes. Most vendor calls finish in 60–120 seconds; receptionists who need to "go check" can take longer.

## Step 5 — Read the transcript and parse answers

For each question in the brief, scan the transcript for the AI's recap or the vendor's direct answer. Build a structured response:

```json
{
  "questions": [
    { "id": "q1", "answered": true, "value": { "in_stock": true, "quantity": "about 800 sheets" }, "confidence": "high" },
    { "id": "q2", "answered": true, "value": { "days": 5 }, "confidence": "high" },
    { "id": "q3", "answered": false, "reason": "didn't_know", "value": null, "confidence": "n/a" }
  ],
  "vendor_demeanor": "friendly" | "rushed" | "hostile" | "neutral",
  "callback_requested": null | "<time-window-string>",
  "transcript_excerpt": "<the relevant turns>"
}
```

`confidence` is your read of how clear the answer was:
- `high` — vendor stated a clear number / yes / no.
- `medium` — answer was hedged ("usually about a week, depending").
- `low` — vendor was vague or you're inferring.

Set `confidence: low` ONLY if you can't tell. Don't make up answers — if it wasn't asked clearly or wasn't answered, mark `answered: false` with a reason.

## Step 6 — Report back + side effects

Comment on the parent issue / routine run:

```
Vendor status check — {vendor_name}:
- Questions: {N} asked, {M} answered
- {q1.id}: {q1.value or "no answer"} (confidence {q1.confidence})
- {q2.id}: ...
- Demeanor: {demeanor}
- Duration: {durationSec}s · Cost: ${costUsd}
```

Side effects:
- Update vendor record in CRM with the new info (in-stock status, lead times, hours).
- If any answer was `confidence: low` or `answered: false`, set a flag on the vendor record so a human reviews next time.
- If `callback_requested` is set, schedule a one-off agent wakeup for that time to retry.
- If `vendor_demeanor: "hostile"` shows up twice in a row, drop the vendor from auto-call rotation and notify the operator — they may need to switch channels.

## Errors

Same shapes as `phone-appointment-booker`. Vendor-specific:
- Some small vendors block "spammy" caller-IDs; if you see multiple `no-answer` results in a row from a vendor that previously picked up, your caller-ID may be on a vendor-side block list. Surface for human triage.
- IVRs are common at larger vendors — the assistant has 60s of patience before bailing. If you see lots of `outcome: ivr-stuck`, swap to the vendor's email channel.

## Cost discipline

Per call: ~$0.05–0.20 (1–2 questions = 60s; 3 questions = 90–120s).

A weekly sweep of 10 vendors at 3 questions each = ~$2/week. Compare to the cost of one wrong-info-driven order error.

## Cadence example

```yaml
# Weekly inventory check
schedule: "0 9 * * 1"  # Monday 9am
skill: phone-vendor-status-check
input_source: vendors_with_tag:active_supplier
question_set: standard_inventory_check  # references a saved question template
batch_pacing_seconds: 60
max_calls_per_run: 10
```

## Out of scope

- Negotiating prices / quantities / SLAs — needs a human or `phone-vendor-negotiation` (not yet built).
- Placing actual orders — definitely a human action; AI calls cannot legally bind you.
- Calling a personal number / private contact for "vendor info" — businesses only.
- Loyalty/relationship calls (just calling to check in) — different skill (`phone-vendor-relationship-ping`, not yet built).

## See also

- [`phone-appointment-booker`](../phone-appointment-booker/SKILL.md)
- [`phone-confirmation-call`](../phone-confirmation-call/SKILL.md)
