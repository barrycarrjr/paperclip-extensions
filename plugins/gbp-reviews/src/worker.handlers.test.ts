/**
 * Wiring tests for the worker's page handlers and the agent reply tool.
 *
 * The SDK's in-memory harness plays the host, so these run the real setup()
 * against the real manifest: every capability the code touches must be one
 * the manifest declares, or the harness throws. Google is a stub on
 * globalThis.fetch that records every call, so each refusal is checked for
 * having made NO Google call and each success for exactly one PUT.
 *
 * Nothing here touches the network or Postgres.
 */
import { test, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { OAuth2Client } from "google-auth-library";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import type { GbpReview, InstanceConfig, LocationConfig } from "./types.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";
const HQ = "99999999-9999-9999-9999-999999999999";
const USER = "user-1";
const REVIEW_NAME = "accounts/111/locations/222/reviews/abc-123";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

const MAIN_ST: LocationConfig = {
  key: "main-st",
  displayName: "Main St Store",
  googleAccountId: "111",
  locationId: "222",
  accountKey: "owner",
  targetCompanyId: COMPANY_A,
};

const BETA: LocationConfig = {
  key: "beta",
  displayName: "Beta Shop",
  googleAccountId: "111",
  locationId: "333",
  accountKey: "owner",
  targetCompanyId: COMPANY_B,
};

const CONFIG: InstanceConfig = {
  allowReplies: true,
  accounts: [
    {
      key: "owner",
      userEmail: "owner@example.com",
      clientIdRef: "ref-id",
      clientSecretRef: "ref-secret",
      refreshTokenRef: "ref-token",
      allowedCompanies: [COMPANY_A, COMPANY_B],
    },
  ],
  locations: [MAIN_ST, BETA],
};

const LIVE_REVIEW: GbpReview = {
  name: REVIEW_NAME,
  reviewId: "abc-123",
  reviewer: { displayName: "Pat Customer", isAnonymous: false },
  starRating: "TWO",
  comment: "Slow service",
  createTime: "2026-09-01T10:00:00Z",
  updateTime: "2026-09-01T10:00:00Z",
};

const STORED_ROW = {
  review_name: REVIEW_NAME,
  location_key: MAIN_ST.key,
  company_id: COMPANY_A,
  reviewer_name: "Pat Customer",
  star_rating: 2,
  review_text: "Slow service",
  reply_text: null,
  reply_time: null,
  reply_source: null,
  review_time: "2026-09-01T10:00:00Z",
  paperclip_issue_id: "issue-1",
};

function scoped(companyId: string | null, rest: Record<string, unknown> = {}) {
  return { ...rest, hostScope: { companyId, userId: USER } };
}

// ── Google stand-in ────────────────────────────────────────────────────────

type Responder = (method: string, url: string, body: unknown) => Response;

const fetchLog: Array<{ method: string; url: string; body: unknown }> = [];
let responder: Responder = () => {
  throw new Error("unexpected Google call");
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function answerGoogle(next: Responder) {
  responder = next;
}

/** Google holds this review, with or without a reply; a PUT answers with the new reply. */
function googleHolding(review: GbpReview, putUpdateTime = "2026-09-06T12:00:00Z"): Responder {
  return (method, url, body) => {
    if (method === "GET" && url.endsWith(`/${REVIEW_NAME}`)) return json(review);
    if (method === "PUT" && url.endsWith(`/${REVIEW_NAME}/reply`)) {
      return json({ comment: (body as { comment: string }).comment, updateTime: putUpdateTime });
    }
    throw new Error(`unexpected Google call ${method} ${url}`);
  };
}

function puts() {
  return fetchLog.filter((c) => c.method === "PUT");
}

const originalFetch = globalThis.fetch;
const originalGetAccessToken = OAuth2Client.prototype.getAccessToken;

before(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    fetchLog.push({ method, url, body });
    return responder(method, url, body);
  }) as typeof fetch;
  // The token refresh goes through google-auth-library's own transport, not
  // globalThis.fetch, so it is short-circuited here rather than reaching the
  // network with a made-up refresh token.
  OAuth2Client.prototype.getAccessToken = (async () => ({ token: "test-token", res: null })) as typeof originalGetAccessToken;
});

after(() => {
  globalThis.fetch = originalFetch;
  OAuth2Client.prototype.getAccessToken = originalGetAccessToken;
});

beforeEach(() => {
  fetchLog.length = 0;
  responder = () => {
    throw new Error("unexpected Google call");
  };
});

// ── harness ────────────────────────────────────────────────────────────────

interface DbStub {
  /** Rows to answer a SELECT with, chosen by a substring of the SQL. */
  rows?: Array<{ match: string; rows: unknown[] }>;
  /** rowCount to answer an INSERT/UPDATE with (default 1, a successful write). */
  rowCount?: number;
}

/**
 * The tool handlers as registered, so a test can call one with a run context
 * the harness would drop. The harness builds its own run context from four
 * fields, and userId (which the host stamps for a person driving a tool
 * through the tools route) is not one of them, so the only way to test what
 * the tool does with it is to hold the handler itself.
 */
type ToolHandler = (params: unknown, runCtx: ToolRunContext & { userId?: string | null }) => Promise<{ content?: string; error?: string; data?: unknown }>;
const registeredTools = new Map<string, ToolHandler>();

