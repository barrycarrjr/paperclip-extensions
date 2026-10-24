/**
 * "Don't reply", at the database edge. The SQL is
 * checked through a recorder, so these run with no Postgres: what matters
 * here is that every write is tied to the review AND its company, and that
 * the skip itself refuses a review that has a reply, so a reply made a
 * moment earlier always wins.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  findDecisionState,
  isSkippedWithoutReply,
  readSkippedForLocation,
  reviewWasEdited,
  skipReview,
  unskipReview,
  type DecisionDb,
} from "./reviewDecisions.js";
import type { LocationConfig } from "./types.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const REVIEW = "accounts/111/locations/222/reviews/abc";

const MAIN_ST: LocationConfig = {
  key: "main-st",
  displayName: "Main St Store",
  googleAccountId: "111",
  locationId: "222",
  accountKey: "owner",
  targetCompanyId: COMPANY_A,
};

class RecordingDb implements DecisionDb {
  namespace = "plugin_test";
  calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  rows: unknown[] = [];
  rowCount = 1;
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.calls.push({ sql, params });
    return this.rows as T[];
  }
  async execute(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    return { rowCount: this.rowCount };
  }
}

function normalise(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("a skip is written only for an unreplied, unskipped review of this location and company", async () => {
  const db = new RecordingDb();
  assert.equal(await skipReview(db, REVIEW, MAIN_ST, "user-1"), true);
  const sql = normalise(db.calls[0]!.sql);
  assert.match(sql, /^UPDATE plugin_test\.reviews SET skipped_at = now\(\), skipped_by_user_id = \$4/);
  assert.match(sql, /WHERE review_name = \$1 AND location_key = \$2 AND company_id = \$3 AND reply_text IS NULL AND skipped_at IS NULL$/);
  assert.deepEqual(db.calls[0]!.params, [REVIEW, MAIN_ST.key, COMPANY_A, "user-1"]);

  // Nothing changed (already skipped, or replied meanwhile) is reported, not thrown.
  db.rowCount = 0;
  assert.equal(await skipReview(db, REVIEW, MAIN_ST, null), false);
});

test("undoing a skip clears who and when, for this location and company only", async () => {
  const db = new RecordingDb();
  assert.equal(await unskipReview(db, REVIEW, MAIN_ST), true);
  const sql = normalise(db.calls[0]!.sql);
  assert.match(sql, /SET skipped_at = NULL, skipped_by_user_id = NULL/);
  assert.match(sql, /WHERE review_name = \$1 AND location_key = \$2 AND company_id = \$3 AND skipped_at IS NOT NULL$/);
  assert.deepEqual(db.calls[0]!.params, [REVIEW, MAIN_ST.key, COMPANY_A]);
});

test("the decision state reads one review in one company, and a reply beats a skip", async () => {
  const db = new RecordingDb();
  assert.equal(await findDecisionState(db, REVIEW, COMPANY_A), null);
  assert.deepEqual(db.calls[0]!.params, [REVIEW, COMPANY_A]);
  assert.match(normalise(db.calls[0]!.sql), /WHERE review_name = \$1 AND company_id = \$2$/);

  db.rows = [{ reply_text: null, skipped_at: new Date() }];
  const skipped = await findDecisionState(db, REVIEW, COMPANY_A);
  assert.deepEqual(skipped, { hasReply: false, skipped: true });
  assert.equal(isSkippedWithoutReply(skipped), true);

  // Answered in Google's console after it was skipped: it is replied, so
  // nothing reports it as skipped.
  db.rows = [{ reply_text: "Thanks!", skipped_at: new Date() }];
  const replied = await findDecisionState(db, REVIEW, COMPANY_A);
  assert.equal(isSkippedWithoutReply(replied), false);
  assert.equal(isSkippedWithoutReply(null), false);
});

test("the list tool reads the skipped, unreplied reviews of one location and company", async () => {
  const db = new RecordingDb();
  db.rows = [{ review_name: "r1" }, { review_name: "r2" }];
  const skipped = await readSkippedForLocation(db, MAIN_ST);
  assert.deepEqual([...skipped], ["r1", "r2"]);
  assert.deepEqual(db.calls[0]!.params, [MAIN_ST.key, COMPANY_A]);
  assert.match(normalise(db.calls[0]!.sql), /WHERE location_key = \$1 AND company_id = \$2 AND reply_text IS NULL AND skipped_at IS NOT NULL$/);
});

test("an edit is a change to the words or the stars, and an unreadable rating is not one", () => {
  const stored = { reviewText: "Slow service", starRating: 2 };
  assert.equal(reviewWasEdited(stored, { reviewText: "Slow service", starRating: 2 }), false);
  // Whitespace Google adds or drops is not the customer's edit.
  assert.equal(reviewWasEdited(stored, { reviewText: "Slow service \n", starRating: 2 }), false);
  assert.equal(reviewWasEdited(stored, { reviewText: "Slow service, but they fixed it", starRating: 2 }), true);
  assert.equal(reviewWasEdited(stored, { reviewText: "Slow service", starRating: 4 }), true);
  assert.equal(reviewWasEdited(stored, { reviewText: "Slow service", starRating: 0 }), false);
  // Postgres can hand the stored rating back as text.
  assert.equal(reviewWasEdited({ reviewText: null, starRating: "5" }, { reviewText: undefined, starRating: 5 }), false);
});
