/**
 * Tests for the one guarded post path.
 *
 * The thing to protect is a public, irreversible write. Every refusal below
 * is checked for what it did NOT do (no OAuth client, no Google call, no
 * audit row) as much as for the code it answered with, and the success path
 * is checked for doing each step exactly once, in order.
 *
 * Google, the OAuth client and the database are all stand-ins; nothing here
 * touches the network or Postgres.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { OAuth2Client } from "google-auth-library";
import {
  postReplyGuarded,
  ReplyGuardError,
  settlePendingAttempts,
  STALE_IN_FLIGHT_MS,
  type PostReplyInput,
  type PostReplyReceipt,
  type ReplyGuardDeps,
} from "./replyGuard.js";
import { classifyBeginPostError, type BeginPostInput, type ReplyPostRow, type ReplyStore, type ReviewRow } from "./replyStore.js";
import type { GbpReview, InstanceConfig, LocationConfig } from "./types.js";
import type { ParsedReviewName } from "./reviewName.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const REVIEW_NAME = "accounts/111/locations/222/reviews/abc-123";

const LOCATION_A: LocationConfig = {
  key: "main-st",
  displayName: "Main St Store",
  googleAccountId: "111",
  locationId: "222",
  accountKey: "owner",
  targetCompanyId: COMPANY_A,
};

const CONFIG: InstanceConfig = {
  allowReplies: true,
  accounts: [
    { key: "owner", userEmail: "owner@example.com", clientIdRef: "a", clientSecretRef: "b", refreshTokenRef: "c", allowedCompanies: [COMPANY_A] },
  ],
  locations: [LOCATION_A],
};

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

// ── stand-ins ──────────────────────────────────────────────────────────────

class MemoryStore implements ReplyStore {
  posts = new Map<string, ReplyPostRow>();
  reviews = new Map<string, ReviewRow>();
  calls: string[] = [];
  upserts: Array<{ review: GbpReview; location: LocationConfig; replySource: string | null }> = [];
  upsertError: Error | null = null;
  /** Thrown by the next finishPost call and then cleared, like one lost connection. */
  finishErrorOnce: Error | null = null;
  forceBegin: "duplicate_key" | "review_busy" | null = null;
  clock: () => Date = () => new Date("2026-09-06T10:00:00.000Z");

  async findPost(key: string) {
    this.calls.push("findPost");
    return this.posts.get(key) ?? null;
  }

  /** Newest first, mirroring ORDER BY created_at DESC. */
  private unsettled(reviewName: string): ReplyPostRow[] {
    return [...this.posts.values()]
      .filter((row) => row.reviewName === reviewName && (row.status === "posting" || row.status === "unknown"))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async findInFlight(reviewName: string) {
    this.calls.push("findInFlight");
    return this.unsettled(reviewName)[0] ?? null;
  }

  async listUnsettledPosts(reviewName: string) {
    this.calls.push("listUnsettledPosts");
    return this.unsettled(reviewName);
  }

  async beginPost(row: BeginPostInput) {
    this.calls.push("beginPost");
    if (this.forceBegin) return this.forceBegin;
    const existing = this.posts.get(row.idempotencyKey);
    if (existing) {
      // The real ON CONFLICT ... DO UPDATE ... WHERE clause: a row restarts
      // only from 'failed' or 'unknown', and only when the key still names
      // the same review and the same company.
      if (existing.status !== "failed" && existing.status !== "unknown") return "duplicate_key" as const;
      if (existing.reviewName !== row.reviewName || existing.companyId !== row.companyId) return "duplicate_key" as const;
    }
    for (const other of this.posts.values()) {
      if (other.idempotencyKey !== row.idempotencyKey && other.reviewName === row.reviewName && other.status === "posting") {
        return "review_busy" as const;
      }
    }
    const now = this.clock().toISOString();
    this.posts.set(row.idempotencyKey, {
      ...row,
      // reply_text = CASE WHEN status = 'failed' THEN EXCLUDED.reply_text ...
      replyText: existing && existing.status !== "failed" ? existing.replyText : row.replyText,
      status: "posting",
      googleUpdateTime: null,
      error: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return "ok" as const;
  }

  async recordPrevious(key: string, previousReplyText: string | null, previousReplyTime: string | null) {
    this.calls.push("recordPrevious");
    const row = this.posts.get(key);
    if (!row) throw new Error(`no row for ${key}`);
    row.previousReplyText = previousReplyText;
    row.previousReplyTime = previousReplyTime;
    row.updatedAt = this.clock().toISOString();
  }

  async finishPost(key: string, status: "posted" | "failed" | "unknown", detail: string) {
    this.calls.push(`finishPost:${status}`);
    if (this.finishErrorOnce) {
      const err = this.finishErrorOnce;
      this.finishErrorOnce = null;
      throw err;
    }
    // Every sentence written onto a row is text somebody may read, so it goes
    // through the same dash sweep as the thrown messages.
    producedText.push(detail);
    const row = this.posts.get(key);
    if (!row) throw new Error(`no row for ${key}`);
    row.status = status;
    row.updatedAt = this.clock().toISOString();
    if (status === "posted") {
      row.googleUpdateTime = detail;
      row.error = null;
    } else {
      row.error = detail;
    }
  }

  async upsertReview(review: GbpReview, location: LocationConfig, replySource: string | null) {
    this.calls.push("upsertReview");
    if (this.upsertError) throw this.upsertError;
    this.upserts.push({ review, location, replySource });
    const existing = this.reviews.get(review.name);
    this.reviews.set(review.name, {
      review_name: review.name,
      location_key: location.key,
      company_id: location.targetCompanyId,
      reviewer_name: review.reviewer.displayName,
      star_rating: 5,
      review_text: review.comment ?? null,
      reply_text: review.reviewReply?.comment ?? null,
      reply_time: review.reviewReply?.updateTime ?? null,
      reply_source: replySource,
      review_time: review.createTime,
      paperclip_issue_id: existing?.paperclip_issue_id ?? null,
    });
  }

  async getReviewRow(reviewName: string, companyId: string) {
    this.calls.push("getReviewRow");
    const row = this.reviews.get(reviewName);
    return row && row.company_id === companyId ? row : null;
  }

  seedPost(row: Partial<ReplyPostRow> & { idempotencyKey: string; status: ReplyPostRow["status"] }) {
    const now = this.clock().toISOString();
    this.posts.set(row.idempotencyKey, {
      reviewName: REVIEW_NAME,
      locationKey: LOCATION_A.key,
      companyId: COMPANY_A,
      source: "human",
      actorUserId: "user-1",
      actorAgentId: null,
      actorRunId: null,
      replyText: "Thanks, Jordan!",
      previousReplyText: null,
      previousReplyTime: null,
      googleUpdateTime: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      ...row,
    });
  }
}

interface FakeGoogle {
  liveReview: GbpReview;
  getReviewCalls: number;
  putCalls: Array<{ review: ParsedReviewName; comment: string }>;
  putBehaviour: "ok" | Error;
}

function liveReviewWith(reply: { comment: string; updateTime: string } | null): GbpReview {
  return {
    name: REVIEW_NAME,
    reviewId: "abc-123",
    reviewer: { displayName: "Jordan", isAnonymous: false },
    starRating: "FIVE",
    comment: "Great service.",
    createTime: "2026-09-01T09:00:00Z",
    updateTime: "2026-09-01T09:00:00Z",
    ...(reply ? { reviewReply: reply } : {}),
  };
}

interface Harness {
  deps: ReplyGuardDeps;
  store: MemoryStore;
  google: FakeGoogle;
  oauthCalls: Array<{ accountKey: string; companyId: string }>;
  logs: Array<{ level: string; message: string }>;
  now: Date;
}

function makeHarness(overrides: { config?: Partial<InstanceConfig>; liveReply?: { comment: string; updateTime: string } | null } = {}): Harness {
  const store = new MemoryStore();
  const google: FakeGoogle = {
    liveReview: liveReviewWith(overrides.liveReply ?? null),
    getReviewCalls: 0,
    putCalls: [],
    putBehaviour: "ok",
  };
  const oauthCalls: Harness["oauthCalls"] = [];
  const logs: Harness["logs"] = [];
  const harness: Harness = {
    store,
    google,
    oauthCalls,
    logs,
    now: new Date("2026-09-06T10:00:00.000Z"),
    deps: {
      config: { ...CONFIG, ...overrides.config },
      store,
      async getOAuthClient(accountKey, companyId) {
        oauthCalls.push({ accountKey, companyId });
        return { fake: true } as unknown as OAuth2Client;
      },
      google: {
        async getReview() {
          google.getReviewCalls += 1;
          return google.liveReview;
        },
        async postReply(_oauth, review, comment) {
          google.putCalls.push({ review, comment });
          if (google.putBehaviour !== "ok") throw google.putBehaviour;
          google.liveReview = { ...google.liveReview, reviewReply: { comment, updateTime: "2026-09-06T10:00:05Z" } };
          return { comment, updateTime: "2026-09-06T10:00:05Z" };
        },
      },
      logger: {
        info: (message) => logs.push({ level: "info", message }),
        warn: (message) => logs.push({ level: "warn", message }),
        error: (message) => logs.push({ level: "error", message }),
      },
      now: () => harness.now,
    },
  };
  store.clock = () => harness.now;
  return harness;
}

function humanInput(overrides: Partial<PostReplyInput> = {}): PostReplyInput {
  return {
    source: "human",
    scope: { companyId: COMPANY_A, userId: "user-1" },
    reviewName: REVIEW_NAME,
    replyText: "Thanks, Jordan!",
    idempotencyKey: "key-1",
    expectedReplyUpdateTime: null,
    replaceExisting: false,
    ...overrides,
  };
}

/** Collects every message the guard produced so the dash test can read them all. */
const producedText: string[] = [];

async function expectRefusal(promise: Promise<PostReplyReceipt>, code: string): Promise<ReplyGuardError | Error> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof Error, "threw a non-Error");
    producedText.push(err.message);
    assert.ok(err.message.startsWith(`[${code}]`), `expected [${code}], got: ${err.message}`);
    return err;
  }
  assert.fail(`expected [${code}] but the post succeeded`);
}