async function makeHarness(config: Record<string, unknown> = CONFIG as unknown as Record<string, unknown>, db: DbStub = {}) {
  const harness = createTestHarness({ manifest, config });
  registeredTools.clear();
  const baseRegister = harness.ctx.tools.register.bind(harness.ctx.tools);
  harness.ctx.tools.register = ((name: string, declaration: Parameters<typeof baseRegister>[1], fn: Parameters<typeof baseRegister>[2]) => {
    registeredTools.set(name, fn as unknown as ToolHandler);
    baseRegister(name, declaration, fn);
  }) as typeof harness.ctx.tools.register;
  // The harness answers every query with no rows and every write with
  // rowCount 0. The handlers under test read rows and expect the audit
  // insert to succeed, so those are answered here; every call is still
  // recorded by the harness for assertions on order and parameters.
  const baseQuery = harness.ctx.db.query.bind(harness.ctx.db);
  const baseExecute = harness.ctx.db.execute.bind(harness.ctx.db);
  harness.ctx.db.query = (async (sql: string, params?: unknown[]) => {
    await baseQuery(sql, params);
    const hit = (db.rows ?? []).find((r) => sql.includes(r.match));
    return hit ? hit.rows : [];
  }) as typeof harness.ctx.db.query;
  harness.ctx.db.execute = async (sql: string, params?: unknown[]) => {
    await baseExecute(sql, params);
    return { rowCount: db.rowCount ?? 1 };
  };
  await plugin.definition.setup(harness.ctx);
  return harness;
}

function seedHq(harness: TestHarness) {
  harness.seed({
    companies: [{ id: HQ, name: "HQ", isPortfolioRoot: true }] as unknown as Parameters<TestHarness["seed"]>[0]["companies"],
  });
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof Error, "not an Error");
    assert.ok(err.message.startsWith(`[${code}]`), `expected [${code}], got: ${err.message}`);
    assert.doesNotMatch(err.message, LONG_DASHES);
    return true;
  });
}

// ── scope: no stamp, no data, no Google ────────────────────────────────────

test("every page handler throws [ESCOPE] without a host stamp and makes no Google call", async () => {
  const harness = await makeHarness();
  const noScope = [
    {},
    { companyId: COMPANY_A },
    { hostScope: { companyId: COMPANY_A } },
    { hostScope: "spoofed" },
    scoped(null),
  ];
  for (const params of noScope) {
    await rejectsWith(harness.getData("review-summary", params), "ESCOPE");
    await rejectsWith(harness.getData("review-list", { ...params, locationKey: MAIN_ST.key }), "ESCOPE");
    await rejectsWith(harness.getData("review-detail", { ...params, reviewName: REVIEW_NAME }), "ESCOPE");
    await rejectsWith(
      harness.performAction("review-post-reply", {
        ...params,
        reviewName: REVIEW_NAME,
        replyText: "Thanks",
        idempotencyKey: "k1",
        expectedReplyUpdateTime: null,
        replaceExisting: false,
      }),
      "ESCOPE",
    );
    await rejectsWith(harness.performAction("review-sync-location", { ...params, locationKey: MAIN_ST.key }), "ESCOPE");
  }
  assert.equal(fetchLog.length, 0);
  assert.equal(harness.dbQueries.length, 0, "no query ran on behalf of nobody");
});

test("review-summary reads hostScope only and ignores the companyId the page sent", async () => {
  const harness = await makeHarness();
  // The page claims company B; the host checked company A.
  const data = (await harness.getData("review-summary", scoped(COMPANY_A, { companyId: COMPANY_B }))) as {
    locations: Array<{ locationKey: string }>;
    isRollup: boolean;
  };
  assert.deepEqual(data.locations.map((l) => l.locationKey), [MAIN_ST.key]);
  assert.equal(data.isRollup, false);
  // And the one query it ran carries the location's own company id.
  assert.equal(harness.dbQueries.length, 1);
  assert.deepEqual(harness.dbQueries[0]!.params, [MAIN_ST.key, COMPANY_A]);
  assert.match(harness.dbQueries[0]!.sql, /AND company_id = \$2/);
});

test("review-summary from HQ rolls up every location, each read with its own company", async () => {
  const harness = await makeHarness();
  seedHq(harness);
  const data = (await harness.getData("review-summary", scoped(HQ))) as { locations: Array<{ locationKey: string }>; isRollup: boolean };
  assert.deepEqual(data.locations.map((l) => l.locationKey), [MAIN_ST.key, BETA.key]);
  assert.equal(data.isRollup, true);
  assert.deepEqual(harness.dbQueries.map((q) => q.params), [[MAIN_ST.key, COMPANY_A], [BETA.key, COMPANY_B]]);
});

// ── review-list ────────────────────────────────────────────────────────────

test("review-list refuses another company's location with one message", async () => {
  const harness = await makeHarness();
  await rejectsWith(harness.getData("review-list", scoped(COMPANY_A, { locationKey: BETA.key })), "ELOCATION_NOT_FOUND");
  await rejectsWith(harness.getData("review-list", scoped(COMPANY_A, { locationKey: "nope" })), "ELOCATION_NOT_FOUND");
  assert.equal(harness.dbQueries.length, 0);
});

