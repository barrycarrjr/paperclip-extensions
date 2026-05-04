/**
 * OAuth2 client_credentials token cache for 3CX v20 XAPI.
 *
 * 3CX issues an access token (~1h TTL) in exchange for client_id +
 * client_secret. We cache the token in memory per (accountKey, tenantId?)
 * and refresh on 401 or proactively at 80% of TTL.
 *
 * Tokens are NEVER persisted to ctx.state — they're derived from secrets
 * resolved on demand and live only in this process.
 */

interface CachedToken {
  accessToken: string;
  /** Epoch ms when we should refresh proactively (80% of advertised TTL). */
  refreshAt: number;
  /** Epoch ms when the token absolutely expires per the OAuth response. */
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<string>>();

export interface TokenFetchInput {
  cacheKey: string;
  pbxBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Native-mode tenant scope, passed as the `tenant` form param if set. */
  tenantId?: string;
  /** Forces an unconditional refresh — used after a 401. */
  force?: boolean;
}

export async function getAccessToken(input: TokenFetchInput): Promise<string> {
  const { cacheKey, force } = input;
  const now = Date.now();

  if (!force) {
    const hit = cache.get(cacheKey);
    if (hit && now < hit.refreshAt) return hit.accessToken;
  }

  const existing = inflight.get(cacheKey);
  if (existing && !force) return existing;

  const promise = fetchToken(input).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, promise);
  return promise;
}

export function clearToken(cacheKey: string): void {
  cache.delete(cacheKey);
  inflight.delete(cacheKey);
}

export function clearAllTokens(): void {
  cache.clear();
  inflight.clear();
}

async function fetchToken(input: TokenFetchInput): Promise<string> {
  const url = `${stripTrailingSlash(input.pbxBaseUrl)}/connect/token`;
  const body = new URLSearchParams();
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("grant_type", "client_credentials");
  if (input.tenantId) body.set("tenant", input.tenantId);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await safeText(res);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `[E3CX_AUTH] OAuth token request rejected (${res.status}). Check clientId/clientSecret. Body: ${truncate(text, 300)}`,
      );
    }
    throw new Error(
      `[E3CX_AUTH] OAuth token request failed (${res.status}). Body: ${truncate(text, 300)}`,
    );
  }

  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number }
    | null;
  const accessToken = json?.access_token;
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("[E3CX_AUTH] OAuth response missing access_token field.");
  }

  const ttlSec =
    typeof json.expires_in === "number" && json.expires_in > 30
      ? json.expires_in
      : 3600;
  const now = Date.now();
  const expiresAt = now + ttlSec * 1000;
  const refreshAt = now + Math.floor(ttlSec * 0.8) * 1000;

  cache.set(input.cacheKey, { accessToken, refreshAt, expiresAt });
  return accessToken;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
