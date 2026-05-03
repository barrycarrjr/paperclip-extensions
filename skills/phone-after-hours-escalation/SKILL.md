---
name: phone-after-hours-escalation
description: Place a real outbound phone call to an on-call human when a Slack page or other notification hasn't been acknowledged within the SLA. Examples - "Slack page in #ops-alerts hasn't been acked in 10 min, call the on-call rotation", "production alert sat unread for 15 min, escalate by phone", "an after-hours customer issue arrived and the Slack DM wasn't read in 5 min". Use as the second-tier escalation when chat-based notifications fail. Chains with slack-tools for status check + post-back; chains with the alerting source for the incident context.
---

# Phone After-Hours Escalation

When a chat-based page goes unacknowledged, a phone call wakes the right human up. Brief, structured, with a clear "ack verbally" success criterion. Posts the ack status back to the source channel so the team has a record.

This is the **first phone skill that chains with another plugin** (`slack-tools`) and operates on a tighter SLA than the others — escalations are time-sensitive.

## When to invoke

- An alerting routine watches a chat channel / DM / queue. After N minutes without ack, it fires this skill against the on-call human.
- An incident-management workflow flags a new high-severity issue and pages the on-call. After SLA, escalate.
- An operator manually triggers it: "I can't reach Sam — call them on the on-call number."

