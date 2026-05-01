import { Octokit } from "@octokit/rest";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

interface OctokitErrorShape {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string | string[] | undefined> };
}

function isOctokitError(err: unknown): err is OctokitErrorShape {
  return !!err && typeof err === "object" && "status" in (err as Record<string, unknown>);
}

export interface ConfigAccount {
  key?: string;
  displayName?: string;
  tokenRef?: string;
  defaultOwner?: string;
  defaultRepo?: string;
  allowedRepos?: string[];
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  allowMutations?: boolean;
  accounts?: ConfigAccount[];
  defaultAccount?: string;
}

export interface ResolvedAccount {
  account: ConfigAccount;
  accountKey: string;
  client: Octokit;
}

interface CachedClient {
  client: Octokit;
  resolvedTokenRef: string;
}

const clientCache = new Map<string, CachedClient>();
const cacheKey = (companyId: string, accountKey: string) =>
  `${companyId}::${accountKey.toLowerCase()}`;

export async function getOctokit(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  accountKeyParam: string | undefined,
): Promise<ResolvedAccount> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const accounts = config.accounts ?? [];

  const requestedKey = (accountKeyParam ?? config.defaultAccount ?? "").trim();
  if (!requestedKey) {
    throw new Error(
      "[EACCOUNT_REQUIRED] No `account` parameter provided and no `defaultAccount` configured on the plugin settings page.",
    );
  }

  const account = accounts.find(
    (a) => (a.key ?? "").toLowerCase() === requestedKey.toLowerCase(),
  );
  if (!account) {
    throw new Error(
      `[EACCOUNT_NOT_FOUND] GitHub account "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `github-tools account "${account.key}"`,
    resourceKey: account.key ?? requestedKey,
    allowedCompanies: account.allowedCompanies,
    companyId: runCtx.companyId,
  });

  if (!account.tokenRef) {
    throw new Error(
      `[ECONFIG] GitHub account "${account.key}" has no tokenRef configured.`,
    );
  }

  const ck = cacheKey(runCtx.companyId, account.key ?? requestedKey);
  const cached = clientCache.get(ck);
  if (cached && cached.resolvedTokenRef === account.tokenRef) {
    return { account, accountKey: account.key ?? requestedKey, client: cached.client };
  }

  const token = await ctx.secrets.resolve(account.tokenRef);
  if (!token) {
    throw new Error(
      `[ECONFIG] GitHub account "${account.key}": secret "${account.tokenRef}" did not resolve.`,
    );
  }

  const client = new Octokit({
    auth: token,
    userAgent: "paperclip-plugin-github-tools",
    request: { retries: 3 },
  });
  clientCache.set(ck, { client, resolvedTokenRef: account.tokenRef });
  return { account, accountKey: account.key ?? requestedKey, client };
}

export interface ResolvedRepo {
  owner: string;
  repo: string;
}

/**
 * Resolve owner/repo with default fallback and allow-list check. Returns the
 * resolved pair, or throws.
 */
export function resolveRepo(
  resolved: ResolvedAccount,
  ownerParam: string | undefined,
  repoParam: string | undefined,
): ResolvedRepo {
  const owner = ownerParam ?? resolved.account.defaultOwner;
  const repo = repoParam ?? resolved.account.defaultRepo;
  if (!owner) {
    throw new Error(
      "[EINVALID_INPUT] No `owner` provided and no `defaultOwner` on the account config.",
    );
  }
  if (!repo) {
    throw new Error(
      "[EINVALID_INPUT] No `repo` provided and no `defaultRepo` on the account config.",
    );
  }
  assertRepoAllowed(resolved, owner, repo);
  return { owner, repo };
}

export function assertRepoAllowed(
  resolved: ResolvedAccount,
  owner: string,
  repo: string,
): void {
  const allow = resolved.account.allowedRepos;
  if (!allow || allow.length === 0) return;
  const target = `${owner}/${repo}`.toLowerCase();
  const hit = allow.some((a) => a.toLowerCase() === target);
  if (!hit) {
    throw new Error(
      `[EGITHUB_FORBIDDEN_REPO] ${owner}/${repo} is not in the account's allowedRepos list.`,
    );
  }
}

export function wrapGithubError(err: unknown): string {
  if (isOctokitError(err)) {
    const status = err.status ?? 0;
    const message = err.message ?? "";
    if (status === 401) return `[EGITHUB_UNAUTHORIZED] ${message}`;
    if (status === 403) {
      // Differentiate auth-vs-rate-limit by header
      const headers = err.response?.headers;
      const remaining = headers?.["x-ratelimit-remaining"];
      const remainingStr = Array.isArray(remaining) ? remaining[0] : remaining;
      if (remainingStr === "0") return `[EGITHUB_RATE_LIMIT] ${message}`;
      return `[EGITHUB_FORBIDDEN] ${message}`;
    }
    if (status === 404) return `[EGITHUB_NOT_FOUND] ${message}`;
    if (status === 409) return `[EGITHUB_CONFLICT] ${message}`;
    if (status === 422) return `[EGITHUB_VALIDATION] ${message}`;
    if (status === 429) return `[EGITHUB_RATE_LIMIT] ${message}`;
    if (status >= 500) return `[EGITHUB_SERVER_${status}] ${message}`;
    return `[EGITHUB_${status}] ${message}`;
  }
  if (err instanceof Error) return `[EGITHUB_UNKNOWN] ${err.message}`;
  return `[EGITHUB_UNKNOWN] ${String(err)}`;
}

export function idempotencyLabel(key: string): string {
  // Lowercase + alphanumeric/dash/underscore only — GitHub allows up to 50
  // chars on labels and most special chars; we normalize to the conservative
  // set so labels look identical across calls.
  const slug = key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `paperclip:idempotency-${slug}`.slice(0, 50);
}