test("review-list returns the location, the account label, the sync time and the reviews", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [{ match: "ORDER BY (reply_text IS NULL)", rows: [STORED_ROW] }],
  });
  // The sync time is the one the sync recorded, not the newest row change.
  await harness.ctx.state.set({ scopeKind: "instance", stateKey: `last-sync:${MAIN_ST.key}` }, "2026-09-06T06:00:00.000Z");
  const data = (await harness.getData("review-list", scoped(COMPANY_A, { locationKey: MAIN_ST.key }))) as {
    location: { key: string; displayName: string };
    account: { key: string; label: string };
    lastSyncedAt: string | null;
    canPostFromHere: boolean;
    isRollup: boolean;
    reviews: Array<{ reviewName: string; replyText: string | null; issueId: string | null }>;
  };
  assert.deepEqual(data.location, { key: MAIN_ST.key, displayName: "Main St Store" });
  assert.deepEqual(data.account, { key: "owner", label: "owner@example.com" });
  assert.equal(data.lastSyncedAt, "2026-09-06T06:00:00.000Z");
  assert.equal(data.canPostFromHere, true);
  assert.equal(data.isRollup, false);
  assert.equal(data.reviews.length, 1);
  assert.equal(data.reviews[0]!.reviewName, REVIEW_NAME);
  assert.equal(data.reviews[0]!.issueId, "issue-1");
  assert.equal(fetchLog.length, 0, "the list never calls Google");
});

test("review-list from HQ is readable and never postable", async () => {
  const harness = await makeHarness();
  seedHq(harness);
  const data = (await harness.getData("review-list", scoped(HQ, { locationKey: BETA.key }))) as { canPostFromHere: boolean; isRollup: boolean };
  assert.equal(data.isRollup, true);
  assert.equal(data.canPostFromHere, false);
  // Read with the location's own company, not HQ's.
  for (const q of harness.dbQueries) assert.deepEqual(q.params, [BETA.key, COMPANY_B]);
});

// ── review-detail ──────────────────────────────────────────────────────────

const DETAIL_ROWS: DbStub = { rows: [{ match: "WHERE review_name = $1 AND location_key = $2 AND company_id = $3", rows: [STORED_ROW] }] };

test("review-detail reads Google live and says where the reply will go", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, DETAIL_ROWS);
  answerGoogle(googleHolding({ ...LIVE_REVIEW, reviewReply: { comment: "Sorry", updateTime: "2026-09-02T10:00:00Z" } }));
  const data = (await harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;
  assert.deepEqual(data.liveReply, { text: "Sorry", updateTime: "2026-09-02T10:00:00Z" });
  assert.equal(data.liveChecked, true);
  assert.equal(data.liveError, null);
  assert.equal(data.postsAs, "Posts as: Main St Store, using the Google account owner@example.com");
  assert.deepEqual(data.posting, { enabled: true, accountFound: true, accountAllowed: true, accountKey: MAIN_ST.accountKey });
  assert.equal(data.canPostFromHere, true);
  assert.equal(data.pendingAttempt, null);
  assert.equal(data.issueId, "issue-1");
  assert.equal((data.review as { starRating: number }).starRating, 2);
  // The suggested reply is for a 2-star review: the careful template, dash-free.
  assert.match(String(data.suggestedReply), /make this right/);
  assert.doesNotMatch(String(data.suggestedReply), LONG_DASHES);
  assert.doesNotMatch(String(data.postsAs), LONG_DASHES);
  assert.equal(fetchLog.length, 1);
  assert.equal(fetchLog[0]!.method, "GET");
});

test("review-detail still answers when Google cannot be read, and says so", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, DETAIL_ROWS);
  answerGoogle(() => json({ error: { message: "quota" } }, 429));
  const data = (await harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;
  assert.equal(data.liveChecked, false);
  assert.equal(data.liveReply, null);
  assert.match(String(data.liveError), /^\[EGBP_HTTP_429\]/);
  assert.equal((data.review as { reviewName: string }).reviewName, REVIEW_NAME);
});

test("review-detail reports the allowReplies switch and a pending attempt", async () => {
  const harness = await makeHarness({ ...CONFIG, allowReplies: false } as unknown as Record<string, unknown>, {
    rows: [
      ...DETAIL_ROWS.rows!,
      { match: "updated_at > now()", rows: [{ status: "posting", created_at: new Date("2026-09-06T11:59:00Z") }] },
    ],
  });
  answerGoogle(googleHolding(LIVE_REVIEW));
  const data = (await harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;
  assert.deepEqual(data.posting, { enabled: false, accountFound: true, accountAllowed: true, accountKey: MAIN_ST.accountKey });
  assert.deepEqual(data.pendingAttempt, { status: "posting", createdAt: "2026-09-06T11:59:00.000Z" });
});

/** A reply_posts row as the database hands it back. */
function rawAttempt(over: Record<string, unknown> = {}) {
  return {
    idempotency_key: "crashed-key",
    review_name: REVIEW_NAME,
    location_key: MAIN_ST.key,
    company_id: COMPANY_A,
    source: "human",
    actor_user_id: USER,
    actor_agent_id: null,
    actor_run_id: null,
    reply_text: "From the crashed worker",
    previous_reply_text: null,
    previous_reply_time: null,
    status: "posting",
    google_update_time: null,
    error: null,
    created_at: new Date("2026-09-06T09:00:00Z"),
    updated_at: new Date("2026-09-06T09:00:00Z"),
    ...over,
  };
}

test("review-detail settles an attempt whose worker never came back, so the Post button is offered again", async () => {
  // The stale row is what listUnsettledPosts sees; findPendingAttempt (the
  // narrower query) sees nothing, which is what it would see once the row has
  // been settled.
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [
      ...DETAIL_ROWS.rows!,
      { match: "status IN ('posting', 'unknown')", rows: [rawAttempt()] },
    ],
  });
  answerGoogle(googleHolding(LIVE_REVIEW));
  const data = (await harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;

  assert.equal(data.pendingAttempt, null, "a lost attempt no longer hides the Post button");
  const settle = harness.dbExecutes.find((e) => e.sql.includes("UPDATE") && e.sql.includes("reply_posts"));
  assert.ok(settle, "the lost attempt was written off");
  assert.deepEqual(settle.params, [
    "failed",
    "No reply reached Google before the attempt was abandoned.",
    "crashed-key",
  ]);
  assert.doesNotMatch(String(settle.params![1]), LONG_DASHES);
});