function recordReceipt(receipt: PostReplyReceipt): PostReplyReceipt {
  producedText.push(receipt.account, receipt.replyText, receipt.location.displayName);
  return receipt;
}

// ── refusals before any outside call ───────────────────────────────────────

test("refuses [EREPLIES_DISABLED] before any store, OAuth or Google call", async () => {
  const h = makeHarness({ config: { allowReplies: false } });
  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EREPLIES_DISABLED");
  assert.deepEqual(h.store.calls, []);
  assert.equal(h.oauthCalls.length, 0);
  assert.equal(h.google.getReviewCalls, 0);
  assert.equal(h.google.putCalls.length, 0);

  // An absent switch is off too; only an explicit true opens it.
  const h2 = makeHarness({ config: { allowReplies: undefined } });
  await expectRefusal(postReplyGuarded(h2.deps, humanInput()), "EREPLIES_DISABLED");
});

test("refuses [ESCOPE] for a null companyId", async () => {
  const h = makeHarness();
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ scope: { companyId: null, userId: "user-1" } })), "ESCOPE");
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ scope: { companyId: "", userId: "user-1" } })), "ESCOPE");
  assert.deepEqual(h.store.calls, []);
  assert.equal(h.oauthCalls.length, 0);
});

test("refuses a malformed and an email/<id> review name", async () => {
  const h = makeHarness();
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ reviewName: "email/18f2a" })), "EINVALID_INPUT");
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ reviewName: "accounts/111/locations/222/reviews/abc/../reply" })), "EINVALID_INPUT");
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ reviewName: 42 })), "EINVALID_INPUT");
  assert.deepEqual(h.store.calls, []);
  assert.equal(h.oauthCalls.length, 0);
  assert.equal(h.google.putCalls.length, 0);
});

