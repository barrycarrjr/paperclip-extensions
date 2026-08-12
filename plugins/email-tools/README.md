# Email Tools (paperclip plugin)

Multi-mailbox email plugin: send via SMTP and receive via IMAP, exposed as
agent tools. Smart provider defaults (Gmail, Office365, Rackspace,
Fastmail, etc.). Per-mailbox `allowedCompanies` isolation; sends and reads
each gated by their own master switch.

## Recent changes

- **v0.18.1** - Fix the rules panel showing nothing. It listed mailboxes filtered by the company being viewed, but the plugin settings screen is instance-level: opening it from a company that owns no mailbox of its own (a portfolio root, typically) produced an empty list and a message claiming no mailbox was configured, directly below a configuration form listing several. Rules are stored per company, so the panel now asks for each mailbox together with the company its rules belong to, taken from the mailbox ingest company or its single allowed company, and works from anywhere. A mailbox with neither is left out and the reason is stated, since there would be no company to file its rules under. Adds the `email.list-rule-scopes` bridge resource for this; it exposes nothing the configuration form on the same screen does not already show, and the bridge is board-gated.

- **v0.18.0** - A sender rules manager, and validation so a typo cannot become a dead rule. Rules have lived in the database since v0.8.0, but the only way to create one was the Auto-triage / Keep / Mute buttons on a message, which can only ever write that one sender exact address, and there was no way to delete a rule anywhere in the product: `email.delete-rule` existed but nothing called it. Most useful rules are domains or subject matches, so the ones people actually want were unreachable. Adds a `settingsPage` UI slot (the plugin first UI contribution) showing every rule for a mailbox grouped by type, a form that builds any of the three pattern forms with a live preview of what will be stored, and a delete button per rule. It needs no new capability: `settingsPage` requires `instance.settings.register`, which was already declared, so upgrading prompts for nothing. Separately, `email.set-rule` now rejects a pattern that is not a full address, an @domain, or a `subject:` match, and stores the normalized form. Previously it accepted anything, so a mistyped rule was saved and silently matched no mail forever, which is the worst failure available here because the operator believes the noise is handled. The existing message buttons on the Email and Portfolio Email pages surfaced no error at all when a rule write failed; they now report it.

- **v0.17.0** - The triage routine's cursor moved out of Markdown and into plugin state, retiring the last thing the rules-home document was still used for. Until now the "how far did I get last time" timestamp was a `last-run:` line of prose inside a document on a rules-home issue, so every run re-derived its lookback window by reading English, and the operator saw a document that looked like it held rules but held only a cursor and some stale copies left over from the v0.8.0 move to the database. Adds `email_get_triage_cursor` / `email_set_triage_cursor` agent tools and matching `email.get-triage-cursor` / `email.set-triage-cursor` bridge handlers, all company-and-mailbox scoped and access-checked the same way the rule tools are. The 5 minute safety overlap and the 24 hour fallback now live in a tested module (`triage-cursor.ts`) rather than in skill prose, a cursor dated in the future is clamped to now so it can never produce a window that silently matches nothing, and the setter refuses to move the cursor backwards unless forced, so a slow or retried run cannot rewind it. Existing installs need no migration: the first run after upgrading finds no cursor, falls back to 24 hours, and writes a real one at the end. Also removes the dead `email.import-rules` handler, the one-shot v0.8.0 Markdown-to-database importer, which has had no caller for several releases; nothing in the plugin parses that Markdown any more. Note that the `email_triaged` table from `001_init.sql` remains present but inert (unused since v0.14.0): plugin migrations are additive only, so it cannot be dropped.