Do NOT invoke when:
- Within standard business hours and the team is online (use chat-only escalation; the phone is reserved for "wake them up" cases).
- The on-call schedule is empty / nobody is rostered (this is a config error — surface, don't auto-call a default).
- The original page has been acked between trigger time and call time (race condition; check ack status one more time before placing the call).
- The on-call has a `do_not_call_after` window set in their preferences (e.g. they've requested no calls after 11pm; some pages are not worth waking up).

## Pre-conditions

- `phone-tools` plugin installed + ready, `allowMutations: true`, real E.164 destination, `defaultNumberId` set.
- `slack-tools` plugin installed + ready (for ack-status check + post-back); calling company in both plugins' `allowedCompanies`.
- An on-call schedule resolved to a SPECIFIC human + phone (the routine that fires this skill is responsible for resolving the schedule, not this skill).
- The page's `severity` and `summary` available — feeds the AI's verbal summary.

## Step 1 — Resolve the brief

| Field | Required | Example |
|---|---|---|
| `oncall_phone` | yes (E.164) | `+15555550123` |
| `oncall_name` | yes | "Sam" (first name only — wakeup calls aren't formal) |
| `caller_business` | yes | "Acme Operations" |
| `incident_summary` | yes | one-line, tightly worded: "Production database has been throwing 5xx errors for 8 minutes" |
| `incident_severity` | yes | `low` / `medium` / `high` / `critical` (controls tone, NOT volume) |
| `incident_link` | recommended | URL the on-call should open: dashboard, Slack thread, runbook |
| `slack_thread` | recommended | `{ channel_id, message_ts }` — used to (a) verify it's still unacked before calling, (b) post ack confirmation back |
| `time_since_page_minutes` | yes | how long the page has been sitting unacked |
| `escalation_chain` | recommended | who to call NEXT if this person doesn't pick up |

## Step 2 — Pre-flight check (BEFORE placing the call)

Before invoking `phone_call_make`, re-verify the page is still unacked. Race conditions matter — calling someone after they already acked from their phone is annoying.

If `slack_thread` is provided, fetch the latest reactions / replies on that message via `slack-tools:slack_get_thread` (or `slack_search_messages`). If anyone has replied or added an ack-style emoji (`:eyes:`, `:white_check_mark:`, `:wave:`, plus any custom ack emoji configured by the team), abort the call and update the source routine: "page was acked between trigger and call, no escalation needed."

Pseudo-code:

```js
const recentReplies = await slackTools.getThread({ channel: slack_thread.channel_id, ts: slack_thread.message_ts });
const ackSignals = ["eyes", "white_check_mark", "wave", "ack", "ok_hand"];
const isAcked = recentReplies.replies.length > 1 ||
                recentReplies.reactions.some((r) => ackSignals.includes(r.name));
if (isAcked) {
  log("page acked since trigger; skipping phone escalation");
  return { outcome: "no-call-needed", reason: "acked-since-trigger" };
}
```

## Step 3 — Construct the assistant config

```
You are calling {oncall_name} from {caller_business} because a {incident_severity} alert has been unacknowledged for {time_since_page_minutes} minutes.

INCIDENT:
{incident_summary}
{if incident_link then "Link: " + incident_link}

GOAL: get a verbal acknowledgment from {oncall_name} that they are awake, aware of the alert, and will look at it now. That's it. You're not solving the incident; you're handing it off.

EXPECTED FLOW:
1. Identify yourself as the automated escalation system — be honest about being automated, no need to pretend otherwise. Wakeup calls are forgiven for being clipped.
2. State the incident summary in one sentence.
3. Ask: "Can you take a look at this now, or should I call the next person on the rotation?"
4. Listen for ONE of:
   a. ACK ("yes, on it" / "I've got it" / "looking now") → confirm "great, thanks", end the call.
   b. NEED MORE INFO ("what's the link?" / "where do I look?") → if `incident_link` was provided, read it character-by-character ("the link is: dashboard dot ops dot acme dot com slash incidents slash 4827"). Then re-ask "can you take it from here?" Listen for ack.
   c. CAN'T TAKE IT ("I'm not available", "call someone else") → confirm "understood, I'll escalate to the next person", end the call.
   d. CONFUSED / GROGGY ("what?" / "huh?") → repeat the summary slowly ONCE, then re-ask.

RULES:
1. {if incident_severity == "critical" then "Be calm but direct. This is a critical alert; brevity matters more than warmth." else "Be calm and polite. They're being woken up."}
2. Speak slowly and clearly. The on-call may be in bed, in a car, or otherwise distracted.
3. NEVER apologize repeatedly — one quick "sorry to wake you" is fine, but do NOT keep apologizing through the call.
4. If they're hostile or yelling, capture that, end the call, and the report should flag for HR / culture follow-up (not your job, but the data matters).
5. If you reach voicemail, leave a SHORT message: "Hi {oncall_name}, this is the on-call escalation system from {caller_business}. {incident_summary}. {if incident_link then "Link is in the Slack channel."} I'm escalating to the next person on the rotation. Please call back if you become available." Then hang up.
6. End the call with the end-call function once you have any of the four answers OR voicemail.

Total call should be under 2 minutes. Faster is better.
```

`firstMessage`:

```
Hi {oncall_name}, this is the automated on-call escalation from {caller_business}. There's a {incident_severity} alert that's been unacked for {time_since_page_minutes} minutes — {incident_summary}. Can you take a look?
```

## Step 4 — Place the call

Same as `phone-appointment-booker` Step 3. `metadata.purpose = "after-hours-escalation"`, `metadata.incident_id` if you have one. Idempotency key: `escalation:{incident_id}:{escalation_attempt_n}` to prevent duplicate calls during retry storms.

**No mutation gate trick:** because escalation calls are time-critical, the calling routine should validate `allowMutations: true` BEFORE the SLA timer expires, not after. If the gate is off when the call needs to fire, the routine should fall back to chat-only escalation and notify the operator about the disabled gate.

## Step 5 — Wait for completion

Cap polling at **90 seconds** — much shorter than other skills because escalation needs to chain quickly into either the next person or chat-back. If the call hasn't ended in 90s, treat as "ongoing" and proceed to the next-person escalation in parallel rather than waiting.

## Step 6 — Read the transcript and classify

| Outcome | Signal |
|---|---|
| `acked-will-handle` | On-call verbally confirmed they'll take the incident. SUCCESS. |
| `acked-needs-info` | On-call acked but asked for more info that was provided; still acked. SUCCESS. |
| `declined-not-available` | On-call answered but said they can't take it. ESCALATE to next in chain. |
| `no-pickup-voicemail` | Voicemail; standard message left. ESCALATE to next in chain immediately. |
| `unreachable` | No-answer / busy / disconnected. ESCALATE immediately. |
| `confused-no-clear-ack` | On-call answered but the AI couldn't get a clear ack after one repeat. ESCALATE; flag for follow-up — they may need a different escalation channel. |
| `hostile` | On-call was hostile. ESCALATE; flag for HR / culture review. |

## Step 7 — Report back + chain side effects

This skill has the most side effects of any phone skill, because escalation needs to keep moving:

For ALL outcomes: post the ack status back to the source Slack thread via `slack-tools:slack_send_message`:

```
🤖 Phone escalation to {oncall_name}: {outcome}
   Duration: {durationSec}s · Cost: ${costUsd}
   {if outcome.startsWith("acked") then "✅ acknowledged verbally" else "❌ not acked — escalating to " + next_in_chain_name}
```

Then per outcome:
- `acked-will-handle` / `acked-needs-info` — DONE. Update the incident record with `acked_via: "phone"`, `acked_by: oncall_name`, `acked_at: <ts>`. Cancel any further escalation timers.
- `declined-not-available` / `no-pickup-voicemail` / `unreachable` / `confused-no-clear-ack` / `hostile` — fire `phone-after-hours-escalation` AGAIN against the next person in `escalation_chain`. Bump `escalation_attempt_n`. If the chain is exhausted, post a "🚨 ALL ESCALATIONS EXHAUSTED" alert to a wider channel (e.g. `#leadership-pages`) AND text/page anyone with the `final-escalation-recipient` flag.

## Errors

Same shapes as `phone-appointment-booker`. Escalation-specific:
- `[ECONCURRENCY_LIMIT]` is dangerous here: if multiple incidents fire at once and the cap rejects calls, escalations get stuck. Either (a) raise `maxConcurrentCalls` for the escalation account specifically, or (b) reserve a dedicated `escalation` account with its own cap separate from regular outbound traffic.
- DNC laws DO NOT generally apply to internal escalation calls (you have a relationship with the on-call), but verify per jurisdiction.

## Cost discipline

Per call: ~$0.05–0.20 (escalation calls are SHORT — usually under 60s).

A typical week's escalations: 3–10 calls. Cost is measured in single dollars, not budget concern.

The expensive failure mode is NOT the calls themselves — it's chains that don't escalate fast enough (incident burns longer because escalation pause is too long) or chains that escalate too aggressively (every call wakes everyone up). Tune `time_since_page_minutes` thresholds carefully per-channel.

## Cadence example (event-driven, not scheduled)

```yaml
# In the incident-watch routine
trigger: event
event: slack.message_unread_after_sla
filter:
  channel_in: ["#prod-alerts", "#oncall-pages"]
  unread_minutes_gte: 10
  oncall_resolvable: true
skill: phone-after-hours-escalation
input_resolver: oncall-schedule  # plugin/skill that resolves "who's on call" from the schedule
```

## Out of scope

- Solving the incident — explicitly NOT this skill's job.
- Multi-party conferencing the on-call into a war-room call — needs the conferencing capability (out of scope until v0.4+).
- Real-time call routing decisions ("AI hears the on-call is at the gym, transfer to extension 200") — needs `phone_call_transfer` (out of scope until v0.4+).
- Calling customers as part of an incident — different skill (and a different conversation about whether AI should be the messenger to customers in an incident).

## See also

- [`slack-tools`](../../plugins/slack-tools/) — for ack status check + post-back
- [`phone-confirmation-call`](../phone-confirmation-call/SKILL.md) — for the same plugin tool surface, different urgency profile
