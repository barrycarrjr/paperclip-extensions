/**
 * Call history cache.
 *
 * 3CX v20's /xapi/v1/CallHistoryView is broken on our reference install
 * (Carr Rock 2026-05-17): `$filter` on SegmentStartTime returns HTTP 500,
 * `$orderby` is silently ignored, and the entity appears to stop at
 * SegmentId 330601 / 2025-06-28 — months out of date. The only XAPI
 * surface with reliably-current call metadata is /xapi/v1/Recordings.
 *
 * Strategy: every 5 minutes the `ingest-call-history` job pulls fresh
 * Recordings rows per account, normalizes each to a NormalizedCallRecord,
 * and merges into the per-account cache stored in ctx.state. The
 * Call history page reads from this cache — no round-trip to 3CX per
 * page request. Caveats:
 *
 *   - Only RECORDED calls land in the cache. Calls 3CX didn't record
 *     (recording disabled per-extension, internal calls without
 *     recording, etc.) won't appear. This is the limitation of using
 *     Recordings as the source.
 *   - Disposition is derived from the recording's presence: a recorded
 *     call was, by definition, answered. Missed / abandoned calls don't
 *     show until we have a working CallHistoryView path.
 *
 * Storage: `instance::3cx:call-history:<accountKey>` → CallHistoryCache.
 * Capped at MAX_ENTRIES per account; oldest entries evicted on insert.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ConfigAccount,
  InstanceConfig,
  NormalizedCallRecord,
} from "./engines/types.js";

const MAX_ENTRIES = 5000;
const BACKFILL_PAGE_SIZE = 200;
const BACKFILL_MAX_PAGES = 25; // 5000-row safety ceiling
const SCHEMA_VERSION = 1;

interface CallHistoryCache {
  schemaVersion: number;
  accountKey: string;
  /** Newest-first; capped at MAX_ENTRIES. */
  entries: NormalizedCallRecord[];
  /** ISO timestamp of the latest successful ingest run. */
  lastIngestAt: string | null;
  /** Highest recording Id we've seen — used to fetch only new rows next run. */
  highWaterId: number;
}

function cacheKey(accountKey: string): {
  scopeKind: "instance";
  stateKey: string;
} {
  return { scopeKind: "instance", stateKey: `3cx:call-history:${accountKey}` };
}

export async function readCache(
  ctx: PluginContext,
  accountKey: string,
): Promise<CallHistoryCache> {
  const v = await ctx.state.get(cacheKey(accountKey));
  if (v && typeof v === "object") {
    const cache = v as Partial<CallHistoryCache>;
    if (cache.schemaVersion === SCHEMA_VERSION && Array.isArray(cache.entries)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        accountKey,
        entries: cache.entries,
        lastIngestAt: cache.lastIngestAt ?? null,
        highWaterId: cache.highWaterId ?? 0,
      };
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    accountKey,
    entries: [],
    lastIngestAt: null,
    highWaterId: 0,
  };
}

async function writeCache(
  ctx: PluginContext,
  cache: CallHistoryCache,
): Promise<void> {
  await ctx.state.set(cacheKey(cache.accountKey), cache);
}

/**
 * Run one ingest pass against an account: fetch Recordings (newest-first
 * via the engine's own listRecordings), convert to call-record shape,
 * merge with the existing cache deduped by callId.
 *
 * Pulls up to BACKFILL_MAX_PAGES × BACKFILL_PAGE_SIZE rows on first run
 * (cold cache); subsequent runs stop pulling once they cross the
 * `highWaterId` boundary so steady-state ingest is cheap.
 */
