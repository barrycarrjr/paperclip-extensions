/**
 * Tests for the reads behind the Reviews page.
 *
 * The rule under test: which location a company may open, and that every
 * query is constrained on the location's OWN company id, not the viewer's.
 * The database is a recorder, so the SQL and its parameters are checked
 * directly.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  findPendingAttempt,
  findReviewForLocation,
  listReviewsForLocation,
  resolveScopedLocation,
  resolveScopedLocationForReview,
  summaryForLocation,
  toReviewListItem,
  type ReviewQueryDb,
} from "./reviewQueries.js";
import { parseReviewName } from "./reviewName.js";
import type { ReviewRow } from "./replyStore.js";
import type { InstanceConfig, LocationConfig } from "./types.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const HQ = "hq";

const MAIN_ST: LocationConfig = {
  key: "main-st",
  displayName: "Main St Store",
  googleAccountId: "111",
  locationId: "222",
  accountKey: "owner",
  targetCompanyId: COMPANY_A,
};

const BETA_HQ: LocationConfig = {
  key: "beta-hq",
  displayName: "Beta HQ",
  googleAccountId: "111",
  locationId: "333",
  accountKey: "owner",
  targetCompanyId: COMPANY_B,
};

const CONFIG: InstanceConfig = { locations: [MAIN_ST, BETA_HQ] };

const SCOPE_A = { companyId: COMPANY_A, userId: "user-1" };
const SCOPE_HQ = { companyId: HQ, userId: "user-1" };

/** The same two minutes the guard uses; the caller passes it so there is one copy. */
const STALE_WINDOW_MS = 2 * 60 * 1000;

class RecordingDb implements ReviewQueryDb {
  namespace = "plugin_test";
  calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  rows: unknown[] = [];
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.calls.push({ sql, params });
    return this.rows as T[];
  }
}

