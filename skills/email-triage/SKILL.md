---
name: email-triage
description: Triage new mail in an IMAP mailbox — apply learned per-sender rules (auto-mark-read + move to a `_paperclip/triage` label) and surface unknown senders for the operator to review weekly. Designed to run autonomously on a daily or twice-daily schedule before the operator starts work, so the inbox is clean by the time they sit down. Reusable across any mailbox configured in the email-tools plugin — pass the mailbox identifier as `mailbox` in the routine. Conservative by default — never deletes mail, only moves to a label that's still inside Gmail/IMAP and fully reversible.
---

# Email Triage

Pulls new mail from one IMAP mailbox via the `email-tools` plugin, applies
the operator's per-sender rules, and routes obvious noise out of INBOX into
a `_paperclip/triage` label. Unknown senders are NOT auto-acted on — they
are left in INBOX and reported, so the operator decides whether they earn
a rule.

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

## Pre-conditions

- `email-tools` plugin installed + `ready`.
- The target mailbox exists in plugin config and the calling company is in
  its `allowedCompanies`.
- The `Disallow moving messages` lock on that mailbox is **OFF**. (This
  skill needs to move mail. It will only ever move TO `_paperclip/triage`,
  never to Trash — but the plugin enforces the lock at the tool level, so
  it must be off for any move to succeed.)
- A **rules-home issue** in the routine's company, with the routine's
  `parentIssueId` pointing at it. This is **no longer where anything is
  stored** (rules are in the plugin database, the cursor is in plugin
  state). Keep it anyway for two reasons: the Morning Brief and Portfolio
  Brief discover which mailboxes to show by listing issues whose title
  starts with `Email triage rules - `, and the skill needs the issue ID
  once to tombstone the retired document (step 5b).
  - Convention: rules-home issue title = `Email triage rules - <mailbox>`.
  - Discovery: agent reads the routine via `GET /api/routines/<routineId>`
    and uses `parentIssueId` as the rules-home issue ID. If
    `parentIssueId` is null, skip step 5b and carry on. Triage itself does
    not depend on it.

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

Separately, resolve the rules-home issue ID. It is not needed for triage,
only for the one-shot tombstone in step 5b, so a null value is not an
error:

```bash
PARENT_ID=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/routines/$ROUTINE_ID" \
  | jq -r '.parentIssueId')
```

### 2. Determine since-cutoff

If `bulkCleanup=true`: use `bulkSince` (default 90 days ago). Ignore the
stored cursor for this run, and **do not write the cursor** in Step 5
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

   "Count" here means tally it in memory for the run report in Step 6.
   There is nowhere to write it: the operator's actual worklist is
   computed live by the Morning Brief and the Email page from unread mail
   minus ruled senders, so it already includes everything you would have
   written down and stays correct after they act on it.

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

### 5. Record the cursor

Call `email-tools:email_set_triage_cursor` with the `mailbox` parameter
and no `lastRunAt` (it defaults to now).

**Skip this entirely when `bulkCleanup=true`** — per Step 2, a backlog
pass must not disturb the regular cadence's cursor.

That is the whole step. Do not write any document. The review queue is
not stored anywhere: the Morning Brief and the Email page compute it live
from unread mail minus senders already covered by a rule, so writing a
copy would only create something that can go stale and disagree with what
the operator sees.

If the setter reports that it refused to move the cursor backwards,
that means a newer run already recorded a later timestamp. Leave it be,
note it in the report, and do not pass `force`.

### 5b. Tombstone the retired rules document (one-time)

Older installs still have a `email-triage-rules` document on the
rules-home issue holding stale sender lists that contradict the database.
Retire it once, then never touch it again.

Skip this step entirely if `PARENT_ID` from Step 1 is null/empty.

Fetch `GET /api/issues/<PARENT_ID>/documents/email-triage-rules`. On 404,
do nothing (nothing to retire). If it exists and its body already
contains `<!-- retired:email-triage-rules -->`, do nothing.

Otherwise `PUT` it back with this body, plus a `changeSummary` of
"Retired: rules moved to the email-tools database":

```markdown
<!-- retired:email-triage-rules -->

# Retired

This document no longer holds anything.

- **Sender rules** live in the email-tools plugin database. Manage them
  with the Auto-triage / Keep / Mute buttons on the Email page or the
  Morning Brief.
- **The triage cursor** lives in plugin state, read and written by
  `email_get_triage_cursor` / `email_set_triage_cursor`.
- **The review queue** is computed live from unread mail minus ruled
  senders, so there is nothing to store.

Previous contents remain in this document's revision history.
```

Do not attempt to DELETE the document. That route requires board auth and
an agent does not have it.

### 6. Report

Append a comment on **this run's issue** (the issue paperclip auto-created
for this routine fire — NOT the rules-home / parent issue). Use
`PAPERCLIP_ISSUE_ID` from the heartbeat env, not the parent issue ID.

```
Email triage - <mailbox> - <UTC timestamp>
- Processed: <N> new messages since <since> (<source>)
- Auto-moved to <triageLabel>: <movedCount>
- Unknown senders worth a rule: <newReviewCount>
- Skipped (kept in INBOX): <leftAloneCount>
- Errors: <errorCount> (see below)

Top candidates for a rule this run:
  - <count> from <sender>
  - <count> from <sender>
  ... (top 5)

Set rules with the Auto-triage / Keep / Mute buttons on the Email page
or the Morning Brief.
```

`<since>` and `<source>` come from `email_get_triage_cursor` in Step 2,
so a run that fell back to the 24 hour window says so plainly instead of
looking identical to one that used a real cursor.

Including the top-5 candidates in the comment means the operator can see
what's pending without opening anything. If `errorCount > 0`, list the
first 5 errors with UID + message instead.

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

Tool names use `<pluginId>:<toolName>` — so `email-tools:email_search`,
`email-tools:email_fetch`, `email-tools:email_mark_read`,
`email-tools:email_move`, `email-tools:email_list_rules`,
`email-tools:email_get_triage_cursor`, and
`email-tools:email_set_triage_cursor`.

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

## After running

- Sender rules live in the email-tools plugin DB. The operator sets them
  with the Auto-triage / Keep / Mute buttons on the Email page, the
  Morning Brief, or the Portfolio equivalents; those write straight to the
  DB via `email.set-rule`. Rules are also learned automatically when the
  operator drags mail into `_paperclip/triage` from any mail client. The
  next run picks all of it up via `email_list_rules`.
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

- `email-tools` plugin v0.17.0+ installed and `ready`. Older versions lack
  the cursor tools; the skill still runs but falls back to a 24 hour
  window every time (see Step 2).
- Target mailbox configured in plugin config with the calling company on
  its `allowedCompanies` list.
- `Disallow moving messages` is OFF for that mailbox.
- A rules-home issue in the same company with the routine's
  `parentIssueId` pointing at it. Optional for triage itself; it is the
  Briefs' mailbox registry and the target for the one-time tombstone.