test("review-detail marks a lost attempt as posted when Google turns out to hold its text", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [
      ...DETAIL_ROWS.rows!,
      { match: "status IN ('posting', 'unknown')", rows: [rawAttempt({ status: "unknown", idempotency_key: "lost-key" })] },
    ],
  });
  answerGoogle(googleHolding({ ...LIVE_REVIEW, reviewReply: { comment: "From the crashed worker", updateTime: "2026-09-06T09:01:00Z" } }));
  const data = (await harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;

  assert.equal(data.pendingAttempt, null);
  const settle = harness.dbExecutes.find((e) => e.sql.includes("status = 'posted'"));
  assert.ok(settle, "the reply did reach Google, so the row says posted");
  assert.deepEqual(settle.params, ["2026-09-06T09:01:00Z", "lost-key"]);
});

test("review-detail leaves an attempt alone when Google could not be read", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [
      ...DETAIL_ROWS.rows!,
      { match: "status IN ('posting', 'unknown')", rows: [rawAttempt()] },
      { match: "updated_at > now()", rows: [{ status: "posting", created_at: new Date("2026-09-06T09:00:00Z") }] },
    ],
  });
  answerGoogle(() => json({ error: { message: "quota" } }, 429));
  const data = (await harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;

  assert.equal(data.liveChecked, false);
  // Nothing may be written off against a review nobody could read.
  assert.equal(harness.dbExecutes.filter((e) => e.sql.includes("reply_posts")).length, 0);
  assert.deepEqual(data.pendingAttempt, { status: "posting", createdAt: "2026-09-06T09:00:00.000Z" });
});

test("review-detail refuses a bad name, another company's review, and a review not synced yet", async () => {
  const harness = await makeHarness();
  await rejectsWith(harness.getData("review-detail", scoped(COMPANY_A, { reviewName: "email/abc" })), "EINVALID_INPUT");
  await rejectsWith(
    harness.getData("review-detail", scoped(COMPANY_A, { reviewName: "accounts/111/locations/333/reviews/abc" })),
    "ELOCATION_NOT_FOUND",
  );
  // A visible location, but the sync has not stored the row: no Google call either.
  await rejectsWith(harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME })), "EREVIEW_NOT_FOUND");
  assert.equal(fetchLog.length, 0);
});

