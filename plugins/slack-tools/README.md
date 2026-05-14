# Slack Tools (paperclip plugin)

Send Slack messages, react to threads, read channel history, search,
upload files, list users, and set your Slack status — all from agent
tools. Multi-workspace aware, per-workspace `allowedCompanies`
isolation, mutations and history reads each gated by their own master
switch.

Anchor use case: the daily CEO morning briefing arrives as a Slack DM via
`slack_send_dm` with a Block Kit body.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.4.10** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.9** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.6** — Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.4.5** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Tools registered

| Tool | Kind | Notes |
|---|---|---|
| `slack_send_dm` | write | Falls back to `defaultDmTarget` when `userId` is omitted. `asUser: true` posts as the operator. |
| `slack_send_channel` | write | Address by `channelId` (preferred) or `channelName`. `asUser: true` posts as the operator. |
| `slack_update_message` | mutation | Edit a previous bot message. Gated by `allowMutations`. |
| `slack_delete_message` | mutation | Delete a previous bot message. Gated by `allowMutations`. |
| `slack_add_reaction` | write | Add an emoji reaction. `asUser: true` reacts as the operator. |
| `slack_remove_reaction` | write | Remove an emoji reaction. Each token can only remove its own. |
| `slack_upload_file` | write | Upload a text/snippet file via files.uploadV2. |
| `slack_read_channel` | history-read | conversations.history. **Gated by `allowReadHistory`.** |
| `slack_read_thread` | history-read | conversations.replies. **Gated by `allowReadHistory`.** |
| `slack_search_messages` | history-read | search.messages. **User token + `allowReadHistory`.** |
| `slack_lookup_user` | read | Resolve by email or user ID. Use once at setup to find your `defaultDmTarget`. |
| `slack_list_channels` | read | List channels, optional substring filter. |
| `slack_get_channel` | read | Single-channel metadata. |
| `slack_list_users` | read | Roster, paginated. Filters bots/deleted unless `includeDeleted`. |
| `slack_set_user_status` | write | Set the operator's status. **User token only.** |

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

The plugin uses **dual-token auth**: a bot token for announce/notify
operations and a user token for "act as me" operations. Configure both at
install — the whole point of an assistant plugin is acting on the
operator's behalf, so the user token is first-class. Setup is three steps
per workspace: create the Slack App from the bundled manifest, store both
tokens as Paperclip secrets, then bind the workspace in the plugin config.

### 1. Create a Slack App from the bundled manifest

The plugin ships [`slack-app-manifest.json`](slack-app-manifest.json)
declaring all the OAuth scopes both tokens need, so you don't click ~37
checkboxes by hand.

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
→ **From a manifest**, pick the target workspace, paste the contents of
`slack-app-manifest.json`, then **Next** → **Create**.

Then on the **OAuth & Permissions** page, install the app to your
workspace and grab BOTH tokens — **Bot User OAuth Token** (`xoxb-…`) and
**User OAuth Token** (`xoxp-…`) — and paste them as `botTokenRef` and
`userTokenRef` in the plugin config (step 3 below).

### 2. Store both tokens as paperclip secrets

For each token:

1. Open `<COMPANY-PREFIX>/company/settings/secrets` in the paperclip UI
   (any company is fine; secrets are looked up by UUID).
2. Click **+ Create secret**.
3. Name it descriptively (e.g. `SLACK_BOT_TOKEN_MAIN`,
   `SLACK_USER_TOKEN_MAIN`).
4. Provider: `Local encrypted` (the default).
5. Value: paste the token. Save.
6. Copy the secret's UUID.

You'll have two secret UUIDs at the end — one for `xoxb-…`, one for
`xoxp-…`.

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
| `Bot token (xoxb-…)` | (paste bot-token secret UUID from step 2) | Bot identity — channel posts, operator DMs. |
| `User token (xoxp-…)` | (paste user-token secret UUID from step 2) | Operator identity — search, files, reactions, reminders. |
| `Default DM target user ID` | `U01ABCDEFGH` | Your Slack user ID from step 3. Saves passing `userId` on every DM. |
| `Default channel ID (optional)` | `C01ABCDEFGH` | If most messages go to one ops channel, paste its ID here. |
| `Allowed companies` | tick the LLC | Which paperclip companies may use this workspace. Empty = unusable. Typical: one workspace = one LLC, single-element list. |

(Optionally) set **Default workspace key** to the identifier above so
agents can omit `workspace` on every call.

## Token routing — which tools use which token

The runtime supports both tokens (`getSlackClient(useUserToken=true|false)`
in `src/slackClient.ts`). The two send tools opt into the user token via
the `asUser` parameter; the rest are bot-only.

