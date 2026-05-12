---
name: support-day-report
description: Pulls yesterday's Help Scout support metrics (volume, response time, CSAT) and posts the summary to Slack as a morning DM to the operator.
routineTitle: Yesterday's support numbers
routineDescription: |
  Weekday morning routine. Pulls yesterday's support metrics from Help Scout
  and posts the digest to the operator's Slack DM.
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
defaultAssigneeRole: support
triggers:
  - kind: schedule
    label: Weekday 8am Eastern
    cronExpression: "0 8 * * 1-5"
    timezone: America/New_York
variables:
  - name: mailboxId
    label: Help Scout mailbox ID
    type: text
    required: true
requiresSkills:
  - support-day-report
requiresPlugins:
  - help-scout
---

# Yesterday's support numbers

Morning ritual: glance at yesterday's support load before the day starts.
Anchor read-side use case for the help-scout + slack-tools plugin pair.

## After importing

1. Set `mailboxId` to the Help Scout mailbox you want reported on.
2. Confirm the slack-tools plugin is configured with the operator's user ID
   as `defaultDmTarget`.
3. Adjust the cron timezone to the operator's local timezone.