test("review-detail from HQ reads the review with its own company and cannot post", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, DETAIL_ROWS);
  seedHq(harness);
  answerGoogle(googleHolding(LIVE_REVIEW));
  const data = (await harness.getData("review-detail", scoped(HQ, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;
  assert.equal(data.isRollup, true);
  assert.equal(data.canPostFromHere, false);
  const rowRead = harness.dbQueries.find((q) => q.sql.includes("WHERE review_name = $1 AND location_key = $2"));
  assert.ok(rowRead);
  assert.deepEqual(rowRead.params, [REVIEW_NAME, MAIN_ST.key, COMPANY_A]);
});

// ── review-post-reply ──────────────────────────────────────────────────────

const POST = {
  reviewName: REVIEW_NAME,
  replyText: "Thank you, Pat. We would like to make this right.",
  idempotencyKey: "panel-1",
  expectedReplyUpdateTime: null,
  replaceExisting: false,
};

test("review-post-reply with allowReplies off throws [EREPLIES_DISABLED] and never calls Google", async () => {
  const harness = await makeHarness({ ...CONFIG, allowReplies: false } as unknown as Record<string, unknown>);
  await rejectsWith(harness.performAction("review-post-reply", scoped(COMPANY_A, POST)), "EREPLIES_DISABLED");
  assert.equal(fetchLog.length, 0);
  assert.equal(harness.dbExecutes.length, 0, "no audit row for a refused post");
});

test("review-post-reply from the portfolio root throws [EROLLUP_READ_ONLY] before anything else", async () => {
  const harness = await makeHarness();
  seedHq(harness);
  await rejectsWith(harness.performAction("review-post-reply", scoped(HQ, POST)), "EROLLUP_READ_ONLY");
  assert.equal(fetchLog.length, 0);
  assert.equal(harness.dbQueries.length, 0);
});

test("review-post-reply needs an idempotency key", async () => {
  const harness = await makeHarness();
  for (const idempotencyKey of [undefined, "", "   ", 42, "x".repeat(201)]) {
    await rejectsWith(harness.performAction("review-post-reply", scoped(COMPANY_A, { ...POST, idempotencyKey })), "EINVALID_INPUT");
  }
  await rejectsWith(
    harness.performAction("review-post-reply", scoped(COMPANY_A, { ...POST, expectedReplyUpdateTime: 123 })),
    "EINVALID_INPUT",
  );
  assert.equal(fetchLog.length, 0);
});

test("review-post-reply refuses another company's review before any Google call", async () => {
  const harness = await makeHarness();
  await rejectsWith(
    harness.performAction("review-post-reply", scoped(COMPANY_A, { ...POST, reviewName: "accounts/111/locations/333/reviews/abc" })),
    "ELOCATION_NOT_FOUND",
  );
  assert.equal(fetchLog.length, 0);
});

test("review-post-reply refuses to overwrite a reply the person did not ask to replace, with no PUT", async () => {
  const harness = await makeHarness();
  answerGoogle(googleHolding({ ...LIVE_REVIEW, reviewReply: { comment: "Already here", updateTime: "2026-09-02T10:00:00Z" } }));
  await rejectsWith(harness.performAction("review-post-reply", scoped(COMPANY_A, POST)), "EREPLY_EXISTS");
  assert.equal(puts().length, 0);
});

test("review-post-reply posts once: audit row, one PUT, then the local upsert, and needs no capability beyond the manifest", async () => {
  const harness = await makeHarness();
  answerGoogle(googleHolding(LIVE_REVIEW, "2026-09-06T12:34:56Z"));
  const receipt = (await harness.performAction("review-post-reply", scoped(COMPANY_A, POST))) as Record<string, unknown>;

  assert.equal(puts().length, 1);
  assert.deepEqual(puts()[0]!.body, { comment: POST.replyText });
  assert.equal(receipt.postedAt, "2026-09-06T12:34:56Z");
  assert.equal(receipt.replaced, false);
  assert.equal(receipt.alreadyPosted, false);
  assert.deepEqual(receipt.location, { key: MAIN_ST.key, displayName: "Main St Store" });
  assert.equal(receipt.account, "owner@example.com");

  // The audit row is written before the PUT and records the signed-in user
  // the host vouched for, not anything the page sent.
  const audit = harness.dbExecutes.find((e) => e.sql.includes("INSERT INTO") && e.sql.includes("reply_posts"));
  assert.ok(audit, "audit row");
  assert.equal(audit.params?.[0], "panel-1");
  assert.equal(audit.params?.[3], COMPANY_A);
  assert.equal(audit.params?.[4], "human");
  assert.equal(audit.params?.[5], USER);
  const posted = harness.dbExecutes.find((e) => e.sql.includes("status = 'posted'"));
  assert.ok(posted, "posted row");
  const upsert = harness.dbExecutes.find((e) => e.sql.includes("ON CONFLICT (review_name)"));
  assert.ok(upsert, "local upsert");
  assert.equal(upsert.params?.[9], "human");
  assert.ok(harness.dbExecutes.indexOf(audit) < harness.dbExecutes.indexOf(posted));
  assert.ok(harness.dbExecutes.indexOf(posted) < harness.dbExecutes.indexOf(upsert));

  // The success path reached its end with the manifest's capabilities alone:
  // the harness would have thrown on any call to issues.update or
  // issue comment creation, which the manifest does not declare.
  await assert.rejects(harness.ctx.issues.update("issue-1", { status: "done" }, COMPANY_A), /issues\.update/);
  await assert.rejects(harness.ctx.issues.createComment("issue-1", "posted", COMPANY_A), /issue\.comments\.create/);
});

// ── the agent tool through the same guard ──────────────────────────────────

test("gbp_reply_to_review answers with a failure result on [EREPLY_EXISTS] and makes no PUT", async () => {
  const harness = await makeHarness();
  answerGoogle(googleHolding({ ...LIVE_REVIEW, reviewReply: { comment: "Already here", updateTime: "2026-09-02T10:00:00Z" } }));
  const result = await harness.executeTool<{ content: string; error?: string }>(
    "gbp_reply_to_review",
    { reviewName: REVIEW_NAME, locationKey: MAIN_ST.key, replyText: "Thanks" },
    { companyId: COMPANY_A, agentId: "agent-1", runId: "run-1" },
  );
  assert.ok(result.error, "the tool must report failure through the error field");
  assert.match(result.error, /^\[EREPLY_EXISTS\]/);
  assert.equal(result.content, result.error);
  assert.equal(puts().length, 0);
});

test("gbp_reply_to_review posts as the agent with a run-scoped key and never asks to replace", async () => {
  const harness = await makeHarness();
  answerGoogle(googleHolding(LIVE_REVIEW));
  const result = await harness.executeTool<{ content: string; error?: string }>(
    "gbp_reply_to_review",
    { reviewName: REVIEW_NAME, locationKey: MAIN_ST.key, replyText: "Thanks" },
    { companyId: COMPANY_A, agentId: "agent-1", runId: "run-1" },
  );
  assert.equal(result.error, undefined);
  assert.equal(puts().length, 1);
  const audit = harness.dbExecutes.find((e) => e.sql.includes("INSERT INTO") && e.sql.includes("reply_posts"));
  assert.ok(audit);
  assert.equal(audit.params?.[0], "run:run-1:abc-123");
  assert.equal(audit.params?.[4], "agent");
  assert.equal(audit.params?.[5], null, "no user on an agent post");
  assert.equal(audit.params?.[6], "agent-1");
  assert.equal(audit.params?.[7], "run-1");
});

// ── review-sync-location ───────────────────────────────────────────────────

test("review-sync-location refuses another company's location and HQ, with no Google call", async () => {
  const harness = await makeHarness();
  seedHq(harness);
  await rejectsWith(harness.performAction("review-sync-location", scoped(COMPANY_A, { locationKey: BETA.key })), "ELOCATION_NOT_FOUND");
  await rejectsWith(harness.performAction("review-sync-location", scoped(HQ, { locationKey: MAIN_ST.key })), "ELOCATION_NOT_FOUND");
  await rejectsWith(harness.performAction("review-sync-location", scoped(COMPANY_A, {})), "ELOCATION_NOT_FOUND");
  assert.equal(fetchLog.length, 0);
});

test("review-sync-location pulls the location's reviews, files the issue, and the issue text is plain", async () => {
  const harness = await makeHarness();
  const created: Array<{ title: string; description: string; companyId: string }> = [];
  const realCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
  harness.ctx.issues.create = async (input) => {
    created.push({ title: input.title, description: input.description ?? "", companyId: input.companyId });
    return realCreate(input);
  };
  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) return json({ reviews: [LIVE_REVIEW] });
    throw new Error(`unexpected Google call ${method} ${url}`);
  });

  const result = (await harness.performAction("review-sync-location", scoped(COMPANY_A, { locationKey: MAIN_ST.key }))) as Record<string, unknown>;
  assert.deepEqual(result.location, { key: MAIN_ST.key, displayName: "Main St Store" });
  assert.equal(result.total, 1);
  assert.equal(result.new, 1);
  assert.equal(typeof result.syncedAt, "string");

  assert.equal(created.length, 1);
  const issue = created[0]!;
  assert.equal(issue.companyId, COMPANY_A);
  assert.doesNotMatch(issue.title, LONG_DASHES);
  assert.doesNotMatch(issue.description, LONG_DASHES);
  assert.doesNotMatch(issue.description, /@CEO Agent reply approved/);
  assert.match(issue.description, /open Reviews inside this company/);
  assert.match(issue.description, /press Sync now/);

  // The stored row carries the location's own company.
  const insert = harness.dbExecutes.find((e) => e.sql.includes("INSERT INTO") && e.sql.includes(".reviews"));
  assert.ok(insert);
  assert.equal(insert.params?.[1], MAIN_ST.key);
  assert.equal(insert.params?.[2], COMPANY_A);
});