| Tool | Token | Why |
|---|---|---|
| `slack_send_dm` | bot, or user when `asUser: true` | Default bot identity for notifications (e.g. daily briefing). `asUser: true` posts as the operator — Brandon sees a DM from *you*, not from "Paperclip Bot". |
| `slack_send_channel` | bot, or user when `asUser: true` | Same — default bot for announcements; `asUser: true` posts as the operator (operator must be a channel member). |
| `slack_add_reaction` | bot, or user when `asUser: true` | Bot reaction by default; `asUser: true` reacts as the operator. |
| `slack_remove_reaction` | bot, or user when `asUser: true` | Each token only removes its own reactions — pick the same token that added it. |
| `slack_upload_file` | bot | files.uploadV2 — ships text/snippet content to the channel. |
| `slack_read_channel` | bot | conversations.history. Gated by `allowReadHistory`. |
| `slack_read_thread` | bot | conversations.replies. Gated by `allowReadHistory`. |
| `slack_search_messages` | **user (required)** | Bot tokens cannot call `search.messages`. Also gated by `allowReadHistory`. |
| `slack_set_user_status` | **user (required)** | Bots cannot change a user's status. |
| `slack_update_message` | bot | Slack restricts edit to the originating token, so this only edits bot-sent messages. Messages sent with `asUser: true` can't be edited by this tool. |
| `slack_delete_message` | bot | Same restriction as update — bot-sent messages only. |
| `slack_lookup_user` | bot | Read-only profile lookup. |
| `slack_list_channels` | bot | Read-only channel list. |
| `slack_get_channel` | bot | Read-only channel metadata. |
| `slack_list_users` | bot | Roster lookup. |

### Sending as the operator (act-as-me)

Use case: an agent reaches out to a teammate, and the message should
appear from you so the teammate engages with their boss/colleague rather
than a bot. Example — the Brandon Activity Monitor pinging Brandon about
his current work:

```ts
await tools.invoke("slack_send_dm", {
  userId: "U_BRANDON_ID",
  asUser: true,
  text: "Hey Brandon — quick check on the Q2 audit. What's the holdup?",
});
```

Caveats when `asUser: true`:

- Requires `userTokenRef` to be configured on the workspace; otherwise the
  call returns `[ECONFIG] ... no userTokenRef configured`.
- The message can't be edited or deleted by `slack_update_message` /
  `slack_delete_message` (bot-token tools). For round-trip "pending →
  done" UX, stick with bot identity (`asUser: false` or omit).
- For channel posts, the operator must be a member of the channel — Slack
  doesn't honour `chat:write.public` for user tokens the way it does for
  bot tokens.

Future tools that *only* make sense on the user token — search, file
upload/download, reactions, reminders — are scoped on the user token by
the bundled manifest and will ship in a later release. Configuring
`userTokenRef` now means those tools will work as soon as they ship — no
Slack-side reinstall and no plugin reconfigure needed.

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

`0.4.0` — add 8 tools: `slack_read_channel`, `slack_read_thread`,
`slack_add_reaction`, `slack_remove_reaction`, `slack_upload_file`,
`slack_search_messages`, `slack_list_users`, `slack_set_user_status`. New
`allowReadHistory` master switch gates the message-history reads
(read_channel, read_thread, search_messages); off by default. Reaction
tools accept `asUser: true` like the send tools. Search and set-status
require user token. Bundled `slack-app-manifest.json` updated with the
extra bot scopes (channels:history, groups:history, im:history,
mpim:history, reactions:read, reactions:write, files:write, pins:read,
pins:write); existing v0.3.x installs need to re-import the manifest and
reinstall the app, then refresh the bot/user token secrets. New
`wrapSlackError` mappings for `file_upload_disabled`, `already_reacted`,
`no_reaction`. `[ECONFIG]` for missing user token now spells out which
field to add and where.

`0.3.1` — close the act-as-me gap on the send tools. Add an
`asUser: boolean` parameter to `slack_send_dm` and `slack_send_channel`;
when true, the message is posted via the workspace's `userTokenRef`
instead of the bot token, so the recipient sees the message from the
operator rather than the Paperclip Bot. Anchor use case: an
activity-monitor agent reaching out to a teammate from your identity.
Bot remains the default; existing morning-briefing flows unchanged.

`0.3.0` — ship `slack-app-manifest.json` so app creation is one-click
import (~37 OAuth scopes pre-declared). Make user token (`xoxp-`) a
first-class part of setup alongside the bot token; document token routing
per tool. Setup-instruction rewrite to match.

`0.1.0` — initial release. send/edit/delete/lookup/list/get; per-workspace
`allowedCompanies`; bot + optional user token; defaultDmTarget /
defaultChannel.
