---
name: email-send
description: Send a single email through one of the operator's IMAP/SMTP-configured mailboxes. Use whenever an agent needs to send an email — to a customer, a contact, a family member, or any external recipient. Always confirm content with the board before sending external emails.
---

# Email Send

Sends a plain-text email via the `email-tools` paperclip plugin (which
wraps SMTP through nodemailer). Multiple mailboxes are supported — agents
pick the right one for the entity context.

## When to invoke

You're in a heartbeat working on an issue and the natural next action is
"send an email." Examples:
- A task says "Email the customer their receipt" → invoke this skill.
- A personal task: "Send <recipient> the dinner reservation details" → invoke this skill.
- A morning briefing wraps up and the board asked for a daily summary email.

## Pre-conditions

- Confirm the recipient address with the board if it isn't already in the
  issue body or a referenced contact record.
- For revenue-tier or external-tier issues, draft first, then create a
  confirmation request (`request_confirmation`) targeting the draft. Do NOT
  send before the board approves.
- For internal/informational issues with explicit pre-approval (e.g.,
  scheduled briefing emails), you may send directly.

## How to invoke

Plugin tools are NOT exposed as Claude Code MCP tools. They live in
paperclip's plugin tool registry and are invoked via a paperclip API call.
**Do not search ToolSearch / MCP** for `email_send` — it won't be there.

Use the paperclip plugin-tool execute endpoint. The body shape is
`{ tool, parameters, runContext }` — the runContext comes from the env vars
auto-injected into your heartbeat:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" --arg company "$PAPERCLIP_COMPANY_ID" '{
    tool: "email-tools:email_send",
    parameters: {
      mailbox: "personal",
      to: "recipient@example.com",
      subject: "Subject line",
      body: "Plain-text body — keep it human."
    },
    runContext: {
      agentId: $agent,
      runId: $run,
      companyId: $company
    }
  }')"
```

The full tool name uses the `<pluginId>:<toolName>` format —
`email-tools:email_send`.

`runContext.projectId` is optional — omit it when the company has no projects
(e.g., personal/operations companies). If you need it, derive from the issue
context.

Available parameters (all under `parameters`):

| Param | Type | Required | Notes |
|---|---|---|---|
| `mailbox` | string | yes | Mailbox identifier (e.g., `personal`, or an entity-specific identifier configured by the operator) |
| `to` | string \| string[] | yes | Recipient address(es). RFC 5322 names allowed |
| `cc` | string \| string[] | no | |
| `bcc` | string \| string[] | no | |
| `subject` | string | yes | |
| `body` | string | yes | Plain text. Required even if `body_html` is set |
| `body_html` | string | no | HTML alternative |
| `in_reply_to` | string | no | Message-ID being replied to |
| `references` | string[] | no | Older Message-IDs in the thread |
| `reply_to` | string | no | Reply-To header override |

To discover what mailbox identifiers are valid, look at the operator's
`email-tools` plugin config (UI: `/instance/settings/plugins/email-tools`,
or `GET /api/plugins/email-tools/config` → `configJson.mailboxes[].key`).
Or just try `personal` for personal mail.

**Voice rules:**
- Personal emails: warm, casual, signed with the operator's first name or initial.
- Business emails: professional but human. Match the entity's brand voice.
- Never use AI-tells ("I hope this email finds you well", em-dashes everywhere,
  excessive enthusiasm). Write like a human would.

## Response

On success the API returns (HTTP 200):

```json
{
  "pluginId": "email-tools",
  "toolName": "email_send",
  "result": {
    "content": "Sent. Message-ID <abc123@gmail.com>",
    "data": {
      "ok": true,
      "mailbox": "personal",
      "message_id": "<abc123@gmail.com>",
      "smtp_response": "250 2.0.0 OK ...",
      "accepted": ["recipient@example.com"],
      "rejected": []
    }
  }
}
```

The `ok` flag is at `result.data.ok` (the plugin's own success flag) — there
is no top-level `ok` field.

On in-band failure (still HTTP 200, plugin handler returned an error):

```json
{
  "pluginId": "email-tools",
  "toolName": "email_send",
  "result": { "error": "[ERROR_CODE] human message" }
}
```

On HTTP-level failure:
- **400** — missing/invalid request body
- **403** — agent token doesn't match `runContext.agentId`, or board user
  lacks company access
- **404** — tool name not registered (plugin not installed)
- **502** — plugin worker not running
- **500** — other dispatch errors
- **503** — plugin tool dispatch is disabled at the server level

Each non-200 returns `{"error": "human message"}` at the top level.

## After sending

Append a comment to the parent issue with:

```
Email sent.
- To: <recipient>
- Subject: <subject>
- Mailbox: <mailbox-key>
- Message-ID: <id-from-tool>
```

This is the audit trail for "did the email actually send."

## Errors

- **Plugin not installed / not ready** → the API call returns 404 or 503.
  Report and ask the board to verify `email-tools` plugin status.
- **Sending disabled** → `{"error": "Sending is disabled. Set 'allowSend' true on the email-tools plugin settings page..."}`.
  Operator flips `allowSend` on the plugin config page.
- **Invalid mailbox identifier** → `{"error": "Mailbox \"X\" not configured..."}`.
  Pick a valid mailbox or ask the board.
- **SMTP errors (auth, connection, send refused)** → `{"error": "[EAUTH] Invalid login..."}`.
  Report with exact error in a comment. Do NOT retry — auth failures usually
  mean the password rotated. Operator rotates the secret in
  `<COMPANY>/company/settings/secrets`.

## Pre-requisites for this skill to work

The `email-tools` plugin must be installed and `ready` in paperclip
(check via `/instance/settings/plugins`), and at least one mailbox must
be configured. As of v0.3.0, all configuration lives in plugin instance
config at `/instance/settings/plugins/email-tools`:

- `name` — display label (free-form)
- `key` — short stable identifier agents pass (e.g. `personal`)
- `allowedCompanies` — list of company UUIDs allowed to use this mailbox
- `imapHost`, `user`
- `pass` — the UUID of a secret created in the company's secrets page
  (`<COMPANY-PREFIX>/company/settings/secrets`)
- optional SMTP overrides

Master toggle: `allowSend = true`.

See the plugin's README for the full schema.
