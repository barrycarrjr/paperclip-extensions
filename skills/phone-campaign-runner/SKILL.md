---
name: phone-campaign-runner
description: Drive an outbound phone campaign — pull pending leads, respect business hours + DNC + concurrency caps + dial pacing, place AI calls via phone-tools, and let the plugin's webhook handler update lead state on call.ended / call.transferred / add_to_dnc. Invoked once per minute by the `phone-campaign-runner` routine; also invokable ad-hoc when an operator says "drive the active campaigns now". Idempotent — running it twice in a tick is a no-op for any lead already calling.
---

# Phone Campaign Runner

The outer loop for outbound campaigns. Per-tick: enumerate running campaigns for the company, find leads ready to dial, place calls within budget. Lead-state updates happen automatically inside the `phone-tools` plugin's webhook handler — this skill is dial-side only.

## When to invoke

- Routine fires every 1 minute (default).
- Operator asks "kick the campaign runner now".
- Do NOT invoke on call.ended / call.transferred events — the plugin handles those internally; the runner only initiates dials.

## Pre-conditions

- `phone-tools` plugin installed and `allowMutations: true`.
- The calling company has at least one campaign in status `running`.
- The campaign's driving assistant has `transferTarget` set on its phone config (campaigns refuse to start without it).
- The calling company is in the phone account's `allowedCompanies` list.

## How to invoke

The runner is one shell-style script that loops through campaigns. Concretely:

### Step 1 — list running campaigns for this company

```
TOOL: phone_campaign_list
PARAMS: { "status": "running" }
→ data.campaigns: Campaign[]
```

If empty, exit (nothing to do this tick).

### Step 2 — for each running campaign, evaluate dial budget

For each campaign:

```
TOOL: phone_campaign_status
PARAMS: { "campaignId": "<id>" }
→ data.counters.today: { attempted, qualified, ... }
→ data.leadsByStatus: { pending, calling, ... }
```

Check budget:

- `today.attempted < campaign.pacing.maxPerDay` — else skip campaign for the rest of the day.
- `data.leadsByStatus.calling < campaign.pacing.maxConcurrent` — else skip campaign this tick (in-flight calls eating the budget).

### Step 3 — pick the next batch of leads

```
TOOL: phone_lead_status (one per lead, OR scan via phone_campaign_status)
```

Prefer leads where:
- `status === "pending"`, OR
- `status ∈ {"no-answer", "busy"}` AND `nextAttemptAfter <= now`

Pick `min(maxConcurrent - calling, slots-left-this-tick)` of them, ordered by `nextAttemptAfter` ascending (so retries that are due go first).

### Step 4 — for each picked lead, check business hours + DNC

```
TOOL: phone_dnc_check
PARAMS: { "phoneE164": "<lead.phoneE164>" }
→ data.inDnc: bool
```

If `inDnc`, the lead is already gated by phone_lead_list_append; this is a defensive double-check. Skip the dial.

For business hours: convert `now` to the lead's local timezone (use `lead.timezoneHint` or fall back to the campaign's `geographicScope` first entry's TZ). If outside `campaign.preflight.callerLocalHours`, skip the lead silently — its status stays `pending`.

### Step 5 — place the call

```
TOOL: phone_call_make
PARAMS: {
  "to": "<lead.phoneE164>",
  "assistant": "<vapiAssistantId resolved from campaign.assistantAgentId's phone config>",
  "metadata": {
    "paperclip_campaign_id": "<campaign.id>",
    "paperclip_lead_phone": "<lead.phoneE164>",
    "paperclip_lead_attempt": <lead.attempts + 1>
  },
  "idempotencyKey": "<campaign.id>:<lead.phoneE164>:<lead.attempts + 1>"
}
```

The metadata is critical — the plugin's onWebhook handler reads `paperclip_campaign_id` + `paperclip_lead_phone` to find the lead and update its status when the call ends. Without metadata, the call still happens but the campaign loses track.

The `idempotencyKey` makes the dial safe to retry within the same tick — if phone_call_make is called twice with the same key in 24h, it returns the existing callId rather than placing a duplicate.

### Step 6 — sleep between dials

After each successful place, sleep `campaign.pacing.secondsBetweenDials` seconds before placing the next one in the same tick. Smooths spike-y dial bursts and gives the engine breathing room.

### Step 7 — write the lead's `calling` state

The plugin's webhook handler updates `lead.status` from `calling` → terminal automatically. The runner doesn't need to track in-flight state itself — but it SHOULD bump `lead.attempts` and write `lead.lastAttemptAt` immediately so the next tick's "is this lead already calling?" check is honest.

```
TOOL: phone_lead_status (read)
TOOL: (no direct write tool — the plugin handles writes via webhook)
```

NOTE: there's no public lead-write tool in v0.5.0. The runner writes `attempts++` indirectly via the call.started webhook → plugin updates state. If the runner needs to track "I dialed this lead at <ts>", add a `last-tick-attempts:<campaignId>:<leadPhone>` state via the runner's own scratch state.

## Step 8 — exit cleanly

After processing all running campaigns, exit. Do NOT busy-wait for call outcomes — the plugin handles that asynchronously via its webhook. The next routine tick (1 minute later) will re-evaluate.

## Out-of-hours handling

The runner skips out-of-hours leads silently (they stay `pending`). The next tick re-evaluates. If a campaign has zero leads in the current hours window across the configured `geographicScope`, the runner does no work and exits.

## Pacing failure modes

- **No-answer lead exceeded `retry.onNoAnswer.maxAttempts`** — the plugin's webhook handler keeps `status: "no-answer"` without setting `nextAttemptAfter`. The runner sees no-`nextAttemptAfter` no-answer and skips. Lead is effectively closed without escalating to disqualified.
- **Concurrency cap saturated by long-running calls** — runner skips dial slots until calls finish. If all max-concurrent calls are AI conversations going strong (3 minutes each), the runner won't dial again until at least one ends.
- **Daily cap hit** — runner skips for the rest of the day. Next-day tick re-evaluates against fresh counters.

## Logging

Every dial decision goes to plugin logger via `phone_call_make` telemetry. Skipped leads log a one-line reason ("out-of-hours-est", "dnc-defensive-double-check", etc.) for the operator's audit log.

## Related

- `phone-campaign-summary` (v0.5.1) — end-of-day rollup of campaign counters → board issue.
- `phone-tools` plugin v0.5.0 — provides `phone_campaign_*`, `phone_lead_*`, `phone_dnc_*` tools.
- The plugin's onWebhook handler is what updates lead state on call.ended / call.transferred / add_to_dnc — the runner is purely the dial-side worker.
- `phone-lead-qualification` and other `phone-*` skills are valid campaign assistants — drop a list of leads into a campaign that uses one of them as its `assistantAgentId` and the campaign runs that script per call.
