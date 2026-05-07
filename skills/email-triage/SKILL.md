---
name: email-triage
description: Triage new mail in an IMAP mailbox — apply learned per-sender rules (auto-mark-read + move to a `_paperclip/triage` label) and surface unknown senders for the operator to review weekly. Designed to run autonomously on a daily or twice-daily schedule before the operator starts work, so the inbox is clean by the time they sit down. Reusable across any mailbox configured in the email-tools plugin — pass the mailbox identifier as `mailbox` in the routine. Conservative by default — never deletes mail, only moves to a label that's still inside Gmail/IMAP and fully reversible.
---

# Email Triage

Pulls new mail from one IMAP mailbox via the `email-tools` plugin, applies
the operator's per-sender rules, and routes obvious noise out of INBOX into
a `_paperclip/triage` label. Unknown senders are NOT auto-acted on — they
land in a review queue for the operator to confirm.

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
- A **rules-home issue** exists in the routine's company, with the
  routine's `parentIssueId` pointing at it. The rules-home issue holds a
  Markdown document (key: `email-triage-rules`) that contains the
  Auto-triage / Keep-always / Review queue sections. The operator edits
  this document in the Paperclip UI to graduate senders.
  - Convention: rules-home issue title = `Email triage rules - <mailbox>`.
  - Discovery: agent reads the routine via `GET /api/routines/<routineId>`
    and uses `parentIssueId` as the rules-home issue ID. If
    `parentIssueId` is null, the skill aborts with a clear error and asks
    the operator to create a rules-home issue and link it.

## Parameters (passed in by the routine)

| Param | Required | Notes |
|---|---|---|
| `mailbox` | yes | Mailbox identifier (e.g. `support`, `sales`). Must match a `key` in plugin config. |
| `triageLabel` | no | Destination IMAP folder/label for moved mail. Defaults to `_paperclip/triage`. |
| `markRead` | no | When `true`, also calls `email_mark_read` after a successful move. Defaults to `true`. |

## Workflow

### 1. Load rules

a. Resolve the rules-home issue:

```bash
PARENT_ID=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/routines/$ROUTINE_ID" \
  | jq -r '.parentIssueId')
```

If `PARENT_ID` is null/empty, abort with an error comment on the run
issue: "No rules-home issue linked. Set the routine's parentIssueId to
an issue holding the email-triage-rules document."

b. Read the document:

```bash
DOC=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/issues/$PARENT_ID/documents/email-triage-rules")
```

If the document doesn't exist (HTTP 404), seed it with the empty
template below using `PUT` (same endpoint):

```markdown
# Email triage rules — mailbox: <mailbox>

last-run:

## Auto-triage senders

<!-- One sender per line. Match is case-insensitive substring of From:. -->
<!-- Forms:                                                                -->
<!--   newsletter@example.com   — full email match                         -->
<!--   @marketing.example.com   — domain anywhere in From                  -->
<!--   subject: webinar invite  — Subject substring match instead          -->

## Keep-always senders

<!-- Same syntax. Beats Auto-triage if both match. -->

## Review queue

<!-- Auto-populated by this skill. One line per sender:
     `<count> messages from <sender>`.
     Graduate entries by moving them into Auto-triage or Keep-always above,
     then delete the line here. -->
```

Parse the three sections into in-memory lists.

### 2. Determine since-cutoff

If `last-run` is set and parseable: use it (minus a 5-minute safety overlap
to catch races with delivery latency).

If not: default to 24 hours ago.

### 3. Search for new mail

