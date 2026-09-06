/**
 * The reply_posts rules run against a real Postgres, not a stub.
 *
 * Every other test of the posting path re-implements the store in memory or
 * answers each write with rowCount 1, so three rules that only exist in the
 * database were never actually run: the partial unique index that allows one
 * attempt in flight per review, the "no rows updated means this key is spent"
 * result that becomes [EDUPLICATE_IN_PROGRESS], and the WHERE clause that ties
 * an attempt key to the review it was first used for. The staleness window in
 * findPendingAttempt is here too, because it passes a number into a SQL
 * interval and a wrong type there would only ever show up at runtime.
 *
 * This file needs a database, so it runs only when
 * GBP_REVIEWS_TEST_DATABASE_URL names one, and prints why it skipped when it
 * does not. It creates its own throwaway schema from the plugin's own
 * migration files and drops it again at the end, so it never touches anything
 * else in the database it is pointed at.
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { createDbReplyStore, type BeginPostInput, type ReplyStore } from "./replyStore.js";
import { findPendingAttempt } from "./reviewQueries.js";
import type { GbpReview, LocationConfig } from "./types.js";

const DATABASE_URL = process.env.GBP_REVIEWS_TEST_DATABASE_URL ?? "";
const SKIP_REASON =
  "GBP_REVIEWS_TEST_DATABASE_URL is not set, so the real Postgres rules were not run. Set it to a Postgres connection string to run them.";

/** The schema name the migration files are written against. */
const MIGRATION_SCHEMA = "plugin_gbp_reviews_6e35570847";

const REVIEW_ONE = "accounts/111/locations/222/reviews/one";
const REVIEW_TWO = "accounts/111/locations/222/reviews/two";
const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";

const MAIN_ST: LocationConfig = {
  key: "main-st",
  displayName: "Main St Store",
  googleAccountId: "111",
  locationId: "222",
  accountKey: "owner",
  targetCompanyId: COMPANY_A,
};

function claim(over: Partial<BeginPostInput> = {}): BeginPostInput {
  return {
    idempotencyKey: "key-1",
    reviewName: REVIEW_ONE,
    locationKey: MAIN_ST.key,
    companyId: COMPANY_A,
    source: "human",
    actorUserId: "user-1",
    actorAgentId: null,
    actorRunId: null,
    replyText: "Thank you for the review.",
    previousReplyText: null,
    previousReplyTime: null,
    ...over,
  };
}