- **v0.16.22** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.21** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.20** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.19** - Mailbox search for the operator Email view. Until now search existed only as the `email_search` agent tool, so there was no way for a person to search their own mail anywhere in the Paperclip UI. Adds an `email.search` bridge resource that crosses folders (and, when no mailbox is named, every mailbox the calling company may see) and returns one newest-first list. Folder scope is chosen rather than brute-forced: Trash and Junk are excluded unless asked for, INBOX and the mailbox's own poll folder are searched first, the folder count is capped, and anything left out is reported back in `skippedFolders` instead of silently narrowing the result. A message that lives in both INBOX and an archive (normal on Gmail, where All Mail duplicates everything) collapses to a single row keyed on Message-ID, keeping the INBOX copy so the operator gets a location they can act on. A folder that fails to open is reported in `errors` and does not abandon the rest of the search. Results are envelope-only: adding snippets would mean pulling full message bytes from every folder searched. Both `email.search` and the `email_search` tool gained a `text` filter (IMAP TEXT, matching headers and body) so a single search box works without the caller guessing which field a term is in. Requires at least one filter, since an empty query would otherwise walk every folder of every mailbox.

- **v0.16.18** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.17** - Stop the IDLE poll storm and reuse resolved mailbox passwords. Each IMAP notification used to fire its own poll, and a poll that auto-triages mail generates more notifications, so a single delivery could queue about fifteen polls for one mailbox inside a millisecond. Notifications now collapse into one poll per burst (plus at most one follow-up if more arrive mid-poll). Separately, every mailbox operation re-resolved the mailbox password through the host, which rate-limits secret resolution; passwords are now reused from an in-memory cache for 60 seconds, shared by the IMAP and SMTP paths and cleared on config change and shutdown, so rotation is still honoured. Tests cover the collapsing behaviour, the reuse window, and per-mailbox lock serialization.

- **v0.16.16** — Fix worker crash on dropped IMAP connections. The persistent pooled connections (added in v0.16.14) had no 'error' listener, so an async socket failure ("Socket timeout", ECONNRESET) on an idle connection crashed the whole worker process — every mailbox then returned 502 in Portfolio Email until the host restarted the worker. openConnection now attaches an error listener to every client (pool, poll, and IDLE paths), logging the failure instead; the pool's existing `usable` check reconnects on next use.

- **v0.16.15** — Persistent per-mailbox IMAP connection pool (fixes Gmail 502s on rapid UI actions). All bridge actions (mark-read, mark-unread, move, delete, list, fetch) and agent tools now share one persistent connection per mailbox via an async serialization queue instead of opening a fresh connection per request.

- **v0.16.14** — Persistent per-mailbox IMAP connection pool. All UI bridge actions (mark-read, mark-unread, move, delete, list, fetch) and agent tools now share one persistent connection per mailbox with an async serialization queue instead of opening a fresh connection per request. Eliminates the Gmail connection-rate-limit 502s that occurred when clicking several actions in rapid succession.

- **v0.16.13** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.12** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.11** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.10** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.9** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.6** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.5** — `email.list-messages` now returns populated `snippet` strings (previously always empty). `fetchHeaders` gained an opt-in `withSnippets` option that adds `source` to the IMAP fetch and runs `simpleParser` per message — single batched round trip but pulls full message bytes. Trade-off: list calls are a bit heavier but the inbox-row hover preview can finally render the body. Agent-tool `email_search` is unchanged (still empty snippets to keep agent calls cheap).

- **v0.16.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.16.0** — New `mute` sender rule type, joining `auto-triage` and `keep-always`. Muted senders stay in INBOX but are marked read on arrival by the poll loop (no folder move, no dispatch, no triage-agent run). `email.set-rule` accepts `ruleType: 'mute'` and runs a one-shot sweep of existing unread INBOX backlog from the sender (`applyMuteRuleToInbox` in `poll.ts`); response includes `sweptCount`. `email.list-rules` now returns a third bucket `mute: string[]` alongside `autoTriage` and `keepAlways`. Telemetry: new `poll-muted` event with mailbox + count. UI surfaces (Portfolio Brief, Morning Brief, Unified Inbox) gain a `Keep · mute` button next to the existing `Keep · read` / `Keep · unread` siblings.

- **v0.15.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.15.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.15.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.15.0** — New `email.delete-message` bridge action: moves a message to the mailbox's Trash folder (Outlook-style soft-delete; recoverable until the provider's retention window empties Trash). Auto-detects the Trash folder via IMAP SPECIAL-USE `\Trash`, falling back to common path names (`Trash`, `[Gmail]/Trash`, `Deleted Items`, `Deleted Messages`, `INBOX.Trash`). Marks read before moving. Respects `disallowMove`. Helper `findTrashFolder` added to `imap.ts`.

