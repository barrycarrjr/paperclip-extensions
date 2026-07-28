import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export interface ConfigAccount {
  key?: string;
  displayName?: string;
  clientIdRef?: string;
  clientSecretRef?: string;
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
const HELP_SCOUT_TOKEN_URL = "https://api.helpscout.net/v2/oauth2/token";
/** Refresh the access token if it expires in less than this window — keeps us off the 401 retry path on the request side. */
const TOKEN_REFRESH_LEAD_MS = 60_000;

interface CachedAuth {
  accessToken: string;
  expiresAt: number;
  clientIdRef: string;
  clientSecretRef: string;
  reportCache: Map<string, { data: unknown; expiresAt: number }>;
}

const authCache = new Map<string, CachedAuth>();
const cacheKey = (companyId: string, accountKey: string) =>
  `${companyId}::${accountKey.toLowerCase()}`;

export interface ResolvedAccount {
  account: ConfigAccount;
  accountKey: string;
  /** Bearer token (Help Scout access_token). Auto-refreshing — caller can re-fetch via refreshAccessToken if a 401 still happens. */
  apiKey: string;
  reportCache: Map<string, { data: unknown; expiresAt: number }>;
  /** Force a fresh access_token exchange and update both the resolved object and the cache. Used by helpScoutRequest's 401 retry. */
  refreshAccessToken: () => Promise<string>;
}

async function exchangeForAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresInSec: number }> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  let res: Response;
  try {
    res = await fetch(HELP_SCOUT_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(`[EHELP_SCOUT_NETWORK] token exchange: ${(err as Error).message}`);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string; error_description?: string };
      if (errBody?.error_description) detail = errBody.error_description;
      else if (errBody?.error) detail = errBody.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(`[EHELP_SCOUT_TOKEN_EXCHANGE] ${detail}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error("[EHELP_SCOUT_TOKEN_EXCHANGE] response missing access_token");
  }
  return {
    accessToken: json.access_token,
    expiresInSec: typeof json.expires_in === "number" ? json.expires_in : 172_800,
  };
}

export async function getHelpScoutAccount(
  ctx: PluginContext,
  companyId: string,
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
    companyId,
  });

  if (!account.clientIdRef || !account.clientSecretRef) {
    throw new Error(
      `[ECONFIG] Help Scout account "${account.key}" is missing clientIdRef or clientSecretRef. Both are required (OAuth2 client_credentials).`,
    );
  }

  const ck = cacheKey(companyId, account.key ?? requestedKey);

  // Force-refresh function — used both on initial cache miss and after a 401 retry.
  const refresh = async (): Promise<string> => {
    const clientId = await ctx.secrets.resolve(account.clientIdRef!);
    if (!clientId) {
      throw new Error(
        `[ECONFIG] Help Scout account "${account.key}": clientIdRef secret did not resolve.`,
      );
    }
    const clientSecret = await ctx.secrets.resolve(account.clientSecretRef!);
    if (!clientSecret) {
      throw new Error(
        `[ECONFIG] Help Scout account "${account.key}": clientSecretRef secret did not resolve.`,
      );
    }
    const { accessToken, expiresInSec } = await exchangeForAccessToken(clientId, clientSecret);
    const expiresAt = Date.now() + expiresInSec * 1000;
    const existing = authCache.get(ck);
    const reportCache =
      existing && existing.clientIdRef === account.clientIdRef
        ? existing.reportCache
        : new Map<string, { data: unknown; expiresAt: number }>();
    authCache.set(ck, {
      accessToken,
      expiresAt,
      clientIdRef: account.clientIdRef!,
      clientSecretRef: account.clientSecretRef!,
      reportCache,
    });
    return accessToken;
  };

  const cached = authCache.get(ck);
  const validCached =
    cached &&
    cached.clientIdRef === account.clientIdRef &&
    cached.clientSecretRef === account.clientSecretRef &&
    cached.expiresAt - Date.now() > TOKEN_REFRESH_LEAD_MS;

  if (validCached) {
    return {
      account,
      accountKey: account.key ?? requestedKey,
      apiKey: cached!.accessToken,
      reportCache: cached!.reportCache,
      refreshAccessToken: refresh,
    };
  }

  const accessToken = await refresh();
  const fresh = authCache.get(ck)!;
  return {
    account,
    accountKey: account.key ?? requestedKey,
    apiKey: accessToken,
    reportCache: fresh.reportCache,
    refreshAccessToken: refresh,
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

  const doFetch = async (bearer: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  };

  let res: Response;
  try {
    res = await doFetch(resolved.apiKey);
  } catch (err) {
    throw new Error(`[EHELP_SCOUT_NETWORK] ${(err as Error).message}`);
  }

  // 401 = access token expired/revoked between cache refresh and now. Retry once with a fresh token.
  if (res.status === 401) {
    try {
      const freshToken = await resolved.refreshAccessToken();
      resolved.apiKey = freshToken;
      res = await doFetch(freshToken);
    } catch (err) {
      throw new Error(`[EHELP_SCOUT_AUTH] ${(err as Error).message}`);
    }
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

  // Parse JSON body regardless of content-type. Help Scout's API returns
  // `application/hal+json` for most resources (HAL-formatted JSON), and
  // `application/problem+json` for some errors. A naive
  // `contentType.includes("application/json")` check misses both because
  // they're "+json" suffix variants, not the bare "application/json" type.
  // Trying to parse anything non-empty + non-204 covers all variants.
  let body: unknown = null;
  if (res.status !== 204) {
    try {
      const text = await res.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          // Non-JSON body — leave body as null. The status-code branch below
          // surfaces the right error code without needing the parsed body.
        }
      }
    } catch {
      // Body read failed; leave body null.
    }
  }

  if (!expectOk) {
    const message =
      (body as { message?: string; error?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `HTTP ${res.status}`;
    const detail = extractValidationDetail(body);
    throw new Error(mapStatusToErrorCode(res.status, detail ? `${message} (${detail})` : message));
  }

  return {
    status: res.status,
    body: body as T | null,
    rateLimitRemaining: res.headers.get("x-ratelimit-remaining-minute"),
  };
}

/**
 * Help Scout answers a rejected write with a top-level `message` of just
 * "Bad Request" and puts the reason (which field, and why) in
 * `_embedded.errors`. Without this the caller sees a bare
 * "[EHELP_SCOUT_400] Bad request" and has no way to tell what was wrong.
 * Returns e.g. `customer: may not be null` or null when the body has no
 * field-level errors.
 */
export function extractValidationDetail(body: unknown): string | null {
  const errors = (
    body as {
      _embedded?: { errors?: Array<{ path?: string; message?: string; rejectedValue?: unknown }> };
    } | null
  )?._embedded?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const parts = errors
    .slice(0, 5)
    .map((e) => {
      const path = typeof e?.path === "string" && e.path.trim() ? e.path.trim() : "(body)";
      const msg = typeof e?.message === "string" && e.message.trim() ? e.message.trim() : "invalid";
      return `${path}: ${msg}`;
    })
    .filter(Boolean);
  if (parts.length === 0) return null;

  const suffix = errors.length > 5 ? `; +${errors.length - 5} more` : "";
  return parts.join("; ") + suffix;
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
 * Help Scout requires a `customer` on POST /conversations/{id}/reply. It is
 * the recipient of the outgoing email, and omitting it fails the whole request
 * with a bare 400. Callers (the mail view, agents) normally know only the
 * conversation, so resolve the recipient from the conversation's
 * primaryCustomer unless one was named explicitly.
 *
 * Returns the object to put in the request's `customer` field: `{ id }` for a
 * customer already on the conversation, `{ email }` when the caller addressed
 * someone else and Help Scout has to resolve or create them.
 */
export async function resolveReplyCustomer(
  resolved: ResolvedAccount,
  conversationId: string,
  opts: { customerId?: string | number; customerEmail?: string } = {},
): Promise<Record<string, unknown>> {
  const rawId = opts.customerId;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== "") {
    const id = Number(rawId);
    if (!Number.isFinite(id)) {
      throw new Error(`[EINVALID_INPUT] \`customerId\` must be numeric, got "${String(rawId)}"`);
    }
    return { id };
  }

  const wanted = opts.customerEmail?.trim();

  const resp = await helpScoutRequest<{ primaryCustomer?: { id?: number; email?: string } }>(
    resolved,
    `/conversations/${encodeURIComponent(conversationId)}`,
  );
  const primary = resp.body?.primaryCustomer;

  if (wanted) {
    // Same person as the conversation's primary customer: prefer the id, which
    // is what Help Scout documents for reply threads.
    if (
      typeof primary?.id === "number" &&
      typeof primary.email === "string" &&
      primary.email.toLowerCase() === wanted.toLowerCase()
    ) {
      return { id: primary.id };
    }
    return { email: wanted };
  }

  if (typeof primary?.id !== "number") {
    throw new Error(
      `[EHELP_SCOUT_NO_CUSTOMER] conversation ${conversationId} has no primary customer to reply to. ` +
        "Pass `customerEmail` (or `customerId`) to address the reply explicitly.",
    );
  }
  return { id: primary.id };
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
 * One-shot helper: resolves a configured account's credentials, exchanges for
 * an access token, and calls /v2/mailboxes. Returns a flat list. Throws on any
 * failure with the standard error codes.
 *
 * Used by the `list-mailboxes` plugin action that powers the dynamic dropdowns
 * for `defaultMailbox` / `allowedMailboxes` on the plugin config form. Board
 * users invoking the action don't have a ToolRunContext, so this function
 * deliberately doesn't go through getHelpScoutAccount (which requires one).
 */