// ── the weekly digest ──────────────────────────────────────────────────────

test("the weekly digest reads each location with its own company and carries no long dashes", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [
      {
        match: "review_time > $3",
        rows: [
          { reviewer_name: "Pat", star_rating: "2", review_text: "Slow service, and the coffee was cold when it finally arrived at our table after a long wait for the server", reply_text: null, review_time: "2026-09-05T10:00:00Z" },
          { reviewer_name: "Sam", star_rating: "5", review_text: "Great", reply_text: "Thanks!", review_time: "2026-09-04T10:00:00Z" },
        ],
      },
    ],
  });
  const created: Array<{ title: string; description: string }> = [];
  const realCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
  harness.ctx.issues.create = async (input) => {
    created.push({ title: input.title, description: input.description ?? "" });
    return realCreate(input);
  };

  await harness.runJob("send-weekly-digest");

  assert.equal(created.length, 2, "one digest per location");
  for (const issue of created) {
    assert.doesNotMatch(issue.title, LONG_DASHES);
    assert.doesNotMatch(issue.description, LONG_DASHES);
  }
  assert.match(created[0]!.description, /Unreplied:\*\* 1/);
  assert.match(created[0]!.description, /\*\*Pat\*\*/);
  assert.deepEqual(
    harness.dbQueries.map((q) => q.params?.slice(0, 2)),
    [[MAIN_ST.key, COMPANY_A], [BETA.key, COMPANY_B]],
  );
});

// ── the sync keeps rows where their location is, and tells the truth about
//    who wrote the reply ────────────────────────────────────────────────────

test("a location moved to another company has its rows re-filed by one sync, so the new company can see them", async () => {
  // Same location key and the same review, but the settings now point the
  // location at company B while the stored row still carries company A.
  const moved: LocationConfig = { ...MAIN_ST, targetCompanyId: COMPANY_B };
  const harness = await makeHarness({ ...CONFIG, locations: [moved] } as unknown as Record<string, unknown>, {
    rows: [
      {
        match: "SELECT review_name, reply_text, reply_source",
        rows: [{ review_name: REVIEW_NAME, reply_text: null, reply_source: null }],
      },
    ],
  });
  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) return json({ reviews: [LIVE_REVIEW] });
    throw new Error(`unexpected Google call ${method} ${url}`);
  });

  await harness.performAction("review-sync-location", scoped(COMPANY_B, { locationKey: moved.key }));

  const update = harness.dbExecutes.find((e) => e.sql.includes("UPDATE") && e.sql.includes(".reviews"));
  assert.ok(update, "the existing row was updated");
  assert.match(update.sql, /location_key = \$4, company_id = \$5/);
  assert.equal(update.params?.[3], moved.key);
  assert.equal(update.params?.[4], COMPANY_B, "the row now belongs to the location's current company");

  // And that pair is exactly what every read is constrained on, so the new
  // company sees the review from here on.
  await harness.getData("review-list", scoped(COMPANY_B, { locationKey: moved.key }));
  const listRead = harness.dbQueries.find((q) => q.sql.includes("ORDER BY (reply_text IS NULL)"));
  assert.deepEqual(listRead?.params, [moved.key, COMPANY_B]);
});

