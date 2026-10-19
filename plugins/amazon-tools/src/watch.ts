// Listing Watch: scheduled snapshots of every listing on an account, and a
// change log of every field that differs from the previous snapshot.
//
// Two checks run on a schedule (no AWS, no push notifications):
// - "status" every few hours: listing status, issues, our price, Buy Box and
//   the other sellers on each ASIN.
// - "content" once a day: what we submitted versus what Amazon shows (title,
//   bullets, description, images, category) and A+ content.
//
// Everything here only reads from Amazon. Writes go to the plugin's own tables.

import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  type ConfigAccount,
  type InstanceConfig,
  type ResolvedAccount,
  openAccount,
  redact,
  retryPolicy,
  spRequest,
} from "./spApi.js";
import {
  type FieldChange,
  type Snapshot,
  contentSnapshot,
  diffSnapshots,
  statusSnapshot,
  submittedContent,
  trimAplusDocument,
  trimCatalogItem,
  trimItemOffers,
  trimListing,
} from "./listings.js";

export type WatchKind = "status" | "content";

type Obj = Record<string, unknown>;
type Db = Pick<PluginContext["db"], "namespace" | "query" | "execute">;

const PAGE_SIZE = 20;
const MAX_PAGES = 100;

// Seconds between calls, per Amazon's published rate for each operation.
export const PACE_MS = {
  listings: 250,
  catalog: 600,
  offers: 2100,
  aplus: 250,
};

const OFFER_FIELDS = ["buyBoxHolder", "buyBoxPrice", "offerCount", "otherSellers"];

function pace(ms: number): Promise<void> {
  return retryPolicy.sleep(ms);
}

export function watchedAccounts(config: InstanceConfig): ConfigAccount[] {
  return (config.accounts ?? []).filter((a) => a.listingWatch === true && !!a.sellerId);
}

/** Every listing on the account in one marketplace, with status, issues and price. */
export async function searchAllListings(acct: ResolvedAccount, marketplaceId: string): Promise<Obj[]> {
  const sellerId = encodeURIComponent(acct.account.sellerId!);
  const listings: Obj[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await spRequest<{ items?: unknown[]; pagination?: { nextToken?: string } }>(
      acct,
      `/listings/2021-08-01/items/${sellerId}`,
      {
        query: {
          marketplaceIds: marketplaceId,
          includedData: "summaries,issues,offers",
          pageSize: PAGE_SIZE,
          pageToken,
        },
      },
    );
    listings.push(...(res.items ?? []).map((i) => trimListing(i, marketplaceId)));
    pageToken = res.pagination?.nextToken;
    if (!pageToken) break;
    await pace(PACE_MS.listings);
  }
  return listings;
}

export async function fetchItemOffers(acct: ResolvedAccount, asin: string, marketplaceId: string): Promise<Obj> {
  const res = await spRequest<{ payload?: unknown }>(
    acct,
    `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers`,
    { query: { MarketplaceId: marketplaceId, ItemCondition: "New" } },
  );
  return trimItemOffers(res.payload);
}

