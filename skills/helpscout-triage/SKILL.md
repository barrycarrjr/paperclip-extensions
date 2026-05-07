---
name: helpscout-triage
description: Triage new conversations in a Help Scout mailbox — apply learned per-sender / per-subject rules to auto-tag and auto-close infrastructure noise (Rollbar alerts, GoDaddy renewals, system notifications), surfacing only the rare human-customer messages for review. Designed to run autonomously on a daily or twice-daily schedule. Reusable across any Help Scout mailbox configured in the help-scout plugin — pass the mailbox identifier as `mailbox` in the routine. Conservative by default — never deletes conversations, only changes status to "closed" and adds tags, both fully reversible from the Help Scout UI.
---

# Help Scout Triage

Pulls new conversations from one Help Scout mailbox via the `help-scout`
plugin, applies the operator's per-sender / per-subject rules, and silences
machine-generated noise by tagging + closing the conversation. Real human
messages are NOT auto-acted on — they stay in the active queue for the
operator (or a support agent) to review.

The **same skill runs against any Help Scout mailbox**. The mailbox
identifier is a parameter, so one routine per mailbox is all you need.

## When to invoke

- A scheduled routine fires `helpscout-triage` on a daily or multi-daily
  cadence (typical: 4x during work hours so noise doesn't pile up).
- Operator asks "triage my Help Scout" or "clean up the support queue"
  ad-hoc.

## Routine setup convention

Same convention as `email-triage`:

| Field | Use placeholder? | Example |
|---|---|---|
| `title` | NO — hardcode the mailbox name | `Triage support Help Scout` |
| `description` | YES — use `{{mailbox}}` | `Run helpscout-triage against the {{mailbox}} mailbox...` |
| `variables` | one entry: `{name: "mailbox", defaultValue: "<key>"}` | |
| `parentIssueId` | the rules-home issue ID for this mailbox | |

Hardcoding the title keeps the placeholder syntax out of the UI listing.
When cloning for a new mailbox, update both the title text and the
variable's `defaultValue`.

## Pre-conditions

- `help-scout` plugin installed + `ready`.
- The target Help Scout account is configured in plugin config with the
  calling company in `allowedCompanies`. `allowMutations` must be true
  (the skill needs to tag and change status).
- A **rules-home issue** exists in the routine's company, with
  `routine.parentIssueId` pointing at it. The rules-home issue holds a
  Markdown document (key: `helpscout-triage-rules`) containing the
  Auto-noise / Keep-active / Review queue sections.

## Parameters (passed in by the routine)

| Param | Required | Notes |
|---|---|---|
| `mailbox` | yes | Help Scout mailbox identifier — the `key` in plugin config (NOT the numeric Help Scout mailboxId). |
| `noiseTag` | no | Tag added to auto-handled conversations. Defaults to `infra-noise`. |
| `closeStatus` | no | Status to set on auto-handled conversations. Defaults to `closed`. Use `spam` if you want them filtered server-side. |

## Workflow

### 1. Load rules

a. Resolve the rules-home issue:

```bash
PARENT_ID=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/routines/$ROUTINE_ID" \
  | jq -r '.parentIssueId')
```

If null/empty, abort with an error comment on the run issue.

b. Read the document:

```bash
DOC=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/issues/$PARENT_ID/documents/helpscout-triage-rules")
```

If 404, seed with the empty template (see "Document template" below) via
`PUT /api/issues/<PARENT_ID>/documents/helpscout-triage-rules`.

Parse the three sections into in-memory lists.

### 2. Determine since-cutoff

If `last-run` is set and parseable: use it (minus a 5-minute safety
overlap). Otherwise default to 24 hours ago.

### 3. Search for new conversations

Call `help-scout:helpscout_find_conversation` with:
- `mailbox`: the mailbox parameter (mapped to `mailboxId` if the plugin
  supports key-to-ID resolution; otherwise the operator must pass the
  numeric ID via plugin config).
- `status: "active"` — only currently-active conversations are eligible
  for triage. The skill never reopens closed/spam.
- `since`: ISO timestamp from step 2.
- `limit: 50` (Help Scout's max per page).
- Paginate via `page` until results are empty or you hit the per-run cap
  (default 500 conversations; surface a warning if hit).

### 4. Classify and act per conversation

For each conversation returned:

a. Get the full conversation if needed (`helpscout_get_conversation` with
   `embed: "threads"` for body content). Most rules can match on the
   metadata returned by find — only fetch when a rule needs body content.

b. **Match against Keep-active first** — if any rule matches, skip this
   conversation. Do not act, do not mention in review queue.

c. **Match against Auto-noise** — if any rule matches:
   - Call `help-scout:helpscout_add_label` with
     `labels: ["<noiseTag>", "<rule-name-or-category>"]` to tag.
   - Call `help-scout:helpscout_change_status` with
     `status: "<closeStatus>"` (default `closed`).
   - Increment `closedCount`. Continue to next.

d. **No match** — only surface to review queue if it looks like a
   triage candidate, otherwise leave alone:
   - Sender domain is in known-noise pattern list (e.g. `@*.notifications`,
     `noreply@`, `no-reply@`, `mailer@`) → add to review queue.
   - Subject contains noise-y keywords (`Daily Summary`, `Renewal Notice`,
     `Service Alert`, `[error]`, `[notification]`) → add to review queue.
   - Otherwise: leave it alone. Person-to-person conversations stay in
     the active queue, untouched.

### 5. Update rules document

- Set `last-run:` to current UTC ISO timestamp.
- Merge new review-queue entries with existing.
- Don't touch Auto-noise or Keep-active — those are human-edited.
- Save back via `PUT /api/issues/<PARENT_ID>/documents/helpscout-triage-rules`.

### 6. Report

Append a comment on **this run's issue** (NOT the rules-home / parent
issue). Use `PAPERCLIP_ISSUE_ID` from the heartbeat env.

```
Help Scout triage — <mailbox> — <UTC timestamp>
- Processed: <N> active conversations since <last-run>
- Auto-closed (tagged <noiseTag>): <closedCount>
- New senders surfaced to review queue: <newReviewCount>
- Skipped (kept active): <leftAloneCount>
- Errors: <errorCount> (see below)

Top review-queue candidates this run:
  - <count> from <sender> (subject pattern: <example>)
  ... (top 5)

Review and graduate senders in the rules document on issue <PARENT_ID>.
```

If `errorCount > 0`, list the first 5 errors instead.

## Document template (for first-run seed)

```markdown
# Help Scout triage rules — mailbox: <mailbox>

last-run:

## Auto-noise senders / subjects

<!-- One rule per line. Match is case-insensitive substring. -->
<!-- Forms: -->
<!--   noreply@example.com           — full email match against From -->
<!--   @rollbar.com                  — domain anywhere in From -->
<!--   subject: Daily Summary        — Subject substring -->
<!--   sender: Rollbar Notification  — display-name match against From -->

## Keep-active senders / subjects

<!-- Same syntax. Beats Auto-noise if both match. Use for senders that
     LOOK like noise but you actually want to see (e.g. an internal team
     member whose alerts you read). -->

## Review queue

<!-- Auto-populated by this skill. One line per sender:
     `<count> conversations from <sender> — example subject: "<subj>"`.
     Graduate entries by moving them into Auto-noise or Keep-active
     above, then delete the line here. -->
```

## Rule matching syntax

Lines under `## Auto-noise` and `## Keep-active` use one of four forms.
Match is case-insensitive, substring of the relevant field.

| Form | Example | Matches |
|---|---|---|
| Full email | `noreply@rollbar.com` | `From:` email contains exact address |
| Domain (leading `@`) | `@rollbar.com` | `From:` email contains domain anywhere |
| Sender display name | `sender: Rollbar Notification` | `From:` display name contains substring |
| Subject substring | `subject: Daily Summary` | `Subject:` contains substring |

Comments (lines starting with `<!--` and `#`) are ignored. Empty lines
are ignored.

## How to invoke the help-scout plugin from a heartbeat

Plugin tools are NOT exposed as Claude Code MCP tools — they live in
paperclip's plugin tool registry.

Use the plugin-tool execute endpoint (same shape as other plugin skills):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n \
    --arg agent "$PAPERCLIP_AGENT_ID" \
    --arg run "$PAPERCLIP_RUN_ID" \
    --arg company "$PAPERCLIP_COMPANY_ID" \
    --arg mailbox "<mailbox-key>" \
    --arg since "2026-05-06T11:00:00Z" '{
      tool: "help-scout:helpscout_find_conversation",
      parameters: { mailbox: $mailbox, status: "active", since: $since, limit: 50 },
      runContext: { agentId: $agent, runId: $run, companyId: $company }
    }')"
