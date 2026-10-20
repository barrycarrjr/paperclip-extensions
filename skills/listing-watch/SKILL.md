---
name: listing-watch
description: Review the changes amazon-tools Listing Watch recorded on a seller's own Amazon listings, judge each one (likely seller edit, harmless, or a problem), post urgent problems to the company's Slack channel at once, and post a weekly digest of everything else. Read-only on Amazon. Use when the listing-watch-review or listing-watch-digest routine fires, or when an operator asks "did anything change on our listings?".
---

# Listing Watch

The amazon-tools plugin attempts complete bounded listing snapshots on a schedule and records each
field that changed. This skill turns those raw changes into a short judgment
for a person: what happened, whether it matters, and what to do.

It never changes anything on Amazon. Fixes are drafted for the operator to make.

## Tools

- `amazon_list_listing_changes` (amazon-tools): the change log and the last checks.
- `amazon_get_listing`, `amazon_get_catalog_item`, `amazon_get_item_offers`,
  `amazon_get_aplus_content`, `amazon_list_aplus_publish_records` (amazon-tools): look closer before judging. Use `contentReferenceKey` and `moduleOffset` for full A+ reads; legacy `asin` is limited to five complete documents.
- `slack_list_channels`, `slack_send_channel` (slack-tools): post to the channel.

## Setup the skill expects

- amazon-tools 0.3.0 or later has a seller account with Listing Watch on, explicitly allowed for this company, and current company-owned credentials. Preflight all stored config before a 0.2.0 upgrade, which activates without an approval pause. New installs or 0.1.0 capability escalation can require approval.
- The operator has authorized this routine and its Slack channel. Otherwise keep the proposed alert on the run issue and ask for that authorization before posting.
- Historical 0.2.0 rows without an owner are retained privately; the new baseline starts without alerts.
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

The next review starts ten minutes before the most recent fully completed "Reviewed through" time, with ID deduplication. On the very
first run, start 24 hours back.

## Judge each change

Read the changes since the last review with `amazon_list_listing_changes`
(`since` = ten minutes before the last completed "Reviewed through" time, `limit` at most 100). Repeat the exact filters with `cursor` set to `nextCursor` until it is null, including empty pages. Never advance `since` within a cursor chain. Persist processed change IDs for deduplication and advance the returned `through` only after all pages and authorized actions finish. Replays must not post the same change twice. A ten-minute overlap recovers ordinarily delayed commits, not arbitrary delays or clock jumps; periodically reread the full seven-day interval with persisted IDs, and choose an older explicit start if the operator needs longer recovery. Group them by SKU. For each group decide one of:

**Likely seller edit** (digest). These are clues, not verified authorship:
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

`amazon_list_listing_changes` returns `health`, one latest status and content check per configured marketplace. A null latest check is missing. Check every pair: status older than 8 hours, content older than 32 hours, `ok: false`, `complete: false`, or nonzero unavailable `coverage` counts mean monitoring needs attention. `complete: null` means an older run has no structured coverage proof; do not call it healthy. `enumerationComplete` alone never proves Buy Box or content coverage. Ordinary empty fields do not indicate a failure. Use the error code and the offers/catalog/A+ counts of required/read ASINs, provider failures, started requests that reached the deadline, reads not attempted for budget, affected listings and unavailable sources.

Record the operational limitation on the Listing Watch log issue. If channel posts are authorized, send one operational notice per new or worsened condition, separate from urgent listing-change alerts:

```
:warning: Listing Watch coverage: <marketplace> <status or content>
Coverage: <read>/<required> ASINs; <provider failures> provider failures; <deadline failures> started requests timed out; <not attempted> not attempted for budget; <affected> listings unavailable
Next step: <one action based on the error or missing source>
```

Persist a condition key with the log: account, marketplace, kind, error/cause and coverage counts (or missing/stale state). Do not include the run timestamp in that key. Repeated equal or improved-but-still-incomplete counts update the log without another Slack post. Notify again only for a new cause, worsened counts or a recurrence after a healthy run, and mark a condition recovered when a fresh complete run returns. Do not turn each generic degraded note into an urgent post. A baseline with ordinary empty values produces no alert.

## Never

- Change anything on Amazon, generate reports, or tell the operator a change was made.
- Post outside the configured channel.
- Post when nothing changed: a review with no urgent changes and no new or worsened operational condition posts nothing to Slack and only comments on the log issue.

Read `health` for every configured marketplace and both kinds, including null (missing) checks. Use `amazon_list_listing_changes` with `limit` at most 100, unchanged filters and every `nextCursor` until null; deduplicate IDs. Start ten minutes before the last completed `through`, and save the new `through` only after all pages and authorized actions finish. Periodically replay seven days with retained IDs; finite overlap cannot recover indefinitely delayed commits or clock jumps.

Example first page (synthetic, then repeat these filters with the returned cursor):

```json
{"account":"seller","since":"2026-01-15T11:50:00Z","limit":100}
```