test("refuses [ELOCATION_NOT_FOUND] for another company's location with the same message as an unknown one, and never resolves OAuth", async () => {
  const h = makeHarness();
  const otherCompany = await expectRefusal(
    postReplyGuarded(h.deps, humanInput({ scope: { companyId: COMPANY_B, userId: "user-2" } })),
    "ELOCATION_NOT_FOUND",
  );
  const unknown = await expectRefusal(
    postReplyGuarded(h.deps, humanInput({ reviewName: "accounts/999/locations/888/reviews/zzz" })),
    "ELOCATION_NOT_FOUND",
  );
  assert.equal(otherCompany.message, unknown.message);
  assert.equal(h.oauthCalls.length, 0);
  assert.equal(h.google.getReviewCalls, 0);
  assert.deepEqual(h.store.calls, []);
});

test("refuses empty and 4097-character text before any Google call", async () => {
  const h = makeHarness();
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ replyText: "   " })), "EINVALID_INPUT");
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ replyText: undefined })), "EINVALID_INPUT");
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ replyText: "x".repeat(4097) })), "EINVALID_INPUT");
  assert.equal(h.oauthCalls.length, 0);
  assert.equal(h.google.getReviewCalls, 0);
  assert.equal(h.google.putCalls.length, 0);
  assert.deepEqual(h.store.calls, []);

  // Exactly 4096 is allowed.
  const ok = await postReplyGuarded(h.deps, humanInput({ replyText: "y".repeat(4096) }));
  assert.equal(ok.replyText.length, 4096);
  assert.equal(h.google.putCalls.length, 1);
});

// ── the overwrite rule ─────────────────────────────────────────────────────

test("[EREPLY_EXISTS] when a live reply exists and replaceExisting is false", async () => {
  const h = makeHarness({ liveReply: { comment: "Old reply", updateTime: "2026-09-02T00:00:00Z" } });
  const err = await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EREPLY_EXISTS");
  assert.ok(err instanceof ReplyGuardError);
  assert.equal(err.details.liveReplyText, "Old reply");
  assert.ok(err.message.includes("Old reply"), "the refusal carries the live text");
  assert.equal(h.google.putCalls.length, 0);
  // The slot is claimed before Google is read, so a refusal after the read
  // must hand it straight back: the row says failed, not posting.
  assert.ok(h.store.calls.includes("beginPost"));
  assert.equal(h.store.posts.get("key-1")!.status, "failed");
});

test("[EREPLY_EXISTS] for source 'agent' even with replaceExisting true", async () => {
  const h = makeHarness({ liveReply: { comment: "Old reply", updateTime: "2026-09-02T00:00:00Z" } });
  await expectRefusal(
    postReplyGuarded(h.deps, humanInput({
      source: "agent",
      scope: { companyId: COMPANY_A, userId: null },
      agent: { agentId: "agent-1", runId: "run-1" },
      idempotencyKey: "run:run-1:abc-123",
      replaceExisting: true,
      expectedReplyUpdateTime: "2026-09-02T00:00:00Z",
    })),
    "EREPLY_EXISTS",
  );
  assert.equal(h.google.putCalls.length, 0);
});

