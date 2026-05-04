import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "slack-tools";
const PLUGIN_VERSION = "0.2.0";

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
        "Paste the UUID of the secret holding this workspace's Slack bot token (xoxb-...). Create the secret first on the company's Secrets page; never paste the raw token here. To get the token: at api.slack.com/apps create or open your Slack App, install it to the workspace, then copy 'Bot User OAuth Token' from OAuth & Permissions. Required scopes: chat:write, chat:write.public, im:write, users:read, users:read.email, channels:read, groups:read.",
    },
    userTokenRef: {
      type: "string",
      format: "secret-ref",
      title: "User token (xoxp-..., optional)",
      description:
        "Paste the UUID of a secret holding a Slack user token (xoxp-...). Optional — only needed if a skill must act *as* the operator (e.g. send a message that appears from your own user). The bot token is sufficient for DMing the operator and posting to channels as a bot identity.",
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

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Slack Tools",
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
    propertyOrder: ["allowMutations", "defaultWorkspace", "workspaces"],
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow editing & deleting messages",
        description:
          "Master switch for slack_update_message and slack_delete_message. Set false (default) to keep the plugin in send-only mode — mutation tools return [EDISABLED] without hitting Slack. Send/lookup tools are unaffected. Flip to true only after you've reviewed which agents/skills can edit or delete.",
        default: false,
      },
      defaultWorkspace: {
        type: "string",
        title: "Default workspace key",
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
        "Send a direct message to a Slack user. Defaults the recipient to the workspace's defaultDmTarget so skills can omit userId. Supports plain text and Block Kit blocks; threading via threadTs.",
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
        },
        required: ["text"],
      },
    },
    {
      name: "slack_send_channel",
      displayName: "Send Slack channel message",
      description:
        "Post a message to a Slack channel. Address by channelId (preferred) OR channelName (resolved to ID via cache). Supports text, Block Kit, threading.",
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
  ],
};

export default manifest;