export async function fetchCatalogItem(acct: ResolvedAccount, asin: string, marketplaceId: string): Promise<Obj> {
  const res = await spRequest(acct, `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, {
    query: {
      marketplaceIds: marketplaceId,
      includedData: "summaries,attributes,images,productTypes,salesRanks",
    },
  });
  return trimCatalogItem(res, marketplaceId);
}

export async function fetchSubmittedListing(acct: ResolvedAccount, sku: string, marketplaceId: string): Promise<Obj> {
  const res = await spRequest(
    acct,
    `/listings/2021-08-01/items/${encodeURIComponent(acct.account.sellerId!)}/${encodeURIComponent(sku)}`,
    { query: { marketplaceIds: marketplaceId, includedData: "summaries,attributes,issues,offers,fulfillmentAvailability" } },
  );
  return trimListing(res, marketplaceId, true);
}

/** Every A+ document published on an ASIN. Empty when the ASIN has none. */
export async function fetchAplus(acct: ResolvedAccount, asin: string, marketplaceId: string): Promise<Obj[]> {
  const records = await spRequest<{ publishRecordList?: Array<{ contentReferenceKey?: string }> }>(
    acct,
    "/aplus/2020-11-01/contentPublishRecords",
    { query: { marketplaceId, asin } },
  );
  const keys = [...new Set((records.publishRecordList ?? []).map((r) => r.contentReferenceKey).filter(Boolean))] as string[];
  const docs: Obj[] = [];
  for (const key of keys) {
    await pace(PACE_MS.aplus);
    const doc = await spRequest(acct, `/aplus/2020-11-01/contentDocuments/${encodeURIComponent(key)}`, {
      query: { marketplaceId, includedDataSet: "CONTENTS,METADATA" },
    });
    docs.push(trimAplusDocument(doc));
  }
  return docs;
}

// ─── Storage ─────────────────────────────────────────────────────────────

interface StoredSnapshot {
  sku: string;
  asin: string | null;
  data: Snapshot;
}

async function loadSnapshots(db: Db, accountKey: string, marketplaceId: string, kind: WatchKind) {
  const rows = await db.query<StoredSnapshot>(
    `SELECT sku, asin, data FROM ${db.namespace}.listing_snapshots
      WHERE account_key = $1 AND marketplace_id = $2 AND kind = $3`,
    [accountKey, marketplaceId, kind],
  );
  return new Map(rows.map((r) => [r.sku, r]));
}

async function saveSnapshot(db: Db, accountKey: string, marketplaceId: string, kind: WatchKind, sku: string, asin: string | null, data: Snapshot) {
  await db.execute(
    `INSERT INTO ${db.namespace}.listing_snapshots (account_key, marketplace_id, sku, kind, asin, data, taken_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
     ON CONFLICT (account_key, marketplace_id, sku, kind) DO UPDATE SET asin = $5, data = $6::jsonb, taken_at = now()`,
    [accountKey, marketplaceId, sku, kind, asin, JSON.stringify(data)],
  );
}

async function deleteSnapshot(db: Db, accountKey: string, marketplaceId: string, kind: WatchKind, sku: string) {
  await db.execute(
    `DELETE FROM ${db.namespace}.listing_snapshots
      WHERE account_key = $1 AND marketplace_id = $2 AND kind = $3 AND sku = $4`,
    [accountKey, marketplaceId, kind, sku],
  );
}

async function recordChanges(db: Db, accountKey: string, marketplaceId: string, kind: WatchKind, sku: string, asin: string | null, changes: FieldChange[]) {
  for (const c of changes) {
    await db.execute(
      `INSERT INTO ${db.namespace}.listing_changes (account_key, marketplace_id, sku, asin, kind, field, before, after)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
      [accountKey, marketplaceId, sku, asin, kind, c.field, JSON.stringify(c.before ?? null), JSON.stringify(c.after ?? null)],
    );
  }
}

// ─── One check ───────────────────────────────────────────────────────────

export interface CheckResult {
  account: string;
  kind: WatchKind;
  ok: boolean;
  listings: number;
  changes: number;
  note?: string;
}

async function snapshotsFor(
  acct: ResolvedAccount,
  kind: WatchKind,
  marketplaceId: string,
  listings: Obj[],
  previous: Map<string, StoredSnapshot>,
  notes: string[],
): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  const asins = [...new Set(listings.map((l) => l.asin).filter((a): a is string => typeof a === "string"))];

  if (kind === "status") {
    const offersByAsin = new Map<string, Obj>();
    let offerFailures = 0;
    for (const asin of asins) {
      try {
        offersByAsin.set(asin, await fetchItemOffers(acct, asin, marketplaceId));
      } catch {
        offerFailures++;
      }
      await pace(PACE_MS.offers);
    }
    if (offerFailures > 0) notes.push(`offers unavailable for ${offerFailures} ASIN(s); previous offer data kept`);
    for (const listing of listings) {
      const sku = listing.sku as string;
      const offers = typeof listing.asin === "string" ? offersByAsin.get(listing.asin) : undefined;
      const snap = statusSnapshot(listing, offers);
      // A failed offers call must not look like the Buy Box going away.
      const prior = previous.get(sku)?.data;
      if (!offers && prior) for (const f of OFFER_FIELDS) snap[f] = prior[f] ?? null;
      out.set(sku, snap);
    }
    return out;
  }

  const live = new Map<string, Obj>();
  const aplus = new Map<string, Obj[]>();
  let aplusBlocked = false;
  for (const asin of asins) {
    live.set(asin, await fetchCatalogItem(acct, asin, marketplaceId));
    await pace(PACE_MS.catalog);
    if (aplusBlocked) continue;
    try {
      aplus.set(asin, await fetchAplus(acct, asin, marketplaceId));
    } catch (err) {
      // A+ needs Brand Registry; without it every ASIN is refused, so stop asking.
      if (/EAMAZON_FORBIDDEN/.test((err as Error).message)) {
        aplusBlocked = true;
        notes.push("A+ content not readable (Brand Registry or role missing); A+ not watched this run");
      }
    }
    await pace(PACE_MS.aplus);
  }
  for (const listing of listings) {
    const sku = listing.sku as string;
    const submitted = await fetchSubmittedListing(acct, sku, marketplaceId);
    await pace(PACE_MS.listings);
    const asin = typeof listing.asin === "string" ? listing.asin : undefined;
    const snap = contentSnapshot(
      (submitted.submitted ?? {}) as Obj,
      (asin && live.get(asin)) || {},
      (asin && aplus.get(asin)) || [],
    );
    // When A+ could not be read this run, keep the last known A+ value.
    const prior = previous.get(sku)?.data;
    if (aplusBlocked && prior && !(asin && aplus.has(asin))) snap.aplus = prior.aplus ?? [];
    out.set(sku, snap);
  }
  return out;
}

