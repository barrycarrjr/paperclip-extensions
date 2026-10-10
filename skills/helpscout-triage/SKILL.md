---
name: helpscout-triage
description: Triage new conversations in a Help Scout mailbox — apply the operator's per-sender / per-subject rules (held in the help-scout plugin database) to auto-tag and auto-close infrastructure noise (Rollbar alerts, GoDaddy renewals, system notifications), surfacing only the rare human-customer messages for review. Designed to run autonomously on a daily or twice-daily schedule. Reusable across any Help Scout mailbox configured in the help-scout plugin — pass the mailbox identifier as `mailbox` in the routine. Conservative by default — never deletes conversations, only changes status to "closed" and adds tags, both fully reversible from the Help Scout UI.
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

Hardcoding the title keeps the placeholder syntax out of the UI listing.
When cloning for a new mailbox, update both the title text and the
variable's `defaultValue`.

Keep the description to the account and this skill. The procedure and the
rules are not repeated there: a copy goes stale the next time this skill
changes, and the run issue inherits it as its own description.

## Pre-conditions

- `help-scout` plugin installed + `ready`.
- The target Help Scout account is configured in plugin config with the
  calling company in `allowedCompanies`. `allowMutations` must be true
  (the skill needs to tag and change status).
- `help-scout` plugin v0.6.0+, which is where triage rules live. Older
  versions kept them in a Markdown document.
- No issue is needed for anything this skill reads or writes. Rules and
  the cursor are in the help-scout plugin. Older installs have a
  "rules-home" issue titled `Help Scout triage rules - <account>` with a
  retired `helpscout-triage-rules` document on it; never read or write
  that document.

## Parameters (passed in by the routine)

| Param | Required | Notes |
|---|---|---|
| `mailbox` | yes | Plugin **account key** from help-scout config (e.g. `industry-bureau`, `support`). Despite the variable name, this is the plugin account identifier — it maps to the `account` parameter on every help-scout tool call, NOT to `mailboxId`. The variable was named `mailbox` for operator readability and is kept that way for compatibility. |
| `mailboxId` | no | Optional — numeric Help Scout mailbox ID inside the account, only needed if the account hosts multiple mailboxes and you want to scope this routine to one. If omitted, the plugin falls back to the account's `defaultMailbox`. |
| `noiseTag` | no | Tag added to auto-handled conversations. Defaults to `infra-noise`. |
| `closeStatus` | no | Status to set on auto-handled conversations. Defaults to `closed`. Use `spam` if you want them filtered server-side. |

> **Plugin parameter names** — every help-scout tool accepts `account` (account key) and `mailboxId` (numeric Help Scout ID). It does NOT accept `mailbox`. If you pass `mailbox`, the plugin silently drops it and falls back to `defaultAccount` / `defaultMailbox`, which can produce false-empty results if the defaults are wrong. Always map this skill's `mailbox` variable to the tool's `account` parameter.

## Workflow

### 1. Load rules

Rules live in the help-scout plugin database. Do not read or parse a
Markdown document for them.

Call `help-scout:helpscout_list_rules` with `account` (this skill's
`mailbox` variable) and, if the routine is scoped to one, `mailboxId`.
The response is:

```json
{ "autoNoise":  ["@statuspage.io", "subject: Daily Summary", ...],
  "keepActive": ["boss@acme.com", "sender: On-call Rotation", ...] }
```

Use these two lists for the matching in Step 5. Keep-active is evaluated
first and wins.

<!-- Step 1b, the one-time lift of a helpscout-triage-rules document into
the database, is retired: the live instance's documents were imported and
tombstoned in August 2026. The helpscout.import-rules plugin action still
exists for an install that has one left. -->

### 2. Determine since-cutoff

Call `help-scout:helpscout_get_triage_cursor` with the same `account`
(and `mailboxId`, if scoped) and **use the returned `since` verbatim**:

```json
{ "lastRunAt": "2026-08-11T06:00:00.000Z",
  "since":     "2026-08-11T05:55:00.000Z",
  "source":    "cursor" }
```

Do not recompute the window. The 5 minute safety overlap and the 24 hour
fallback are applied inside the tool. `source` is `"cursor"` or
`"fallback"` and is worth naming in the run report.

If the tool comes back unknown, an older `help-scout` is installed than
this skill expects. Fall back to 24 hours ago, carry on, and say so.

### 3. Verify credentials see the mailbox

