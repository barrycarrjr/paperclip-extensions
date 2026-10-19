---
name: listing-watch-review
description: Every 6 hours, review the listing changes amazon-tools Listing Watch recorded since the last review and post any urgent problem to the Listing Watch Slack channel.
routineTitle: Review listing changes
routineDescription: |
  Use the listing-watch skill. Read the changes recorded since the last
  "Reviewed through" comment on the Listing Watch log issue, judge each one,
  post every urgent problem to the {{channel}} Slack channel, and comment the
  new "Reviewed through" time and counts on the log issue. Read-only on Amazon.
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
defaultAssigneeRole: researcher
triggers:
  - kind: schedule
    label: Every 6 hours, 30 minutes after the status check
    cronExpression: "47 */6 * * *"
    timezone: UTC
variables:
  - name: channel
    label: Slack channel for alerts
    type: text
    required: true
    defaultValue: listing-watch
requiresSkills:
  - listing-watch
requiresPlugins:
  - amazon-tools
  - slack-tools
---

# Review listing changes

Runs 30 minutes after each amazon-tools `listing_watch_status` check (which runs
at :17 past every sixth hour, UTC), so each review sees a fresh snapshot. The
daily content check (07:43 UTC) is picked up by the 12:47 UTC review.

## After importing

1. Assign it to the Listing Watch agent.
2. Set `channel` if the Slack channel is not called `listing-watch`.
3. Run it once by hand: the first review creates the **Listing Watch log** issue
   and looks back 24 hours.