test("[EREPLY_CHANGED] when the live updateTime differs from expectedReplyUpdateTime", async () => {
  const h = makeHarness({ liveReply: { comment: "Old reply", updateTime: "2026-09-03T00:00:00Z" } });
  await expectRefusal(
    postReplyGuarded(h.deps, humanInput({ replaceExisting: true, expectedReplyUpdateTime: "2026-09-02T00:00:00Z" })),
    "EREPLY_CHANGED",
  );
  assert.equal(h.google.putCalls.length, 0);
});

test("[EREPLY_CHANGED] when expected is set and the live reply is gone", async () => {
  const h = makeHarness({ liveReply: null });
  await expectRefusal(
    postReplyGuarded(h.deps, humanInput({ replaceExisting: true, expectedReplyUpdateTime: "2026-09-02T00:00:00Z" })),
    "EREPLY_CHANGED",
  );
  assert.equal(h.google.putCalls.length, 0);
  assert.equal(h.store.posts.get("key-1")!.status, "failed", "the claimed slot is handed back");
});

// ── the success paths ──────────────────────────────────────────────────────

test("a first reply makes exactly one PUT, one beginPost before it, one finish posted after, and one upsert with reply_source 'human' and the scope's user", async () => {
  const h = makeHarness();
  const receipt = recordReceipt(await postReplyGuarded(h.deps, humanInput()));

  assert.equal(h.google.putCalls.length, 1);
  assert.equal(h.google.putCalls[0]!.comment, "Thanks, Jordan!");
  assert.deepEqual(h.oauthCalls, [{ accountKey: "owner", companyId: COMPANY_A }]);

  const order = h.store.calls.filter((c) => c === "beginPost" || c === "finishPost:posted" || c === "upsertReview");
  assert.deepEqual(order, ["beginPost", "finishPost:posted", "upsertReview"]);

  const row = h.store.posts.get("key-1")!;
  assert.equal(row.status, "posted");
  assert.equal(row.source, "human");
  assert.equal(row.actorUserId, "user-1");
  assert.equal(row.actorAgentId, null);
  assert.equal(row.googleUpdateTime, "2026-09-06T10:00:05Z");
  assert.equal(row.previousReplyText, null);

  assert.equal(h.store.upserts.length, 1);
  assert.equal(h.store.upserts[0]!.replySource, "human");
  assert.equal(h.store.upserts[0]!.review.reviewReply?.comment, "Thanks, Jordan!");
  assert.equal(h.store.upserts[0]!.location.key, "main-st");

  assert.equal(receipt.postedAt, "2026-09-06T10:00:05Z");
  assert.equal(receipt.replaced, false);
  assert.equal(receipt.previousReplyText, null);
  assert.equal(receipt.recordedLocally, true);
  assert.equal(receipt.alreadyPosted, false);
  assert.equal(receipt.account, "owner@example.com");
  assert.equal(receipt.location.displayName, "Main St Store");
});

test("an agent post records the agent and run ids and no user", async () => {
  const h = makeHarness();
  await postReplyGuarded(h.deps, humanInput({
    source: "agent",
    scope: { companyId: COMPANY_A, userId: null },
    agent: { agentId: "agent-1", runId: "run-1" },
    idempotencyKey: "run:run-1:abc-123",
  }));
  const row = h.store.posts.get("run:run-1:abc-123")!;
  assert.equal(row.source, "agent");
  assert.equal(row.actorUserId, null);
  assert.equal(row.actorAgentId, "agent-1");
  assert.equal(row.actorRunId, "run-1");
  assert.equal(h.store.upserts[0]!.replySource, "agent");
});

test("a replace with matching updateTime and replaceExisting true records previous_reply_text and returns replaced true", async () => {
  const h = makeHarness({ liveReply: { comment: "Old reply", updateTime: "2026-09-02T00:00:00Z" } });
  const receipt = recordReceipt(await postReplyGuarded(h.deps, humanInput({
    replyText: "New reply",
    replaceExisting: true,
    expectedReplyUpdateTime: "2026-09-02T00:00:00Z",
  })));
  assert.equal(h.google.putCalls.length, 1);
  assert.equal(receipt.replaced, true);
  assert.equal(receipt.previousReplyText, "Old reply");
  const row = h.store.posts.get("key-1")!;
  assert.equal(row.previousReplyText, "Old reply");
  assert.equal(row.previousReplyTime, "2026-09-02T00:00:00Z");
});

// ── idempotency ────────────────────────────────────────────────────────────

test("same key twice returns the stored receipt with zero further PUTs", async () => {
  const h = makeHarness();
  const first = await postReplyGuarded(h.deps, humanInput());
  const second = recordReceipt(await postReplyGuarded(h.deps, humanInput()));
  assert.equal(h.google.putCalls.length, 1);
  assert.equal(second.alreadyPosted, true);
  assert.equal(second.postedAt, first.postedAt);
  assert.equal(second.replyText, first.replyText);
  assert.equal(second.recordedLocally, true);
  // The stored receipt needs no Google round trip at all.
  assert.equal(h.google.getReviewCalls, 1);
});

test("same key with different text is [EINVALID_INPUT]", async () => {
  const h = makeHarness();
  await postReplyGuarded(h.deps, humanInput());
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ replyText: "Something else" })), "EINVALID_INPUT");
  assert.equal(h.google.putCalls.length, 1);
});

