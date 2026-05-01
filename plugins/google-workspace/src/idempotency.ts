/**
 * Best-effort in-memory idempotency cache for mutation tools.
 *
 * Google's APIs don't support native idempotency keys (unlike Stripe), so a
 * client-side cache is the closest we can get. Same-process retries with the
 * same key short-circuit and return the original result. Worker restart wipes
 * the cache — this is best-effort, not a guarantee.
 *
 * Keyed by (companyId, toolName, idempotencyKey) so two companies submitting
 * the same key get separate slots.
 */

import type { ToolResult } from "@paperclipai/plugin-sdk";

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 1000;

interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(companyId: string, toolName: string, idempotencyKey: string): string {
  return `${companyId}::${toolName}::${idempotencyKey}`;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getCached(
  companyId: string,
  toolName: string,
  idempotencyKey: string | undefined,
): ToolResult | undefined {
  if (!idempotencyKey) return undefined;
  evictExpired();
  const entry = cache.get(cacheKey(companyId, toolName, idempotencyKey));
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey(companyId, toolName, idempotencyKey));
    return undefined;
  }
  return entry.result;
}

export function putCached(
  companyId: string,
  toolName: string,
  idempotencyKey: string | undefined,
  result: ToolResult,
): void {
  if (!idempotencyKey) return;
  if (result.error) return;
  cache.set(cacheKey(companyId, toolName, idempotencyKey), {
    result,
    expiresAt: Date.now() + TTL_MS,
  });
  evictExpired();
}
