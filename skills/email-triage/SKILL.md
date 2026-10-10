---
name: email-triage
description: Triage new mail in an IMAP mailbox. Apply learned per-sender rules (auto-mark-read + move to a `_paperclip/triage` label) and record unknown senders in the email-tools review queue for the operator to decide on. Designed to run autonomously on a daily or twice-daily schedule before the operator starts work, so the inbox is clean by the time they sit down. Reusable across any mailbox configured in the email-tools plugin: pass the mailbox identifier as `mailbox` in the routine. Conservative by default. Never deletes mail, only moves to a label that's still inside Gmail/IMAP and fully reversible.
---

# Email Triage

Pulls new mail from one IMAP mailbox via the `email-tools` plugin, applies
the operator's per-sender rules, and routes obvious noise out of INBOX into
a `_paperclip/triage` label. Unknown senders are NOT auto-acted on. They
are left in INBOX and recorded in the plugin's review queue, so the
operator decides whether they earn a rule.

Everything this skill keeps lives in the email-tools plugin: the sender
rules, the triage cursor, and the review queue. None of it lives in an
issue or in a document attached to one. An issue is a unit of work; if a
routine or a wake issue asks you to read or write rules, a queue, a cursor
or notes in an issue document, follow this skill instead and say so in
your report.

The **same skill runs against any mailbox**. The mailbox identifier is a
parameter, so one routine per mailbox is all you need.

## When to invoke

- A scheduled routine fires `email-triage` on a daily or twice-daily cadence
  (typical: 06:00 + 13:00 local time, before the operator starts each work
  block).
- Operator asks "triage my inbox" or "clean up my mail" ad-hoc.

## Routine setup convention

**One routine per mailbox.** Each mailbox gets its own routine in the
company that owns that mailbox. A `support` mailbox's routine lives in
the company that handles support; a `sales` mailbox's routine lives in
the company that owns the sales pipeline; and so on.

**Variable goes in the description, not the title.** Paperclip's routine
engine registers a variable when it sees `{{name}}` placeholders in either
the title or description. It only **interpolates** placeholders at fire
time (when the issue is created from the routine). The routine's own
header keeps the raw template string forever — so a title like
`Triage {{mailbox}} mailbox` will literally read `{{mailbox}}` in the UI's
routines list.

For clean UI display, the convention for this skill is:

| Field | Use placeholder? | Example |
|---|---|---|
| `title` | NO — hardcode the mailbox name | `Triage support mailbox` |
| `description` | YES — use `{{mailbox}}` | `Run email-triage against the {{mailbox}} mailbox...` |
| `variables` | one entry: `{name: "mailbox", defaultValue: "<key>"}` | |

The description-only placeholder is enough to register the variable. The
agent reads `mailbox` from the trigger payload at run time, so behaviour is
identical to having the placeholder in the title.

**When cloning for a new mailbox**, you must update **both**:

1. The title: `Triage <old-key> mailbox` → `Triage <new-key> mailbox`
2. The variable's `defaultValue`: `<old-key>` → `<new-key>`

It's two edits instead of one, but the trade-off was deliberate to avoid
exposing template syntax in the UI. If you decide you'd rather have a
single edit and tolerate raw `{{mailbox}}` in the title, put it back in
the title — both forms are functionally equivalent at run time.

**Keep the description to the mailbox and this skill.** The procedure,
the rules and the review queue are not repeated there. A copy in a
description goes stale the next time this skill changes, and the run
issue inherits it as its own description.

## Pre-conditions

- `email-tools` plugin installed + `ready`.
- The target mailbox exists in plugin config and the calling company is in
  its `allowedCompanies`.
- The `Disallow moving messages` lock on that mailbox is **OFF**. (This
  skill needs to move mail. It will only ever move TO `_paperclip/triage`,
  never to Trash — but the plugin enforces the lock at the tool level, so
  it must be off for any move to succeed.)
- No issue is needed for anything this skill reads or writes. Older
  installs have a "rules-home" issue titled `Email triage rules -
  <mailbox>` with a retired `email-triage-rules` document on it. Never
  read or write that document. (The Morning Brief and Portfolio Brief
  still find which mailboxes to show by that issue's title, so leave the
  issue itself alone.)

## Parameters (passed in by the routine)