test("beginPost 'review_busy' is [EDUPLICATE_IN_PROGRESS] with no PUT", async () => {
  const h = makeHarness();
  h.store.forceBegin = "review_busy";
  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EDUPLICATE_IN_PROGRESS");
  assert.equal(h.google.putCalls.length, 0);

  h.store.forceBegin = "duplicate_key";
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ idempotencyKey: "key-2" })), "EDUPLICATE_IN_PROGRESS");
  assert.equal(h.google.putCalls.length, 0);
});

test("a key that is still 'posting' is [EDUPLICATE_IN_PROGRESS] before any Google call", async () => {
  const h = makeHarness();
  h.store.seedPost({ idempotencyKey: "key-1", status: "posting" });
  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EDUPLICATE_IN_PROGRESS");
  assert.equal(h.oauthCalls.length, 0);
  assert.equal(h.google.getReviewCalls, 0);
});

test("a fetch that throws after send finishes the row unknown and throws [EPOST_UNCONFIRMED]; the retry reconciles before the overwrite rule", async () => {
  const h = makeHarness();
  h.google.putBehaviour = new TypeError("fetch failed");
  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EPOST_UNCONFIRMED");
  assert.equal(h.store.posts.get("key-1")!.status, "unknown");
  assert.equal(h.store.posts.get("key-1")!.error, "fetch failed");
  assert.equal(h.google.putCalls.length, 1);
  assert.ok(h.logs.some((l) => l.level === "error"));

  // The request did arrive: Google now holds exactly the text we sent.
  h.google.liveReview = liveReviewWith({ comment: "Thanks, Jordan!", updateTime: "2026-09-06T10:00:03Z" });
  h.google.putBehaviour = "ok";
  const receipt = recordReceipt(await postReplyGuarded(h.deps, humanInput()));
  assert.equal(h.google.putCalls.length, 1, "no second PUT");
  assert.equal(h.store.posts.get("key-1")!.status, "posted");
  assert.equal(h.store.posts.get("key-1")!.googleUpdateTime, "2026-09-06T10:00:03Z");
  assert.equal(receipt.alreadyPosted, true);
  assert.equal(receipt.postedAt, "2026-09-06T10:00:03Z");
});

test("an unknown row whose text is not on Google falls through to a fresh attempt with the same key", async () => {
  const h = makeHarness();
  h.google.putBehaviour = new TypeError("socket hang up");
  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EPOST_UNCONFIRMED");

  // Nothing reached Google, so the retry posts, reusing the row.
  h.google.putBehaviour = "ok";
  const receipt = await postReplyGuarded(h.deps, humanInput());
  assert.equal(h.google.putCalls.length, 2);
  assert.equal(receipt.alreadyPosted, false);
  assert.equal(h.store.posts.get("key-1")!.status, "posted");
  assert.equal(h.store.posts.size, 1, "the retry restarts the row rather than adding one");
});

test("another key's 'posting' row untouched for two minutes is reconciled and a fresh attempt proceeds; a younger one is [EDUPLICATE_IN_PROGRESS]", async () => {
  const h = makeHarness();
  const started = new Date(h.now.getTime() - STALE_IN_FLIGHT_MS - 1000).toISOString();
  h.store.seedPost({
    idempotencyKey: "crashed-key",
    status: "posting",
    replyText: "From the crashed worker",
    createdAt: started,
    updatedAt: started,
  });

  // Google never got the crashed worker's reply, so its row becomes failed
  // and the new attempt goes ahead.
  const receipt = await postReplyGuarded(h.deps, humanInput({ idempotencyKey: "fresh-key" }));
  assert.equal(h.store.posts.get("crashed-key")!.status, "failed");
  assert.equal(h.google.putCalls.length, 1);
  assert.equal(receipt.alreadyPosted, false);
  assert.equal(h.store.posts.get("fresh-key")!.status, "posted");

  // A younger in-flight row belongs to a live worker: wait for it.
  const h2 = makeHarness();
  const recent = new Date(h2.now.getTime() - 30 * 1000).toISOString();
  h2.store.seedPost({ idempotencyKey: "live-key", status: "posting", createdAt: recent, updatedAt: recent });
  await expectRefusal(postReplyGuarded(h2.deps, humanInput({ idempotencyKey: "fresh-key" })), "EDUPLICATE_IN_PROGRESS");
  assert.equal(h2.oauthCalls.length, 0);
  assert.equal(h2.google.putCalls.length, 0);
  assert.equal(h2.store.posts.get("live-key")!.status, "posting");
});

