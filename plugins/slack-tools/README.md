# Slack Tools (paperclip plugin)

Send Slack messages from agent tools — DMs to the operator, channel posts,
Block Kit, edits, deletes, and user/channel lookups. Multi-workspace aware,
per-workspace `allowedCompanies` isolation, edit/delete gated by a master
switch.

Anchor use case: the daily CEO morning briefing arrives as a Slack DM via
`slack_send_dm` with a Block Kit body.

## Tools registered

| Tool | Kind | Notes |
|---|---|---|
| `slack_send_dm` | write | Falls back to `defaultDmTarget` when `userId` is omitted. |
| `slack_send_channel` | write | Address by `channelId` (preferred) or `channelName`. |
| `slack_update_message` | mutation | Edit a previous bot message. Gated by `allowMutations`. |
| `slack_delete_message` | mutation | Delete a previous bot message. Gated by `allowMutations`. |
| `slack_lookup_user` | read | Resolve by email or user ID. Use once at setup to find your `defaultDmTarget`. |
| `slack_list_channels` | read | List channels, optional substring filter. |
| `slack_get_channel` | read | Single-channel metadata. |

Every tool accepts an optional `workspace` parameter; if omitted, falls back
to the configured `defaultWorkspace`. Send tools accept `threadTs` for
threaded replies.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\slack-tools
pnpm install
pnpm build