**Before** searching, call `help-scout:helpscout_list_mailboxes` with
`account: <skill's mailbox variable>`. Inspect the response:

- `data.mailboxes.length === 0` — credentials are scoped wrong (no
  mailbox membership, missing scopes, or auth'd against the wrong Help
  Scout install). **Abort the run** with an error comment tagged
  `[ECREDENTIAL_NO_MAILBOXES]` on the run issue. Do NOT proceed to
  search/classify — a successful zero-mailbox call would feed the
  next steps a false-empty queue and the agent would silently report
  "all clean" when the real problem is broken credentials. Surface the
  error so the operator can re-authorize the OAuth app.
- `data.mailboxes.length >= 1` — credentials are good, proceed.

### 4. Search for new conversations

Call `help-scout:helpscout_find_conversation` with:
- `account`: the **account key** (the skill's `mailbox` variable —
  re-emphasizing because the parameter name on the tool is `account`,
  not `mailbox`).
- `mailboxId` (optional): if the routine has the optional `mailboxId`
  variable set, pass it here. Otherwise omit and the plugin uses the
  account's `defaultMailbox`.
- `status: "active"` — only currently-active conversations are eligible
  for triage. The skill never reopens closed/spam.
- `since`: ISO timestamp from step 2.
- `limit: 50` (Help Scout's max per page).
- Paginate via `page` until results are empty or you hit the per-run cap
  (default 500 conversations; surface a warning if hit).

If `data.totalCount === 0` AND the queue genuinely had activity (you can
sanity-check by glancing at the Help Scout UI), the credentials likely
allow `list_mailboxes` but lack scope for `/conversations`. Surface
`[ECREDENTIAL_INSUFFICIENT_SCOPE]` on the run issue.

### 5. Classify and act per conversation

For each conversation returned:

a. Get the full conversation if needed (`helpscout_get_conversation` with
   `embed: "threads"` for body content). Most rules can match on the
   metadata returned by find — only fetch when a rule needs body content.

b. **Match against Keep-active first** — if any rule matches, skip this
   conversation. Do not act, do not count it as a rule candidate.

c. **Match against Auto-noise** — if any rule matches:
   - Call `help-scout:helpscout_add_label` with
     `labels: ["<noiseTag>", "<rule-name-or-category>"]` to tag.
   - Call `help-scout:helpscout_change_status` with
     `status: "<closeStatus>"` (default `closed`).
   - Increment `closedCount`. Continue to next.

d. **No match** — count it as a rule candidate if it looks like one,
   otherwise leave it alone entirely.

   "Count" means tally it in memory for the run report in Step 7. Do not
   store it anywhere, least of all in an issue or a document: a
   conversation this skill does not close stays active in Help Scout
   until someone handles it, so Help Scout itself is the list of what is
   waiting. The operator sets rules from the Keep active / Auto-noise
   buttons in the Help Scout view, which write straight to the database.

   - Sender domain is in known-noise pattern list (e.g. `@*.notifications`,
     `noreply@`, `no-reply@`, `mailer@`) → count it.
   - Subject contains noise-y keywords (`Daily Summary`, `Renewal Notice`,
     `Service Alert`, `[error]`, `[notification]`) → count it.
   - Otherwise: leave it alone and do not count it. Person-to-person
     conversations stay in the active queue, untouched.

### 6. Record the cursor

Call `help-scout:helpscout_set_triage_cursor` with the same `account`
(and `mailboxId`) and no `lastRunAt`, so it records the current time.

That is the whole step. Do not write any document. If the setter reports
that it refused to move the cursor backwards, a newer run already
recorded a later timestamp: note it and finish normally, do not force.

### 7. Report

Append a comment on **this run's issue**: `PAPERCLIP_ISSUE_ID` from the
heartbeat env. That is the issue paperclip created for this routine fire,
or the wake issue that woke you. Never comment on, or write to, a
rules-home or parent issue.

```
Help Scout triage - <mailbox> - <UTC timestamp>
- Processed: <N> active conversations since <since> (<source>)
- Auto-closed (tagged <noiseTag>): <closedCount>
- Unknown senders worth a rule: <newCandidateCount>
- Skipped (kept active): <leftAloneCount>
- Errors: <errorCount> (see below)

Top candidates for a rule this run:
  - <count> from <sender> (subject pattern: <example>)
  ... (top 5)

Set rules with the Keep active / Auto-noise buttons in the Help Scout view.
```

`<since>` and `<source>` come from `helpscout_get_triage_cursor` in Step
2, so a run that fell back to the 24 hour window says so plainly instead
of looking identical to one that used a real cursor.

If `errorCount > 0`, list the first 5 errors instead.

## When an issue wakes you (watch-new-mail)

An account with the help-scout **watch-new-mail** job on has one
long-lived triage issue. The job checks the account every 2 minutes and
wakes that issue when active conversations appear past the triage cursor;
a human comment wakes it too. Its description only names the account and
this skill. The behaviour below is the same for every account, so it
lives here, not in the issue.

- When woken, run one triage cycle: Steps 1 to 7, with the comment in
  Step 7 only if something was processed or a rule changed.
- At the end of every run, in this order:
  1. If anything reopened the issue, set it back to `blocked`
     (`PATCH /api/issues/<id>` with `{"status":"blocked"}`). Blocked
     means "waiting for mail" and keeps the platform's 30 second re-wake
     scan away (it only looks at `todo` and `in_progress`). Do not "fix"
     it to `in_progress`.
  2. If your session offers a way to schedule your own wake, keep exactly
     one fallback wake about an hour out. If it does not, skip this; the
     watch job still covers new conversations.
  3. End the run.
- Keep nothing in that issue. Rules and the cursor are in the plugin. The
  issue's comments are the run history, not a place to look things up.

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
    --arg account "<account-key>" \
    --arg since "2026-05-06T11:00:00Z" '{
      tool: "help-scout:helpscout_find_conversation",
      parameters: { account: $account, status: "active", since: $since, limit: 50 },
      runContext: { agentId: $agent, runId: $run, companyId: $company }
    }')"
