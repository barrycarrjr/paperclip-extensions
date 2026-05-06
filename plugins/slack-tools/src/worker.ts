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
  useUserToken = false,
): Promise<ResolveResult> {
  try {
    const resolved = await getSlackClient(ctx, runCtx, toolName, workspaceKey, useUserToken);
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
    const allowReadHistory = !!rawConfig.allowReadHistory;
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
        `slack-tools: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}, history reads ${allowReadHistory ? "ENABLED" : "disabled"}). Workspaces — ${summary}`,
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
            asUser: { type: "boolean" },
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
          asUser?: boolean;
        };
        if (!p.text) return { error: "[EINVALID_INPUT] `text` is required" };

        const useUserToken = !!p.asUser;
        const r = await resolveOrError(
          ctx,
          runCtx,
          "slack_send_dm",
          p.workspace,
          useUserToken,
        );
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
            asUser: useUserToken,
          });
          return {
            content: `DM sent to ${target} on ${r.resolved.workspaceKey}${useUserToken ? " (as user)" : ""}.`,
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
            asUser: { type: "boolean" },
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
          asUser?: boolean;
        };
        if (!p.text) return { error: "[EINVALID_INPUT] `text` is required" };

        const useUserToken = !!p.asUser;
        const r = await resolveOrError(
          ctx,
          runCtx,
          "slack_send_channel",
          p.workspace,
          useUserToken,
        );
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
              error: `[ESLACK_CHANNEL_NOT_FOUND] No channel named "${p.channelName}" visible to the ${useUserToken ? "operator" : "bot"}.`,
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
            asUser: useUserToken,
          });
          return {
            content: `Message posted to ${channelId} on ${r.resolved.workspaceKey}${useUserToken ? " (as user)" : ""}.`,
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

    ctx.tools.register(
      "slack_read_channel",
      {
        displayName: "Read Slack channel history",
        description:
          "Read recent messages from a channel or DM. Gated by allowReadHistory.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            limit: { type: "number" },
            oldest: { type: "string" },
            latest: { type: "string" },
          },
          required: ["channelId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        if (!allowReadHistory) {
          return {
            error:
              "[EDISABLED] slack_read_channel is disabled. Enable 'Allow reading message history' on /instance/settings/plugins/slack-tools.",
          };
        }
        const p = params as {
          workspace?: string;
          channelId?: string;
          limit?: number;
          oldest?: string;
          latest?: string;
        };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };

        const limit = clampLimit(p.limit, 20, 100);
        const r = await resolveOrError(ctx, runCtx, "slack_read_channel", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const result = await r.resolved.client.conversations.history({
            channel: p.channelId,
            limit,
            oldest: p.oldest,
            latest: p.latest,
          });
          const messages = (result.messages ?? []).map((m) => ({
            ts: m.ts ?? null,
            text: m.text ?? null,
            userId: m.user ?? null,
            threadTs: m.thread_ts ?? null,
            replyCount: m.reply_count ?? null,
          }));
          await track(ctx, runCtx, "slack_read_channel", r.resolved.workspaceKey, {
            channelId: p.channelId,
            count: messages.length,
          });
          return {
            content: `Read ${messages.length} message(s) from ${p.channelId}.`,
            data: { messages },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_read_thread",
      {
        displayName: "Read Slack thread replies",
        description:
          "Read replies in a message thread. Gated by allowReadHistory.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            threadTs: { type: "string" },
            limit: { type: "number" },
          },
          required: ["channelId", "threadTs"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        if (!allowReadHistory) {
          return {
            error:
              "[EDISABLED] slack_read_thread is disabled. Enable 'Allow reading message history' on /instance/settings/plugins/slack-tools.",
          };
        }
        const p = params as {
          workspace?: string;
          channelId?: string;
          threadTs?: string;
          limit?: number;
        };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };
        if (!p.threadTs) return { error: "[EINVALID_INPUT] `threadTs` is required" };

        const limit = clampLimit(p.limit, 20, 100);
        const r = await resolveOrError(ctx, runCtx, "slack_read_thread", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const result = await r.resolved.client.conversations.replies({
            channel: p.channelId,
            ts: p.threadTs,
            limit,
          });
          // conversations.replies returns the parent at index 0, then replies in order.
          const replies = (result.messages ?? []).map((m, i) => ({
            ts: m.ts ?? null,
            text: m.text ?? null,
            userId: m.user ?? null,
            isParent: i === 0,
          }));
          await track(ctx, runCtx, "slack_read_thread", r.resolved.workspaceKey, {
            channelId: p.channelId,
            threadTs: p.threadTs,
            count: replies.length,
          });
          return {
            content: `Read ${replies.length} message(s) in thread ${p.threadTs}.`,
            data: { messages: replies },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_add_reaction",
      {
        displayName: "Add Slack reaction",
        description:
          "Add an emoji reaction to a message. Default bot identity; asUser:true reacts as the operator.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            ts: { type: "string" },
            emoji: { type: "string" },
            asUser: { type: "boolean" },
          },
          required: ["channelId", "ts", "emoji"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          channelId?: string;
          ts?: string;
          emoji?: string;
          asUser?: boolean;
        };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };
        if (!p.ts) return { error: "[EINVALID_INPUT] `ts` is required" };
        if (!p.emoji) return { error: "[EINVALID_INPUT] `emoji` is required" };

        const useUserToken = !!p.asUser;
        const r = await resolveOrError(
          ctx,
          runCtx,
          "slack_add_reaction",
          p.workspace,
          useUserToken,
        );
        if (!r.ok) return { error: r.error };

        // Slack expects the emoji name without surrounding colons.
        const name = p.emoji.replace(/^:|:$/g, "");

        try {
          await r.resolved.client.reactions.add({
            channel: p.channelId,
            timestamp: p.ts,
            name,
          });
          await track(ctx, runCtx, "slack_add_reaction", r.resolved.workspaceKey, {
            channelId: p.channelId,
            ts: p.ts,
            emoji: name,
            asUser: useUserToken,
          });
          return {
            content: `Reacted :${name}: on ${p.ts} in ${p.channelId}${useUserToken ? " (as user)" : ""}.`,
            data: { ok: true },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_remove_reaction",
      {
        displayName: "Remove Slack reaction",
        description:
          "Remove an emoji reaction from a message. Default bot identity; asUser:true removes the operator's reaction.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            ts: { type: "string" },
            emoji: { type: "string" },
            asUser: { type: "boolean" },
          },
          required: ["channelId", "ts", "emoji"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          channelId?: string;
          ts?: string;
          emoji?: string;
          asUser?: boolean;
        };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };
        if (!p.ts) return { error: "[EINVALID_INPUT] `ts` is required" };
        if (!p.emoji) return { error: "[EINVALID_INPUT] `emoji` is required" };

        const useUserToken = !!p.asUser;
        const r = await resolveOrError(
          ctx,
          runCtx,
          "slack_remove_reaction",
          p.workspace,
          useUserToken,
        );
        if (!r.ok) return { error: r.error };

        const name = p.emoji.replace(/^:|:$/g, "");

        try {
          await r.resolved.client.reactions.remove({
            channel: p.channelId,
            timestamp: p.ts,
            name,
          });
          await track(ctx, runCtx, "slack_remove_reaction", r.resolved.workspaceKey, {
            channelId: p.channelId,
            ts: p.ts,
            emoji: name,
            asUser: useUserToken,
          });
          return {
            content: `Removed :${name}: from ${p.ts} in ${p.channelId}${useUserToken ? " (as user)" : ""}.`,
            data: { ok: true },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_upload_file",
      {
        displayName: "Upload file to Slack",
        description:
          "Upload a text/snippet file to a channel via files.uploadV2. Returns the file ID and permalink.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            channelId: { type: "string" },
            content: { type: "string" },
            filename: { type: "string" },
            title: { type: "string" },
            threadTs: { type: "string" },
          },
          required: ["channelId", "content", "filename"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          channelId?: string;
          content?: string;
          filename?: string;
          title?: string;
          threadTs?: string;
        };
        if (!p.channelId) return { error: "[EINVALID_INPUT] `channelId` is required" };
        if (!p.content) return { error: "[EINVALID_INPUT] `content` is required" };
        if (!p.filename) return { error: "[EINVALID_INPUT] `filename` is required" };

        const r = await resolveOrError(ctx, runCtx, "slack_upload_file", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          // The SDK's destination union forbids `thread_ts: undefined` on
          // channel-only uploads — only set keys that have actual values.
          const args: Record<string, unknown> = {
            channel_id: p.channelId,
            content: p.content,
            filename: p.filename,
          };
          if (p.title) args.title = p.title;
          if (p.threadTs) args.thread_ts = p.threadTs;
          // files.uploadV2 returns { ok, files: [{ ok, files: [{ id, permalink, ... }] }] }.
          const result = (await r.resolved.client.files.uploadV2(
            args as Parameters<typeof r.resolved.client.files.uploadV2>[0],
          )) as {
            ok?: boolean;
            files?: Array<{ files?: Array<{ id?: string; permalink?: string }> }>;
          };
          const file = result.files?.[0]?.files?.[0];
          await track(ctx, runCtx, "slack_upload_file", r.resolved.workspaceKey, {
            channelId: p.channelId,
            filename: p.filename,
            threaded: !!p.threadTs,
          });
          return {
            content: `Uploaded ${p.filename} to ${p.channelId}.`,
            data: {
              fileId: file?.id ?? null,
              permalink: file?.permalink ?? null,
            },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_search_messages",
      {
        displayName: "Search Slack messages",
        description:
          "Search messages across the workspace using Slack search syntax. Requires user token. Gated by allowReadHistory.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        if (!allowReadHistory) {
          return {
            error:
              "[EDISABLED] slack_search_messages is disabled. Enable 'Allow reading message history' on /instance/settings/plugins/slack-tools.",
          };
        }
        const p = params as { workspace?: string; query?: string; limit?: number };
        if (!p.query) return { error: "[EINVALID_INPUT] `query` is required" };

        const limit = clampLimit(p.limit, 20, 50);
        const r = await resolveOrError(
          ctx,
          runCtx,
          "slack_search_messages",
          p.workspace,
          true,
        );
        if (!r.ok) return { error: r.error };

        try {
          const result = (await r.resolved.client.search.messages({
            query: p.query,
            count: limit,
          })) as {
            messages?: {
              matches?: Array<{
                ts?: string;
                text?: string;
                user?: string;
                permalink?: string;
                channel?: { id?: string; name?: string };
              }>;
            };
          };
          const matches = (result.messages?.matches ?? []).map((m) => ({
            ts: m.ts ?? null,
            channelId: m.channel?.id ?? null,
            channelName: m.channel?.name ?? null,
            text: m.text ?? null,
            userId: m.user ?? null,
            permalink: m.permalink ?? null,
          }));
          await track(ctx, runCtx, "slack_search_messages", r.resolved.workspaceKey, {
            count: matches.length,
            queryLength: p.query.length,
          });
          return {
            content: `Found ${matches.length} match(es).`,
            data: { matches },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_list_users",
      {
        displayName: "List Slack users",
        description:
          "List members of the workspace, paginated. Filters bots and deactivated users by default.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            limit: { type: "number" },
            includeDeleted: { type: "boolean" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          limit?: number;
          includeDeleted?: boolean;
        };
        const limit = clampLimit(p.limit, 100, 500);
        const includeDeleted = !!p.includeDeleted;

        const r = await resolveOrError(ctx, runCtx, "slack_list_users", p.workspace);
        if (!r.ok) return { error: r.error };

        try {
          const collected: Array<{
            id: string;
            name: string | null;
            realName: string | null;
            email: string | null;
            isBot: boolean;
            deleted: boolean;
            tz: string | null;
          }> = [];
          let cursor: string | undefined;
          while (collected.length < limit) {
            const resp = await r.resolved.client.users.list({
              cursor,
              limit: Math.min(200, limit - collected.length + 50),
            });
            for (const u of resp.members ?? []) {
              if (!u.id) continue;
              if (!includeDeleted && (u.deleted || u.is_bot)) continue;
              collected.push({
                id: u.id,
                name: u.name ?? null,
                realName: u.real_name ?? null,
                email: u.profile?.email ?? null,
                isBot: !!u.is_bot,
                deleted: !!u.deleted,
                tz: u.tz ?? null,
              });
              if (collected.length >= limit) break;
            }
            cursor = resp.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
          }
          await track(ctx, runCtx, "slack_list_users", r.resolved.workspaceKey, {
            count: collected.length,
            includeDeleted,
          });
          return {
            content: `Listed ${collected.length} user(s).`,
            data: { users: collected },
          };
        } catch (err) {
          return { error: wrapSlackError(err) };
        }
      },
    );

    ctx.tools.register(
      "slack_set_user_status",
      {
        displayName: "Set Slack user status",
        description:
          "Set the operator's Slack status (text + emoji + expiry). Requires user token.",
        parametersSchema: {
          type: "object",
          properties: {
            workspace: { type: "string" },
            statusText: { type: "string" },
            statusEmoji: { type: "string" },
            statusExpiry: { type: "number" },
          },
          required: ["statusText"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          workspace?: string;
          statusText?: string;
          statusEmoji?: string;
          statusExpiry?: number;
        };
        if (typeof p.statusText !== "string") {
          return { error: "[EINVALID_INPUT] `statusText` is required" };
        }
        if (p.statusText.length > 100) {
          return { error: "[EINVALID_INPUT] `statusText` exceeds 100 chars" };
        }

        const r = await resolveOrError(
          ctx,
          runCtx,
          "slack_set_user_status",
          p.workspace,
          true,
        );
        if (!r.ok) return { error: r.error };

        try {
          await r.resolved.client.users.profile.set({
            profile: {
              status_text: p.statusText,
              status_emoji: p.statusEmoji ?? "",
              status_expiration: p.statusExpiry ?? 0,
            },
          });
          await track(ctx, runCtx, "slack_set_user_status", r.resolved.workspaceKey, {
            hasEmoji: !!p.statusEmoji,
            hasExpiry: typeof p.statusExpiry === "number" && p.statusExpiry > 0,
          });
          return {
            content: `Set status on ${r.resolved.workspaceKey}.`,
            data: { ok: true },
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
