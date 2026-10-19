---
name: listing-watch
description: Review the changes amazon-tools Listing Watch recorded on a seller's own Amazon listings, judge each one (the seller's own edit, harmless, or a problem), post urgent problems to the company's Slack channel at once, and post a weekly digest of everything else. Read-only on Amazon. Use when the listing-watch-review or listing-watch-digest routine fires, or when an operator asks "did anything change on our listings?".
---

# Listing Watch

The amazon-tools plugin snapshots every listing on a schedule and records each
field that changed. This skill turns those raw changes into a short judgment
for a person: what happened, whether it matters, and what to do.

It never changes anything on Amazon. Fixes are drafted for the operator to make.

## Tools

- `amazon_list_listing_changes` (amazon-tools): the change log and the last checks.
- `amazon_get_listing`, `amazon_get_catalog_item`, `amazon_get_item_offers`,
  `amazon_get_aplus_content` (amazon-tools): look closer before judging.
- `slack_list_channels`, `slack_send_channel` (slack-tools): post to the channel.

## Setup the skill expects

- amazon-tools has a seller account with Listing Watch on, allowed for this company.
- slack-tools has a workspace allowed for this company.
- A Slack channel named in the routine's `channel` variable (default
  `listing-watch`) exists, and the Slack bot is a member. If it is missing, say so
  on the run's issue and stop. Do not create channels.

## Where the last review is remembered

Keep one issue in this company titled **Listing Watch log**. Create it on the
first run if it does not exist. Every review ends with a comment on it:

```
Reviewed through 2026-01-15T12:00:00Z. 14 changes: 2 urgent (alerted), 12 for the digest.
```

The next review starts from the most recent "Reviewed through" time. On the very
first run, start 24 hours back.

## Judge each change

Read the changes since the last review with `amazon_list_listing_changes`
(`since` = the last "Reviewed through" time, `limit` 500; page with a later
`since` if there are more). Group them by SKU. For each group decide one of:

**Own edit** (digest). The seller changed it. Signs:
- a `submitted…` field changed (`submittedTitle`, `submittedBullets`,
  `submittedDescription`, `searchTerms`) and the matching `live…` field moved to
  the same value in the same or next check;
- `ourPrice` changed and the Buy Box is still ours.

**Harmless** (digest).
- `offerCount` moved but no new seller appeared and the Buy Box is still ours.
- An issue with severity WARNING appeared or cleared.
- An issue cleared, or status gained BUYABLE or DISCOVERABLE.
- A `buyBoxPrice` change while we still hold the Buy Box.

**Urgent** (alert now). Any of:
- `status` lost BUYABLE or DISCOVERABLE (suppressed, not buyable, not searchable).
- `listing` is `removed`.
- A new issue with severity ERROR.
- `buyBoxHolder` changed from `us` to `other` or `none`.
- `otherSellers` gained a seller (possible hijacker or counterfeit).
- `liveTitle`, `liveBullets`, `images`, `brand` or `category` changed while the
  matching `submitted…` field did not (another seller's edit or an Amazon
  override), or `titleOverridden` became `true`.
- An `aplus` document disappeared or its status is no longer APPROVED.

When unsure, look closer with the detail tools. If still unsure, treat it as
urgent and say what is unclear. Never guess a cause you did not see.

## Alert: urgent changes

Post one message per SKU to the channel with `slack_send_channel`, as soon as the
review finds it:

```
:rotating_light: Listing Watch: <one-line problem>
SKU <sku> · ASIN <asin> · found <detected time, operator's local time>
Before: <value>  After: <value>
Why it matters: <one sentence>
Suggested next step: <one concrete step the operator can take in Seller Central>
```

Keep it to these lines. Never paste buyer data, credentials or anything not in
the change log or the detail tools. Never claim a fix was made.

## Digest: everything else

The **listing-watch-digest** routine posts once a week. Read the last 7 days of
changes, and post one message:

```
:clipboard: Listing Watch weekly digest, <start> to <end>
<n> listings checked · <u> urgent alerts sent · <d> other changes
Own edits: <count>, one line each (SKU: what changed)
Harmless: <count>, one line each
Still open: <urgent problems from this week that the latest snapshot still shows>
```

Then comment on the **Listing Watch log** issue with the same counts.

## Also say so when the watch itself is unhealthy

`amazon_list_listing_changes` returns the last checks. If the latest status check
is older than 8 hours, or a check failed, post one urgent message about the watch
itself (what failed, the error code) instead of staying silent.

## Never

- Change anything on Amazon, or tell the operator a change was made.
- Post outside the configured channel.
- Post when nothing changed: a review with no urgent items posts nothing to
  Slack and only comments on the log issue.
