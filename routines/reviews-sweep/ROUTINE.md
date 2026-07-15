---
name: reviews-sweep
description: Daily sweep of unreplied Google Business Profile reviews. Wakes an agent to process the review queue via the reviews-reply skill — auto-posting warm thank-yous to plain 5-star reviews and holding everything substantive (and every review of 3 stars or fewer) for board approval.
routineTitle: Clear the Google reviews queue
routineDescription: |
  Daily. Process unreplied Google Business Profile reviews for this company
  using the reviews-reply skill: refine each drafted reply, auto-post to plain
  5-star reviews, and hold anything with written content or 3 stars or fewer
  for the board. Never auto-reply to a negative review.
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
defaultAssigneeRole: ceo
triggers:
  - kind: schedule
    label: Daily 9am Eastern
    cronExpression: "0 9 * * *"
    timezone: America/New_York
requiresSkills:
  - reviews-reply
requiresPlugins:
  - gbp-reviews
---

# Clear the Google reviews queue

The `gbp-reviews` plugin already creates an issue per new review with a drafted
reply. This routine is the daily backstop that makes sure the queue actually
gets worked — nothing sits unreplied — and applies the auto-vs-hold policy in
one pass.

Pairs the `gbp-reviews` plugin with the `reviews-reply` skill.

## After importing

1. Confirm the `gbp-reviews` plugin is installed and configured for this
   company (accounts + locations, with this company as the `targetCompanyId`).
2. Attach the `reviews-reply` skill to the assignee (the CEO by default, or a
   marketing/support agent if you have one).
3. Decide the trust posture:
   - **Starting out:** leave the plugin's `allowReplies` **off** — the routine
     will draft and hold every reply for you to approve.
   - **Once you trust it:** turn `allowReplies` **on** so plain 5-star reviews
     get a hands-free thank-you, while everything substantive still waits for
     your approval.
4. Adjust the cron timezone to the operator's local timezone.

## Why a routine on top of the plugin's poller

The plugin's 15-minute poller catches *new* reviews. This daily routine catches
anything that slipped (API sync lag, a review edited after the fact, a draft
left un-actioned) and gives a single, predictable moment where the review queue
is brought to zero — so the operator always knows reviews are handled.