test("a stale 'posting' row whose text Google holds is settled as posted, and the reply then counts as existing", async () => {
  const h = makeHarness({ liveReply: { comment: "From the crashed worker", updateTime: "2026-09-06T09:50:00Z" } });
  const started = new Date(h.now.getTime() - STALE_IN_FLIGHT_MS - 1000).toISOString();
  h.store.seedPost({
    idempotencyKey: "crashed-key",
    status: "posting",
    replyText: "From the crashed worker",
    createdAt: started,
    updatedAt: started,
  });

  await expectRefusal(postReplyGuarded(h.deps, humanInput({ idempotencyKey: "fresh-key" })), "EREPLY_EXISTS");
  assert.equal(h.store.posts.get("crashed-key")!.status, "posted");
  assert.equal(h.store.posts.get("crashed-key")!.googleUpdateTime, "2026-09-06T09:50:00Z");
  assert.equal(h.google.putCalls.length, 0);
  assert.equal(h.store.posts.get("fresh-key")!.status, "failed", "our own claim is handed back");
});

// ── no attempt may block a review for good ─────────────────────────────────

test("our own 'posting' row untouched for two minutes is called abandoned, settled against Google, and the retry makes exactly one PUT", async () => {
  const h = makeHarness();
  const started = new Date(h.now.getTime() - STALE_IN_FLIGHT_MS - 1000).toISOString();
  // The worker died between the audit row and the PUT: nothing reached Google.
  h.store.seedPost({ idempotencyKey: "key-1", status: "posting", createdAt: started, updatedAt: started });

  const receipt = await postReplyGuarded(h.deps, humanInput());
  assert.equal(h.google.putCalls.length, 1, "exactly one public write");
  assert.equal(receipt.alreadyPosted, false);
  const row = h.store.posts.get("key-1")!;
  assert.equal(row.status, "posted");
  assert.equal(row.createdAt, started, "the row is restarted, not replaced");
  assert.ok(
    h.logs.some((l) => l.level === "warn"),
    "the abandoned attempt is logged rather than passing silently",
  );
});

test("a stale own 'posting' row whose text Google already holds returns the stored receipt and makes no PUT", async () => {
  const h = makeHarness({ liveReply: { comment: "Thanks, Jordan!", updateTime: "2026-09-06T09:58:00Z" } });
  const started = new Date(h.now.getTime() - STALE_IN_FLIGHT_MS - 1000).toISOString();
  h.store.seedPost({ idempotencyKey: "key-1", status: "posting", createdAt: started, updatedAt: started });

  const receipt = await postReplyGuarded(h.deps, humanInput());
  assert.equal(h.google.putCalls.length, 0, "the reply was already on Google");
  assert.equal(receipt.alreadyPosted, true);
  assert.equal(receipt.postedAt, "2026-09-06T09:58:00Z");
  assert.equal(h.store.posts.get("key-1")!.status, "posted");
});

test("another key's 'unknown' row is settled against Google whatever key asks, and blocks a fresh post when Google holds its text", async () => {
  const h = makeHarness({ liveReply: { comment: "From the dropped connection", updateTime: "2026-09-06T09:40:00Z" } });
  // The tab that owned this key is gone, so only another key can ever reach it.
  h.store.seedPost({ idempotencyKey: "lost-key", status: "unknown", replyText: "From the dropped connection" });

  await expectRefusal(postReplyGuarded(h.deps, humanInput({ idempotencyKey: "fresh-key" })), "EREPLY_EXISTS");
  const settled = h.store.posts.get("lost-key")!;
  assert.equal(settled.status, "posted", "the lost attempt is no longer unsettled");
  assert.equal(settled.googleUpdateTime, "2026-09-06T09:40:00Z");
  assert.equal(h.google.putCalls.length, 0);
});

test("another key's 'unknown' row that never reached Google is marked failed and the fresh post goes ahead", async () => {
  const h = makeHarness();
  h.store.seedPost({ idempotencyKey: "lost-key", status: "unknown", replyText: "Never arrived" });

  const receipt = await postReplyGuarded(h.deps, humanInput({ idempotencyKey: "fresh-key" }));
  assert.equal(h.store.posts.get("lost-key")!.status, "failed");
  assert.equal(h.google.putCalls.length, 1);
  assert.equal(receipt.alreadyPosted, false);
});

test("when Google holds a different reply, the crashed row is marked unknown with its own sentence and nothing is posted", async () => {
  const h = makeHarness({ liveReply: { comment: "Written in Google's console", updateTime: "2026-09-06T09:30:00Z" } });
  const started = new Date(h.now.getTime() - STALE_IN_FLIGHT_MS - 1000).toISOString();
  h.store.seedPost({
    idempotencyKey: "crashed-key",
    status: "posting",
    replyText: "From the crashed worker",
    createdAt: started,
    updatedAt: started,
  });

  await expectRefusal(postReplyGuarded(h.deps, humanInput({ idempotencyKey: "fresh-key" })), "EREPLY_EXISTS");
  const crashed = h.store.posts.get("crashed-key")!;
  assert.equal(crashed.status, "unknown");
  assert.equal(crashed.error, "Google holds a different reply from the one this attempt sent.");
  assert.equal(h.google.putCalls.length, 0);
});

