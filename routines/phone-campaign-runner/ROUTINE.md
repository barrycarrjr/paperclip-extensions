---
name: phone-campaign-runner
description: Tick the outbound phone campaign runner. Every minute, enumerate running campaigns for the company and place the next batch of dials within budget (concurrency / daily cap / hours / DNC). Lead state updates happen automatically via the plugin's webhook handler — this routine only triggers the dial side.
routineTitle: Phone campaign runner (per-minute tick)
routineDescription: |
  Every minute, drive any campaigns in `running` status: pick pending
  leads, respect business hours / DNC / pacing, place AI calls. Idle
  ticks (no running campaigns or all-out-of-hours) cost nothing — the
  runner exits early.
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
defaultAssigneeRole: operator
triggers:
  - kind: schedule
    label: Every minute
    cronExpression: "* * * * *"
    timezone: UTC
requiresSkills:
  - phone-campaign-runner
requiresPlugins:
  - phone-tools
---

# Phone campaign runner routine

Anchor use-case for the v0.5.0 outbound campaign mode of `phone-tools`.

## What this routine does

Fires every minute. Calls the `phone-campaign-runner` skill, which:

1. Lists running campaigns for the company.
2. For each, evaluates concurrency cap, daily cap, lead status counts.
3. Picks pending or retry-due leads inside business hours.
4. Calls `phone_call_make` for each, with metadata that ties the call back to the campaign + lead.
5. Sleeps `pacing.secondsBetweenDials` between dials within the same tick.
6. Exits.

Lead state updates (qualified / no-answer / transferred / dnc) are the plugin's job, not the routine's — they fire automatically when Vapi posts `call.ended` / `call.transferred` / `add_to_dnc` webhooks.

## After importing

1. Make sure the `phone-tools` plugin is installed and `allowMutations: true`.
2. Make sure at least one assistant has `transferTarget` configured (campaigns refuse to start without one).
3. Create your first campaign via the API:

   ```
   phone_campaign_create  →  phone_lead_list_import_csv  →  phone_campaign_start
   ```

4. The routine will pick it up on the next tick.

## Idle ticks

If no campaigns are running, or all running campaigns are out-of-hours, the routine does no work and exits in < 100ms. Safe to run every minute even on quiet days — the cost is one tool call per tick.

## Pacing override

The routine fires every minute, but each campaign has its own `pacing.secondsBetweenDials` (default 90s) controlling intra-tick spacing. If you want SLOWER dialing than 1 batch/minute, lower the campaign's `pacing.maxConcurrent` and `pacing.maxPerHour` rather than slowing the routine — the routine only initiates dials that fit budget, so lowering caps naturally throttles.

## Related

- `phone-tools` plugin v0.5.0+ for the `phone_campaign_*` / `phone_lead_*` / `phone_dnc_*` tools.
- The `phone-assistant` agent bundle ties campaigns together with the rest of the phone toolkit.