```

Tool names use `<pluginId>:<toolName>` — so:
- `help-scout:helpscout_find_conversation`
- `help-scout:helpscout_get_conversation`
- `help-scout:helpscout_add_label`
- `help-scout:helpscout_change_status`
- `help-scout:helpscout_list_rules`
- `help-scout:helpscout_get_triage_cursor`
- `help-scout:helpscout_set_triage_cursor`

## Errors

- `[ECOMPANY_NOT_ALLOWED]` — calling company isn't in the help-scout
  account's `allowedCompanies`. Surface, don't retry.
- `[EMUTATIONS_DISALLOWED]` (or similar) — `allowMutations` is off for
  the account. Surface; the skill can't function.
- `[EHELPSCOUT_AUTH]` — PAT expired/invalid. Surface for operator to
  rotate the secret.
- `[EHELPSCOUT_RATE_LIMIT]` — back off; Help Scout caps at 400 req/min.
  Resume next run.
- `helpscout_list_rules` fails — do not guess. Abort with an error
  comment rather than running in "no rules" mode, which would auto-close
  nothing and, worse, treat keep-active senders as unclassified.
- `helpscout_set_triage_cursor` refuses the write (cursor would move
  backwards) — a newer run already recorded a later timestamp. Not an
  error. Note it and finish normally.
- `helpscout.import-rules` reports fewer rules than the document held —
  stop and report. Do not tombstone a document whose rules did not all
  make it across.

## After running

- Triage rules live in the help-scout plugin database. The operator sets
  them with the Keep active / Auto-noise buttons in the Help Scout view,
  which write the rule and tag the conversation in one action. The next
  run picks them up via `helpscout_list_rules`.
- Once a sender pattern is consistently auto-closed, recommend the
  operator install a **Help Scout workflow** (Help Scout's own filter
  engine) so the conversation is tagged and closed at delivery time —
  cheaper than running this skill against it on each cycle.

## Out of scope

- Bulk historical cleanup of an existing closed-conversation backlog.
  This skill only acts on conversations modified since the stored cursor.
- Auto-replying to customers — different skill (`helpscout-respond` or
  similar). This skill never sends replies.
- Reopening or moving between mailboxes.
- Permanent delete — Help Scout doesn't expose hard-delete via API and
  this skill wouldn't use it anyway.

## Pre-requisites

- `help-scout` plugin v0.6.0+ installed and `ready`. That is the version
  that added the rules table and the cursor tools; older versions kept
  both in a Markdown document.
- Help Scout PAT issued and stored as a paperclip secret.
- At least one Help Scout account configured in plugin config with the
  calling company in `allowedCompanies`, `allowMutations: true`, and
  `defaultMailbox` (or explicit `mailboxId` per call) set.
- A rules-home issue linked via `routine.parentIssueId`. Only needed
  until the one-time import and tombstone in step 1b have run.