- **v0.14.0** — Cleanup: removed the dead `email.record-triage` bridge handler. It was an audit-style write to the legacy `email_triaged` table — back when the Email view used the DB to filter the message list. After we switched the view to mirror Outlook's unread INBOX directly (v0.7.0 era), nothing read or wrote the table anymore. The `email_triaged` table itself remains in the schema (plugin migrations can't DROP in Phase 1) but is now fully inert. Sender rules continue to live in `email_sender_rules` — that's the active table.

- **v0.13.0** — On-rule-creation backlog sweep. When `email.set-rule` is called with `ruleType=auto-triage`, the worker now also scans the mailbox's INBOX for unread messages whose From matches the pattern (exact email or `@domain`) and moves them to `_paperclip/triage`. Closes the gap between v0.12.0 (which only catches new arrivals) and the case where the rule is added after the matching mail already landed. Response now includes `sweptCount` so the UI can surface "moved N existing messages." Respects `disallowMove`. Best-effort: rule write succeeds even if the sweep fails.

- **v0.12.0** — Real-time auto-triage on arrival. The `poll-mailboxes` job now applies `auto-triage` sender rules to incoming mail directly: when a new INBOX message's From address matches a rule, the message is marked read and moved to `_paperclip/triage` before any event/issue dispatch fires. This closes the "rule already exists, new email from that sender still landed in INBOX" gap — previously the operator had to wait for the next email-triage routine run. Respects `disallowMove`. Falls through to normal dispatch on move failure. Telemetry: `poll-auto-triaged` event with mailbox + count.

- **v0.11.0** — New `email.mark-unread` bridge action (mirror of `email.mark-read`). Lets the Email view flip an already-read message back to unread so it reappears in the unread INBOX view — useful when a previous handoff / triage was a mistake.

- **v0.10.0** — Triage-folder watcher: the `poll-mailboxes` job now also scans each mailbox's `_paperclip/triage` folder for messages that appeared since the last scan and INSERTs auto-triage rules for the senders found. This means the operator can train rules from any IMAP client (Outlook, Mail.app, mobile) just by moving messages into the triage folder — Paperclip sees the move on its next poll and writes the rule automatically. Per-mailbox cursor stored in plugin state under `<mailboxKey>:triage-cursor`. First run / UIDVALIDITY change seeds the cursor at the current max UID so we don't bulk-rule from years of historical triage history. Rule scoped to `mailbox.ingestCompanyId` (consistent with existing dispatch behavior). Skipped if `ingestCompanyId` isn't set.

- **v0.9.0** — New agent tool `email_list_rules` returns sender rules from the DB (`{ autoTriage: string[], keepAlways: string[] }`). The email-triage skill (paperclip-extensions/skills/email-triage/SKILL.md) is updated to call this tool instead of parsing Auto-triage / Keep-always sections from the Markdown rules-home doc. The Markdown's rule sections are now deprecated read-only history; the skill only writes the Review queue section going forward. UI views (Email, MorningBrief, UnifiedInbox, PortfolioBrief) already write rules via `email.set-rule` to the same DB so both halves of the loop stay consistent.

- **v0.8.0** — Sender rules now live in a DB table instead of a Markdown rules doc. New migration `002_sender_rules.sql` creates `email_sender_rules` (company_id, mailbox_key, sender_pattern, rule_type ∈ {auto-triage, keep-always}) with UNIQUE on (company_id, mailbox_key, sender_pattern). New bridge handlers: `email.list-rules`, `email.set-rule` (upsert), `email.delete-rule`. The Email view writes rules to the DB (and still updates the Markdown doc for backward compat with the existing triage routines). Routine migration to read from DB is the next step.

- **v0.7.0** — PostgreSQL database namespace (`plugin_email_tools_7cbee3fdf3`). New `migrations/001_init.sql` creates `email_triaged` table tracking per-UID triage decisions (keep-always, dismiss, auto-triage, move) so the Email view survives page refreshes without touching IMAP read flags. `email.list-messages` now filters triaged UIDs from results and returns `uidValidity`. New bridge actions: `email.record-triage` (INSERT into `email_triaged`), `email.send-reply` (SMTP reply with threading headers, equivalent to `email_reply` tool), `email.send-new` (SMTP send, equivalent to `email_send` tool). Both send actions require `allowSend = true`. Capabilities added: `database.namespace.migrate`, `database.namespace.read`, `database.namespace.write`.

