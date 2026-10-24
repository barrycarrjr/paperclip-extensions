/**
 * "Don't reply": a decision recorded about a review, short of posting one.
 *
 * Some reviews are better left unanswered. The usual case is an unhappy
 * review found months late: a reply then reads as "why did this take you so
 * long", which is worse than silence. A person marks it on the Reviews page,
 * after a confirmation. It then leaves "Needs a reply", its task is
 * cancelled, and the agent reply tool refuses it, so an agent working through
 * the queue cannot undo the decision by answering anyway. That refusal also
 * covers a reply an agent drafted earlier that is still waiting as an
 * approval: approving it later runs the tool, and the tool says no.
 *
 * It is not permanent. "Reply after all" clears it, and so does the customer
 * editing their review, because an edited review is not the one the person
 * decided about.
 *
 * Every write here is constrained on the review AND its company, like every
 * read in reviewQueries.ts.
 */
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { LocationConfig } from "./types.js";

export type DecisionDb = Pick<PluginDatabaseClient, "namespace" | "query" | "execute">;

/** Where a review stands, as far as a skip is concerned. */
export interface ReviewDecisionState {
  hasReply: boolean;
  skipped: boolean;
}

export async function findDecisionState(
  db: Pick<DecisionDb, "namespace" | "query">,
  reviewName: string,
  companyId: string,
): Promise<ReviewDecisionState | null> {
  const rows = await db.query<{ reply_text: string | null; skipped_at: unknown }>(
    `SELECT reply_text, skipped_at FROM ${db.namespace}.reviews
     WHERE review_name = $1 AND company_id = $2`,
    [reviewName, companyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    hasReply: row.reply_text != null && row.reply_text.length > 0,
    skipped: row.skipped_at != null,
  };
}

/**
 * Whether the reply tool must refuse this review: a person chose not to
 * answer it. A reply wins over a skip everywhere else, so a review that has
 * one is not reported as skipped.
 */
export function isSkippedWithoutReply(state: ReviewDecisionState | null): boolean {
  return state != null && state.skipped && !state.hasReply;
}

/** Mark a review as not needing a reply. True when this call changed it. */
export async function skipReview(
  db: DecisionDb,
  reviewName: string,
  location: LocationConfig,
  userId: string | null,
): Promise<boolean> {
  const result = await db.execute(
    `UPDATE ${db.namespace}.reviews SET skipped_at = now(), skipped_by_user_id = $4, updated_at = now()
     WHERE review_name = $1 AND location_key = $2 AND company_id = $3
       AND reply_text IS NULL AND skipped_at IS NULL`,
    [reviewName, location.key, location.targetCompanyId, userId],
  );
  return result.rowCount > 0;
}

/** Undo a skip. True when this call changed it. */
export async function unskipReview(db: DecisionDb, reviewName: string, location: LocationConfig): Promise<boolean> {
  const result = await db.execute(
    `UPDATE ${db.namespace}.reviews SET skipped_at = NULL, skipped_by_user_id = NULL, updated_at = now()
     WHERE review_name = $1 AND location_key = $2 AND company_id = $3 AND skipped_at IS NOT NULL`,
    [reviewName, location.key, location.targetCompanyId],
  );
  return result.rowCount > 0;
}

/** The skipped, still unreplied reviews at a location, for the agent's list tool. */
export async function readSkippedForLocation(
  db: Pick<DecisionDb, "namespace" | "query">,
  location: LocationConfig,
): Promise<Set<string>> {
  const rows = await db.query<{ review_name: string }>(
    `SELECT review_name FROM ${db.namespace}.reviews
     WHERE location_key = $1 AND company_id = $2 AND reply_text IS NULL AND skipped_at IS NOT NULL`,
    [location.key, location.targetCompanyId],
  );
  return new Set(rows.map((row) => row.review_name));
}

/**
 * Whether the customer changed their review since we stored it. Text and
 * stars are compared rather than Google's update time, because that time can
 * move for reasons that are not the customer's (a reply being posted is one),
 * and a skip that undid itself for no visible reason would be worse than none.
 */
export function reviewWasEdited(
  stored: { reviewText: string | null | undefined; starRating: number | string | null | undefined },
  live: { reviewText: string | null | undefined; starRating: number },
): boolean {
  const storedText = (stored.reviewText ?? "").trim();
  const liveText = (live.reviewText ?? "").trim();
  if (storedText !== liveText) return true;
  const storedStars = Number(stored.starRating);
  // A rating Google sent in a shape we could not read comes through as 0,
  // which is not a change the customer made.
  return Number.isFinite(storedStars) && live.starRating >= 1 && storedStars !== live.starRating;
}
