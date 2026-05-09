# Email Tools (paperclip plugin)

Multi-mailbox email plugin: send via SMTP and receive via IMAP, exposed as
agent tools. Smart provider defaults (Gmail, Office365, Rackspace,
Fastmail, etc.). Per-mailbox `allowedCompanies` isolation; sends and reads
each gated by their own master switch.

## Recent changes

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
