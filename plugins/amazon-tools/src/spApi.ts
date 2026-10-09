import { gunzipSync } from "node:zlib";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export type Region = "na" | "eu" | "fe";

export interface ConfigAccount {
  key?: string;
  name?: string;
  region?: Region;
  sellerId?: string;
  marketplaceIds?: string[];
  lwaClientIdRef?: string;
  lwaClientSecretRef?: string;
  refreshTokenRef?: string;
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  defaultAccount?: string;
  accounts?: ConfigAccount[];
}

export const REGION_ENDPOINTS: Record<Region, string> = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

export const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

// ─── Read-only guard ─────────────────────────────────────────────────────
//
// Every SP-API call goes through spRequest, and spRequest refuses anything
// that is not on this list. GET is allowed only on the read operations the
// tools use. The single POST is "create report", which asks Amazon to build
// a report and changes nothing in the seller's account.

const READ_PATHS: RegExp[] = [
  /^\/orders\/v0\/orders$/,
  /^\/orders\/v0\/orders\/[^/]+$/,
  /^\/orders\/v0\/orders\/[^/]+\/orderItems$/,
  /^\/finances\/v0\/financialEventGroups$/,
  /^\/finances\/v0\/financialEventGroups\/[^/]+\/financialEvents$/,
  /^\/finances\/v0\/financialEvents$/,
  /^\/fba\/inventory\/v1\/summaries$/,
  /^\/listings\/2021-08-01\/items\/[^/]+\/[^/]+$/,
  /^\/reports\/2021-06-30\/reports$/,
  /^\/reports\/2021-06-30\/reports\/[^/]+$/,
  /^\/reports\/2021-06-30\/documents\/[^/]+$/,
  /^\/sellers\/v1\/marketplaceParticipations$/,
];

const CREATE_REPORT_PATH = "/reports/2021-06-30/reports";

export function assertReadOnly(method: string, path: string): void {
  const m = method.toUpperCase();
  if (m === "GET" && READ_PATHS.some((re) => re.test(path))) return;
  if (m === "POST" && path === CREATE_REPORT_PATH) return;
  throw new Error(
    `[EWRITE_BLOCKED] ${m} ${path} is not an allowed read-only Amazon call.`,
  );
}

// ─── Secret redaction ────────────────────────────────────────────────────

export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

// ─── Account resolution + LWA tokens ─────────────────────────────────────

interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface TokenEntry {
  refsKey: string;
  creds: Credentials;
  accessToken?: string;
  expiresAt: number;
  pending?: Promise<string>;
}

// In-memory only. Keyed by (company, account) so no signed-in client is shared
// across company boundaries; the refs key detects a config change.
const tokenCache = new Map<string, TokenEntry>();

export function clearTokenCache(): void {
  tokenCache.clear();
}

export interface ResolvedAccount {
  account: ConfigAccount;
  accountKey: string;
  endpoint: string;
  marketplaceIds: string[];
  getAccessToken: () => Promise<string>;
  /** Every secret value for this account, for redaction. */
  secretValues: () => string[];
}

export function findAccount(config: InstanceConfig, requested: string | undefined): ConfigAccount {
  const key = (requested ?? config.defaultAccount ?? "").trim();
  const accounts = config.accounts ?? [];
  if (!key) {
    if (accounts.length === 1) return accounts[0]!;
    throw new Error(
      "[EACCOUNT_REQUIRED] No `account` given and no default account is set on the plugin settings page.",
    );
  }
  const account = accounts.find((a) => (a.key ?? "").toLowerCase() === key.toLowerCase());
  if (!account) {
    throw new Error(`[EACCOUNT_NOT_FOUND] Amazon account "${key}" is not configured.`);
  }
  return account;
}

export function checkAccountShape(account: ConfigAccount): string[] {
  const problems: string[] = [];
  const label = account.key ? `Account "${account.key}"` : "An account";
  if (!account.key) problems.push(`${label} has no identifier.`);
  if (!account.region || !(account.region in REGION_ENDPOINTS)) {
    problems.push(`${label} needs a region (na, eu or fe).`);
  }
  if (!account.marketplaceIds || account.marketplaceIds.length === 0) {
    problems.push(`${label} needs at least one marketplace ID.`);
  }
  if (!account.lwaClientIdRef) problems.push(`${label} has no LWA client ID secret.`);
  if (!account.lwaClientSecretRef) problems.push(`${label} has no LWA client secret.`);
  if (!account.refreshTokenRef) problems.push(`${label} has no refresh token secret.`);
  return problems;
}

/**
 * Open an account without a company check. `cacheScope` is the calling
 * company for tool calls; the connection test passes its own scope.
 */