test("a reply first seen by the sync is recorded as written in Google, and an unreplied review has no source", async () => {
  const harness = await makeHarness();
  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) {
      return json({
        reviews: [
          { ...LIVE_REVIEW, reviewReply: { comment: "Answered in the Google console", updateTime: "2026-09-02T10:00:00Z" } },
          { ...LIVE_REVIEW, name: "accounts/111/locations/222/reviews/def-456", reviewId: "def-456" },
        ],
      });
    }
    throw new Error(`unexpected Google call ${method} ${url}`);
  });

  await harness.performAction("review-sync-location", scoped(COMPANY_A, { locationKey: MAIN_ST.key }));

  const inserts = harness.dbExecutes.filter((e) => e.sql.includes("INSERT INTO") && e.sql.includes(".reviews"));
  assert.equal(inserts.length, 2);
  assert.match(inserts[0]!.sql, /reply_time, reply_source, paperclip_issue_id/);
  assert.equal(inserts[0]!.params?.[9], "google", "a reply nobody here wrote came from Google");
  assert.equal(inserts[1]!.params?.[9], null, "no reply, no source");
});

test("a synced reply the audit table says Paperclip sent keeps its own source", async () => {
  const harness = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [
      {
        match: "SELECT review_name, reply_text, reply_source",
        rows: [{ review_name: REVIEW_NAME, reply_text: null, reply_source: null }],
      },
      { match: "status = 'posted' AND reply_text", rows: [{ source: "human" }] },
    ],
  });
  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) {
      return json({ reviews: [{ ...LIVE_REVIEW, reviewReply: { comment: "Thank you, Pat.", updateTime: "2026-09-06T12:00:00Z" } }] });
    }
    throw new Error(`unexpected Google call ${method} ${url}`);
  });

  await harness.performAction("review-sync-location", scoped(COMPANY_A, { locationKey: MAIN_ST.key }));

  const lookup = harness.dbQueries.find((q) => q.sql.includes("status = 'posted' AND reply_text"));
  assert.ok(lookup, "the audit table was asked who sent this text");
  assert.deepEqual(lookup.params, [REVIEW_NAME, "Thank you, Pat."]);
  const update = harness.dbExecutes.find((e) => e.sql.includes("UPDATE") && e.sql.includes(".reviews"));
  assert.equal(update?.params?.[2], "human", "the list does not credit Google for a reply a person sent");
});

test("a reply nobody here sent becomes google, and an unchanged reply is not looked up at all", async () => {
  // Nothing in reply_posts matches, so the changed text is Google's.
  const changed = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [
      {
        match: "SELECT review_name, reply_text, reply_source",
        rows: [{ review_name: REVIEW_NAME, reply_text: "Older wording", reply_source: "human" }],
      },
    ],
  });
  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) {
      return json({ reviews: [{ ...LIVE_REVIEW, reviewReply: { comment: "Edited in the console", updateTime: "2026-09-06T12:00:00Z" } }] });
    }
    throw new Error(`unexpected Google call ${method} ${url}`);
  });
  await changed.performAction("review-sync-location", scoped(COMPANY_A, { locationKey: MAIN_ST.key }));
  const changedUpdate = changed.dbExecutes.find((e) => e.sql.includes("UPDATE") && e.sql.includes(".reviews"));
  assert.equal(changedUpdate?.params?.[2], "google");

  // The text still matches, so the recorded source stands and no extra read happens.
  const unchanged = await makeHarness(CONFIG as unknown as Record<string, unknown>, {
    rows: [
      {
        match: "SELECT review_name, reply_text, reply_source",
        rows: [{ review_name: REVIEW_NAME, reply_text: "Same wording", reply_source: "agent" }],
      },
    ],
  });
  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) {
      return json({ reviews: [{ ...LIVE_REVIEW, reviewReply: { comment: "Same wording", updateTime: "2026-09-06T12:00:00Z" } }] });
    }
    throw new Error(`unexpected Google call ${method} ${url}`);
  });
  await unchanged.performAction("review-sync-location", scoped(COMPANY_A, { locationKey: MAIN_ST.key }));
  const unchangedUpdate = unchanged.dbExecutes.find((e) => e.sql.includes("UPDATE") && e.sql.includes(".reviews"));
  assert.equal(unchangedUpdate?.params?.[2], "agent");
  assert.equal(unchanged.dbQueries.filter((q) => q.sql.includes("status = 'posted' AND reply_text")).length, 0);
});

// ── Last synced is the sync, not the last row change ───────────────────────

test("Last synced is the time the sync ran, and a location that has never been synced says so", async () => {
  const harness = await makeHarness();
  const before = (await harness.getData("review-list", scoped(COMPANY_A, { locationKey: MAIN_ST.key }))) as { lastSyncedAt: string | null };
  assert.equal(before.lastSyncedAt, null, "never synced has no time");

  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) return json({ reviews: [] });
    throw new Error(`unexpected Google call ${method} ${url}`);
  });
  const result = (await harness.performAction("review-sync-location", scoped(COMPANY_A, { locationKey: MAIN_ST.key }))) as {
    total: number;
    syncedAt: string;
    lastSyncedAt: string | null;
  };
  assert.equal(result.total, 0);
  assert.equal(result.lastSyncedAt, result.syncedAt, "the time reported is the time recorded");
  assert.equal(harness.getState({ scopeKind: "instance", stateKey: `last-sync:${MAIN_ST.key}` }), result.syncedAt);

  // A location whose Google listing holds no reviews has no rows at all, and
  // still reports the sync that just ran.
  const after = (await harness.getData("review-list", scoped(COMPANY_A, { locationKey: MAIN_ST.key }))) as { lastSyncedAt: string | null };
  assert.equal(after.lastSyncedAt, result.syncedAt);
  assert.equal(harness.dbQueries.filter((q) => q.sql.includes("MAX(updated_at)")).length, 0, "no row change decides this any more");
});