test("a retry restarted a moment ago is not treated as abandoned, however old its created_at is", async () => {
  const h = makeHarness();
  const firstAttempt = new Date(h.now.getTime() - 10 * 60 * 1000).toISOString();
  // The first attempt failed ten minutes ago and has just been retried with
  // the same key, so created_at is old but updated_at is now.
  h.store.seedPost({
    idempotencyKey: "key-1",
    status: "posting",
    createdAt: firstAttempt,
    updatedAt: h.now.toISOString(),
  });

  await expectRefusal(postReplyGuarded(h.deps, humanInput({ idempotencyKey: "key-2" })), "EDUPLICATE_IN_PROGRESS");
  assert.equal(h.store.posts.get("key-1")!.status, "posting", "the live retry is left alone");
  assert.equal(h.google.putCalls.length, 0, "no second public write");
  assert.equal(h.oauthCalls.length, 0);
});

test("settlePendingAttempts settles every lost attempt on a review and leaves a live one alone", async () => {
  const h = makeHarness();
  const started = new Date(h.now.getTime() - STALE_IN_FLIGHT_MS - 1000).toISOString();
  h.store.seedPost({ idempotencyKey: "lost-key", status: "unknown", replyText: "Never arrived", createdAt: started, updatedAt: started });
  h.store.seedPost({ idempotencyKey: "crashed-key", status: "posting", replyText: "Never arrived", createdAt: started, updatedAt: started });
  h.store.seedPost({ idempotencyKey: "live-key", status: "posting", createdAt: h.now.toISOString(), updatedAt: h.now.toISOString() });

  await settlePendingAttempts(
    { store: h.store, logger: h.deps.logger, now: h.deps.now },
    REVIEW_NAME,
    liveReviewWith(null),
  );

  assert.equal(h.store.posts.get("lost-key")!.status, "failed");
  assert.equal(h.store.posts.get("crashed-key")!.status, "failed");
  assert.equal(h.store.posts.get("live-key")!.status, "posting", "a worker that may still be running is left alone");
});

// ── the key belongs to its review ──────────────────────────────────────────

test("a key first used for another review is refused and restarts nothing", async () => {
  const h = makeHarness();
  h.store.seedPost({
    idempotencyKey: "key-1",
    status: "failed",
    reviewName: "accounts/111/locations/222/reviews/other-review",
  });

  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EINVALID_INPUT");
  assert.equal(h.store.posts.get("key-1")!.status, "failed", "the other review's row is untouched");
  assert.equal(h.store.posts.get("key-1")!.reviewName, "accounts/111/locations/222/reviews/other-review");
  assert.equal(h.oauthCalls.length, 0);
  assert.equal(h.google.getReviewCalls, 0);
  assert.equal(h.google.putCalls.length, 0);
});

test("a key first used in another company is refused before any Google call", async () => {
  const h = makeHarness();
  h.store.seedPost({ idempotencyKey: "key-1", status: "failed", companyId: COMPANY_B });
  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EINVALID_INPUT");
  assert.equal(h.google.getReviewCalls, 0);
  assert.equal(h.store.posts.get("key-1")!.companyId, COMPANY_B);
});

test("the store refuses the restart too when the key names a different review", async () => {
  const h = makeHarness();
  h.store.seedPost({
    idempotencyKey: "key-1",
    status: "failed",
    reviewName: "accounts/111/locations/222/reviews/other-review",
  });
  // Straight at the store, the way a second process would reach it if the
  // guard's own check were ever removed.
  const begun = await h.store.beginPost({
    idempotencyKey: "key-1",
    reviewName: REVIEW_NAME,
    locationKey: LOCATION_A.key,
    companyId: COMPANY_A,
    source: "human",
    actorUserId: "user-1",
    actorAgentId: null,
    actorRunId: null,
    replyText: "Thanks, Jordan!",
    previousReplyText: null,
    previousReplyTime: null,
  });
  assert.equal(begun, "duplicate_key");
});

// ── an agent correcting itself, and a refusal that must hand the slot back ──

test("an agent may retry a failed attempt with corrected text under the same run key, making one PUT", async () => {
  const h = makeHarness();
  const agentInput = {
    source: "agent" as const,
    scope: { companyId: COMPANY_A, userId: null },
    agent: { agentId: "agent-1", runId: "run-1" },
    idempotencyKey: "run:run-1:abc-123",
  };
  h.google.putBehaviour = new Error("[EGBP_HTTP_400] The reply is too long");
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ ...agentInput, replyText: "A very long reply" })), "EGBP_HTTP_400");
  assert.equal(h.store.posts.get("run:run-1:abc-123")!.status, "failed");

  // The agent cannot mint a new key inside its run, so a corrected reply has
  // to be allowed on the failed row or the review waits for the next run.
  h.google.putBehaviour = "ok";
  const receipt = await postReplyGuarded(h.deps, humanInput({ ...agentInput, replyText: "A shorter reply" }));
  assert.equal(h.google.putCalls.length, 2);
  assert.equal(h.google.putCalls[1]!.comment, "A shorter reply");
  const row = h.store.posts.get("run:run-1:abc-123")!;
  assert.equal(row.status, "posted");
  assert.equal(row.replyText, "A shorter reply", "the audit row says what was actually sent");
  assert.equal(receipt.replyText, "A shorter reply");
});

