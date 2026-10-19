---
name: listing-watch-digest
description: Weekly digest of every listing change Listing Watch recorded in the last 7 days, posted to the Listing Watch Slack channel.
routineTitle: Weekly listing changes digest
routineDescription: |
  Use the listing-watch skill's digest section. Summarize the last 7 days of
  listing changes (own edits, harmless changes, urgent alerts sent, problems
  still open) in one message to the {{channel}} Slack channel, then comment the
  counts on the Listing Watch log issue. Read-only on Amazon.
priority: low
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
defaultAssigneeRole: researcher
triggers:
  - kind: schedule
    label: Mondays 9am Eastern
    cronExpression: "0 9 * * 1"
    timezone: America/New_York
variables:
  - name: channel
    label: Slack channel for the digest
    type: text
    required: true
    defaultValue: listing-watch
requiresSkills:
  - listing-watch
requiresPlugins:
  - amazon-tools
  - slack-tools
---

# Weekly listing changes digest

One message a week, so changes that are not urgent are still seen without
interrupting anyone. Urgent problems were already posted by the review routine;
the digest lists them again only if the latest snapshot still shows them.