```

Tool names use `<pluginId>:<toolName>` — so:
- `help-scout:helpscout_find_conversation`
- `help-scout:helpscout_get_conversation`
- `help-scout:helpscout_add_label`
- `help-scout:helpscout_change_status`

## Errors

- `[ECOMPANY_NOT_ALLOWED]` — calling company isn't in the help-scout
  account's `allowedCompanies`. Surface, don't retry.
- `[EMUTATIONS_DISALLOWED]` (or similar) — `allowMutations` is off for
  the account. Surface; the skill can't function.
- `[EHELPSCOUT_AUTH]` — PAT expired/invalid. Surface for operator to
  rotate the secret.
- `[EHELPSCOUT_RATE_LIMIT]` — back off; Help Scout caps at 400 req/min.
  Resume next run.
- Rules document parse error — fall back to "no rules" mode, surface a
  warning.
- Rules document missing (404) — auto-create from template, treat as no
  rules for this run.

## After running

- The rules document on the rules-home issue is the source of truth.
  Operator graduates entries from Review queue → Auto-noise or
  Keep-active by editing the document directly in the Paperclip UI.
- Once a sender pattern is consistently auto-closed, recommend the
  operator install a **Help Scout workflow** (Help Scout's own filter
  engine) so the conversation is tagged and closed at delivery time —
  cheaper than running this skill against it on each cycle.

## Out of scope

- Bulk historical cleanup of an existing closed-conversation backlog.
  This skill only acts on conversations modified since `last-run`.
- Auto-replying to customers — different skill (`helpscout-respond` or
  similar). This skill never sends replies.
- Reopening or moving between mailboxes.
- Permanent delete — Help Scout doesn't expose hard-delete via API and
  this skill wouldn't use it anyway.

## Pre-requisites

- `help-scout` plugin v0.2.0+ installed and `ready`.
- Help Scout PAT issued and stored as a paperclip secret.
- At least one Help Scout account configured in plugin config with the
  calling company in `allowedCompanies`, `allowMutations: true`, and
  `defaultMailbox` (or explicit `mailboxId` per call) set.
- A rules-home issue exists in the same company, linked via
  `routine.parentIssueId`.