test("different text on an 'unknown' row is still refused, because that text may already be live", async () => {
  const h = makeHarness();
  h.store.seedPost({ idempotencyKey: "key-1", status: "unknown", replyText: "The first wording" });
  await expectRefusal(postReplyGuarded(h.deps, humanInput({ replyText: "A different wording" })), "EINVALID_INPUT");
  assert.equal(h.google.getReviewCalls, 0);
  assert.equal(h.google.putCalls.length, 0);
});

test("an account the company is not allowed to use fails after the claim, and the slot is handed straight back", async () => {
  const h = makeHarness();
  h.deps.getOAuthClient = async () => {
    throw new Error("[ECOMPANY_NOT_ALLOWED] This Google account is not allowed for this company in the plugin settings.");
  };

  await expectRefusal(postReplyGuarded(h.deps, humanInput()), "ECOMPANY_NOT_ALLOWED");
  assert.equal(h.google.getReviewCalls, 0, "Google is never read");
  assert.equal(h.google.putCalls.length, 0, "nothing is posted");
  const row = h.store.posts.get("key-1")!;
  assert.equal(row.status, "failed", "the claimed slot does not stay held");
  assert.ok(row.error!.startsWith("[ECOMPANY_NOT_ALLOWED]"));
});

test("a database failure after a successful PUT still returns a receipt and never calls the post failed", async () => {
  const h = makeHarness();
  h.store.finishErrorOnce = new Error("connection terminated");
  const receipt = recordReceipt(await postReplyGuarded(h.deps, humanInput()));
  assert.equal(h.google.putCalls.length, 1);
  assert.equal(receipt.alreadyPosted, false);
  assert.equal(receipt.postedAt, "2026-09-06T10:00:05Z", "the receipt carries Google's own time");
  assert.equal(receipt.recordedLocally, false, "and says the record was not written");
  assert.ok(h.logs.some((l) => l.level === "error" && l.message.includes("could not record the attempt")));
});

// ── failures after the audit row ───────────────────────────────────────────

test("Google 403 on the PUT finishes failed with the [EGBP_HTTP_403] text and rethrows", async () => {
  const h = makeHarness();
  h.google.putBehaviour = new Error("[EGBP_HTTP_403] The caller does not have permission");
  const err = await expectRefusal(postReplyGuarded(h.deps, humanInput()), "EGBP_HTTP_403");
  assert.equal(err.message, "[EGBP_HTTP_403] The caller does not have permission");
  const row = h.store.posts.get("key-1")!;
  assert.equal(row.status, "failed");
  assert.equal(row.error, "[EGBP_HTTP_403] The caller does not have permission");
  assert.ok(!h.store.calls.includes("upsertReview"));

  // A failed row does not block a retry with the same key.
  h.google.putBehaviour = "ok";
  const receipt = await postReplyGuarded(h.deps, humanInput());
  assert.equal(receipt.alreadyPosted, false);
  assert.equal(h.google.putCalls.length, 2);
});

test("an upsert failure after a successful PUT still returns a receipt with recordedLocally false and logs an error", async () => {
  const h = makeHarness();
  h.store.upsertError = new Error("relation is locked");
  const receipt = recordReceipt(await postReplyGuarded(h.deps, humanInput()));
  assert.equal(receipt.recordedLocally, false);
  assert.equal(receipt.postedAt, "2026-09-06T10:00:05Z");
  assert.equal(h.store.posts.get("key-1")!.status, "posted", "the audit row still says posted");
  assert.ok(h.logs.some((l) => l.level === "error" && l.message.includes("could not record locally")));
});

test("the receipt carries the review's task id when the local row has one", async () => {
  const h = makeHarness();
  h.store.reviews.set(REVIEW_NAME, {
    review_name: REVIEW_NAME,
    location_key: LOCATION_A.key,
    company_id: COMPANY_A,
    reviewer_name: "Jordan",
    star_rating: 5,
    review_text: "Great service.",
    reply_text: null,
    reply_time: null,
    reply_source: null,
    review_time: "2026-09-01T09:00:00Z",
    paperclip_issue_id: "issue-9",
  });
  const receipt = await postReplyGuarded(h.deps, humanInput());
  assert.equal(receipt.issueId, "issue-9");
  assert.equal(h.store.reviews.get(REVIEW_NAME)!.reply_source, "human");
});

// ── the store's error classifier ───────────────────────────────────────────

test("classifyBeginPostError tells the two unique rules apart by constraint name", () => {
  assert.equal(
    classifyBeginPostError('duplicate key value violates unique constraint "reply_posts_pkey"'),
    "duplicate_key",
  );
  assert.equal(
    classifyBeginPostError('duplicate key value violates unique constraint "idx_reply_posts_one_in_flight"'),
    "review_busy",
  );
  assert.equal(classifyBeginPostError('duplicate key value violates unique constraint "reviews_pkey"'), null);
  assert.equal(classifyBeginPostError("connection refused"), null);
});

// ── wording ────────────────────────────────────────────────────────────────

test("every thrown message and every returned string contains no long dashes", () => {
  assert.ok(producedText.length > 10, "the earlier tests collected the guard's wording");
  for (const text of producedText) {
    assert.doesNotMatch(text, LONG_DASHES, `long dash in: ${text}`);
  }
});