# Then from your paperclip checkout:
cd %USERPROFILE%\paperclip
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\slack-tools
```

The plugin worker reloads automatically when the install finishes and again
whenever its instance config is saved. No manual paperclip restart needed.

> Don't use `npx paperclipai` — that fetches the published package, which
> won't have your fork's changes. Always run the CLI through pnpm from the
> paperclip workspace.

## Configure

Setup is two-step per Slack workspace: create the Slack App + paperclip
secret, then bind the workspace in the plugin config.

### 1. Create a Slack App and get a bot token

1. Go to https://api.slack.com/apps and click **Create New App** → "From
   scratch". Pick a name (e.g. `Paperclip`) and the workspace to install
   into.
2. Open the new app's **OAuth & Permissions** page.
3. Under **Bot Token Scopes**, add:
   - `chat:write` — post messages to channels the bot is in
   - `chat:write.public` — post to public channels without joining first
   - `im:write` — DM users
   - `users:read` — `slack_lookup_user`, `slack_get_channel` member counts
   - `users:read.email` — required if you'll look up users by email
   - `channels:read` — `slack_list_channels` (public)
   - `groups:read` — `slack_list_channels` (private)
4. (Optional) Under **User Token Scopes**, add scopes like `chat:write` if a
   skill will ever need to send a message *as* the operator. Most skills
   only need the bot token.
5. Click **Install to Workspace**, approve, and copy:
   - `Bot User OAuth Token` (`xoxb-...`) — required
   - `User OAuth Token` (`xoxp-...`) — optional, only if you added user
     token scopes

### 2. Store the token(s) as paperclip secrets

For each token:

1. Open `<COMPANY-PREFIX>/company/settings/secrets` in the paperclip UI
   (any company is fine; secrets are looked up by UUID).
2. Click **+ Create secret**.
3. Name it descriptively (e.g. `SLACK_BOT_TOKEN_MAIN`,
   `SLACK_USER_TOKEN_MAIN`).
4. Provider: `Local encrypted` (the default).
5. Value: paste the token. Save.
6. Copy the secret's UUID.

### 3. Find your default DM target user ID

You'll want the bot to DM you without specifying a user ID every time.
Slack identifies users by `U`-prefixed IDs. To find yours:

- Easiest: open Slack → click your avatar → **Profile** → click `⋯` →
  **Copy member ID**. The result is `U…`.
- Or call `slack_lookup_user` once with your email after step 4 below.

### 4. Bind the workspace in the plugin config

Open `/instance/settings/plugins/slack-tools`. Click **+ Add item** under
Slack workspaces. Fill in:

| Field | Example | Notes |
|---|---|---|
| `Identifier` | `team-main` | Short stable ID agents pass as the `workspace` parameter. Lowercase, no spaces. **Don't change after skills start using it.** |
| `Display name` | `Acme Slack` | Free-form label. |
| `Bot token (xoxb-…)` | (paste secret UUID from step 2) | Stored as a UUID; plugin resolves at runtime. |
| `User token (xoxp-…, optional)` | (paste secret UUID, or leave blank) | Only if you need user-token-scoped operations. |
| `Default DM target user ID` | `U01ABCDEFGH` | Your Slack user ID from step 3. Saves passing `userId` on every DM. |
| `Default channel ID (optional)` | `C01ABCDEFGH` | If most messages go to one ops channel, paste its ID here. |
| `Allowed companies` | tick the LLC | Which paperclip companies may use this workspace. Empty = unusable. Typical: one workspace = one LLC, single-element list. |

(Optionally) set **Default workspace key** to the identifier above so
agents can omit `workspace` on every call.

## Block Kit templates

Slack supports rich messages via [Block Kit](https://api.slack.com/block-kit).
The plugin doesn't ship templates as code — agents pass `blocks` arrays
directly to `slack_send_dm` / `slack_send_channel`. Three common shapes:

### Status update (with progress badge)

```json
{
  "text": "Daily briefing for 2026-05-01",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "📊 Daily briefing — 2026-05-01" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Open issues*\n12" },
        { "type": "mrkdwn", "text": "*Overdue*\n3" }
      ]
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "Generated by `ceo-morning-briefing` skill" }
      ]
    }
  ]
}
```

### Approval request (with action buttons)

Note: action buttons require an inbound webhook receiver, which Paperclip
doesn't currently expose. Buttons render but won't roundtrip. Use plain
`section` blocks until that lands. Track in the cross-plugin "Webhook
receiver model" question (see `paperclip-extensions/plugin-plans/README.md`).

### Error alert

```json
{
  "text": "🚨 Heartbeat failure: rollbar-scraper",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": ":rotating_light: *rollbar-scraper failed*\n\n```\nERR_API_TIMEOUT after 3 retries\n```"
      }
    }
  ]
}
```

The Slack [Block Kit Builder](https://app.slack.com/block-kit-builder/)
renders blocks live so you can design visually, then paste the JSON into
your skill's tool call.

## Tool usage examples

### Send a DM to the operator

```ts
await tools.invoke("slack_send_dm", {
  // workspace omitted → uses defaultWorkspace
  // userId omitted → uses workspace.defaultDmTarget
  text: "📊 Daily briefing — open issues: 12, overdue: 3",
});
```

### Post to a channel by name

```ts
await tools.invoke("slack_send_channel", {
  channelName: "ops",
  text: "Deployment finished: paperclip@4238ea68",
});
```

### Look up a user (e.g. once, to find your `defaultDmTarget`)

```ts
const result = await tools.invoke("slack_lookup_user", {
  email: "you@example.com",
});
console.log(result.data.id); // U01ABCDEFGH — paste into the workspace config
```

### Edit a "pending" message to "done"

```ts
const post = await tools.invoke("slack_send_dm", {
  text: "⏳ Generating month-end report…",
});
// ... do the work ...
await tools.invoke("slack_update_message", {
  channelId: post.data.channel,  // chat.postMessage returns the IM channel
  ts: post.data.ts,
  text: "✅ Month-end report ready: see #finance.",
});
```

`slack_update_message` requires `allowMutations` — flip it on once you've
verified which skills can edit messages.

## Error codes

The plugin wraps Slack API errors into prefixed codes so consuming skills
can pattern-match:

| Code | Meaning |
|---|---|
| `[EWORKSPACE_REQUIRED]` | No workspace param and no default configured. |
| `[EWORKSPACE_NOT_FOUND]` | Workspace identifier not in plugin config. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in this workspace's `allowedCompanies`. |
| `[ECONFIG]` | Workspace lacks the required token ref or the secret didn't resolve. |
| `[EDISABLED]` | Mutation tool called while `allowMutations=false`. |
| `[EINVALID_INPUT]` | Required param missing or contradictory (e.g. both `email` and `userId`). |
| `[ESLACK_AUTH]` | Slack rejected the token (invalid_auth / token_expired / token_revoked). |
| `[ESLACK_SCOPE]` | Slack returned `missing_scope`. The error message lists the scope needed; add it to your app and reinstall. |
| `[ESLACK_CHANNEL_NOT_FOUND]` | Slack couldn't find the channel, or the bot can't see it (private channel without invite). |
| `[ESLACK_USER_NOT_FOUND]` | No user matched the email/ID. |
| `[ESLACK_NOT_IN_CHANNEL]` | Bot needs to be invited to the channel first. Use `/invite @<your-bot>` in the target channel. |
| `[ESLACK_RATE_LIMIT]` | Slack returned 429. Client retries internally; this surfaces only after exhausting retries. |
| `[ESLACK_MSG_TOO_LONG]` | Message body > 40,000 chars. |
| `[ESLACK_<UPPER_CASED>]` | Other platform errors. |
| `[ESLACK_REQUEST]` / `[ESLACK_HTTP]` / `[ESLACK_UNKNOWN]` | Network / unknown errors. |

## Threading

Every send tool returns a `ts` (timestamp). Pass that as `threadTs` on a
later send to thread the reply rather than starting a new message. Common
pattern for daily briefings: store the first day's `ts` and reply to it on
subsequent days so the briefing collapses into one Slack thread.

## `allowedCompanies` cheatsheet

Every workspace entry must list `allowedCompanies` — the paperclip company
UUIDs that may use it. Three meaningful states:

| Setting | Behavior |
|---|---|
| Missing or `[]` | Workspace exists in config but is unusable (fail-safe deny). |
| `["company-uuid-A"]` | Only company A's agents can call tools against this workspace. |
| `["*"]` | Portfolio-wide. Rare for Slack since most workspaces belong to one team. |

Cross-tenant attempts are logged via `ctx.logger.warn("ECOMPANY_NOT_ALLOWED", …)`
and returned as `[ECOMPANY_NOT_ALLOWED]` to the caller.

## Out of scope (this version)

- Reading channels, threads, or search — covered by the existing Slack MCP
  if you have it connected. Don't duplicate.
- Slash commands / button interactivity — needs a Paperclip-level inbound
  HTTP path. See cross-plugin webhook discussion in
  `paperclip-extensions/plugin-plans/README.md`.
- Workflow Builder integration.
- Canvases — use the existing Slack MCP.

## Versioning

`0.1.0` — initial release. send/edit/delete/lookup/list/get; per-workspace
`allowedCompanies`; bot + optional user token; defaultDmTarget /
defaultChannel.