export async function runCheck(ctx: PluginContext, account: ConfigAccount, kind: WatchKind): Promise<CheckResult> {
  const db = ctx.db;
  const accountKey = account.key!;
  const startedAt = new Date().toISOString();
  let total = 0;
  let changeCount = 0;
  const notes: string[] = [];
  let acct: ResolvedAccount | undefined;
  try {
    acct = openAccount(ctx, account, "listing-watch");
    for (const marketplaceId of acct.marketplaceIds) {
      const listings = (await searchAllListings(acct, marketplaceId)).filter((l) => typeof l.sku === "string");
      total += listings.length;
      const previous = await loadSnapshots(db, accountKey, marketplaceId, kind);
      const baseline = previous.size === 0;
      const current = await snapshotsFor(acct, kind, marketplaceId, listings, previous, notes);

      for (const [sku, snap] of current) {
        const asin = typeof snap.asin === "string" ? snap.asin : (listings.find((l) => l.sku === sku)?.asin as string | undefined) ?? null;
        const prior = previous.get(sku);
        const changes: FieldChange[] = prior
          ? diffSnapshots(prior.data, snap)
          : baseline
            ? []
            : [{ field: "listing", before: null, after: "added" }];
        await recordChanges(db, accountKey, marketplaceId, kind, sku, asin, changes);
        await saveSnapshot(db, accountKey, marketplaceId, kind, sku, asin, snap);
        changeCount += changes.length;
      }
      for (const [sku, prior] of previous) {
        if (current.has(sku)) continue;
        await recordChanges(db, accountKey, marketplaceId, kind, sku, prior.asin, [
          { field: "listing", before: "present", after: "removed" },
        ]);
        await deleteSnapshot(db, accountKey, marketplaceId, kind, sku);
        changeCount++;
      }
      if (baseline) notes.push(`first ${kind} check in ${marketplaceId}: baseline saved, no changes recorded`);
    }
    await saveRun(db, accountKey, kind, startedAt, true, total, changeCount, notes.join("; ") || null);
    return { account: accountKey, kind, ok: true, listings: total, changes: changeCount, note: notes.join("; ") || undefined };
  } catch (err) {
    const message = redact((err as Error).message, acct?.secretValues() ?? []);
    await saveRun(db, accountKey, kind, startedAt, false, total, changeCount, message.slice(0, 1000));
    return { account: accountKey, kind, ok: false, listings: total, changes: changeCount, note: message };
  }
}

async function saveRun(db: Db, accountKey: string, kind: WatchKind, startedAt: string, ok: boolean, listings: number, changes: number, note: string | null) {
  await db.execute(
    `INSERT INTO ${db.namespace}.listing_watch_runs (account_key, kind, started_at, finished_at, ok, listings, changes, note)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7)`,
    [accountKey, kind, startedAt, ok, listings, changes, note],
  );
}

export async function runScheduledCheck(ctx: PluginContext, kind: WatchKind): Promise<CheckResult[]> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const results: CheckResult[] = [];
  for (const account of watchedAccounts(config)) {
    const result = await runCheck(ctx, account, kind);
    results.push(result);
    const line = `listing watch ${kind} ${result.account}: ${result.ok ? "ok" : "failed"}, ${result.listings} listing(s), ${result.changes} change(s)${result.note ? ` (${result.note})` : ""}`;
    if (result.ok) ctx.logger.info(line);
    else ctx.logger.warn(line);
  }
  return results;
}

// ─── Reading the change log ──────────────────────────────────────────────

export interface ChangeQuery {
  since: string;
  sku?: string;
  asin?: string;
  field?: string;
  limit: number;
}

export async function listChanges(db: Db, accountKey: string, q: ChangeQuery) {
  const params: unknown[] = [accountKey, q.since];
  const where = ["account_key = $1", "detected_at >= $2"];
  for (const [column, value] of [["sku", q.sku], ["asin", q.asin], ["field", q.field]] as const) {
    if (!value) continue;
    params.push(value);
    where.push(`${column} = $${params.length}`);
  }
  params.push(q.limit);
  const changes = await db.query<Obj>(
    `SELECT detected_at, marketplace_id, sku, asin, kind, field, before, after
       FROM ${db.namespace}.listing_changes
      WHERE ${where.join(" AND ")}
      ORDER BY detected_at DESC, sku, field
      LIMIT $${params.length}`,
    params,
  );
  const runs = await db.query<Obj>(
    `SELECT kind, started_at, finished_at, ok, listings, changes, note
       FROM ${db.namespace}.listing_watch_runs
      WHERE account_key = $1
      ORDER BY started_at DESC
      LIMIT 4`,
    [accountKey],
  );
  return { changes, recentChecks: runs };
}
