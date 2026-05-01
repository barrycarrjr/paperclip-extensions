import { WebClient, ErrorCode, type WebClientOptions } from "@slack/web-api";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export interface ConfigWorkspace {
  key?: string;
  displayName?: string;
  botTokenRef?: string;
  userTokenRef?: string;
  defaultDmTarget?: string;
  defaultChannel?: string;
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  allowMutations?: boolean;
  workspaces?: ConfigWorkspace[];
  defaultWorkspace?: string;
}

export interface ResolvedWorkspace {
  workspace: ConfigWorkspace;
  workspaceKey: string;
  client: WebClient;
  /**
   * Channel name → ID cache shared per resolved workspace. Populated lazily
   * when slack_send_channel is called with `channelName` instead of
   * `channelId`. We use a 5-minute TTL because Slack's conversations.list is
   * paginated and cheap to refresh.
   */
  channelCache: Map<string, { id: string; expiresAt: number }>;
}

interface CachedClient {
  client: WebClient;
  resolvedTokenRef: string;
  channelCache: Map<string, { id: string; expiresAt: number }>;
}

const clientCache = new Map<string, CachedClient>();
const cacheKey = (companyId: string, workspaceKey: string, useUserToken: boolean) =>
  `${companyId}::${workspaceKey.toLowerCase()}::${useUserToken ? "user" : "bot"}`;

export async function getSlackClient(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  workspaceKeyParam: string | undefined,
  useUserToken = false,
): Promise<ResolvedWorkspace> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const workspaces = config.workspaces ?? [];

  const requestedKey = (workspaceKeyParam ?? config.defaultWorkspace ?? "").trim();
  if (!requestedKey) {
    throw new Error(
      "[EWORKSPACE_REQUIRED] No `workspace` parameter provided and no `defaultWorkspace` configured on the plugin settings page.",
    );
  }

  const workspace = workspaces.find(
    (w) => (w.key ?? "").toLowerCase() === requestedKey.toLowerCase(),
  );
  if (!workspace) {
    throw new Error(
      `[EWORKSPACE_NOT_FOUND] Slack workspace "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `slack-tools workspace "${workspace.key}"`,
    resourceKey: workspace.key ?? requestedKey,
    allowedCompanies: workspace.allowedCompanies,
    companyId: runCtx.companyId,
  });

  const tokenRef = useUserToken ? workspace.userTokenRef : workspace.botTokenRef;
  if (!tokenRef) {
    throw new Error(
      `[ECONFIG] Slack workspace "${workspace.key}": no ${useUserToken ? "userTokenRef" : "botTokenRef"} configured.`,
    );
  }

  const ck = cacheKey(runCtx.companyId, workspace.key ?? requestedKey, useUserToken);
  const cached = clientCache.get(ck);
  if (cached && cached.resolvedTokenRef === tokenRef) {
    return {
      workspace,
      workspaceKey: workspace.key ?? requestedKey,
      client: cached.client,
      channelCache: cached.channelCache,
    };
  }

  const token = await ctx.secrets.resolve(tokenRef);
  if (!token) {
    throw new Error(
      `[ECONFIG] Slack workspace "${workspace.key}": secret "${tokenRef}" did not resolve.`,
    );
  }

  const opts: WebClientOptions = {
    retryConfig: { retries: 3 },
  };
  const client = new WebClient(token, opts);
  const channelCache = new Map<string, { id: string; expiresAt: number }>();
  clientCache.set(ck, { client, resolvedTokenRef: tokenRef, channelCache });
  return {
    workspace,
    workspaceKey: workspace.key ?? requestedKey,
    client,
    channelCache,
  };
}

export function wrapSlackError(err: unknown): string {
  // @slack/web-api errors carry a `code` and often a Slack `data.error` string.
  const e = err as {
    code?: string;
    data?: { error?: string; needed?: string; provided?: string };
    message?: string;
  };
  if (e?.code === ErrorCode.PlatformError && e.data?.error) {
    const slackErr = e.data.error;
    // Friendly mapping for common cases
    switch (slackErr) {
      case "not_authed":
      case "invalid_auth":
      case "token_revoked":
      case "token_expired":
        return `[ESLACK_AUTH] ${slackErr}`;
      case "missing_scope":
        return `[ESLACK_SCOPE] missing scope (needed=${e.data.needed ?? "?"}, provided=${e.data.provided ?? "?"})`;
      case "channel_not_found":
        return `[ESLACK_CHANNEL_NOT_FOUND] ${slackErr}`;
      case "user_not_found":
      case "users_not_found":
        return `[ESLACK_USER_NOT_FOUND] ${slackErr}`;
      case "not_in_channel":
        return `[ESLACK_NOT_IN_CHANNEL] bot must be invited to this channel first`;
      case "rate_limited":
        return `[ESLACK_RATE_LIMIT] ${slackErr}`;
      case "msg_too_long":
        return `[ESLACK_MSG_TOO_LONG] message exceeds 40,000 chars`;
      default:
        return `[ESLACK_${slackErr.toUpperCase()}] ${slackErr}`;
    }
  }
  if (e?.code === ErrorCode.RequestError) {
    return `[ESLACK_REQUEST] ${e.message ?? "request failed"}`;
  }
  if (e?.code === ErrorCode.HTTPError) {
    return `[ESLACK_HTTP] ${e.message ?? "http error"}`;
  }
  if (e?.code === ErrorCode.RateLimitedError) {
    return `[ESLACK_RATE_LIMIT] ${e.message ?? "rate limited"}`;
  }
  if (err instanceof Error) return `[ESLACK_UNKNOWN] ${err.message}`;
  return `[ESLACK_UNKNOWN] ${String(err)}`;
}

const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve a channel name (no leading '#') to a channel ID. Uses the
 * per-workspace cache populated lazily from conversations.list. Returns null
 * if the channel can't be found in the bot's visible set.
 */
export async function resolveChannelId(
  resolved: ResolvedWorkspace,
  channelName: string,
): Promise<string | null> {
  const normalized = channelName.replace(/^#/, "").toLowerCase();
  const now = Date.now();

  const cached = resolved.channelCache.get(normalized);
  if (cached && cached.expiresAt > now) {
    return cached.id;
  }

  // Iterate paginated channels; conversations.list returns up to 1000 per page.
  let cursor: string | undefined;
  do {
    const resp = await resolved.client.conversations.list({
      cursor,
      limit: 1000,
      types: "public_channel,private_channel",
      exclude_archived: true,
    });
    for (const ch of resp.channels ?? []) {
      if (ch.name && ch.id) {
        resolved.channelCache.set(ch.name.toLowerCase(), {
          id: ch.id,
          expiresAt: now + CHANNEL_CACHE_TTL_MS,
        });
      }
    }
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return resolved.channelCache.get(normalized)?.id ?? null;
}