if (!DATABASE_URL) {
  console.log(`Skipping the reply_posts Postgres tests: ${SKIP_REASON}`);
  test("the reply_posts rules that live in the database", { skip: SKIP_REASON }, () => {});
} else {
  const schema = `gbp_reviews_pg_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let pool: import("pg").Pool;
  let db: PluginDatabaseClient;
  let store: ReplyStore;

  before(async () => {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: DATABASE_URL, max: 4 });
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    await pool.query(`CREATE SCHEMA ${schema}`);
    for (const file of ["001_create_reviews.sql", "002_reply_posts.sql"]) {
      const sql = (await readFile(join(migrationsDir, file), "utf8")).split(MIGRATION_SCHEMA).join(schema);
      await pool.query(sql);
    }
    db = {
      namespace: schema,
      query: (async (sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[])).rows) as PluginDatabaseClient["query"],
      execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await pool.query(sql, params as unknown[])).rowCount ?? 0 }),
    };
    store = createDbReplyStore(db);
  });

  after(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });

  async function reset() {
    await pool.query(`TRUNCATE ${schema}.reply_posts, ${schema}.reviews`);
  }

  test("one attempt at a time per review: a second key is refused by the index, whatever it carries", async () => {
    await reset();
    assert.equal(await store.beginPost(claim({ idempotencyKey: "first" })), "ok");
    // A different key, same review, while the first is still posting. Nothing
    // in the code stops this; the partial unique index does.
    assert.equal(await store.beginPost(claim({ idempotencyKey: "second" })), "review_busy");
    // Another review is not blocked by it.
    assert.equal(await store.beginPost(claim({ idempotencyKey: "third", reviewName: REVIEW_TWO })), "ok");

    // Once the first attempt has settled the slot is free again.
    await store.finishPost("first", "posted", "2026-09-06T12:00:00Z");
    assert.equal(await store.beginPost(claim({ idempotencyKey: "second" })), "ok");
  });

  test("a key that already posted is spent, and a failed one restarts with the new wording", async () => {
    await reset();
    assert.equal(await store.beginPost(claim({ idempotencyKey: "posted-key" })), "ok");
    await store.finishPost("posted-key", "posted", "2026-09-06T12:00:00Z");
    // Zero rows updated is what the guard reads as "this key is done".
    assert.equal(await store.beginPost(claim({ idempotencyKey: "posted-key" })), "duplicate_key");
    const posted = await store.findPost("posted-key");
    assert.equal(posted?.status, "posted");
    assert.equal(posted?.googleUpdateTime, "2026-09-06T12:00:00Z");

    assert.equal(await store.beginPost(claim({ idempotencyKey: "failed-key", reviewName: REVIEW_TWO })), "ok");
    await store.finishPost("failed-key", "failed", "Google refused it.");
    const failedRow = await store.findPost("failed-key");
    assert.ok(failedRow);
    assert.equal(
      await store.beginPost(claim({ idempotencyKey: "failed-key", reviewName: REVIEW_TWO, replyText: "Shorter wording." })),
      "ok",
    );
    const restarted = await store.findPost("failed-key");
    assert.equal(restarted?.status, "posting");
    assert.equal(restarted?.replyText, "Shorter wording.", "a failed attempt may be corrected");
    assert.equal(restarted?.error, null);
    assert.equal(restarted?.createdAt, failedRow.createdAt, "the first attempt time is kept");
    assert.ok(
      new Date(restarted!.updatedAt).getTime() >= new Date(failedRow.updatedAt).getTime(),
      "and the restart is what the stale window measures from",
    );
  });

  test("an unknown attempt restarts but keeps its wording, because that wording may already be on Google", async () => {
    await reset();
    assert.equal(await store.beginPost(claim({ idempotencyKey: "unknown-key" })), "ok");
    await store.finishPost("unknown-key", "unknown", "The connection dropped.");
    assert.equal(await store.beginPost(claim({ idempotencyKey: "unknown-key", replyText: "Different wording." })), "ok");
    const row = await store.findPost("unknown-key");
    assert.equal(row?.status, "posting");
    assert.equal(row?.replyText, "Thank you for the review.");
  });

  test("an attempt key belongs to the review and company it was first used for", async () => {
    await reset();
    assert.equal(await store.beginPost(claim({ idempotencyKey: "bound" })), "ok");
    await store.finishPost("bound", "failed", "Google refused it.");

    // Same key, another review: the database refuses to restart the row, so
    // the audit table can never describe a post that did not happen.
    assert.equal(await store.beginPost(claim({ idempotencyKey: "bound", reviewName: REVIEW_TWO })), "duplicate_key");
    // Same key, same review, another company: refused for the same reason.
    assert.equal(await store.beginPost(claim({ idempotencyKey: "bound", companyId: COMPANY_B })), "duplicate_key");

    const row = await store.findPost("bound");
    assert.equal(row?.status, "failed", "nothing was restarted");
    assert.equal(row?.reviewName, REVIEW_ONE);
    assert.equal(row?.companyId, COMPANY_A);
  });

  test("what the guard reads before the write is what the database holds", async () => {
    await reset();
    assert.equal(await store.beginPost(claim({ idempotencyKey: "live" })), "ok");
    await store.recordPrevious("live", "The reply Google held", "2026-09-05T09:00:00Z");

    const inFlight = await store.findInFlight(REVIEW_ONE);
    assert.equal(inFlight?.idempotencyKey, "live");
    assert.equal(inFlight?.previousReplyText, "The reply Google held");
    assert.equal(inFlight?.previousReplyTime, "2026-09-05T09:00:00Z");

    await store.finishPost("live", "unknown", "The connection dropped.");
    const unsettled = await store.listUnsettledPosts(REVIEW_ONE);
    assert.deepEqual(unsettled.map((r) => [r.idempotencyKey, r.status]), [["live", "unknown"]]);
  });

  test("the pending attempt window is a real number of milliseconds in real SQL", async () => {
    await reset();
    assert.equal(await store.beginPost(claim({ idempotencyKey: "fresh" })), "ok");

    // A live attempt inside the window comes back, which is what hides the
    // Post button while somebody is genuinely posting.
    const pending = await findPendingAttempt(db, REVIEW_ONE, 2 * 60 * 1000);
    assert.equal(pending?.status, "posting");
    assert.ok(pending?.createdAt, "the attempt time is readable");

    // A window of zero excludes everything, which only holds if the number
    // really did reach SQL as a number of milliseconds.
    assert.equal(await findPendingAttempt(db, REVIEW_ONE, 0), null);
    // A fractional window is a double precision value, not an integer.
    assert.equal((await findPendingAttempt(db, REVIEW_ONE, 1500.5))?.status, "posting");

    // Older than the window: the worker is gone, so the button comes back.
    await pool.query(`UPDATE ${schema}.reply_posts SET updated_at = now() - interval '10 minutes' WHERE idempotency_key = $1`, ["fresh"]);
    assert.equal(await findPendingAttempt(db, REVIEW_ONE, 2 * 60 * 1000), null);

    // And an unsettled attempt of any age never counts as pending.
    await pool.query(`UPDATE ${schema}.reply_posts SET status = 'unknown', updated_at = now() WHERE idempotency_key = $1`, ["fresh"]);
    assert.equal(await findPendingAttempt(db, REVIEW_ONE, 2 * 60 * 1000), null);
  });

  test("a review row follows its location when the location is pointed at another company", async () => {
    await reset();
    const live: GbpReview = {
      name: REVIEW_ONE,
      reviewId: "one",
      reviewer: { displayName: "Pat Customer", isAnonymous: false },
      starRating: "TWO",
      comment: "Slow service",
      createTime: "2026-09-01T10:00:00Z",
      updateTime: "2026-09-01T10:00:00Z",
    };
    await store.upsertReview(live, MAIN_ST, null);
    assert.equal((await store.getReviewRow(REVIEW_ONE, COMPANY_A))?.company_id, COMPANY_A);

    // The same location, now filed under another company and renamed.
    const moved: LocationConfig = { ...MAIN_ST, key: "main-street", targetCompanyId: COMPANY_B };
    await store.upsertReview({ ...live, reviewReply: { comment: "Thanks", updateTime: "2026-09-06T12:00:00Z" } }, moved, "human");

    assert.equal(await store.getReviewRow(REVIEW_ONE, COMPANY_A), null, "the old company no longer sees it");
    const nowB = await store.getReviewRow(REVIEW_ONE, COMPANY_B);
    assert.equal(nowB?.location_key, "main-street");
    assert.equal(nowB?.reply_text, "Thanks");
    assert.equal(nowB?.reply_source, "human");
  });
}
