/**
 * Federal / external DNC list cross-check.
 *
 * The FTC's National Do Not Call Registry is the canonical US list,
 * but its API requires per-organization SAN registration (free for
 * legitimate sellers, but a bureaucratic process). Rather than gate
 * the plugin on that, we accept any operator-provided URL pointing
 * to a plain-text or single-column CSV of E.164 numbers (one per
 * line) and fetch it periodically.
 *
 * Operators can therefore use:
 *   - The FTC registry (after SAN registration) — point at the
 *     dump URL the FTC provides.
 *   - A third-party DNC scrubbing service's published list.
 *   - An internal corporate suppression list.
 *   - A self-curated text file hosted anywhere reachable from the
 *     Paperclip server.
 *
 * The cache is per-account, refreshed on a configurable interval
 * (default 24h). Stale-on-error: if the fetch fails, the previous
 * cached set is reused — never accidentally dial through a DNC
 * because the source URL was momentarily unreachable.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";

const STATE_KEY_PREFIX = "federal-dnc";

interface FederalDncCache {
  accountKey: string;
  /** ISO timestamp of the most recent successful fetch. */
  refreshedAt: string;
  /** Raw count for ops dashboards. */
  count: number;
  /** E.164 numbers as a sorted array (we also keep a Set in memory after read). */
  entries: string[];
  /** URL the cache was populated from — guard against stale cache when URL changes. */
  sourceUrl: string;
}

function cacheKey(accountKey: string): string {
  return `${STATE_KEY_PREFIX}:${accountKey}`;
}

/**
 * Read the cached federal DNC entries for an account. Returns null
 * if the cache is empty OR was populated from a different URL than
 * the one the operator currently has configured.
 */
export async function readFederalDncCache(
  ctx: PluginContext,
  accountKey: string,
  expectedUrl: string,
): Promise<FederalDncCache | null> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: cacheKey(accountKey),
  });
  if (!value || typeof value !== "object") return null;
  const cache = value as FederalDncCache;
  if (cache.sourceUrl !== expectedUrl) return null;
  return cache;
}

/**
 * Force-refresh: fetch the URL, parse, and persist. Returns the new
 * cache. On HTTP error throws — caller decides whether to fall back
 * to the stale cache (recommended) or surface the error.
 */
export async function refreshFederalDncCache(
  ctx: PluginContext,
  accountKey: string,
  url: string,
): Promise<FederalDncCache> {
  const res = await fetch(url, { headers: { Accept: "text/plain, text/csv, */*" } });
  if (!res.ok) {
    throw new Error(
      `[EFEDERAL_DNC_FETCH] GET ${url} returned HTTP ${res.status}.`,
    );
  }
  const text = await res.text();
  const entries = parseFederalDncText(text);
  const cache: FederalDncCache = {
    accountKey,
    refreshedAt: new Date().toISOString(),
    count: entries.length,
    entries,
    sourceUrl: url,
  };
  await ctx.state.set(
    { scopeKind: "instance", stateKey: cacheKey(accountKey) },
    cache,
  );
  return cache;
}

/**
 * Parse a plain-text or single-column CSV body into a deduped, sorted
 * E.164 string array. Tolerant of:
 *   - Comments (lines starting with # or //)
 *   - Trailing whitespace
 *   - Mixed phone formats (10-digit, parens, etc.) — uses the same
 *     normalizer as the campaign CSV import
 *   - Header rows ("phone", "number", "Phone Number" etc.) — silently
 *     skipped if the value is non-numeric
 *
 * Bad rows are silently dropped — a single malformed line shouldn't
 * poison the whole list.
 */
export function parseFederalDncText(text: string): string[] {
  const out = new Set<string>();
  const stripped = text.replace(/^﻿/, "");
  const lines = stripped.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("//")) continue;
    // For CSV with multiple columns, take the first cell.
    const firstCell = trimmed.split(",")[0]?.trim() ?? "";
    if (!firstCell) continue;
    const e164 = quickNormalize(firstCell);
    if (e164) out.add(e164);
  }
  return Array.from(out).sort();
}

/**
 * Phone normalizer — duplicates `csv.ts:normalizeToE164` because we
 * don't want this module to depend on the campaign CSV stack (which
 * brings in lead-shape concepts irrelevant to a flat DNC list). Keep
 * the two in sync; both produce the same E.164 form.
 */
function quickNormalize(raw: string): string | null {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  let candidate: string;
  if (hasPlus) {
    candidate = `+${digits}`;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    candidate = `+${digits}`;
  } else {
    candidate = `+${digits}`;
  }
  if (!/^\+[1-9]\d{6,14}$/.test(candidate)) return null;
  return candidate;
}

/**
 * Determine whether the cache needs a refresh based on age. Default
 * TTL: 24h. Operators with a fast-changing list can override via
 * account.federalDncRefreshHours.
 */
export function isCacheStale(
  cache: FederalDncCache | null,
  maxAgeHours: number,
): boolean {
  if (!cache) return true;
  const ageHours =
    (Date.now() - new Date(cache.refreshedAt).getTime()) / (1000 * 60 * 60);
  return ageHours >= maxAgeHours;
}

/**
 * Lookup. Membership is a simple binary-search-friendly sorted-array
 * Includes call. For the typical DNC list size (millions), a Set
 * built once per cache read would beat repeated array scans, but
 * that means re-allocating on every dial — current design assumes
 * callers cache the Set themselves if they query in tight loops.
 */
export function isInFederalDnc(cache: FederalDncCache, phoneE164: string): boolean {
  // The entries are sorted; for hot paths a Set is faster but for
  // the single-check-per-dial pattern this is fine and avoids
  // memory churn.
  return cache.entries.includes(phoneE164);
}

/**
 * Convenience: get-or-refresh, with stale-on-error fallback. Used by
 * the runner and dial-time check tools so callers don't have to
 * orchestrate the cache lifecycle themselves.
 */
export async function getOrRefreshFederalDnc(
  ctx: PluginContext,
  accountKey: string,
  url: string | undefined,
  maxAgeHours: number,
): Promise<FederalDncCache | null> {
  if (!url) return null;
  const cached = await readFederalDncCache(ctx, accountKey, url);
  if (!isCacheStale(cached, maxAgeHours)) return cached;
  try {
    return await refreshFederalDncCache(ctx, accountKey, url);
  } catch (err) {
    ctx.logger.warn("phone-tools: federal DNC refresh failed; using stale cache", {
      accountKey,
      url,
      err: (err as Error).message,
    });
    // Stale-on-error: better to dial through a 30h-old DNC list than to
    // skip the check entirely or to error the dial.
    return cached;
  }
}