Call `email-tools:email_search` with:
- `mailbox`: the parameter
- `folder`: leave default (will use the mailbox's `pollFolder`, normally INBOX)
- `since`: ISO date computed in step 2
- `limit`: 200

If the result is exactly 200, repeat with the most recent date in the result
set as the new `since`, until you get fewer than 200 (you've caught up). Cap
total messages processed at 1000 per run — anything more, surface a warning
and let it run again later.

### 4. Classify and act per message

For each message UID returned:

a. Call `email-tools:email_fetch` to get headers + body.

b. **Match against Keep-always first** — if any rule matches, skip this
   message entirely. Do not act, do not mention in review queue.

c. **Match against Auto-triage** — if any rule matches:
   - Call `email-tools:email_move` with `targetFolder = <triageLabel>`.
     `email_move` does NOT mark as read; it only moves.
   - If `markRead` (default true), then call `email-tools:email_mark_read`
     with the same UID after the move succeeds.
   - Increment `movedCount`. Continue to next message.

d. **No match** — only surface to review queue if it looks like a
   triage candidate, otherwise leave alone:
   - Has `List-Unsubscribe` header → strong signal it's a marketing list →
     add sender to review queue (with count).
   - Sender domain matches `noreply@`, `no-reply@`, `notifications@`,
     `marketing@`, `news@`, `mailer@`, `bounces@`, `info@` → moderate
     signal → add sender to review queue.
   - Otherwise: leave it alone. Don't pollute the review queue with normal
     person-to-person mail.

### 5. Update rules document

- Set `last-run:` to current UTC ISO timestamp.
- For each entry in the review queue this run, **merge** with the existing
  Review queue section: if the same sender is already there, increment
  the count; otherwise add a new line.
- Don't touch Auto-triage or Keep-always sections — those are
  human-edited.
- Save back via `PUT /api/issues/<PARENT_ID>/documents/email-triage-rules`
  with body `{ title, format: "markdown", body: <new-markdown> }`.

### 6. Report

Append a comment on **this run's issue** (the issue paperclip auto-created
for this routine fire — NOT the rules-home / parent issue). Use
`PAPERCLIP_ISSUE_ID` from the heartbeat env, not the parent issue ID.

```
Email triage — <mailbox> — <UTC timestamp>
- Processed: <N> new messages since <last-run>
- Auto-moved to <triageLabel>: <movedCount>
- New senders surfaced to review queue: <newReviewCount>
- Skipped (kept in INBOX): <leftAloneCount>
- Errors: <errorCount> (see below)

Top review-queue candidates this run:
  - <count> from <sender>
  - <count> from <sender>
  ... (top 5)

Review and graduate senders in the rules document on issue <PARENT_ID>.
```

Including the top-5 review-queue candidates in the comment means the
operator can see what's pending without opening anything. If
`errorCount > 0`, list the first 5 errors with UID + message instead.

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

Tool names use `<pluginId>:<toolName>` — so `email-tools:email_search`,
`email-tools:email_fetch`, `email-tools:email_mark_read`,
`email-tools:email_move`.

## Rule matching syntax (in the rules document)

Lines under `## Auto-triage senders` and `## Keep-always senders` use one
of three forms. Match is case-insensitive, substring of the relevant
header.

| Form | Example | Matches |
|---|---|---|
| Full address | `newsletter@vercel.com` | `From:` contains exact email |
| Domain (leading `@`) | `@marketing.linkedin.com` | `From:` contains domain anywhere |
| Subject substring | `subject: webinar invite` | `Subject:` contains the substring |

Comments (lines starting with `<!--` and `#`) are ignored.

Empty lines are ignored.

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
- Rules document parse error — fall back to "no rules" mode (act on
  nothing, add everything triage-eligible to review queue), and surface a
  comment warning the operator that the rules document needs cleanup.
- Rules document missing (404) — auto-create with the empty template via
  `PUT`, treat as no rules for this run.

## After running

- The rules document on the rules-home issue is the source of truth.
  Operator graduates entries from Review queue → Auto-triage or
  Keep-always by editing the document directly in the Paperclip UI.
  Next run picks up the new rules automatically.
- Once a sender pattern is consistently triaged, recommend the operator
  install a **provider-side filter** (Gmail Filter / Outlook Rule) so the
  message never even hits INBOX. Skill output should call this out
  explicitly when a sender has been auto-triaged for 14+ days with zero
  human intervention. (Implementation: walk the Auto-triage section, look
  at the `last-run` timestamps stored alongside each rule once the
  operator starts adding them.)

## Out of scope

- Bulk historical cleanup of an existing INBOX backlog. This skill only
  acts on mail that has arrived since `last-run`; it does not walk the
  full mailbox history. A backlog cleanup is a one-shot operation,
  better handled with provider-side filters or a separate bulk-cleanup
  skill.
- Auto-unsubscribe (clicking `List-Unsubscribe` URLs / sending unsubscribe
  mailtos) — defer to a future skill. Daily triage just gets noise out
  of INBOX; the operator can decide separately whether to actually
  unsubscribe.
- Multi-mailbox aggregation — call this skill once per mailbox.
- Reply / send — different skills.
- Permanent delete — this skill never trashes mail. The triage label is
  the floor.

## Pre-requisites for this skill to work

- `email-tools` plugin v0.5.0+ installed and `ready`.
- Target mailbox configured in plugin config with the calling company on
  its `allowedCompanies` list.
- `Disallow moving messages` is OFF for that mailbox.
- A rules-home issue exists in the same company, with the
  `email-triage-rules` document present (or missing, in which case the
  skill auto-creates it from the empty template).
- The routine's `parentIssueId` is set to the rules-home issue's ID.