function normalise(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// ── which location may be opened ──────────────────────────────────────────

test("an unknown location key resolves to nothing", () => {
  assert.equal(resolveScopedLocation(CONFIG, SCOPE_A, false, "no-such-key"), null);
});

test("a location key belonging to another company resolves to nothing", () => {
  // The same answer as an unknown key, so the reply never confirms that the
  // location exists somewhere else.
  assert.equal(resolveScopedLocation(CONFIG, SCOPE_A, false, BETA_HQ.key), null);
});

test("a key that is not a string resolves to nothing", () => {
  for (const key of [undefined, null, 42, "", ["main-st"], { key: "main-st" }]) {
    assert.equal(resolveScopedLocation(CONFIG, SCOPE_A, false, key), null, `key=${JSON.stringify(key)}`);
  }
});

test("a company opens its own location and may post from it", () => {
  const resolved = resolveScopedLocation(CONFIG, SCOPE_A, false, MAIN_ST.key);
  assert.ok(resolved);
  assert.equal(resolved.location.key, MAIN_ST.key);
  assert.equal(resolved.isRollup, false);
  assert.equal(resolved.canPostFromHere, true);
});

test("HQ resolves any location, read-only", () => {
  for (const location of [MAIN_ST, BETA_HQ]) {
    const resolved = resolveScopedLocation(CONFIG, SCOPE_HQ, true, location.key);
    assert.ok(resolved, location.key);
    assert.equal(resolved.location.key, location.key);
    assert.equal(resolved.isRollup, true);
    assert.equal(resolved.canPostFromHere, false);
  }
});

test("a location whose own company is HQ still cannot post from the roll-up", () => {
  // canPostFromHere needs both: not the roll-up AND the location's company.
  const config: InstanceConfig = { locations: [{ ...MAIN_ST, targetCompanyId: HQ }] };
  const resolved = resolveScopedLocation(config, SCOPE_HQ, true, MAIN_ST.key);
  assert.ok(resolved);
  assert.equal(resolved.canPostFromHere, false);
});

test("a review name resolves to the visible location that carries its ids", () => {
  const parsed = parseReviewName("accounts/111/locations/222/reviews/abc")!;
  const own = resolveScopedLocationForReview(CONFIG, SCOPE_A, false, parsed);
  assert.ok(own);
  assert.equal(own.location.key, MAIN_ST.key);
  assert.equal(own.canPostFromHere, true);

  // Another company's review under the same Google account: nothing.
  const theirs = parseReviewName("accounts/111/locations/333/reviews/abc")!;
  assert.equal(resolveScopedLocationForReview(CONFIG, SCOPE_A, false, theirs), null);

  // HQ sees it, read-only.
  const fromHq = resolveScopedLocationForReview(CONFIG, SCOPE_HQ, true, theirs);
  assert.ok(fromHq);
  assert.equal(fromHq.location.key, BETA_HQ.key);
  assert.equal(fromHq.canPostFromHere, false);
});

// ── the queries ───────────────────────────────────────────────────────────

test("the list reads the location key and the location's OWN company id, not the viewer's", async () => {
  const db = new RecordingDb();
  // HQ is the viewer; the parameter must still be company B, the location's own.
  await listReviewsForLocation(db, BETA_HQ);
  assert.equal(db.calls.length, 1);
  const call = db.calls[0]!;
  assert.deepEqual(call.params, [BETA_HQ.key, COMPANY_B]);
  const sql = normalise(call.sql);
  assert.match(sql, /WHERE location_key = \$1 AND company_id = \$2/);
  assert.match(sql, /ORDER BY \(reply_text IS NULL\) DESC, review_time DESC/);
  assert.match(sql, /LIMIT 200$/);
  assert.match(sql, /FROM plugin_test\.reviews/);
});

test("the list maps rows to the page's shape", async () => {
  const db = new RecordingDb();
  const row: ReviewRow = {
    review_name: "accounts/111/locations/222/reviews/abc",
    location_key: MAIN_ST.key,
    company_id: COMPANY_A,
    reviewer_name: "Pat",
    star_rating: 4,
    review_text: "Good",
    reply_text: null,
    reply_time: null,
    reply_source: null,
    review_time: "2026-09-01T10:00:00Z",
    paperclip_issue_id: "issue-1",
  };
  db.rows = [row];
  const items = await listReviewsForLocation(db, MAIN_ST);
  assert.deepEqual(items, [
    {
      reviewName: row.review_name,
      reviewerName: "Pat",
      starRating: 4,
      reviewText: "Good",
      replyText: null,
      replyTime: null,
      replySource: null,
      reviewTime: row.review_time,
      issueId: "issue-1",
    },
  ]);
});

test("toReviewListItem turns a text rating into a number and fills absent columns with null", () => {
  const item = toReviewListItem({
    review_name: "accounts/111/locations/222/reviews/abc",
    location_key: MAIN_ST.key,
    company_id: COMPANY_A,
    reviewer_name: "Pat",
    star_rating: "5" as unknown as number,
    review_text: null,
    reply_text: "Thanks",
    reply_time: "2026-09-02T10:00:00Z",
    reply_source: "human",
    review_time: "2026-09-01T10:00:00Z",
    paperclip_issue_id: null,
  });
  assert.equal(item.starRating, 5);
  assert.equal(item.reviewText, null);
  assert.equal(item.replySource, "human");
  assert.equal(item.issueId, null);
});

test("one review is read by name AND location AND the location's company", async () => {
  const db = new RecordingDb();
  const name = "accounts/111/locations/333/reviews/abc";
  const found = await findReviewForLocation(db, name, BETA_HQ);
  assert.equal(found, null);
  assert.deepEqual(db.calls[0]!.params, [name, BETA_HQ.key, COMPANY_B]);
  assert.match(normalise(db.calls[0]!.sql), /WHERE review_name = \$1 AND location_key = \$2 AND company_id = \$3/);
});

test("the summary is constrained on the location's own company and returns numbers", async () => {
  const db = new RecordingDb();
  // Postgres hands COUNT back as text; the page adds these up.
  db.rows = [{ unreplied: "2", avg_rating: "4.5000", total: "7" }];
  const summary = await summaryForLocation(db, BETA_HQ);
  assert.deepEqual(summary, { unreplied: 2, avgRating: 4.5, total: 7 });
  assert.deepEqual(db.calls[0]!.params, [BETA_HQ.key, COMPANY_B]);
  assert.match(normalise(db.calls[0]!.sql), /WHERE location_key = \$1 AND company_id = \$2/);

  db.rows = [];
  assert.deepEqual(await summaryForLocation(db, MAIN_ST), { unreplied: 0, avgRating: null, total: 0 });
});

test("the pending attempt is a posting row inside the stale window, or null", async () => {
  const db = new RecordingDb();
  const name = "accounts/111/locations/222/reviews/abc";
  assert.equal(await findPendingAttempt(db, name, STALE_WINDOW_MS), null);
  assert.deepEqual(db.calls[0]!.params, [name, STALE_WINDOW_MS]);
  const sql = normalise(db.calls[0]!.sql);
  assert.match(sql, /ORDER BY created_at DESC LIMIT 1/);

  db.rows = [{ status: "posting", created_at: new Date("2026-09-06T10:00:00Z") }];
  assert.deepEqual(await findPendingAttempt(db, name, STALE_WINDOW_MS), {
    status: "posting",
    createdAt: "2026-09-06T10:00:00.000Z",
  });
});

test("the pending attempt query ignores unknown rows and posting rows older than the window", async () => {
  const db = new RecordingDb();
  await findPendingAttempt(db, "accounts/111/locations/222/reviews/abc", STALE_WINDOW_MS);
  const sql = normalise(db.calls[0]!.sql);

  // An 'unknown' row is never pending: it is settled against Google by
  // settlePendingAttempts, and one that could not be settled must not hide
  // the Post button for good.
  assert.match(sql, /status = 'posting'/);
  assert.doesNotMatch(sql, /unknown/);

  // The age is measured from updated_at, because a same-key retry restarts
  // the row in place and keeps the first attempt's created_at.
  assert.match(sql, /updated_at > now\(\) - \(\$2::double precision \* interval '1 millisecond'\)/);
  assert.doesNotMatch(sql, /created_at >/);
});

test("every query names the plugin namespace and no other schema", async () => {
  const db = new RecordingDb();
  await listReviewsForLocation(db, MAIN_ST);
  await findReviewForLocation(db, "accounts/111/locations/222/reviews/abc", MAIN_ST);
  await summaryForLocation(db, MAIN_ST);
  await findPendingAttempt(db, "accounts/111/locations/222/reviews/abc", STALE_WINDOW_MS);
  for (const call of db.calls) {
    const refs = [...call.sql.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)\./g)].map((m) => m[1]);
    assert.ok(refs.length > 0, call.sql);
    assert.deepEqual(new Set(refs), new Set(["plugin_test"]), call.sql);
    // Every parameter is referenced, which is what the host's validator demands.
    const placeholders = new Set([...call.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.equal(placeholders.size, call.params?.length ?? 0, call.sql);
  }
});
