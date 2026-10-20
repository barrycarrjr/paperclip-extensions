---
name: listing-watch-digest
description: Weekly digest of every listing change Listing Watch recorded in the last 7 days, posted to the Listing Watch Slack channel.
routineTitle: Weekly listing changes digest
routineDescription: |
  Use the listing-watch skill's digest section. Summarize the last 7 days of
  listing changes (likely seller edits, harmless changes, urgent alerts sent, problems
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
the digest lists them again only if current authorized evidence still shows them. Report stale, incomplete or degraded checks rather than claiming coverage. Read every cursor page and deduplicate change IDs before reporting counts.

Read `health` for every configured marketplace and both kinds, including null (missing) checks. Use `amazon_list_listing_changes` with `limit` at most 100, unchanged filters and every `nextCursor` until null; deduplicate IDs. Start ten minutes before the last completed `through`, and save the new `through` only after all pages and authorized actions finish. Periodically replay seven days with retained IDs; finite overlap cannot recover indefinitely delayed commits or clock jumps.

Use structured `complete` and `coverage`, not generic degraded wording, to assess each marketplace/kind. Record missing, stale or unavailable coverage on the log issue. Send only an authorized operational notice for a new or worsened condition, deduplicated by account, marketplace, kind and cause/counts without the run timestamp. Repeated equal or improved incomplete conditions update the log silently; reset after a healthy run. Keep urgent listing-change alerts separate. Ordinary absent optional values are known empty data and do not trigger an alert.
