import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export interface ConfigAccount {
  key?: string;
  displayName?: string;
  apiKeyRef?: string;
  defaultMailbox?: string;
  allowedMailboxes?: string[];
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  allowMutations?: boolean;
  accounts?: ConfigAccount[];
  defaultAccount?: string;
}

const HELP_SCOUT_BASE = "https://api.helpscout.net/v2";

interface CachedAuth {
  apiKey: string;
  resolvedRef: string;
  reportCache: Map<string, { data: unknown; expiresAt: number }>;
}

const authCache = new Map<string, CachedAuth>();
const cacheKey = (companyId: string, accountKey: string) =>
  `${companyId}::${accountKey.toLowerCase()}`;

export interface ResolvedAccount {
  account: ConfigAccount;
  accountKey: string;
  apiKey: string;
  reportCache: Map<string, { data: unknown; expiresAt: number }>;
}

export async function getHelpScoutAccount(
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
      `[EACCOUNT_NOT_FOUND] Help Scout account "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `help-scout account "${account.key}"`,
    resourceKey: account.key ?? requestedKey,
    allowedCompanies: account.allowedCompanies,
    companyId: runCtx.companyId,
  });

  if (!account.apiKeyRef) {
    throw new Error(
      `[ECONFIG] Help Scout account "${account.key}" has no apiKeyRef configured.`,
    );
  }

  const ck = cacheKey(runCtx.companyId, account.key ?? requestedKey);
  const cached = authCache.get(ck);
  if (cached && cached.resolvedRef === account.apiKeyRef) {
    return {
      account,
      accountKey: account.key ?? requestedKey,
      apiKey: cached.apiKey,
      reportCache: cached.reportCache,
    };
  }

  const apiKey = await ctx.secrets.resolve(account.apiKeyRef);
  if (!apiKey) {
    throw new Error(
      `[ECONFIG] Help Scout account "${account.key}": secret "${account.apiKeyRef}" did not resolve.`,
    );
  }

  const reportCache = new Map<string, { data: unknown; expiresAt: number }>();
  authCache.set(ck, { apiKey, resolvedRef: account.apiKeyRef, reportCache });
  return {
    account,
    accountKey: account.key ?? requestedKey,
    apiKey,
    reportCache,
  };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  expectStatus?: number[];
}

export async function helpScoutRequest<T = unknown>(
  resolved: ResolvedAccount,
  pathPart: string,
  opts: RequestOptions = {},
): Promise<{ status: number; body: T | null; rateLimitRemaining: string | null }> {
  const url = new URL(HELP_SCOUT_BASE + pathPart);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.apiKey}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new Error(`[EHELP_SCOUT_NETWORK] ${(err as Error).message}`);
  }

  // Help Scout 429 — surface, don't retry inside the request helper. The
  // caller can decide whether to retry or fail.
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") ?? "?";
    throw new Error(`[EHELP_SCOUT_RATE_LIMIT] retry after ${retryAfter}s`);
  }

  const expectOk =
    opts.expectStatus && opts.expectStatus.length > 0
      ? opts.expectStatus.includes(res.status)
      : res.ok;

  let body: unknown = null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      // tolerate empty / malformed JSON on non-2xx
    }
  }

  if (!expectOk) {
    const message =
      (body as { message?: string; error?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `HTTP ${res.status}`;
    throw new Error(mapStatusToErrorCode(res.status, message));
  }

  return {
    status: res.status,
    body: body as T | null,
    rateLimitRemaining: res.headers.get("x-ratelimit-remaining-minute"),
  };
}

function mapStatusToErrorCode(status: number, msg: string): string {
  if (status === 401) return `[EHELP_SCOUT_AUTH] ${msg}`;
  if (status === 403) return `[EHELP_SCOUT_FORBIDDEN] ${msg}`;
  if (status === 404) return `[EHELP_SCOUT_NOT_FOUND] ${msg}`;
  if (status === 422) return `[EHELP_SCOUT_INVALID] ${msg}`;
  if (status >= 500) return `[EHELP_SCOUT_SERVER_${status}] ${msg}`;
  return `[EHELP_SCOUT_${status}] ${msg}`;
}

/**
 * Throws [EHELP_SCOUT_MAILBOX_NOT_ALLOWED] if the resolved account has an
 * allowedMailboxes list and the addressed mailbox is not in it. Pass-through
 * if allowedMailboxes is empty/missing.
 */
export function assertMailboxAllowed(resolved: ResolvedAccount, mailboxId: string | undefined): void {
  if (!mailboxId) return;
  const allow = resolved.account.allowedMailboxes;
  if (!allow || allow.length === 0) return;
  if (!allow.includes(mailboxId)) {
    throw new Error(
      `[EHELP_SCOUT_MAILBOX_NOT_ALLOWED] mailbox "${mailboxId}" is not in the account's allowedMailboxes list.`,
    );
  }
}

export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Resolve mailboxId with default fallback and allow-list check.
 * Returns the mailbox to use, or throws if unavailable.
 */
export function resolveMailboxId(
  resolved: ResolvedAccount,
  paramMailboxId: string | undefined,
  required: boolean,
): string | undefined {
  const id = paramMailboxId ?? resolved.account.defaultMailbox;
  if (!id) {
    if (required) {
      throw new Error(
        "[EINVALID_INPUT] No mailboxId provided and no defaultMailbox on the account config.",
      );
    }
    return undefined;
  }
  assertMailboxAllowed(resolved, id);
  return id;
}