// ── review-detail: a missing account is not a refused one ──────────────────

test("review-detail says the Google account is missing rather than not allowed for this company", async () => {
  const harness = await makeHarness({ ...CONFIG, accounts: [] } as unknown as Record<string, unknown>, DETAIL_ROWS);
  const data = (await harness.getData("review-detail", scoped(COMPANY_A, { reviewName: REVIEW_NAME }))) as Record<string, unknown>;
  assert.deepEqual(data.posting, { enabled: true, accountFound: false, accountAllowed: false, accountKey: MAIN_ST.accountKey });
  assert.equal(puts().length, 0);
});

// ── the two read and sync tools obey the location's company ────────────────

const AGENT_A = { companyId: COMPANY_A, agentId: "agent-1", runId: "run-1" };

test("gbp_list_reviews refuses another company's location before any Google call, and still serves its own", async () => {
  const harness = await makeHarness();
  const refused = await harness.executeTool<{ content: string; error?: string }>("gbp_list_reviews", { locationKey: BETA.key }, AGENT_A);
  assert.ok(refused.error, "a refusal must be reported as a failure");
  assert.match(refused.error, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.equal(refused.content, refused.error);
  assert.doesNotMatch(refused.error, LONG_DASHES);
  assert.equal(fetchLog.length, 0, "no Google call for another company's location");

  answerGoogle((method, url) => {
    if (method === "GET" && url.includes("/locations/222/reviews")) return json({ reviews: [LIVE_REVIEW], totalReviewCount: 1 });
    throw new Error(`unexpected Google call ${method} ${url}`);
  });
  const allowed = await harness.executeTool<{ content: string; error?: string }>("gbp_list_reviews", { locationKey: MAIN_ST.key }, AGENT_A);
  assert.equal(allowed.error, undefined);
  assert.match(allowed.content, /Pat Customer/);
});

test("gbp_sync_location refuses another company's location before any Google call, issue or row", async () => {
  const harness = await makeHarness();
  const created: string[] = [];
  const realCreate = harness.ctx.issues.create.bind(harness.ctx.issues);
  harness.ctx.issues.create = async (input) => {
    created.push(input.companyId);
    return realCreate(input);
  };

  const result = await harness.executeTool<{ content: string; error?: string }>("gbp_sync_location", { locationKey: BETA.key }, AGENT_A);
  assert.ok(result.error);
  assert.match(result.error, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.equal(result.content, result.error);
  assert.doesNotMatch(result.error, LONG_DASHES);
  assert.equal(fetchLog.length, 0);
  assert.deepEqual(created, [], "no issue is filed in the other company");
  assert.equal(harness.dbExecutes.length, 0, "and no row is written");
});

// ── the reply tool: the review decides the location, not the parameter ─────

test("the reply tool ignores the locationKey it is handed and files the audit row under the review's own location", async () => {
  for (const locationKey of [BETA.key, "no-such-location"]) {
    const harness = await makeHarness();
    fetchLog.length = 0;
    answerGoogle(googleHolding(LIVE_REVIEW));
    const result = await harness.executeTool<{ content: string; error?: string }>(
      "gbp_reply_to_review",
      { reviewName: REVIEW_NAME, locationKey, replyText: "Thanks" },
      AGENT_A,
    );
    assert.equal(result.error, undefined, locationKey);
    assert.equal(puts().length, 1, locationKey);
    const audit = harness.dbExecutes.find((e) => e.sql.includes("INSERT INTO") && e.sql.includes("reply_posts"));
    assert.ok(audit, locationKey);
    assert.equal(audit.params?.[1], REVIEW_NAME, locationKey);
    assert.equal(audit.params?.[2], MAIN_ST.key, locationKey);
    assert.equal(audit.params?.[3], COMPANY_A, locationKey);
  }
});

test("an agent tool call a person drove records the person as well as the agent", async () => {
  const harness = await makeHarness();
  answerGoogle(googleHolding(LIVE_REVIEW));
  const handler = registeredTools.get("gbp_reply_to_review");
  assert.ok(handler, "the reply tool is registered");

  // Straight to the handler, because the host stamps runContext.userId for a
  // board caller and the test harness's own runner does not carry that field.
  const result = await handler(
    { reviewName: REVIEW_NAME, locationKey: MAIN_ST.key, replyText: "Thanks" },
    { agentId: "agent-1", runId: "run-1", companyId: COMPANY_A, projectId: "project-1", userId: USER },
  );

  assert.equal(result.error, undefined);
  const audit = harness.dbExecutes.find((e) => e.sql.includes("INSERT INTO") && e.sql.includes("reply_posts"));
  assert.ok(audit);
  assert.equal(audit.params?.[4], "agent");
  assert.equal(audit.params?.[5], USER, "the person who drove the tool is on the audit row");
  assert.equal(audit.params?.[6], "agent-1");
  assert.equal(audit.params?.[7], "run-1");
});