- **v0.6.0** — Adds UI bridge handlers for the new Paperclip Email view. New `ctx.data.register` handlers: `email.list-mailboxes` (returns mailboxes visible to a company), `email.list-messages` (IMAP search returning headers), `email.fetch-message` (full parsed body), `email.list-folders` (IMAP LIST). New `ctx.actions.register` handlers: `email.move-message` (marks read + moves, respects `disallowMove`), `email.mark-read`. These are called by the Email page in the main UI via the plugin bridge API (`POST /api/plugins/:pluginId/data/:key` and `actions/:key`) — no agent/run context required. A new `listFolders` helper was added to `imap.ts`.

- **v0.5.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.5.1** — `email_move` now verifies the message actually moved into
  the destination folder before reporting success.
- **v0.5.0** — minor bump to align with the cross-plugin release.
- **v0.4.0** — turned the previously send-only plugin into a full inbox
  companion. Adds `email_search`, `email_fetch`, `email_get_attachment`,
  `email_thread`, `email_mark_read`, `email_mark_unread`, `email_move`,
  `email_reply`. Per-mailbox IMAP polling + IDLE for sub-minute push.
  Per-mailbox dispatch (`onReceive.mode = none | event | issue`); issue
  mode files an issue under the mailbox's `ingestCompanyId`. Bulk ops
  accept `uid: number | number[]`. `setupInstructions` rendered as a Setup
  tab on the plugin's settings page (canonical install walkthrough).
- **v0.3.0** — per-mailbox `allowedCompanies` enforcement; `name` field
  per mailbox; env-file fallback removed (every mailbox must live in
  plugin config now). See "Migrating from v0.2.0" below.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\email-tools
pnpm install
pnpm build

