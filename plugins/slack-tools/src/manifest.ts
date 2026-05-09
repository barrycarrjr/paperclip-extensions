import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "slack-tools";
const PLUGIN_VERSION = "0.4.2";

const workspaceItemSchema = {
  type: "object",
  required: ["key", "botTokenRef", "allowedCompanies"],
  propertyOrder: [
    // Identity & primary auth
    "key",
    "displayName",
    "botTokenRef",
    "userTokenRef",
    // Defaults agents fall back to
    "defaultDmTarget",
    "defaultChannel",
    // Access control
    "allowedCompanies",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling Slack tools (e.g. 'main', 'team-main'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it. Must be unique across workspaces.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description:
        "Human-readable label shown in this settings form (e.g. 'Acme Slack', 'Beta Slack'). Free-form; you can rename it later without breaking anything.",
    },
    botTokenRef: {
      type: "string",
      format: "secret-ref",
      title: "Bot token (xoxb-...)",
      description:
        "Paste the UUID of the secret holding this workspace's Slack bot token (xoxb-...). Used by tools that announce or notify (channel posts, operator DMs from the bot identity). Create the Slack App by importing the bundled `slack-app-manifest.json` at api.slack.com/apps (Create New App → From a manifest), install it to your workspace, then copy 'Bot User OAuth Token' from OAuth & Permissions. Store it as a secret on the company's Secrets page and paste the secret's UUID here — never paste the raw token.",
    },
    userTokenRef: {
      type: "string",
      format: "secret-ref",
      title: "User token (xoxp-...)",
      description:
        "Paste the UUID of the secret holding this workspace's Slack user token (xoxp-...). Used by tools that act *as you* — search, file uploads, reactions, reminders, personal-identity DMs. The whole point of an assistant plugin is acting on the operator's behalf, so this is first-class: configure it at install time alongside the bot token. Get it from the same OAuth & Permissions page as the bot token after installing the app via the bundled manifest. Store it as a secret on the company's Secrets page and paste the secret's UUID here.",
    },
    defaultDmTarget: {
      type: "string",
      title: "Default DM target user ID",
      description:
        "U-prefixed Slack user ID for the operator (e.g. 'U01ABCDEFGH'). When skills call slack_send_dm without specifying userId, this is the recipient. Saves looking up every time. Run slack_lookup_user once with your email to get the ID, then paste here.",
    },
    defaultChannel: {
      type: "string",
      title: "Default channel ID (optional)",
      description:
        "C-prefixed channel ID (e.g. 'C01ABCDEFGH') used when slack_send_channel is called without channelId or channelName. Useful when one workspace has a single 'ops' channel everything posts to.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may call Slack tools against this workspace. Tick 'Portfolio-wide' to allow every company; otherwise tick the specific companies. Empty = unusable (fail-safe deny). Typically a Slack workspace belongs to one LLC's team, so use a single-company list rather than ['*'].",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup — Slack Tools

Connect one or more Slack workspaces so agents can send DMs, post to channels, and (in future tools) act on your behalf for search, files, reactions, and reminders. Reckon on **about 5 minutes** per workspace using the bundled manifest.

This plugin uses **dual-token auth**: a bot token for announce/notify operations and a user token for "act as me" operations. Configure both at install time — the whole point of an assistant plugin is acting on the operator's behalf, so the user token is first-class.

---

## 1. Create the Slack App from the bundled manifest

The plugin ships a \`slack-app-manifest.json\` file in its source folder ([github.com/.../paperclip-extensions/plugins/slack-tools](https://github.com/)). It declares all the OAuth scopes both tokens need, so you don't click ~37 checkboxes by hand.

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**.
2. Pick the workspace you want to connect.
3. Paste the contents of \`slack-app-manifest.json\` and click **Next** → **Create**.

The app is now configured with the scopes for both bot and user tokens.

---

## 2. Install the app and grab BOTH tokens

On the new app's **OAuth & Permissions** page, click **Install to Workspace** and approve. After install, the page shows two tokens:

- **Bot User OAuth Token** — starts with \`xoxb-...\` — bot identity (channel posts, operator DMs)
- **User OAuth Token** — starts with \`xoxp-...\` — your identity (search, files, reactions, reminders)

Copy both.

---

## 3. Store both tokens as Paperclip secrets

In Paperclip, switch to the company that should own this workspace connection. For each token:

- Go to **Secrets → Add**
- Name it descriptively (e.g. \`SLACK_BOT_TOKEN_MAIN\`, \`SLACK_USER_TOKEN_MAIN\`)
- Paste the token as the value
- Save, then **copy the secret's UUID**

You'll have two secret UUIDs at the end.

---

## 4. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above. Under **Slack workspaces**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | \`main\` |
| **Display name** | (e.g. "Acme Slack") |
| **Bot token** | paste the bot-token secret UUID from step 3 |
| **User token** | paste the user-token secret UUID from step 3 |
| **Default DM target** | your Slack user ID — see step 5 |
| **Default channel ID** | optional; a C-prefixed channel ID for the default posting channel |
| **Allowed companies** | tick the company that owns this workspace |

At the top, set **Default workspace key** to \`main\`.

---

## 5. Find your Slack user ID (for Default DM target)

Run \`slack_lookup_user\` with your email once after setup:

\`\`\`json
{ "email": "you@example.com" }
\`\`\`

Copy the returned \`userId\` (U-prefixed) and paste it into **Default DM target user ID** in the workspace config above. This is what skills use when they call \`slack_send_dm\` without specifying a recipient.

---

## Token routing — which tools use which token

Default = bot token (announce/notify identity). Send / reaction tools opt into the user token via \`asUser: true\`. Search and status tools always require the user token.

- \`slack_send_dm\` / \`slack_send_channel\` — bot by default; \`asUser: true\` posts as the operator (e.g. an activity-monitor agent reaching out to a teammate from your identity).
- \`slack_add_reaction\` / \`slack_remove_reaction\` — bot reaction by default; \`asUser: true\` reacts as the operator. Slack restricts removal to the originating token, so a bot reaction can't be removed with \`asUser: true\` and vice versa.
- \`slack_search_messages\` — **user token only**. Bot tokens cannot call \`search.messages\`.
- \`slack_set_user_status\` — **user token only**. Bots cannot change a user's status.
- \`slack_update_message\` / \`slack_delete_message\` — bot only. Each token can only edit/delete its own sends, so messages sent with \`asUser: true\` can't be edited via these tools.
- \`slack_read_channel\`, \`slack_read_thread\`, \`slack_lookup_user\`, \`slack_list_channels\`, \`slack_list_users\`, \`slack_get_channel\` — bot-token reads. \`slack_upload_file\` is also bot-token.

## Read-history safety switch

\`slack_read_channel\`, \`slack_read_thread\`, and \`slack_search_messages\` return raw message bodies — these are gated behind the **Allow reading message history** switch on the Configuration tab. Off by default; flip on after you've reviewed which agents are allowed to read message content. Roster and channel-metadata reads (\`slack_lookup_user\`, \`slack_list_users\`, \`slack_list_channels\`, \`slack_get_channel\`) stay ungated since they don't expose message bodies.

## Required scopes (already in the bundled manifest)

The shipped \`slack-app-manifest.json\` declares everything every current tool needs, including:
- Bot: \`chat:write\`, \`chat:write.public\`, \`im:write\`, \`channels:read\`, \`groups:read\`, \`channels:history\`, \`groups:history\`, \`im:history\`, \`mpim:history\`, \`reactions:read\`, \`reactions:write\`, \`files:write\`, \`pins:read\`, \`pins:write\`, \`users:read\`, \`users:read.email\`.
- User: \`search:read\`, \`reactions:write\`, \`users.profile:write\`, plus the rest of the act-as-me set (chat, files, im/groups/channels history, etc.).

If you upgraded from v0.3.x, **re-import the v0.4.0 manifest at api.slack.com/apps** (App Manifest → Edit → paste the new JSON), then **reinstall the app to your workspace**. Reinstalling rotates both tokens, so update the \`SLACK_BOT_TOKEN_*\` and \`SLACK_USER_TOKEN_*\` secrets afterward.

---

## Troubleshooting

- **\`not_in_channel\` error** — the bot isn't a member of the channel. Either invite it with \`/invite @YourBot\` in Slack, or use \`chat:write.public\` scope (already in the manifest) and post to a public channel.
- **\`missing_scope\` error** — Slack added a new scope or you've imported an older manifest. Re-import the latest \`slack-app-manifest.json\`, reinstall the app, and update both secrets (the tokens change on reinstall).
- **\`channel_not_found\`** — double-check you're passing a C-prefixed channel ID, not a channel name. Use \`slack_list_channels\` to find the correct ID.
- **\`[ECONFIG] ... no userTokenRef configured\`** — a future tool needs the user token but you didn't set one. Add the \`xoxp-\` secret and paste its UUID into the workspace's User token field.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Send DMs, channel messages, and Block Kit messages to Slack. Multi-workspace, per-workspace company isolation, edit/delete gated. Anchor use case: the daily CEO morning briefing arrives as a Slack DM.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: [
      "allowMutations",
      "allowReadHistory",
      "defaultWorkspace",
      "workspaces",
    ],
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow editing & deleting messages",
        description:
          "Master switch for slack_update_message and slack_delete_message. Set false (default) to keep the plugin in send-only mode — mutation tools return [EDISABLED] without hitting Slack. Send/lookup tools are unaffected. Flip to true only after you've reviewed which agents/skills can edit or delete.",
        default: false,
      },
      allowReadHistory: {
        type: "boolean",
        title: "Allow reading message history",
        description:
          "Master switch for slack_read_channel, slack_read_thread, and slack_search_messages — tools that return raw message bodies. Set false (default) to keep the plugin from exposing channel/thread/search content; gated tools return [EDISABLED] without hitting Slack. Roster and channel-metadata reads (slack_lookup_user, slack_list_users, slack_list_channels, slack_get_channel) are unaffected. Flip to true only after you've reviewed which agents/skills can read message bodies — Slack history is sensitive and contains everything members have ever posted in those channels.",
        default: false,
      },
      defaultWorkspace: {
        type: "string",
        title: "Default workspace key",
        "x-paperclip-optionsFromSibling": {
          sibling: "workspaces",
          valueKey: "key",
          labelKey: "displayName",
        },
        description:
          "Identifier of the workspace used when an agent omits the `workspace` parameter in a tool call. Strict: if the calling company isn't in the default workspace's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no automatic fallback). Leave blank to require an explicit `workspace` on every call.",
      },
      workspaces: {
        type: "array",
        title: "Slack workspaces",
        description:
          "One entry per Slack workspace this plugin can talk to. Most operators have one workspace per LLC. Every workspace must list 'Allowed companies' — empty list = unusable (fail-safe deny).",
        items: workspaceItemSchema,
      },
    },
  },
  tools: [
    {
      name: "slack_send_dm",
      displayName: "Send Slack DM",
      description:
        "Send a direct message to a Slack user. Defaults the recipient to the workspace's defaultDmTarget so skills can omit userId. Supports plain text and Block Kit blocks; threading via threadTs. Set `asUser: true` to send as the operator (xoxp- user token) instead of the bot.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description:
              "Workspace identifier as configured on the plugin settings page. Optional — falls back to defaultWorkspace.",
          },
          userId: {
            type: "string",
            description:
              "U-prefixed Slack user ID (e.g. 'U01ABCDEFGH'). Optional — falls back to the workspace's defaultDmTarget.",
          },
          text: {
            type: "string",
            description:
              "Plain-text body. Required even when blocks are used (Slack uses text as the notification fallback).",
          },
          blocks: {
            type: "array",
            description:
              "Optional Block Kit array. See https://app.slack.com/block-kit-builder/ to design blocks visually, then paste the JSON here. The README documents common templates (status update, approval request, error alert).",
            items: { type: "object" },
          },
          threadTs: {
            type: "string",
            description:
              "Optional thread timestamp to reply within an existing thread. Use the `ts` returned from a prior slack_send_dm/channel call.",
          },
          asUser: {
            type: "boolean",
            description:
              "If true, post as the operator using the workspace's userTokenRef (xoxp-...). The recipient sees a DM from the operator instead of from the Paperclip Bot. Default false. Use for skills that should appear to come from the user (e.g. an activity-monitor agent reaching out to a teammate). Slack restricts edit/delete to the original token, so messages sent with asUser:true cannot be edited or deleted by slack_update_message / slack_delete_message.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "slack_send_channel",
      displayName: "Send Slack channel message",
      description:
        "Post a message to a Slack channel. Address by channelId (preferred) OR channelName (resolved to ID via cache). Supports text, Block Kit, threading. Set `asUser: true` to post as the operator (xoxp- user token) instead of the bot.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: {
            type: "string",
            description:
              "Workspace identifier. Optional — falls back to defaultWorkspace.",
          },
          channelId: {
            type: "string",
            description:
              "C-prefixed channel ID (e.g. 'C01ABCDEFGH'). Preferred over channelName because channels can be renamed.",
          },
          channelName: {
            type: "string",
            description:
              "Channel name without the leading '#' (e.g. 'ops', 'general'). Slower than channelId — the worker resolves to ID via the channels.list cache. Use channelId in production skills.",
          },
          text: {
            type: "string",
            description: "Plain-text body. Required as Slack notification fallback.",
          },
          blocks: {
            type: "array",
            description: "Optional Block Kit array.",
            items: { type: "object" },
          },
          threadTs: {
            type: "string",
            description: "Optional thread timestamp to reply within an existing thread.",
          },
          asUser: {
            type: "boolean",
            description:
              "If true, post as the operator using the workspace's userTokenRef (xoxp-...). The channel sees a message from the operator instead of from the Paperclip Bot. Default false. The operator must be a member of the channel. Slack restricts edit/delete to the original token, so messages sent with asUser:true cannot be edited or deleted by slack_update_message / slack_delete_message.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "slack_update_message",
      displayName: "Edit Slack message",
      description:
        "Edit a message previously sent by the bot. Useful for 'pending → done' status messages. Gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: { type: "string", description: "Channel where the message lives." },
          ts: {
            type: "string",
            description: "Message timestamp (ts) returned by the prior send call.",
          },
          text: { type: "string", description: "New plain-text body." },
          blocks: {
            type: "array",
            description: "New Block Kit body. Replaces all blocks.",
            items: { type: "object" },
          },
        },
        required: ["channelId", "ts"],
      },
    },
    {
      name: "slack_delete_message",
      displayName: "Delete Slack message",
      description:
        "Delete a message previously sent by the bot. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: { type: "string", description: "Channel where the message lives." },
          ts: { type: "string", description: "Message timestamp (ts) of the message to delete." },
        },
        required: ["channelId", "ts"],
      },
    },
    {
      name: "slack_lookup_user",
      displayName: "Look up Slack user",
      description:
        "Resolve a Slack user by email or user ID. Use once at setup time to find the operator's user ID for defaultDmTarget.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          email: {
            type: "string",
            description:
              "Email address to look up. Requires the bot's users:read.email scope. Mutually exclusive with userId.",
          },
          userId: {
            type: "string",
            description: "U-prefixed user ID to fetch the profile for. Mutually exclusive with email.",
          },
        },
      },
    },
    {
      name: "slack_list_channels",
      displayName: "List Slack channels",
      description:
        "List channels in the workspace, filtered by query (substring on name). Returns id, name, isPrivate, memberCount. Useful for finding channelId at setup time.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          query: {
            type: "string",
            description:
              "Optional case-insensitive substring filter applied to channel name. Empty = all channels.",
          },
          limit: {
            type: "number",
            description: "Max channels to return. Default 100, max 1000.",
          },
          types: {
            type: "string",
            description:
              "Slack channel types: 'public_channel', 'private_channel', 'mpim', 'im'. Comma-separated. Default 'public_channel,private_channel'.",
          },
        },
      },
    },
    {
      name: "slack_get_channel",
      displayName: "Get Slack channel",
      description: "Retrieve channel metadata (purpose, topic, members count) for one channel.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: { type: "string", description: "C-prefixed channel ID." },
        },
        required: ["channelId"],
      },
    },
    {
      name: "slack_read_channel",
      displayName: "Read Slack channel history",
      description:
        "Read recent messages from a channel or DM via conversations.history. Returns ts, text, userId, threadTs, replyCount per message. Gated by the plugin's `Allow reading message history` master switch — returns [EDISABLED] when the switch is off.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: {
            type: "string",
            description: "C-prefixed channel ID, or D-prefixed DM ID. Required.",
          },
          limit: {
            type: "number",
            description: "Max messages to return. Default 20, clamped 1–100.",
          },
          oldest: {
            type: "string",
            description: "Unix timestamp (seconds, may include sub-second precision e.g. '1696200000.000100'). Only return messages posted after this time.",
          },
          latest: {
            type: "string",
            description: "Unix timestamp. Only return messages posted before this time.",
          },
        },
        required: ["channelId"],
      },
    },
    {
      name: "slack_read_thread",
      displayName: "Read Slack thread replies",
      description:
        "Read replies in a message thread via conversations.replies. Returns ts, text, userId, isParent per message; the parent is index 0 with isParent:true. Gated by `Allow reading message history`.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: {
            type: "string",
            description: "Channel ID where the thread lives. Required.",
          },
          threadTs: {
            type: "string",
            description: "Timestamp (`ts`) of the parent message. Required.",
          },
          limit: {
            type: "number",
            description: "Max messages to return (including parent). Default 20, clamped 1–100.",
          },
        },
        required: ["channelId", "threadTs"],
      },
    },
    {
      name: "slack_add_reaction",
      displayName: "Add Slack reaction",
      description:
        "Add an emoji reaction to a message via reactions.add. Default is the bot identity; pass `asUser: true` to react as the operator (requires userTokenRef).",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: { type: "string", description: "Channel where the message lives." },
          ts: {
            type: "string",
            description: "Timestamp (`ts`) of the message to react to.",
          },
          emoji: {
            type: "string",
            description:
              "Emoji name without colons (e.g. 'thumbsup', 'eyes'). Surrounding colons are stripped if present.",
          },
          asUser: {
            type: "boolean",
            description:
              "If true, react as the operator using the workspace's userTokenRef (xoxp-...). Default false (bot reaction).",
          },
        },
        required: ["channelId", "ts", "emoji"],
      },
    },
    {
      name: "slack_remove_reaction",
      displayName: "Remove Slack reaction",
      description:
        "Remove an emoji reaction from a message via reactions.remove. Default bot identity; pass `asUser: true` to remove the operator's reaction (requires userTokenRef). Each token can only remove its own reactions.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: { type: "string", description: "Channel where the message lives." },
          ts: { type: "string", description: "Timestamp (`ts`) of the message." },
          emoji: {
            type: "string",
            description: "Emoji name without colons. Surrounding colons are stripped if present.",
          },
          asUser: {
            type: "boolean",
            description:
              "If true, remove the operator's reaction using userTokenRef (xoxp-...). Default false (remove bot reaction).",
          },
        },
        required: ["channelId", "ts", "emoji"],
      },
    },
    {
      name: "slack_upload_file",
      displayName: "Upload file to Slack",
      description:
        "Upload a text/snippet file to a channel via files.uploadV2. Use this for log dumps, code snippets, JSON payloads, etc. Returns the file ID and permalink.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          channelId: {
            type: "string",
            description: "C-prefixed channel ID where the file will be shared.",
          },
          content: {
            type: "string",
            description:
              "Text content to upload (the file body). For text/code files only — binary uploads aren't exposed by this tool.",
          },
          filename: {
            type: "string",
            description:
              "Filename including extension (e.g. 'report.txt', 'queries.sql'). Slack uses the extension to highlight the snippet.",
          },
          title: { type: "string", description: "Optional display title shown in Slack." },
          threadTs: {
            type: "string",
            description: "Optional thread timestamp to upload the file as a reply.",
          },
        },
        required: ["channelId", "content", "filename"],
      },
    },
    {
      name: "slack_search_messages",
      displayName: "Search Slack messages",
      description:
        "Search messages across the workspace via search.messages. Supports Slack search syntax (in:#channel, from:@user, before:, after:, has:link, etc.). Returns ts, channelId, channelName, text, userId, permalink per match. **Requires user token** — bot tokens cannot search. Gated by `Allow reading message history`.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          query: {
            type: "string",
            description:
              "Slack search query string. Supports modifiers like 'in:#ops from:@barry has:link before:2026-04-01'. Required.",
          },
          limit: {
            type: "number",
            description: "Max matches to return. Default 20, clamped 1–50.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "slack_list_users",
      displayName: "List Slack users",
      description:
        "List members of the workspace via users.list (paginated). By default filters out bots and deactivated users. Returns id, name, realName, email, isBot, deleted, tz per member.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          limit: {
            type: "number",
            description: "Max users to return. Default 100, clamped 1–500.",
          },
          includeDeleted: {
            type: "boolean",
            description:
              "If true, also return bots and deactivated/deleted users. Default false.",
          },
        },
      },
    },
    {
      name: "slack_set_user_status",
      displayName: "Set Slack user status",
      description:
        "Set the operator's Slack status (status text + emoji + optional expiry) via users.profile.set. **Requires user token** — bots cannot change a user's status.",
      parametersSchema: {
        type: "object",
        properties: {
          workspace: { type: "string", description: "Workspace identifier. Optional." },
          statusText: {
            type: "string",
            description: "Status text. Max 100 chars (Slack limit).",
          },
          statusEmoji: {
            type: "string",
            description: "Emoji name with surrounding colons (e.g. ':laptop:', ':palm_tree:').",
          },
          statusExpiry: {
            type: "number",
            description:
              "Unix timestamp (seconds) when the status should clear. 0 or omitted = no expiry.",
          },
        },
        required: ["statusText"],
      },
    },
  ],
};

export default manifest;
