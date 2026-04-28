# Email Tools (paperclip plugin)

Exposes `email_send` as an agent tool. Multi-mailbox SMTP via nodemailer
with smart provider defaults (Gmail, Office365, Rackspace, Fastmail, etc.).

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

> Don't use `npx paperclipai` for any of the CLI commands — that fetches
> the published `paperclipai` package from npm, which won't have your
> fork's changes. Always run the CLI through pnpm from the paperclip
> workspace.

## Configure (v0.2.0+)

As of v0.2.0 the canonical path is the encrypted secrets store + the
plugin's instance config. The env file still works as a fallback for any
mailbox you haven't migrated yet — see "Legacy env file" below.

### 1. Store each mailbox password as a paperclip secret

For each mailbox you want this plugin to send from:

1. Open `<COMPANY-PREFIX>/company/settings/secrets` in the paperclip UI
   (any company is fine; secrets are looked up by UUID).
2. Click **+ Create secret**.
3. Name it descriptively (e.g. `IMAP_PERSONAL_PASS`).
4. Provider: `Local encrypted` (the default).
5. Value: the actual password (Gmail app password, Office365 SMTP password,
   etc.). Save.
6. Copy the secret's UUID — visible in the secrets list, or via
   `GET /api/companies/<companyId>/secrets`.

### 2. Bind mailboxes in the plugin config

Open `/instance/settings/plugins/email-tools`. For each mailbox add an
entry:

| Field | Value |
|---|---|
| `key` | Identifier agents use (e.g. `personal`, `work`) |
| `imapHost` | e.g. `imap.gmail.com` (SMTP host auto-derives unless overridden) |
| `user` | The full email address |
| `pass` | Paste the secret UUID from step 1 |
| `smtpHost` / `smtpPort` / `smtpSecure` / `smtpUser` / `smtpFrom` | Only set if the provider deviates from defaults |

Then flip the master switch:

| Field | Value |
|---|---|
| `allowSend` | `true` |

Save. The worker auto-restarts and the new config takes effect on the
next `email_send` call.

### Legacy env file (fallback)

`%USERPROFILE%\.paperclip\instances\default\email-tools.env` is still
read for any mailbox NOT present in the plugin config. Format:

```
IMAP_ALLOW_SEND=true
IMAP_MAILBOXES=personal,work

IMAP_PERSONAL_HOST=imap.gmail.com
IMAP_PERSONAL_PORT=993
IMAP_PERSONAL_USER=you@gmail.com
IMAP_PERSONAL_PASS=<gmail app password>      # plaintext — migrate to a secret-ref when you can

# Optional SMTP overrides — only needed when the provider deviates from defaults
# IMAP_WORK_SMTP_HOST=smtp.office365.com
# IMAP_WORK_SMTP_PORT=587
# IMAP_WORK_SMTP_SECURE=false
```

If a mailbox key appears in BOTH the plugin config AND the env file, the
plugin config wins. After editing the env file, restart paperclip for
changes to take effect.

## Tool

`email_send` registered with parameters:

| Param | Type | Required | Notes |
|---|---|---|---|
| `mailbox` | string | yes | Mailbox `key` from the plugin config (or from env `IMAP_MAILBOXES` for legacy mailboxes) |
| `to` | string \| string[] | yes | RFC 5322 names allowed |
| `cc` | string \| string[] | no | |
| `bcc` | string \| string[] | no | |
| `subject` | string | yes | |
| `body` | string | yes | Plain text. Required even if `body_html` is set. |
| `body_html` | string | no | HTML alternative |
| `in_reply_to` | string | no | Message-ID being replied to |
| `references` | string[] | no | Older Message-IDs in the thread |
| `reply_to` | string | no | Reply-To header override |

Returns Message-ID + SMTP response on success, or `error` string on failure.

## Authors

Barry Carr · Tony Allard