# Then from your paperclip checkout:
cd %USERPROFILE%\paperclip
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\email-tools
```

The plugin worker reloads automatically when the install finishes (and
again whenever its instance config is saved). No manual paperclip restart
needed.

> Don't use `npx paperclipai` — that fetches the published package, which
> won't have your fork's changes. Always run the CLI through pnpm from the
> paperclip workspace.

## Configure

For each mailbox you want this plugin to send from:

### 1. Store the password as a paperclip secret

1. Open `<COMPANY-PREFIX>/company/settings/secrets` in the paperclip UI
   (any company is fine; secrets are looked up by UUID).
2. Click **+ Create secret**.
3. Name it descriptively (e.g. `IMAP_PERSONAL_PASS`).
4. Provider: `Local encrypted` (the default).
5. Value: the actual password (Gmail app password, Office365 SMTP password,
   etc.). Save.
6. Copy the secret's UUID — visible in the secrets list, or via
   `GET /api/companies/<companyId>/secrets`.

### 2. Bind the mailbox in the plugin config

Open `/instance/settings/plugins/email-tools`. Click **+ Add item** under
Mailboxes. Fill in:

| Field | Example | Notes |
|---|---|---|
| `Display name` | `Personal Mailbox` | Free-form label shown on this settings page. You can rename it later without breaking anything. |
| `Identifier` | `personal` | Short stable ID agents pass as the `mailbox` parameter. Lowercase, no spaces. **Don't change after skills start using it.** |
| `Allowed companies` | `["company-uuid-1"]` or `["*"]` | Which companies can use this mailbox. Empty = unusable. |
| `IMAP host` | `imap.gmail.com` | SMTP host auto-derives unless overridden |
| `Username (email address)` | `you@gmail.com` | The full email address |
| `Password` | (paste secret UUID from step 1) | Stored encrypted via the secrets store |
| `SMTP host` / `SMTP port` / `TLS on connect` / `SMTP username` / `From address` | (optional) | Only set if the provider deviates from defaults |

Find company UUIDs via `GET /api/companies` or the company list URL.

### 3. Flip the master switch

| Field | Value |
|---|---|
| `allowSend` | `true` |

Save. The worker auto-restarts and the new config takes effect on the
next `email_send` call.

## Migrating from v0.2.0

If your v0.2.0 setup used the env file (`%USERPROFILE%\.paperclip\instances\default\email-tools.env`),
you have to migrate to plugin config:

1. For each mailbox in the env file:
   - Create a secret in the paperclip secrets UI containing the value of
     `IMAP_<KEY>_PASS`.
   - On `/instance/settings/plugins/email-tools`, add a Mailbox row with
     the host/user from the env file, and the new secret UUID as the password.
   - Set Display name, Identifier, and Allowed companies per the table above.
2. Delete the env file (it's no longer read).
3. Save the plugin config and confirm the worker logs
   `email-tools: ready. Mailboxes — ...` with no orphan warning.

The worker logs `email-tools: N mailbox(es) have no allowedCompanies and
will reject every call. Backfill...` at startup if any mailbox is missing
its company list — use that as your migration TODO list.

## Tool

`email_send`:

| Param | Type | Required | Notes |
|---|---|---|---|
| `mailbox` | string | yes | The mailbox Identifier from plugin config. Calling company must be in that mailbox's Allowed companies. |
| `to` | string \| string[] | yes | RFC 5322 names allowed |
| `cc` | string \| string[] | no | |
| `bcc` | string \| string[] | no | |
| `subject` | string | yes | |
| `body` | string | yes | Plain text. Required even if `body_html` is set. |
| `body_html` | string | no | HTML alternative |
| `in_reply_to` | string | no | Message-ID being replied to |
| `references` | string[] | no | Older Message-IDs in the thread |
| `reply_to` | string | no | Reply-To header override |

`email_search`:

| Param | Type | Required | Notes |
|---|---|---|---|
| `mailbox` | string | yes | The mailbox Identifier from plugin config. Calling company must be in that mailbox's Allowed companies. |
| `folder` | string | no | Defaults to the mailbox's poll folder (INBOX if unset). |
| `text` | string | no | Free text matched against headers and body (IMAP TEXT). Use when you do not know which field holds the term. Slowest filter. |
| `from` | string | no | Substring of the From: header |
| `to` | string | no | Substring of the To: header |
| `subject` | string | no | Substring of the Subject: header |
| `since` / `before` | string | no | ISO date or `YYYY-MM-DD` |
| `unseen` | boolean | no | Unread only |
| `limit` | number | no | Default 50, max 200 |

Returns headers and no bodies. Use `email_fetch` for a full message.

### Searching from the UI

The operator Email view calls the `email.search` bridge resource, which takes
the same filters plus `includeTrash`, and differs in scope: omit `mailbox` and
it searches every mailbox the calling company is allowed to see, and omit
`folder` and it searches across folders rather than one. It answers with
`{ results, truncated, searchedMailboxes, skippedFolders, errors }`.

Two things are worth knowing about the scope it picks. Trash and Junk are left
out unless `includeTrash` is set, and the number of folders per mailbox is
capped, so a very large account is not guaranteed to be searched exhaustively.
Anything left out is listed in `skippedFolders`, and a folder that could not be
opened lands in `errors`, so the caller can tell the difference between "no
matches" and "not looked at".

### Example invocation

```http
POST /api/plugins/tools/execute
{
  "tool": "email-tools.email_send",
  "params": {
    "mailbox": "personal",
    "to": "you@example.com",
    "subject": "Hello",
    "body": "Plain-text body."
  },
  "runContext": {
    "agentId": "...",
    "runId": "...",
    "companyId": "<must-be-in-mailbox-allowedCompanies>",
    "projectId": "..."
  }
}
```

Returns Message-ID + SMTP response on success, or `error` on failure.

## Error codes

| Code | When |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in the mailbox's `allowedCompanies`, or the list is empty. |
| `[<SMTP_CODE>]` | Wrapped from nodemailer / SMTP server (e.g. `[EAUTH]`, `[ETIMEDOUT]`, `[ESOCKET]`). |
| `[SMTP_ERROR]` | Generic fallback when nodemailer didn't supply a code. |

## Authors

Barry Carr · Tony Allard