export function openAccount(ctx: PluginContext, account: ConfigAccount, cacheScope: string): ResolvedAccount {
  const problems = checkAccountShape(account);
  if (problems.length > 0) throw new Error(`[ECONFIG] ${problems.join(" ")}`);

  const accountKey = account.key!;
  const cacheKey = `${cacheScope}::${accountKey.toLowerCase()}`;
  const refsKey = [account.lwaClientIdRef, account.lwaClientSecretRef, account.refreshTokenRef].join("|");

  const entry = (): TokenEntry | undefined => {
    const e = tokenCache.get(cacheKey);
    return e && e.refsKey === refsKey ? e : undefined;
  };

  async function loadCreds(): Promise<Credentials> {
    const cached = entry();
    if (cached) return cached.creds;
    const [clientId, clientSecret, refreshToken] = await Promise.all([
      ctx.secrets.resolve(account.lwaClientIdRef!),
      ctx.secrets.resolve(account.lwaClientSecretRef!),
      ctx.secrets.resolve(account.refreshTokenRef!),
    ]);
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(`[ECONFIG] Account "${accountKey}": one of its secrets did not resolve.`);
    }
    const creds = { clientId, clientSecret, refreshToken };
    tokenCache.set(cacheKey, { refsKey, creds, expiresAt: 0 });
    return creds;
  }

  async function getAccessToken(): Promise<string> {
    const creds = await loadCreds();
    const e = entry()!;
    if (e.accessToken && e.expiresAt - 60_000 > Date.now()) return e.accessToken;
    if (e.pending) return e.pending;
    e.pending = fetchLwaToken(creds)
      .then(({ token, expiresIn }) => {
        e.accessToken = token;
        e.expiresAt = Date.now() + expiresIn * 1000;
        return token;
      })
      .finally(() => {
        e.pending = undefined;
      });
    return e.pending;
  }

  return {
    account,
    accountKey,
    endpoint: REGION_ENDPOINTS[account.region!],
    marketplaceIds: account.marketplaceIds!,
    getAccessToken,
    secretValues: () => {
      const e = entry();
      if (!e) return [];
      return [e.creds.clientId, e.creds.clientSecret, e.creds.refreshToken, e.accessToken ?? ""];
    },
  };
}

/** Resolve the account an agent asked for, enforcing company access. */
export async function resolveAccount(
  ctx: PluginContext,
  companyId: string,
  toolName: string,
  requested: string | undefined,
): Promise<ResolvedAccount> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const account = findAccount(config, requested);
  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `amazon-tools account "${account.key}"`,
    resourceKey: account.key ?? "",
    allowedCompanies: account.allowedCompanies,
    companyId,
  });
  return openAccount(ctx, account, companyId);
}

async function fetchLwaToken(creds: Credentials): Promise<{ token: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const secrets = [creds.clientId, creds.clientSecret, creds.refreshToken];
  let res: Response;
  try {
    res = await fetch(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(redact(`[EAMAZON_NETWORK] Could not reach Amazon sign-in: ${(err as Error).message}`, secrets));
  }
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    | null;
  if (!res.ok || !json?.access_token) {
    const reason = json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
    throw new Error(redact(`[EAMAZON_AUTH] Amazon sign-in failed: ${reason}`, secrets));
  }
  return { token: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

// ─── Requests ────────────────────────────────────────────────────────────

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
}

export const retryPolicy = {
  maxRetries: 4,
  baseDelayMs: 1000,
  maxDelayMs: 15_000,
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, retryPolicy.maxDelayMs);
  }
  const exp = retryPolicy.baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * retryPolicy.baseDelayMs;
  return Math.min(exp + jitter, retryPolicy.maxDelayMs);
}

export async function spRequest<T = unknown>(
  resolved: ResolvedAccount,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  assertReadOnly(method, path);

  const url = new URL(resolved.endpoint + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }

  for (let attempt = 0; ; attempt++) {
    const token = await resolved.getAccessToken();
    const headers: Record<string, string> = {
      "x-amz-access-token": token,
      Accept: "application/json",
      "User-Agent": "paperclip-amazon-tools/0.1 (Language=JavaScript)",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new Error(
        redact(`[EAMAZON_NETWORK] ${(err as Error).message}`, resolved.secretValues()),
      );
    }

    const retryable = res.status === 429 || res.status === 500 || res.status === 503;
    if (retryable && attempt < retryPolicy.maxRetries) {
      await retryPolicy.sleep(retryDelay(attempt, res.headers.get("retry-after")));
      continue;
    }

    const body = (await res.json().catch(() => null)) as
      | { payload?: unknown; errors?: Array<{ code?: string; message?: string; details?: string }> }
      | null;

    if (!res.ok) {
      const first = body?.errors?.[0];
      const detail = first
        ? `${first.code ?? ""} ${first.message ?? ""} ${first.details ?? ""}`.trim()
        : `HTTP ${res.status}`;
      throw new Error(redact(statusError(res.status, detail), resolved.secretValues()));
    }
    return body as T;
  }
}

function statusError(status: number, detail: string): string {
  if (status === 400) return `[EAMAZON_INVALID] ${detail}`;
  if (status === 401 || status === 403) {
    return `[EAMAZON_FORBIDDEN] ${detail}. Check that the app has the needed role in Seller Central and was re-authorized after roles changed.`;
  }
  if (status === 404) return `[EAMAZON_NOT_FOUND] ${detail}`;
  if (status === 429) return `[EAMAZON_RATE_LIMIT] ${detail}. Amazon is still throttling after retries; try again later.`;
  if (status >= 500) return `[EAMAZON_UPSTREAM_${status}] ${detail}`;
  return `[EAMAZON_${status}] ${detail}`;
}

/** Download a report document from its pre-signed URL (no Amazon auth header). */
export async function downloadDocument(
  url: string,
  compression: string | undefined,
): Promise<{ text: string; contentType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("[EAMAZON_DOCUMENT] Report document URL is not https.");
  }
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`[EAMAZON_NETWORK] Report download failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`[EAMAZON_DOCUMENT] Report download failed: HTTP ${res.status}`);
  let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
  if (compression === "GZIP") bytes = gunzipSync(bytes);
  const contentType = res.headers.get("content-type") ?? "";
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim() ?? "utf-8";
  let text: string;
  try {
    text = new TextDecoder(charset).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return { text, contentType };
}