export async function ingestAccount(
  ctx: PluginContext,
  account: ConfigAccount,
  /** Function that calls engine.listRecordings — passed in to avoid an
   *  import cycle with the engine module. */
  fetchPage: (cursor: string | undefined) => Promise<{
    recordings: Array<{
      id: string;
      extension: string;
      from: string;
      receivedAt: string;
      durationSec: number;
      fromDidNumber?: string;
      toDidNumber?: string;
    }>;
    nextCursor?: string;
  }>,
  /**
   * Function that maps a Recording metadata row into the
   * NormalizedCallRecord shape — provided by the engine since it knows
   * how to interpret CallType, From/ToDnType, etc.
   */
  toCallRecord: (row: {
    id: string;
    extension: string;
    from: string;
    receivedAt: string;
    durationSec: number;
    fromDidNumber?: string;
    toDidNumber?: string;
  }) => NormalizedCallRecord,
): Promise<{
  accountKey: string;
  newlyIngested: number;
  totalCached: number;
}> {
  const accountKey = account.key;
  const cache = await readCache(ctx, accountKey);

  let cursor: string | undefined;
  let pagesPulled = 0;
  const fresh: NormalizedCallRecord[] = [];
  let newHighWater = cache.highWaterId;
  let crossedHighWater = false;

  while (pagesPulled < BACKFILL_MAX_PAGES) {
    const page = await fetchPage(cursor);
    pagesPulled += 1;
    if (!page.recordings || page.recordings.length === 0) break;

    for (const r of page.recordings) {
      const numericId = Number(r.id);
      if (Number.isFinite(numericId) && numericId > newHighWater) {
        newHighWater = numericId;
      }
      if (
        cache.highWaterId > 0 &&
        Number.isFinite(numericId) &&
        numericId <= cache.highWaterId
      ) {
        crossedHighWater = true;
        continue;
      }
      fresh.push(toCallRecord(r));
    }

    if (crossedHighWater || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  // Merge fresh with existing, dedupe by callId, sort newest-first, cap.
  const seen = new Set<string>();
  const merged: NormalizedCallRecord[] = [];
  for (const c of fresh) {
    if (seen.has(c.callId)) continue;
    seen.add(c.callId);
    merged.push(c);
  }
  for (const c of cache.entries) {
    if (seen.has(c.callId)) continue;
    seen.add(c.callId);
    merged.push(c);
  }
  merged.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const capped = merged.slice(0, MAX_ENTRIES);

  await writeCache(ctx, {
    schemaVersion: SCHEMA_VERSION,
    accountKey,
    entries: capped,
    lastIngestAt: new Date().toISOString(),
    highWaterId: newHighWater,
  });

  return {
    accountKey,
    newlyIngested: fresh.length,
    totalCached: capped.length,
  };
}

/**
 * Query helper for the page data channel — applies date / direction /
 * queue / limit filters against the cached entries, no XAPI involved.
 */
export interface QueryOpts {
  since?: string;
  until?: string;
  direction?: "inbound" | "outbound" | "internal";
  queue?: string;
  limit?: number;
}

export async function queryCache(
  ctx: PluginContext,
  accountKey: string,
  opts: QueryOpts,
): Promise<{
  calls: NormalizedCallRecord[];
  totalCached: number;
  lastIngestAt: string | null;
}> {
  const cache = await readCache(ctx, accountKey);
  const sinceMs = opts.since ? Date.parse(opts.since) : 0;
  const untilMs = opts.until ? Date.parse(opts.until) : Infinity;

  let filtered = cache.entries.filter((c) => {
    const t = Date.parse(c.startedAt);
    return Number.isFinite(t) && t >= sinceMs && t <= untilMs;
  });
  if (opts.direction) {
    filtered = filtered.filter((c) => c.direction === opts.direction);
  }
  if (opts.queue) {
    filtered = filtered.filter((c) => c.queue === opts.queue);
  }
  const limit = opts.limit ?? 200;
  return {
    calls: filtered.slice(0, limit),
    totalCached: cache.entries.length,
    lastIngestAt: cache.lastIngestAt,
  };
}

/**
 * Iterate all configured accounts (in the order they appear in the
 * instance config). Used by the ingest job to know which accounts to
 * poll.
 */
export async function listConfiguredAccounts(
  ctx: PluginContext,
): Promise<ConfigAccount[]> {
  const config = (await ctx.config.get()) as InstanceConfig;
  return config.accounts ?? [];
}
