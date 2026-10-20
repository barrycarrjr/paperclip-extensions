---
name: listing-watch-review
description: Every 6 hours, review the listing changes amazon-tools Listing Watch recorded since the last review and post any urgent problem to the Listing Watch Slack channel.
routineTitle: Review listing changes
routineDescription: |
  Use the listing-watch skill. Read the changes recorded since the last
  "Reviewed through" comment on the Listing Watch log issue, judge each one,
  post every urgent problem to the {{channel}} Slack channel, and comment the
  new "Reviewed through" watermark returned by the tool and counts on the log issue only after every cursor page and authorized action finishes. Report structured incomplete coverage, deduplicating new or worsened operational notices. Read-only on Amazon.
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
at :17 past every sixth hour, UTC), and checks whether a fresh complete snapshot actually exists. The schedule does not guarantee success or full coverage. The
daily content check (07:43 UTC) is picked up by the 12:47 UTC review.

## After importing

1. Assign it to the Listing Watch agent.
2. Set `channel` if the Slack channel is not called `listing-watch`.
3. Run it once by hand: the first review creates the **Listing Watch log** issue
   and looks back 24 hours.

Read `health` for every configured marketplace and both kinds, including null (missing) checks. Use `amazon_list_listing_changes` with `limit` at most 100, unchanged filters and every `nextCursor` until null; deduplicate IDs. Start ten minutes before the last completed `through`, and save the new `through` only after all pages and authorized actions finish. Periodically replay seven days with retained IDs; finite overlap cannot recover indefinitely delayed commits or clock jumps.

Use structured `complete` and `coverage`, not generic degraded wording, to assess each marketplace/kind. Record missing, stale or unavailable coverage on the log issue. Send only an authorized operational notice for a new or worsened condition, deduplicated by account, marketplace, kind and cause/counts without the run timestamp. Repeated equal or improved incomplete conditions update the log silently; reset after a healthy run. Keep urgent listing-change alerts separate. Ordinary absent optional values are known empty data and do not trigger an alert.
