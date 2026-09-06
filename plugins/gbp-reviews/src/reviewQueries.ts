/**
 * The reads behind the Reviews page, with the company rule baked in.
 *
 * Every query here is constrained on TWO columns: the location key the page
 * asked for AND the company that location belongs to (its targetCompanyId,
 * never the company the page was opened in). The second column is a line of
 * defence against a row that was filed under the wrong company, and it is
 * what lets HQ read every location's reviews without a special case: HQ is
 * allowed to see the location, so it reads with that location's own company
 * id, the same id the daily sync writes.
 *
 * Which locations a company may see at all is decided by
 * scopeLocationsForCompany; this file only adds "and is the one you asked
 * for". Everything takes the database as a parameter so the tests can hand
 * in a recorder and check the SQL and its parameters without Postgres.
 */
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { CompanyScope } from "./hostScope.js";
import { scopeLocationsForCompany } from "./locationScope.js";
import { reviewBelongsToLocation, type ParsedReviewName } from "./reviewName.js";
import type { ReplyPostStatus, ReviewRow } from "./replyStore.js";
import type { InstanceConfig, LocationConfig } from "./types.js";

/** The read half of ctx.db; the page never writes through this file. */
export type ReviewQueryDb = Pick<PluginDatabaseClient, "namespace" | "query">;

export interface ScopedLocation {
  location: LocationConfig;
  /** True when the viewer is HQ looking across companies. */
  isRollup: boolean;
  /**
   * Posting is allowed only from the location's own company, never from the
   * roll-up: a post from HQ would put the wrong company on every audit row.
   */
  canPostFromHere: boolean;
}

function scoped(config: InstanceConfig, scope: CompanyScope, isPortfolioRoot: boolean) {
  return scopeLocationsForCompany({
    companyId: scope.companyId,
    isPortfolioRoot,
    locations: config.locations ?? [],
  });
}

function withPostingRule(
  location: LocationConfig,
  scope: CompanyScope,
  isRollup: boolean,
): ScopedLocation {
  return {
    location,
    isRollup,
    canPostFromHere: !isRollup && location.targetCompanyId === scope.companyId,
  };
}

/**
 * The location the page asked for, if the viewing company may see it. An
 * unknown key and another company's key both come back as nothing, so the
 * answer never confirms that a location exists elsewhere.
 */
export function resolveScopedLocation(
  config: InstanceConfig,
  scope: CompanyScope,
  isPortfolioRoot: boolean,
  locationKey: unknown,
): ScopedLocation | null {
  if (typeof locationKey !== "string" || locationKey.length === 0) return null;
  const result = scoped(config, scope, isPortfolioRoot);
  const location = result.locations.find((l) => l.key === locationKey) ?? null;
  if (!location) return null;
  return withPostingRule(location, scope, result.isRollup);
}

/**
 * The visible location a review name sits under, by its Google account and
 * location ids, or nothing. The review name is trusted only after
 * parseReviewName, which is why this takes the parsed form.
 */
export function resolveScopedLocationForReview(
  config: InstanceConfig,
  scope: CompanyScope,
  isPortfolioRoot: boolean,
  parsed: ParsedReviewName,
): ScopedLocation | null {
  const result = scoped(config, scope, isPortfolioRoot);
  const location = result.locations.find((l) => reviewBelongsToLocation(parsed, l)) ?? null;
  if (!location) return null;
  return withPostingRule(location, scope, result.isRollup);
}

/** One review as the page sees it. The same shape in the list and the detail. */
export interface ReviewListItem {
  reviewName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  replyText: string | null;
  replyTime: string | null;
  /** 'human', 'agent', 'google', or null when nobody recorded it. */
  replySource: string | null;
  reviewTime: string;
  issueId: string | null;
}

export function toReviewListItem(row: ReviewRow): ReviewListItem {
  return {
    reviewName: row.review_name,
    reviewerName: row.reviewer_name,
    starRating: Number(row.star_rating),
    reviewText: row.review_text ?? null,
    replyText: row.reply_text ?? null,
    replyTime: row.reply_time ?? null,
    replySource: row.reply_source ?? null,
    reviewTime: row.review_time,
    issueId: row.paperclip_issue_id ?? null,
  };
}

const REVIEW_COLUMNS =
  "review_name, location_key, company_id, reviewer_name, star_rating, review_text, reply_text, reply_time, reply_source, review_time, paperclip_issue_id";

