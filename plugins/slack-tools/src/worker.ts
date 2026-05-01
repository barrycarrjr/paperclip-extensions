import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  type ConfigWorkspace,
  type InstanceConfig,
  type ResolvedWorkspace,
  getSlackClient,
  resolveChannelId,
  wrapSlackError,
} from "./slackClient.js";
import { isCompanyAllowed } from "./companyAccess.js";

type ResolveResult =
  | { ok: true; resolved: ResolvedWorkspace }
  | { ok: false; error: string };

async function resolveOrError(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  workspaceKey: string | undefined,
): Promise<ResolveResult> {
  try {
    const resolved = await getSlackClient(ctx, runCtx, toolName, workspaceKey);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  workspaceKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.telemetry.track(`slack-tools.${tool}`, {
      workspace: workspaceKey,
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // telemetry failures should never break tool calls
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("slack-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const workspaces: ConfigWorkspace[] = rawConfig.workspaces ?? [];

    if (workspaces.length === 0) {
      ctx.logger.warn(
        "slack-tools: no workspaces configured. Add them on /instance/settings/plugins/slack-tools.",
      );
    } else {
      const summary = workspaces
        .map((w) => {
          const k = w.key ?? "(no-key)";
          const allowed = w.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          const tokens = `${w.botTokenRef ? "bot" : ""}${w.botTokenRef && w.userTokenRef ? "+" : ""}${w.userTokenRef ? "user" : ""}`;
          return `${k} [${tokens || "no-token"}, ${access}]`;
        })
        .join(", ");
      ctx.logger.info(
        `slack-tools: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Workspaces — ${summary}`,
      );

      const orphans = workspaces.filter(
        (w) => !w.allowedCompanies || w.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `slack-tools: ${orphans.length} workspace(s) have no allowedCompanies and will reject every call. ` +
            `Backfill on the plugin settings page: ${orphans
              .map((w) => w.key ?? "(no-key)")
              .join(", ")}`,
        );
      }
    }

    ctx.tools.register(
      "slack_send_dm",
      {
        displayName: "Send Slack DM",
        description:
          "Send a direct message to a Slack user. Falls back to defaultDmTarget when userId is omitted.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            userId: { type: "string" },
            text: { type: "string" },
            blocks: { type: "array", items: { type: "object" } },
            threadTs: { type: "string" },
          },
          required: ["text"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          userId?: string;
          text?: string;
          blocks?: unknown[];
          threadTs?: string;
        };
        if (!p.text) return { error: "[EINVALID_INPUT] `text` is required" };

        const r = await resolveOrError(ctx, runCtx, "slack_send_dm", p.workspace);
        if (!r.ok) return { error: r.error };

        const target = p.userId ?? r.resolved.workspace.defaultDmTarget;
        if (!target) {
          return {
            error:
              "[EINVALID_INPUT] No userId provided and workspace has no defaultDmTarget configured.",
          };
        }

        try {
          // chat.postMessage with a user ID as channel opens the IM and posts.
          const result = await r.resolved.client.chat.postMessage({
            channel: target,
            text: p.text,
            blocks: p.blocks as never,
            thread_ts: p.threadTs,
          });
          await track(ctx, runCtx, "slack_send_dm", r.resolved.workspaceKey, {
            target,
            threaded: !!p.threadTs,
            hasBlocks: Array.isArray(p.blocks),
          });
          return {
            content: `DM sent to ${target} on ${r.resolved.workspaceKey}.`,
            data: { ts: result.ts ?? null, channel: result.channel ?? null },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_send_channel",
      {
        displayName: "Send Slack channel message",
        description:
          "Post a message to a Slack channel. Address by channelId (preferred) or channelName.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            channelName: { type: "string" },
            text: { type: "string" },
            blocks: { type: "array", items: { type: "object" } },
            threadTs: { type: "string" },
          },
          required: ["text"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          channelId?: string;
          channelName?: string;
          text?: string;
          blocks?: unknown[];
          threadTs?: string;
        };
        if (!p.text) return { error: "[EINVALID_INPUT] `text` is required" };

        const r = await resolveOrError(ctx, runCtx, "slack_send_channel", p.workspace);
        if (!r.ok) return { error: r.error };

        let channelId =
          p.channelId ??
          (p.channelName ? null : r.resolved.workspace.defaultChannel ?? null);

        if (!channelId && p.channelName) {
          try {
            channelId = await resolveChannelId(r.resolved, p.channelName);
          } catch (err) {
            return { error: wrapSlackError(err) };
          }
          if (!channelId) {
            return {
              error: `[ESLACK_CHANNEL_NOT_FOUND] No channel named "${p.channelName}" visible to the bot.`,
            };
          }
        }

        if (!channelId) {
          return {
            error:
              "[EINVALID_INPUT] Provide channelId or channelName, or set defaultChannel on the workspace.",
          };
        }

        try {
          const result = await r.resolved.client.chat.postMessage({
            channel: channelId,
            text: p.text,
            blocks: p.blocks as never,
            thread_ts: p.threadTs,
          });
          await track(ctx, runCtx, "slack_send_channel", r.resolved.workspaceKey, {
            channelId,
            threaded: !!p.threadTs,
            hasBlocks: Array.isArray(p.blocks),
          });
          return {
            content: `Message posted to ${channelId} on ${r.resolved.workspaceKey}.`,
            data: { ts: result.ts ?? null, channel: result.channel ?? null },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_update_message",
      {
        displayName: "Edit Slack message",
        description: "Edit a previously-sent message. Gated by allowMutations.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            ts: { type: "string" },
            text: { type: "string" },
            blocks: { type: "array", items: { type: "object" } },
          },
          required: ["channelId", "ts"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        if (!allowMutations) {
          return {
            error:
              "[EDISABLED] slack_update_message is disabled. Enable 'Allow editing & deleting messages' on /instance/settings/plugins/slack-tools.",
          };
        }
        const p = params as {
          workspace?: string;
          channelId?: string;
          ts?: string;
          text?: string;
          blocks?: unknown[];
        };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };
        if (!p.ts) return { error: "[EINVALID_INPUT] `ts` is required" };
        if (!p.text && !p.blocks) {
          return { error: "[EINVALID_INPUT] Provide `text` and/or `blocks` to update." };
        }

        const r = await resolveOrError(ctx, runCtx, "slack_update_message", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const result = await r.resolved.client.chat.update({
            channel: p.channelId,
            ts: p.ts,
            text: p.text ?? "",
            blocks: p.blocks as never,
          });
          await track(ctx, runCtx, "slack_update_message", r.resolved.workspaceKey, {
            channelId: p.channelId,
          });
          return {
            content: `Updated message ${p.ts} in ${p.channelId}.`,
            data: { ok: !!result.ok, ts: result.ts ?? p.ts },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_delete_message",
      {
        displayName: "Delete Slack message",
        description: "Delete a previously-sent message. Gated by allowMutations.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            ts: { type: "string" },
          },
          required: ["channelId", "ts"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        if (!allowMutations) {
          return {
            error:
              "[EDISABLED] slack_delete_message is disabled. Enable 'Allow editing & deleting messages' on /instance/settings/plugins/slack-tools.",
          };
        }
        const p = params as { workspace?: string; channelId?: string; ts?: string };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };
        if (!p.ts) return { error: "[EINVALID_INPUT] `ts` is required" };

        const r = await resolveOrError(ctx, runCtx, "slack_delete_message", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const result = await r.resolved.client.chat.delete({
            channel: p.channelId,
            ts: p.ts,
          });
          await track(ctx, runCtx, "slack_delete_message", r.resolved.workspaceKey, {
            channelId: p.channelId,
          });
          return {
            content: `Deleted message ${p.ts} in ${p.channelId}.`,
            data: { ok: !!result.ok },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_lookup_user",
      {
        displayName: "Look up Slack user",
        description: "Resolve a Slack user by email or by user ID.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            email: { type: "string" },
            userId: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { workspace?: string; email?: string; userId?: string };
        if (!p.email && !p.userId) {
          return { error: "[EINVALID_INPUT] Provide `email` or `userId`." };
        }
        if (p.email && p.userId) {
          return { error: "[EINVALID_INPUT] Provide only one of `email` or `userId`." };
        }

        const r = await resolveOrError(ctx, runCtx, "slack_lookup_user", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const profile = p.email
            ? await r.resolved.client.users.lookupByEmail({ email: p.email })
            : await r.resolved.client.users.info({ user: p.userId! });

          const user = profile.user;
          if (!user) {
            return { error: "[ESLACK_USER_NOT_FOUND] no user returned" };
          }
          await track(ctx, runCtx, "slack_lookup_user", r.resolved.workspaceKey, {
            mode: p.email ? "email" : "userId",
          });
          return {
            content: `Resolved user ${user.id ?? "?"}.`,
            data: {
              id: user.id ?? null,
              name: user.name ?? null,
              realName: user.real_name ?? null,
              email: user.profile?.email ?? null,
              isBot: !!user.is_bot,
              deleted: !!user.deleted,
              tz: user.tz ?? null,
            },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_list_channels",
      {
        displayName: "List Slack channels",
        description: "List channels in the workspace, optionally filtered by name substring.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
            types: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          query?: string;
          limit?: number;
          types?: string;
        };
        const limit = clampLimit(p.limit, 100, 1000);
        const types = p.types ?? "public_channel,private_channel";

        const r = await resolveOrError(ctx, runCtx, "slack_list_channels", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const collected: Array<{
            id: string;
            name: string;
            isPrivate: boolean;
            memberCount: number | null;
            isArchived: boolean;
          }> = [];
          let cursor: string | undefined;
          const q = (p.query ?? "").trim().toLowerCase();
          while (collected.length < limit) {
            const resp = await r.resolved.client.conversations.list({
              cursor,
              limit: Math.min(1000, limit - collected.length + 50),
              types,
              exclude_archived: false,
            });
            for (const ch of resp.channels ?? []) {
              if (!ch.id || !ch.name) continue;
              if (q && !ch.name.toLowerCase().includes(q)) continue;
              collected.push({
                id: ch.id,
                name: ch.name,
                isPrivate: !!ch.is_private,
                memberCount: ch.num_members ?? null,
                isArchived: !!ch.is_archived,
              });
              if (collected.length >= limit) break;
            }
            cursor = resp.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
          }
          await track(ctx, runCtx, "slack_list_channels", r.resolved.workspaceKey, {
            count: collected.length,
            query: q || null,
          });
          return {
            content: `Listed ${collected.length} channel(s).`,
            data: { channels: collected },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_get_channel",
      {
        displayName: "Get Slack channel",
        description: "Retrieve channel metadata (purpose, topic, member count) for one channel.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
          },
          required: ["channelId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { workspace?: string; channelId?: string };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };

        const r = await resolveOrError(ctx, runCtx, "slack_get_channel", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const result = await r.resolved.client.conversations.info({
            channel: p.channelId,
            include_num_members: true,
          });
          await track(ctx, runCtx, "slack_get_channel", r.resolved.workspaceKey, {
            channelId: p.channelId,
          });
          return {
            content: `Retrieved channel ${p.channelId}.`,
            data: result.channel ?? null,
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "slack-tools ready" };
  },
});

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

export default plugin;
runWorker(plugin, import.meta.url);

// Silence unused-import warnings while keeping the symbol available for
// downstream type consumers.
void isCompanyAllowed;
