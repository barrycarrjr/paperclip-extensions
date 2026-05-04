/**
 * REST wrapper around 3CX v20 XAPI.
 *
 * Provides:
 * - Auth header injection (Bearer token from tokenStore)
 * - Native-mode tenant header for server-side scoping
 * - Retry-on-401 with token refresh (handles silent rotation)
 * - Retry-on-429 with backoff
 * - Error mapping to [E3CX_*] codes for skill pattern-matching
 * - Short-TTL response cache for hot read endpoints
 *
 * Plugin-internal — never exposed to the tool surface. Engines build
 * their normalized shapes on top of this.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clearToken, getAccessToken } from "./tokenStore.js";

export interface XapiClientOpts {
  ctx: PluginContext;
  accountKey: string;
  pbxBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Native-mode tenant scope; injected into auth + headers. */
  tenantId?: string;
}

interface CacheEntry {
  expiresAt: number;
  payload: unknown;
}

/**
 * Per-(account, tenantId) response cache. TTL kept short (5–15s) so we
 * don't hammer the PBX when multiple agents query at once but we also
 * don't serve stale "queue depth" data.
 *
 * Resolves open question #2 from the plan defensively without needing
 * exact rate-limit numbers from 3CX docs.
 */
const responseCache = new Map<string, CacheEntry>();
const HOT_TTL_MS = 8000;

export class XapiClient {
  private readonly cacheKey: string;

  constructor(private readonly opts: XapiClientOpts) {
    this.cacheKey = opts.tenantId
      ? `${opts.accountKey}::${opts.tenantId}`
      : opts.accountKey;
  }

  /** Bare GET. */
  async get<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>("GET", path, init);
  }

  /** Bare POST with a JSON body. */
  async post<T = unknown>(
    path: string,
    body: unknown,
    init: RequestInit = {},
  ): Promise<T> {
    return this.request<T>("POST", path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * GET with a short-TTL response cache. Use only for read endpoints
   * that are queried frequently (queue depth, today stats). Cache key
   * includes the tenantId so two companies in native mode don't share.
   */
  async getCached<T = unknown>(path: string, ttlMs: number = HOT_TTL_MS): Promise<T> {
    const key = `${this.cacheKey}::${path}`;
    const now = Date.now();
    const hit = responseCache.get(key);
    if (hit && hit.expiresAt > now) return hit.payload as T;
    const payload = await this.get<T>(path);
    responseCache.set(key, { payload, expiresAt: now + ttlMs });
    return payload;
  }

  invalidateCache(): void {
    for (const k of Array.from(responseCache.keys())) {
      if (k.startsWith(`${this.cacheKey}::`)) responseCache.delete(k);
    }
  }

  /** The bearer token to use for raw transports (e.g. WebSocket). */
  async resolveBearerToken(force = false): Promise<string> {
    return getAccessToken({
      cacheKey: this.cacheKey,
      pbxBaseUrl: this.opts.pbxBaseUrl,
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      tenantId: this.opts.tenantId,
      force,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const url = this.urlFor(path);
    let attempt = 0;
    let forceRefresh = false;

    while (true) {
      attempt += 1;
      const token = await this.resolveBearerToken(forceRefresh);
      forceRefresh = false;

      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      };
      if (this.opts.tenantId) headers["X-3CX-Tenant"] = this.opts.tenantId;

      let res: Response;
      try {
        res = await fetch(url, { ...init, method, headers });
      } catch (err) {
        throw new Error(
          `[E3CX_NETWORK] ${method} ${path} failed: ${(err as Error).message}`,
        );
      }

      if (res.status === 401 && attempt === 1) {
        clearToken(this.cacheKey);
        forceRefresh = true;
        continue;
      }
      if (res.status === 429 && attempt <= 2) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
        await sleep(Math.min(5000, Math.max(500, retryAfter * 1000)));
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(mapError(res.status, method, path, text));
      }

      if (res.status === 204) return undefined as unknown as T;
      const ctype = res.headers.get("Content-Type") ?? "";
      if (ctype.includes("application/json")) {
        return (await res.json()) as T;
      }
      return (await safeText(res)) as unknown as T;
    }
  }

  private urlFor(path: string): string {
    const base = stripTrailingSlash(this.opts.pbxBaseUrl);
    if (path.startsWith("http")) return path;
    return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  }
}

function mapError(status: number, method: string, path: string, body: string): string {
  const snippet = truncate(body, 300);
  if (status === 401 || status === 403) {
    return `[E3CX_AUTH] ${method} ${path} → ${status}. Token rejected after refresh. Body: ${snippet}`;
  }
  if (status === 404) {
    return `[E3CX_NOT_FOUND] ${method} ${path} → 404. Body: ${snippet}`;
  }
  if (status === 409) {
    return `[E3CX_CONFLICT] ${method} ${path} → 409. Body: ${snippet}`;
  }
  if (status === 429) {
    return `[E3CX_RATE_LIMITED] ${method} ${path} → 429 after retry. Body: ${snippet}`;
  }
  if (status >= 500) {
    return `[E3CX_UPSTREAM] ${method} ${path} → ${status}. Body: ${snippet}`;
  }
  return `[E3CX_HTTP_${status}] ${method} ${path}. Body: ${snippet}`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