export async function listMailboxesForAccount(
  ctx: PluginContext,
  account: ConfigAccount,
): Promise<Array<{ id: string; name: string; email: string }>> {
  if (!account.clientIdRef || !account.clientSecretRef) {
    throw new Error(
      `[ECONFIG] Account "${account.key ?? "(no-key)"}" is missing clientIdRef or clientSecretRef.`,
    );
  }
  const clientId = await ctx.secrets.resolve(account.clientIdRef);
  if (!clientId) {
    throw new Error(`[ECONFIG] clientIdRef did not resolve for account "${account.key}".`);
  }
  const clientSecret = await ctx.secrets.resolve(account.clientSecretRef);
  if (!clientSecret) {
    throw new Error(`[ECONFIG] clientSecretRef did not resolve for account "${account.key}".`);
  }
  const { accessToken } = await exchangeForAccessToken(clientId, clientSecret);
  const res = await fetch(`${HELP_SCOUT_BASE}/mailboxes?size=50`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`[EHELP_SCOUT_${res.status}] failed to list mailboxes`);
  }
  const json = (await res.json()) as {
    _embedded?: { mailboxes?: Array<{ id: number; name: string; email: string }> };
  };
  const list = json._embedded?.mailboxes ?? [];
  return list.map((m) => ({
    id: String(m.id),
    name: m.name,
    email: m.email,
  }));
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
