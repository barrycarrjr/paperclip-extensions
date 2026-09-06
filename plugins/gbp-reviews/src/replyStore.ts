/**
 * The database side of posting a reply, behind a small interface.
 *
 * replyGuard.ts holds the decision chain (who may post, what may be
 * overwritten, which attempt wins) and is tested with no database and no
 * network. This file is the only place that knows the two tables involved,
 * so the guard's tests inject an in-memory copy of this interface and the
 * worker hands it the real one built on ctx.db.
 *
 * Two of the idempotency layers live in the database, not in code:
 * reply_posts.idempotency_key is the primary key, and a partial unique index
 * allows one 'posting' row per review. beginPost turns those two unique
 * violations into plain results so the guard can answer with the right
 * [ECODE] rather than a raw Postgres message.
 */
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { ReplySource } from "./replySource.js";
import type { GbpReview, LocationConfig } from "./types.js";
import { starRatingToNumber } from "./gbpClient.js";

export type ReplyPostStatus = "posting" | "posted" | "failed" | "unknown";
export type ReplyPostSource = "human" | "agent";

export interface ReplyPostRow {
  idempotencyKey: string;
  reviewName: string;
  locationKey: string;
  companyId: string;
  source: ReplyPostSource;
  actorUserId: string | null;
  actorAgentId: string | null;
  actorRunId: string | null;
  replyText: string;
  previousReplyText: string | null;
  previousReplyTime: string | null;
  status: ReplyPostStatus;
  googleUpdateTime: string | null;
  error: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
}

/** What the guard knows before the Google call; the store fills in the rest. */
export type BeginPostInput = Omit<
  ReplyPostRow,
  "status" | "googleUpdateTime" | "error" | "createdAt" | "updatedAt"
>;

/**
 * 'duplicate_key': this idempotency key already has a row that is posting or
 * posted (a retry of a failed or unknown attempt with the same key is allowed
 * and restarts that row instead). 'review_busy': another key is mid-post for
 * the same review.
 */
export type BeginPostResult = "ok" | "duplicate_key" | "review_busy";

export interface ReviewRow {
  review_name: string;
  location_key: string;
  company_id: string;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  reply_text: string | null;
  reply_time: string | null;
  reply_source: string | null;
  review_time: string;
  paperclip_issue_id: string | null;
}

export interface ReplyStore {
  findPost(idempotencyKey: string): Promise<ReplyPostRow | null>;
  /**
   * The newest attempt on this review whose outcome is not settled: still
   * 'posting', or 'unknown' because the connection dropped after the PUT.
   * Both kinds have to come back, because both have to be reconciled against
   * Google before anyone may post again; an 'unknown' row nobody can reach
   * is exactly what used to block a review for good.
   */
  findInFlight(reviewName: string): Promise<ReplyPostRow | null>;
  /** Every unsettled attempt on this review, newest first. */
  listUnsettledPosts(reviewName: string): Promise<ReplyPostRow[]>;
  beginPost(row: BeginPostInput): Promise<BeginPostResult>;
  /**
   * The reply Google held when we looked, written after the slot is claimed
   * and before the PUT. The claim happens before the live read, so these two
   * columns cannot be filled in at claim time.
   */
  recordPrevious(idempotencyKey: string, previousReplyText: string | null, previousReplyTime: string | null): Promise<void>;
  /**
   * `detail` is the Google update time when `status` is 'posted' and the
   * error text otherwise.
   */
  finishPost(idempotencyKey: string, status: Exclude<ReplyPostStatus, "posting">, detail: string): Promise<void>;
  /**
   * Record the live review locally, creating the row when the sync has not
   * seen it yet. An existing row also follows its location: the location key
   * and the company come from the location passed in, so a location that was
   * repointed at another company does not leave its rows filed under the old
   * one, invisible to every screen.
   */
  upsertReview(liveReview: GbpReview, location: LocationConfig, replySource: ReplySource | null): Promise<void>;
  getReviewRow(reviewName: string, companyId: string): Promise<ReviewRow | null>;
}