| Param | Required | Notes |
|---|---|---|
| `mailbox` | yes | Mailbox identifier (e.g. `support`, `sales`). Must match a `key` in plugin config. |
| `triageLabel` | no | Destination IMAP folder/label for moved mail. Defaults to `_paperclip/triage`. |
| `markRead` | no | When `true`, also calls `email_mark_read` after a successful move. Defaults to `true`. |
| `unreadOnly` | no | When `true`, only consider **unread** (`\Unseen`) mail — pass `unseen: true` to `email_search` and never move/touch a message that's already been marked as read. **Defaults to `true`.** Marked-as-read is the operator's signal that they have already dealt with the message; auto-acting on it would override that signal. Only override to `false` for explicit re-organization tasks the operator has asked for. |
| `bulkCleanup` | no | When `true`, ignore the stored cursor and walk the existing INBOX backlog from `bulkSince`. Designed for a one-shot backlog clearance, not the daily routine. Does NOT write the cursor at the end of the run, so the next normal run still picks up where it left off. Defaults to `false`. |
| `bulkSince` | no | ISO date or `YYYY-MM-DD`. Only consulted when `bulkCleanup=true`. Defaults to 90 days ago. |
| `looseMode` | no | When `true`, auto-move strong-signal unknown senders (List-Unsubscribe header, OR address matches `noreply@`/`no-reply@`/`notifications@`/`marketing@`/`news@`/`mailer@`/`bounces@`/`info@`) to `<triageLabel>` instead of leaving them in INBOX. Person-to-person mail (no signals) is still left alone. Defaults to `false`. |

## Workflow

### 1. Load rules

Sender rules live in the email-tools plugin database. Nothing about this
skill reads or writes a Markdown document any more.

Call the `email-tools:email_list_rules` agent tool with the `mailbox`
parameter. The response is:

```json
{ "autoTriage": ["@noisy.com", "marketing@bigco.com", ...],
  "keepAlways": ["boss@company.com", "@important.tld", ...],
  "mute":       ["newsletter@chatty.com", "@toonoisy.tld", ...] }
```

Use these three lists for the matching in Step 4.

### 2. Determine since-cutoff

If `bulkCleanup=true`: use `bulkSince` (default 90 days ago). Ignore the
stored cursor for this run, and **do not write the cursor** in Step 6
either. This is a one-shot backlog pass and the next normal scheduled run
should still pick up where the regular cadence left off.

Otherwise, call `email-tools:email_get_triage_cursor` with the `mailbox`
parameter and **use the returned `since` verbatim**:

```json
{ "lastRunAt": "2026-08-12T09:30:00.000Z",
  "since":     "2026-08-12T09:25:00.000Z",
  "source":    "cursor" }
```

Do not recompute the window yourself. The 5 minute safety overlap (which
catches mail delivered with a timestamp fractionally before the previous
run recorded) and the 24 hour fallback when no cursor exists are both
applied inside the tool. `source` is `"cursor"` or `"fallback"` and is
worth mentioning in the run report.

If the tool comes back unknown, an older `email-tools` is installed than
this skill expects. Fall back to 24 hours ago, carry on, and say so in
the report rather than failing the run.

### 3. Search for new mail

