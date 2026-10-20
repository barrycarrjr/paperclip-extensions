---
name: listing-watch
displayName: Listing Watch pack
description: One-click setup for watching a seller's own Amazon listings. Imports the listing-watch agent, the listing-watch skill, the 6-hourly review routine and the weekly digest routine. Requires amazon-tools (with Listing Watch on) and slack-tools.
icon: eye
category: commerce
requiresPlugins:
  - amazon-tools
  - slack-tools
includes:
  agents:
    - listing-watch
  routines:
    - listing-watch-review
    - listing-watch-digest
  skills:
    - listing-watch
---

# Listing Watch pack

amazon-tools records field changes after bounded checks with explicit coverage; this pack adds the agent
that reads those changes, decides which ones matter, and tells a person.

## After installing

1. Preflight every account before upgrading 0.2.0 to 0.3.0 (no approval pause); configure either company-owned credential mode and explicitly turn on **Listing Watch**. Old unowned history stays private; the first complete check starts a new baseline.
2. In Slack, create a `listing-watch` channel and invite the slack-tools bot.
3. Give the Listing Watch agent the amazon-tools read tools and the slack-tools
   `slack_list_channels` and `slack_send_channel` tools.
4. Review the 240-second job budget, 100-page/2,000-listing and 4 MiB bounds and incomplete/degraded outcomes. Assign and enable routines only after the operator approves their account, agent and Slack channel. Run **Review listing changes** once by hand to check setup. Importing this bundle does not perform those actions.

Read `health` for every configured marketplace and both kinds, including null (missing) checks. Use `amazon_list_listing_changes` with `limit` at most 100, unchanged filters and every `nextCursor` until null; deduplicate IDs. Start ten minutes before the last completed `through`, and save the new `through` only after all pages and authorized actions finish. Periodically replay seven days with retained IDs; finite overlap cannot recover indefinitely delayed commits or clock jumps.

Use structured `complete` and `coverage`, not generic degraded wording, to assess each marketplace/kind. Record missing, stale or unavailable coverage on the log issue. Send only an authorized operational notice for a new or worsened condition, deduplicated by account, marketplace, kind and cause/counts without the run timestamp. Repeated equal or improved incomplete conditions update the log silently; reset after a healthy run. Keep urgent listing-change alerts separate. Ordinary absent optional values are known empty data and do not trigger an alert.