const PKEY_CONSTRAINT = "reply_posts_pkey";
const IN_FLIGHT_INDEX = "idx_reply_posts_one_in_flight";

/**
 * Which of the two unique rules an insert error hit, or null when it was
 * something else. Only the message text crosses the worker-to-host boundary
 * (the host serialises `err.message` and nothing more), so this matches the
 * constraint name Postgres puts in the message rather than an error code.
 */
export function classifyBeginPostError(message: string): Exclude<BeginPostResult, "ok"> | null {
  if (!/duplicate key value violates unique constraint/i.test(message)) return null;
  if (message.includes(IN_FLIGHT_INDEX)) return "review_busy";
  if (message.includes(PKEY_CONSTRAINT)) return "duplicate_key";
  return null;
}

interface RawReplyPostRow {
  idempotency_key: string;
  review_name: string;
  location_key: string;
  company_id: string;
  source: ReplyPostSource;
  actor_user_id: string | null;
  actor_agent_id: string | null;
  actor_run_id: string | null;
  reply_text: string;
  previous_reply_text: string | null;
  previous_reply_time: string | null;
  status: ReplyPostStatus;
  google_update_time: string | null;
  error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function fromRaw(row: RawReplyPostRow): ReplyPostRow {
  return {
    idempotencyKey: row.idempotency_key,
    reviewName: row.review_name,
    locationKey: row.location_key,
    companyId: row.company_id,
    source: row.source,
    actorUserId: row.actor_user_id,
    actorAgentId: row.actor_agent_id,
    actorRunId: row.actor_run_id,
    replyText: row.reply_text,
    previousReplyText: row.previous_reply_text,
    previousReplyTime: row.previous_reply_time,
    status: row.status,
    googleUpdateTime: row.google_update_time,
    error: row.error,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const REPLY_POST_COLUMNS =
  "idempotency_key, review_name, location_key, company_id, source, actor_user_id, actor_agent_id, actor_run_id, " +
  "reply_text, previous_reply_text, previous_reply_time, status, google_update_time, error, created_at, updated_at";

export function createDbReplyStore(db: PluginDatabaseClient): ReplyStore {
  const ns = db.namespace;

  return {
    async findPost(idempotencyKey) {
      const rows = await db.query<RawReplyPostRow>(
        `SELECT ${REPLY_POST_COLUMNS} FROM ${ns}.reply_posts WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      return rows[0] ? fromRaw(rows[0]) : null;
    },

    async findInFlight(reviewName) {
      const rows = await db.query<RawReplyPostRow>(
        `SELECT ${REPLY_POST_COLUMNS} FROM ${ns}.reply_posts WHERE review_name = $1 AND status IN ('posting', 'unknown') ORDER BY created_at DESC LIMIT 1`,
        [reviewName],
      );
      return rows[0] ? fromRaw(rows[0]) : null;
    },

    async listUnsettledPosts(reviewName) {
      const rows = await db.query<RawReplyPostRow>(
        `SELECT ${REPLY_POST_COLUMNS} FROM ${ns}.reply_posts WHERE review_name = $1 AND status IN ('posting', 'unknown') ORDER BY created_at DESC`,
        [reviewName],
      );
      return rows.map(fromRaw);
    },

    async beginPost(row) {
      // A retry carries the same key as the attempt it retries, so the row
      // may already exist. It is restarted only from 'failed' or 'unknown';
      // a key that is 'posting' or 'posted' updates nothing, and zero rows
      // is reported as a duplicate. The partial unique index still applies
      // on the update path, so a second key mid-post for the same review is
      // refused here too.
      //
      // The two extra predicates bind the key to its review: a key first used
      // for one review can never restart its row by naming another one, so the
      // audit row can never describe a post that did not happen. The guard
      // refuses that case with a sentence first; this is the database saying
      // the same thing.
      //
      // reply_text is rewritten only for a 'failed' row, so an agent may
      // correct its wording after Google rejected it. An 'unknown' row keeps
      // its text, because that text may already be live on Google.
      let result: { rowCount: number };
      try {
        result = await db.execute(
          `INSERT INTO ${ns}.reply_posts (idempotency_key, review_name, location_key, company_id, source, actor_user_id, actor_agent_id, actor_run_id, reply_text, previous_reply_text, previous_reply_time, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'posting')
           ON CONFLICT (idempotency_key) DO UPDATE SET
             status = 'posting',
             reply_text = CASE WHEN ${ns}.reply_posts.status = 'failed' THEN EXCLUDED.reply_text ELSE ${ns}.reply_posts.reply_text END,
             previous_reply_text = EXCLUDED.previous_reply_text,
             previous_reply_time = EXCLUDED.previous_reply_time,
             google_update_time = NULL,
             error = NULL,
             updated_at = now()
           WHERE ${ns}.reply_posts.status IN ('failed', 'unknown')
             AND ${ns}.reply_posts.review_name = EXCLUDED.review_name
             AND ${ns}.reply_posts.company_id = EXCLUDED.company_id`,
          [
            row.idempotencyKey,
            row.reviewName,
            row.locationKey,
            row.companyId,
            row.source,
            row.actorUserId,
            row.actorAgentId,
            row.actorRunId,
            row.replyText,
            row.previousReplyText,
            row.previousReplyTime,
          ],
        );
      } catch (err) {
        const classified = classifyBeginPostError((err as Error).message ?? String(err));
        if (classified) return classified;
        throw err;
      }
      return result.rowCount > 0 ? "ok" : "duplicate_key";
    },

    async recordPrevious(idempotencyKey, previousReplyText, previousReplyTime) {
      await db.execute(
        `UPDATE ${ns}.reply_posts SET previous_reply_text = $1, previous_reply_time = $2, updated_at = now() WHERE idempotency_key = $3`,
        [previousReplyText, previousReplyTime, idempotencyKey],
      );
    },

    async finishPost(idempotencyKey, status, detail) {
      if (status === "posted") {
        await db.execute(
          `UPDATE ${ns}.reply_posts SET status = 'posted', google_update_time = $1, error = NULL, updated_at = now() WHERE idempotency_key = $2`,
          [detail, idempotencyKey],
        );
        return;
      }
      await db.execute(
        `UPDATE ${ns}.reply_posts SET status = $1, error = $2, updated_at = now() WHERE idempotency_key = $3`,
        [status, detail, idempotencyKey],
      );
    },

    async upsertReview(liveReview, location, replySource) {
      const reviewerName = liveReview.reviewer?.isAnonymous
        ? "Anonymous"
        : liveReview.reviewer?.displayName || "Anonymous";
      await db.execute(
        `INSERT INTO ${ns}.reviews (review_name, location_key, company_id, reviewer_name, star_rating, review_text, reply_text, review_time, reply_time, reply_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (review_name) DO UPDATE SET
           location_key = EXCLUDED.location_key,
           company_id = EXCLUDED.company_id,
           reply_text = EXCLUDED.reply_text,
           reply_time = EXCLUDED.reply_time,
           reply_source = EXCLUDED.reply_source,
           updated_at = now()`,
        [
          liveReview.name,
          location.key,
          location.targetCompanyId,
          reviewerName,
          starRatingToNumber(liveReview.starRating),
          liveReview.comment ?? null,
          liveReview.reviewReply?.comment ?? null,
          liveReview.createTime,
          liveReview.reviewReply?.updateTime ?? null,
          replySource,
        ],
      );
    },

    async getReviewRow(reviewName, companyId) {
      const rows = await db.query<ReviewRow>(
        `SELECT review_name, location_key, company_id, reviewer_name, star_rating, review_text, reply_text, reply_time, reply_source, review_time, paperclip_issue_id
         FROM ${ns}.reviews WHERE review_name = $1 AND company_id = $2`,
        [reviewName, companyId],
      );
      return rows[0] ?? null;
    },
  };
}