Call `email-tools:email_search` with:
- `mailbox`: the parameter
- `folder`: leave default (will use the mailbox's `pollFolder`, normally INBOX)
- `since`: ISO date computed in step 2
- `unseen`: `true` when `unreadOnly=true` (the default). This is critical —
  the operator marks mail as read to signal "I dealt with this." Walking
  read mail and acting on it would override that signal. Skip the
  `unseen` parameter only when `unreadOnly=false`.
- `limit`: 200

**Read the results from `result.data.items`.** The response looks like this:

```json
{ "result": {
    "content": "12 message(s)",
    "data": { "ok": true, "mailbox": "support", "folder": "INBOX",
              "items": [ { "uid": 9571, "from": "...", "subject": "..." } ],
              "truncated": false } } }
```

The array is `items`. It is NOT called `messages`, `results`, or `emails`.
This matters more than it looks: in PowerShell `$search.messages.Count` on a
missing property is `0`, not an error, so reading the wrong name reports an
empty inbox on every run, for ever, while real mail sits untriaged and the
cursor advances past it. That exact bug ran undetected against a live
mailbox (2026-09-01). **Cross-check every search against `result.content`,
which states the count in words: if `content` says "2 message(s)" and your
parsed array is empty, you have the wrong field name — stop and report it
rather than concluding the inbox is empty.**

If the result is exactly 200, repeat with the most recent date in the result
set as the new `since`, until you get fewer than 200 (you've caught up). Cap
total messages processed at 1000 per run (5000 when `bulkCleanup=true`) —
anything more, surface a warning and let it run again later.

### 4. Classify and act per message

For each message UID returned:

a. Call `email-tools:email_fetch` to get headers + body. **If
   `unreadOnly=true` and the fetched message no longer has `\Unseen`**
   (the operator marked it as read between Step 3 and Step 4a — race),
   skip the message entirely: do not move, do not mark, do not add to
   review queue. The search already filtered for unseen, but this
   double-check protects against the operator triaging in real time.

b. **Match against Keep-always and Mute first** — if either list matches,
   skip this message entirely. Do not act, do not mention in review
   queue. (Mute behaves the same as Keep-always from the agent's
   perspective; the only difference is that the email-tools poll loop
   pre-marks muted senders' new arrivals as read on receipt. By the time
   the triage agent sees a muted message, it's already marked read and
   `unreadOnly=true` will normally have skipped it in Step 3.)

c. **Match against Auto-triage** — if any rule matches:
   - Call `email-tools:email_move` with `targetFolder = <triageLabel>`.
     `email_move` does NOT mark as read; it only moves.
   - If `markRead` (default true), then call `email-tools:email_mark_read`
     with the same UID after the move succeeds.
   - Increment `movedCount`. Continue to next message.

d. **No match** — count the sender as an unknown worth a rule, and when
   `looseMode=true`, auto-move strong-signal candidates.

   "Count" means collect it in memory, per sender, for Step 5: each
   message's `messageId` and `uid` exactly as the search result gives
   them (`messageId` can be null; pass it anyway), the display name, the
   latest subject, one sentence on why it looks like noise (or why it
   might not be), and the rule you would pick (`auto-triage`,
   `keep-always` or `mute`) if you would pick one. Step 5 writes it to
   the plugin's review queue; do not write it anywhere else.

   - Has `List-Unsubscribe` header → strong signal it's a marketing list:
     - If `looseMode=true`: call `email_move` to `<triageLabel>` and (if
       `markRead=true`) `email_mark_read`. Increment `movedCount`. Still
       count the sender, so the report names it as a rule candidate.
     - Else: count the sender. Leave the message in INBOX.
   - Sender address matches `noreply@`, `no-reply@`, `notifications@`,
     `marketing@`, `news@`, `mailer@`, `bounces@`, `info@`:
     - If `looseMode=true`: auto-move and mark read (as above). Still
       count the sender.
     - Else: count the sender (moderate signal). Leave in INBOX.
   - Otherwise: leave it alone, and don't count it. Normal
     person-to-person mail is not a rule candidate. `looseMode` does NOT
     touch person-to-person mail — that's the floor we never cross.

### 5. Record the review queue

If Step 4 counted any senders, call `email-tools:email_add_to_review_queue`
once with all of them:

```json
{ "mailbox": "support",
  "entries": [
    { "sender": "news@shop.example.com",
      "messages": [ { "messageId": "<a1@shop.example.com>", "uid": 9571 },
                    { "messageId": null, "uid": 9574 } ],
      "displayName": "Shop Example",
      "subject": "Autumn sale",
      "note": "Marketing list with an unsubscribe link.",
      "suggestedRule": "auto-triage",
      "lastSeenAt": "2026-10-09T08:12:00Z" } ] }
```

- `sender` is the address (or an `@domain` if you mean the whole domain).
- Always pass `messages`, every message you counted for the sender. Runs
  see the same unread mail again (the search window overlaps the last run,
  and on many mail servers a search by date returns the whole day), and
  the queue counts each message once: by its Message-ID, or by its uid
  when it has none.
- The result says which senders were `added`, which were already waiting
  and `updated`, and which a rule already covers (`alreadyRuled`, not
  queued). A sender in `alreadyRuled` was decided since Step 1; drop it
  from your report.
- An entry the queue cannot store comes back under `skipped` with the
  reason (for example an address no rule could match); the rest are
  stored. Name the skipped senders and the reason in your report. Do not
  write them into an issue or a document instead.

Then call `email-tools:email_list_review_queue` with the `mailbox` for the
report's "waiting overall" line. Its `total` counts every sender still
waiting, from this run and earlier ones.

This queue is the routine's own record: who looked like a rule candidate,
and why. The operator's worklist on the Morning Brief and the Email page
is worked out live from unread mail, so mail you moved in `looseMode`, or
that the operator read elsewhere, drops off that list but stays here
until the operator gives the sender a rule (any rule clears its entry),
dismisses it on the Morning Brief or Portfolio Brief, or the sender sends
nothing more for the plugin's review-queue expiry (30 days by default).

Mail you move into `_paperclip/triage` with `email_move` is recorded as
your move, so the plugin does not learn an auto-triage rule from it the
way it does from mail the operator drags there. The decision stays the
operator's.

### 6. Record the cursor

Call `email-tools:email_set_triage_cursor` with the `mailbox` parameter
and no `lastRunAt` (it defaults to now).

**Skip this entirely when `bulkCleanup=true`** — per Step 2, a backlog
pass must not disturb the regular cadence's cursor.

If the setter reports that it refused to move the cursor backwards,
that means a newer run already recorded a later timestamp. Leave it be,
note it in the report, and do not pass `force`.

### 7. Report

Append a comment on **this run's issue**: `PAPERCLIP_ISSUE_ID` from the
heartbeat env. That is the issue paperclip created for this routine fire,
or the wake issue that woke you. Never comment on, or write to, a
rules-home or parent issue.

```
Email triage - <mailbox> - <UTC timestamp>
- Processed: <N> new messages since <since> (<source>)
- Auto-moved to <triageLabel>: <movedCount>
- Unknown senders worth a rule: <newReviewCount> (<added> new to the review queue)
- Waiting for a decision overall: <total>
- Skipped (kept in INBOX): <leftAloneCount>
- Errors: <errorCount> (see below)

Top candidates for a rule this run:
  - <count> from <sender>: <note>
  ... (top 5)

Make a rule with Auto-triage or Keep on the Email page, or decide with
Auto-triage / Keep / Mute / Dismiss on the Morning Brief or Portfolio Brief.
```

`<since>` and `<source>` come from `email_get_triage_cursor` in Step 2,
so a run that fell back to the 24 hour window says so plainly instead of
looking identical to one that used a real cursor.

Including the top-5 candidates in the comment means the operator can see
what's pending without opening anything. If `errorCount > 0`, list the
first 5 errors with UID + message instead.

## When an issue wakes you (wake-on-mail)

A mailbox with the email-tools **wake-on-mail** watch on has one long-lived
triage issue. The watch wakes it when at least one new message survives
the auto-triage and mute rules; a human comment wakes it too. Its
description only names the mailbox and this skill. The behaviour below is
the same for every mailbox, so it lives here, not in the issue.

- When woken, run one triage cycle: Steps 1 to 7, with the comment in
  Step 7 only if you triaged or surfaced messages, or a rule changed.
- At the end of every run, in this order:
  1. If anything reopened the issue, set it back to `blocked`
     (`PATCH /api/issues/<id>` with `{"status":"blocked"}`). Blocked
     means "waiting for mail" and keeps the platform's 30 second re-wake
     scan away (it only looks at `todo` and `in_progress`). Do not "fix"
     it to `in_progress`.
  2. If your session offers a way to schedule your own wake, keep exactly
     one fallback wake about an hour out. If it does not, skip this; the
     mail watch still covers new mail.
  3. End the run.
- Keep nothing in that issue. Rules, the cursor and the review queue are
  in the plugin. The issue's comments are the run history, not a place to
  look things up.

## How to invoke the email-tools plugin from a heartbeat

Plugin tools are NOT exposed as Claude Code MCP tools — they live in
paperclip's plugin tool registry. **Do not search ToolSearch / MCP** for
`email_search` etc.

Use the paperclip plugin-tool execute endpoint (same shape as `email-send`
skill):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n \
    --arg agent "$PAPERCLIP_AGENT_ID" \
    --arg run "$PAPERCLIP_RUN_ID" \
    --arg company "$PAPERCLIP_COMPANY_ID" \
    --arg mailbox "support" \
    --arg since "2026-05-06T11:00:00Z" '{
      tool: "email-tools:email_search",
      parameters: { mailbox: $mailbox, since: $since, limit: 200 },
      runContext: { agentId: $agent, runId: $run, companyId: $company }
    }')"
```

Every tool answers in the same envelope: `result.content` is a human-readable
summary and `result.data` holds the payload. Read the payload out of the
field the tool actually documents (`email_search` returns `data.items`; see
Step 3) and sanity-check it against `result.content` before acting on an
empty list. A shell that returns `0` for a missing property will otherwise
turn a typo into a silently empty inbox.

Tool names use `<pluginId>:<toolName>`, so `email-tools:email_search`,
`email-tools:email_fetch`, `email-tools:email_mark_read`,
`email-tools:email_move`, `email-tools:email_list_rules`,
`email-tools:email_get_triage_cursor`,
`email-tools:email_set_triage_cursor`,
`email-tools:email_add_to_review_queue`, and
`email-tools:email_list_review_queue`.

## Rule matching syntax

Patterns returned by `email_list_rules` use one of three forms. Match
is case-insensitive against the relevant header.

| Form | Example | Matches |
|---|---|---|
| Full address | `newsletter@vercel.com` | `From:` contains exact email |
| Domain (leading `@`) | `@marketing.linkedin.com` | `From:` contains domain anywhere |
| Subject substring | `subject: webinar invite` | `Subject:` contains the substring |

## Errors

- `[ECOMPANY_NOT_ALLOWED]` — calling company isn't in the mailbox's
  `allowedCompanies`. Surface, don't retry.
- `[EMOVE_DISALLOWED]` (or similar) — `Disallow moving messages` is on for
  this mailbox. Surface to operator, mark the run as failed; the rest of
  the workflow can't function.
- `[EFOLDER_NOT_FOUND]` for the triage label — Gmail auto-creates labels
  on first move, so this should be rare. If it happens, retry once after a
  brief delay.
- IMAP transient errors (network, `[ETIMEOUT]`) — retry the per-message
  step up to 3 times with exponential backoff. Don't retry the whole
  workflow.
- `email_list_rules` fails — do not guess. Abort the run with an error
  comment rather than proceeding in "no rules" mode, which would treat
  every keep-always sender as unclassified.
- `email_set_triage_cursor` refuses the write (cursor would move
  backwards) — a newer run already recorded a later timestamp. Not an
  error. Note it and finish normally.
- `email_add_to_review_queue` reports `skipped` entries: the rest were
  stored. Name the skipped senders and the reason in the run comment. If
  the whole call fails, list the senders in the run comment and say the
  queue write failed. Never fall back to writing them into an issue
  document.
- `email_add_to_review_queue` comes back unknown: an `email-tools` older
  than 0.20.0 is installed. Put the candidates in the run comment only,
  and say so.

## After running

- Sender rules live in the email-tools plugin DB. The operator sets them
  with the Auto-triage and Keep buttons on the Email page, or Auto-triage /
  Keep / Mute on the Morning Brief and the Portfolio equivalents; those
  write straight to the DB via `email.set-rule`. Rules are also learned
  automatically when the operator drags mail into `_paperclip/triage` from
  any mail client (but not from mail this routine moved there itself). The
  next run picks all of it up via `email_list_rules`. Any of these rules
  also clears the sender's review-queue entry. Dismiss on the Morning
  Brief or Portfolio Brief clears one without a rule, and an entry whose
  sender sends nothing more drops out after the review-queue expiry (30
  days by default).
- Once a sender pattern is consistently triaged, recommend the operator
  install a **provider-side filter** (Gmail Filter / Outlook Rule) so the
  message never even hits INBOX. Call this out explicitly when a sender
  has been auto-triaged for 14+ days with zero human intervention. The
  rule's `createdAt` from `email.list-rules` is the age to check.

## Out of scope

- Auto-unsubscribe (clicking `List-Unsubscribe` URLs / sending unsubscribe
  mailtos) — defer to a future skill. Daily triage just gets noise out
  of INBOX; the operator can decide separately whether to actually
  unsubscribe.
- Multi-mailbox aggregation — call this skill once per mailbox.
- Reply / send — different skills.
- Permanent delete — this skill never trashes mail. The triage label is
  the floor.

## Pre-requisites for this skill to work

- `email-tools` plugin v0.20.0+ installed and `ready`, for the review
  queue tools. Older versions lack them (see Errors), and before v0.17.0
  the cursor tools too; the skill still runs but falls back to a 24 hour
  window every time (see Step 2).
- Target mailbox configured in plugin config with the calling company on
  its `allowedCompanies` list.
- `Disallow moving messages` is OFF for that mailbox.