/** Newest first, with the ones still waiting for a reply on top. */
export const REVIEW_LIST_LIMIT = 200;

export async function listReviewsForLocation(
  db: ReviewQueryDb,
  location: LocationConfig,
): Promise<ReviewListItem[]> {
  const rows = await db.query<ReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM ${db.namespace}.reviews
     WHERE location_key = $1 AND company_id = $2
     ORDER BY (reply_text IS NULL) DESC, review_time DESC
     LIMIT ${REVIEW_LIST_LIMIT}`,
    [location.key, location.targetCompanyId],
  );
  return rows.map(toReviewListItem);
}

/**
 * One review by name, but only if it is filed under this location AND that
 * location's company. A name the sync has not stored yet comes back as
 * nothing; the page then offers Sync now rather than guessing.
 */
export async function findReviewForLocation(
  db: ReviewQueryDb,
  reviewName: string,
  location: LocationConfig,
): Promise<ReviewListItem | null> {
  const rows = await db.query<ReviewRow>(
    `SELECT ${REVIEW_COLUMNS} FROM ${db.namespace}.reviews
     WHERE review_name = $1 AND location_key = $2 AND company_id = $3`,
    [reviewName, location.key, location.targetCompanyId],
  );
  return rows[0] ? toReviewListItem(rows[0]) : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

// "Last synced" used to be read from here, as MAX(updated_at) over this
// location's rows. That is the time of the last row CHANGE, not of the last
// sync: posting a reply bumped it, so the page reported a sync that never
// ran, and a location whose Google listing holds no reviews has no rows at
// all and so read as never synced however often it was pulled. The sync now
// records its own time in plugin state (see lastSyncStateKey in worker.ts)
// and the page reads that, so this query is gone rather than left to mislead.

export interface LocationSummary {
  unreplied: number;
  avgRating: number | null;
  total: number;
}

/** The dashboard counts. Postgres returns COUNT as text, so they are made numbers here. */
export async function summaryForLocation(
  db: ReviewQueryDb,
  location: LocationConfig,
): Promise<LocationSummary> {
  const rows = await db.query<{ unreplied: unknown; avg_rating: unknown; total: unknown }>(
    `SELECT COUNT(CASE WHEN reply_text IS NULL THEN 1 END) AS unreplied, AVG(star_rating) AS avg_rating, COUNT(*) AS total
     FROM ${db.namespace}.reviews WHERE location_key = $1 AND company_id = $2`,
    [location.key, location.targetCompanyId],
  );
  const s = rows[0];
  const avg = s?.avg_rating == null ? null : Number(s.avg_rating);
  return {
    unreplied: Number(s?.unreplied ?? 0),
    avgRating: avg !== null && Number.isFinite(avg) ? avg : null,
    total: Number(s?.total ?? 0),
  };
}

export interface PendingAttempt {
  createdAt: string;
  status: Extract<ReplyPostStatus, "posting" | "unknown">;
}

/**
 * An attempt on this review that is genuinely still running: a 'posting' row
 * touched within the stale window. The page shows no Post button while one
 * exists, because a second post at the same moment would be refused anyway.
 *
 * Nothing older comes back, and no 'unknown' row comes back at all. Those are
 * settled against Google by settlePendingAttempts before this runs, and a row
 * that could not be settled must never hide the Post button for good: a
 * crashed worker or a dropped connection would otherwise make the review
 * unanswerable from Paperclip for ever.
 *
 * The window is measured from updated_at, not created_at, because a retry
 * with the same key restarts the row in place and keeps the first attempt's
 * created_at. The caller passes the window so there is only one copy of it.
 */
export async function findPendingAttempt(
  db: ReviewQueryDb,
  reviewName: string,
  staleAfterMs: number,
): Promise<PendingAttempt | null> {
  const rows = await db.query<{ status: PendingAttempt["status"]; created_at: unknown }>(
    `SELECT status, created_at FROM ${db.namespace}.reply_posts
     WHERE review_name = $1 AND status = 'posting'
       AND updated_at > now() - ($2::double precision * interval '1 millisecond')
     ORDER BY created_at DESC LIMIT 1`,
    [reviewName, staleAfterMs],
  );
  const row = rows[0];
  if (!row) return null;
  return { createdAt: toIsoOrNull(row.created_at) ?? String(row.created_at), status: row.status };
}
