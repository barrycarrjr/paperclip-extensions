---
name: pbx-daily-call-report
description: Pulls today's PBX call stats from 3CX (offered / answered / abandoned / SLA / peak depth) and posts a one-line summary to the operator's company board or Slack DM at end-of-business-day.
routineTitle: Daily PBX call report
routineDescription: |
  Daily routine that fires at end-of-business-day, pulls call metrics from
  the company's 3CX PBX for the day, and posts a one-line summary to
  whichever channel is configured (board issue comment or Slack DM).
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
defaultAssigneeRole: operator
triggers:
  - kind: schedule
    label: Weekday 6pm Eastern
    cronExpression: "0 18 * * 1-5"
    timezone: America/New_York
variables:
  - name: queueName
    label: Queue name (3CX)
    type: text
    required: true
  - name: targetChannel
    label: Where to post
    type: select
    required: true
    options:
      - { value: "board", label: "Company board (issue comment)" }
      - { value: "slack", label: "Slack DM to operator" }
    defaultValue: board
requiresSkills:
  - pbx-daily-call-report
requiresPlugins:
  - 3cx-tools
---

# Daily PBX call report routine

Anchor use-case for the `3cx-tools` plugin: end-of-day, ship the operator a
one-line picture of how the phones did. Useful as a heartbeat that
confirms the PBX integration is alive and as a quick scan of whether
abandonment / SLA is creeping.

## What gets sent

A single comment / DM with: queue name, offered, answered, abandoned,
service-level percentage, peak queue depth. No charts, no thread —
designed to be readable on a phone in under five seconds.

## After importing

1. Pick the right queue (most operators run one main queue; sites with
   multiple queues deploy one routine per queue).
2. Choose the target channel — board comment vs. Slack DM.
3. If picking Slack, ensure the slack-tools plugin is also installed and
   the operator's user ID is the default DM target.
4. Adjust the cron timezone to the company's local timezone.

## Related

- The `pbx-queue-watchdog` skill / routine is the sibling that fires
  ad-hoc when queue depth spikes during the day — use it alongside this
  one.
- The `phone-assistant` agent bundle ties this routine to the rest of the
  phone toolkit.
