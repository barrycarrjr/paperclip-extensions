/**
 * Tests for the triage review queue.
 *
 * The behaviours worth pinning: a sender is keyed the way a rule matches it;
 * each message is counted once however many runs see it, a message with no
 * Message-ID included, and repeating a call or an import changes nothing; an
 * entry that cannot be stored is skipped and reported while the rest of the
 * batch is stored, in one statement; a sender a rule covers is never queued;
 * every entry has a way out (a rule, Dismiss, or the expiry); a failed clear
 * never fails the rule; mail the agent itself moved into the triage folder is
 * not learned as a rule; one company or mailbox never sees another's entries;
 * and nothing outside sender-rules.ts writes a rule around the clearing.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import type { PluginContext, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { NAMESPACE, openPluginDb } from "./pglite-db.js";
import {
  DEFAULT_EXPIRY_DAYS,
  STORED_MESSAGE_IDS,
  addToReviewQueue,
  clearReviewEntriesForRule,
  dismissReviewEntry,
  expiryCutoff,
  isCoveredByRules,
  listReviewQueue,
  normalizeReviewSender,
  parseReviewEntries,
  resolveExpiryDays,
  type ReviewEntry,
} from "./review-queue.js";
import { writeSenderRule } from "./sender-rules.js";
import { recordAgentTriageMoves, withoutAgentMoves } from "./agent-moves.js";
import { learnFromTriageHeaders } from "./poll.js";

const COMPANY = "aaaaaaaa-1111-4222-8333-444444444444";
const OTHER_COMPANY = "bbbbbbbb-5555-4666-8777-888888888888";
const NOW = new Date("2026-10-09T12:00:00.000Z");
const CUTOFF = expiryCutoff(NOW, DEFAULT_EXPIRY_DAYS);
const LONG_AGO = new Date("2000-01-01T00:00:00.000Z");

function entries(raw: unknown[], now = NOW): ReviewEntry[] {
  const parsed = parseReviewEntries(raw, now, { expiresBefore: LONG_AGO });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(parsed.skipped, []);
  return parsed.entries;
}

type Opened = Awaited<ReturnType<typeof openPluginDb>>;

async function withDb(fn: (db: PluginDatabaseClient, opened: Opened) => Promise<void>): Promise<void> {
  const opened = await openPluginDb();
  try {
    await fn(opened.db, opened);
  } finally {
    await opened.pg.close();
  }
}

function add(db: PluginDatabaseClient, raw: unknown[], mailbox = "personal", companyId = COMPANY) {
  return addToReviewQueue(db, { companyId, mailbox, entries: entries(raw), expiresBefore: LONG_AGO });
}

async function list(db: PluginDatabaseClient, mailbox = "personal", companyId = COMPANY, expiresBefore = LONG_AGO) {
  return listReviewQueue(db, { companyId, mailbox, limit: 100, expiresBefore });
}

async function count(db: PluginDatabaseClient, sender: string): Promise<number> {
  const [entry] = (await list(db)).entries.filter((e) => e.sender === sender);
  return entry?.messageCount ?? 0;
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as PluginContext["logger"];

// ── Keys, coverage and settings (no database) ───────────────────────────────

test("a sender is keyed the way a rule matches it: lowercased address or @domain", () => {
  assert.equal(normalizeReviewSender("Promo@Shop.Example.com"), "promo@shop.example.com");
  assert.equal(normalizeReviewSender("Pat Example <Pat@Example.com>"), "pat@example.com");
  assert.equal(normalizeReviewSender("`promo@shop.example.com`"), "promo@shop.example.com");
  assert.equal(normalizeReviewSender("@Shop.Example.com"), "@shop.example.com");
  for (const bad of ["subject: Big sale", "Pat Example", "", "  ", 42, null, "o'brien@example.com"]) {
    assert.equal(normalizeReviewSender(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("coverage matches the poll loop and the Email page: exact address or exact @domain", () => {
  const rules = new Set(["pat@example.com", "@shop.example.com"]);
  assert.equal(isCoveredByRules("pat@example.com", rules), true);
  assert.equal(isCoveredByRules("promo@shop.example.com", rules), true);
  assert.equal(isCoveredByRules("@shop.example.com", rules), true);
  assert.equal(isCoveredByRules("other@example.com", rules), false);
  // A domain rule does not reach subdomains anywhere else in this plugin.
  assert.equal(isCoveredByRules("news@mail.shop.example.com", rules), false);
  // One address rule does not settle a whole-domain candidate.
  assert.equal(isCoveredByRules("@example.com", rules), false);
});

test("the expiry defaults to 30 days and stays between 1 and 365", () => {
  assert.equal(resolveExpiryDays(undefined), 30);
  assert.equal(resolveExpiryDays("10"), 30);
  assert.equal(resolveExpiryDays(0), 1);
  assert.equal(resolveExpiryDays(1000), 365);
  assert.equal(resolveExpiryDays(14.7), 14);
  assert.equal(expiryCutoff(NOW, 30).toISOString(), "2026-09-09T12:00:00.000Z");
});

// ── Validation (no database) ────────────────────────────────────────────────

test("entries that cannot be stored are skipped with the reason, and the rest go ahead", () => {
  const parsed = parseReviewEntries(
    [
      { sender: "ok@example.com" },
      { sender: "o'brien@example.com" },
      { sender: "x@example.com", count: 0 },
      { sender: "y@example.com", suggestedRule: "delete" },
      { sender: "z@example.com", lastSeenAt: "last tuesday" },
      "pat@example.com",
    ],
    NOW,
    { expiresBefore: CUTOFF },
  );
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.entries.map((e) => e.sender), ["ok@example.com"]);
  assert.deepEqual(
    parsed.skipped.map((s) => s.index),
    [1, 2, 3, 4, 5],
  );
  assert.match(parsed.skipped[0]!.reason, /no rule could match|not an address/);
  assert.match(parsed.skipped[1]!.reason, /count/);
  assert.match(parsed.skipped[2]!.reason, /suggestedRule/);
  assert.match(parsed.skipped[3]!.reason, /ISO dates/);
});

test("a batch that is not a non-empty list fails whole", () => {
  for (const raw of [undefined, null, [], "pat@example.com", { sender: "pat@example.com" }]) {
    const parsed = parseReviewEntries(raw, NOW, { expiresBefore: CUTOFF });
    assert.equal(parsed.ok, false, `should reject ${JSON.stringify(raw)}`);
  }
});

test("a message with no Message-ID still counts: by its uid, or failing that by number", () => {
  const [fromSearch, bare] = entries([
    {
      sender: "a@example.com",
      messages: [
        { messageId: null, uid: 41 },
        { messageId: "<x1@example.com>", uid: 42 },
        { messageId: "  ", uid: null },
      ],
    },
    { sender: "b@example.com", messageIds: ["<y1@example.com>", null, ""] },
  ]);
  assert.deepEqual(fromSearch!.messageKeys, ["uid:41", "<x1@example.com>"]);
  assert.equal(fromSearch!.atLeast, 3);
  assert.deepEqual(bare!.messageKeys, ["<y1@example.com>"]);
  assert.equal(bare!.atLeast, 3);
});

test("an entry last seen before the expiry is reported as too old, not stored", () => {
  const parsed = parseReviewEntries(
    [
      { sender: "old@example.com", lastSeenAt: "2026-08-01T00:00:00Z" },
      { sender: "new@example.com", lastSeenAt: "2026-10-01T00:00:00Z" },
    ],
    NOW,
    { expiresBefore: CUTOFF },
  );
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.entries.map((e) => e.sender), ["new@example.com"]);
  assert.match(parsed.skipped[0]!.reason, /older than the review-queue expiry/);
});

test("the same sender twice in one batch is merged without counting a message twice", () => {
  const [merged, ...rest] = entries([
    {
      sender: "promo@shop.example.com",
      messageIds: ["<a@x>", "<b@x>"],
      note: "older note",
      subject: "Older",
      lastSeenAt: "2026-10-01T00:00:00Z",
    },
    {
      sender: "Promo <PROMO@shop.example.com>",
      messageIds: ["<b@x>", "<c@x>"],
      note: "newer note",
      suggestedRule: "auto-triage",
      lastSeenAt: "2026-10-05T00:00:00Z",
    },
  ]);
  assert.equal(rest.length, 0);
  assert.deepEqual(merged!.messageKeys, ["<a@x>", "<b@x>", "<c@x>"]);
  assert.equal(merged!.atLeast, 3);
  assert.equal(merged!.note, "newer note");
  assert.equal(merged!.subject, "Older", "a field the newer sighting lacks keeps the older value");
  assert.equal(merged!.suggestedRule, "auto-triage");
  assert.equal(merged!.firstSeenAt, "2026-10-01T00:00:00.000Z");
  assert.equal(merged!.lastSeenAt, "2026-10-05T00:00:00.000Z");
});

test("defaults: one message, seen now; a future date is clamped to now; a long note is cut", () => {
  const [plain, future, wordy] = entries([
    { sender: "a@example.com" },
    { sender: "b@example.com", lastSeenAt: "2099-01-01T00:00:00Z" },
    { sender: "c@example.com", note: "x".repeat(5000) },
  ]);
  assert.equal(plain!.atLeast, 1);
  assert.equal(plain!.lastSeenAt, NOW.toISOString());
  assert.equal(plain!.firstSeenAt, NOW.toISOString());
  assert.equal(future!.lastSeenAt, NOW.toISOString());
  assert.equal(wordy!.note!.length, 2000);
});

// ── Storage (PGlite, host rules enforced) ───────────────────────────────────

test("add then list: new senders are added, a repeat is updated, noisiest first", async () => {
  await withDb(async (db) => {
    const first = await add(db, [
      { sender: "quiet@example.com", displayName: "Quiet", lastSeenAt: "2026-10-02T09:00:00Z" },
      {
        sender: "loud@example.com",
        count: 4,
        subject: "Sale",
        note: "Marketing list with an unsubscribe link.",
        suggestedRule: "auto-triage",
        lastSeenAt: "2026-10-03T09:00:00Z",
      },
    ]);
    assert.deepEqual(first, {
      added: ["quiet@example.com", "loud@example.com"],
      updated: [],
      alreadyRuled: [],
      skipped: [],
    });

    const second = await add(db, [
      { sender: "quiet@example.com", messageIds: ["<q2@example.com>"], lastSeenAt: "2026-10-04T09:00:00Z" },
    ]);
    assert.deepEqual(second.updated, ["quiet@example.com"]);

    const { entries: waiting, total } = await list(db);
    assert.equal(total, 2);
    assert.deepEqual(
      waiting.map((e) => [e.sender, e.messageCount]),
      [
        ["loud@example.com", 4],
        ["quiet@example.com", 2],
      ],
    );
    const loud = waiting[0]!;
    assert.equal(loud.lastSubject, "Sale");
    assert.equal(loud.note, "Marketing list with an unsubscribe link.");
    assert.equal(loud.suggestedRule, "auto-triage");
    const quiet = waiting[1]!;
    assert.equal(quiet.displayName, "Quiet", "a later sighting without a name keeps the name");
    assert.equal(quiet.firstSeenAt, "2026-10-02T09:00:00.000Z");
    assert.equal(quiet.lastSeenAt, "2026-10-04T09:00:00.000Z");
  });
});

test("each message is counted once, however many runs see it", async () => {
  await withDb(async (db) => {
    const sender = "promo@shop.example.com";
    await add(db, [{ sender, messages: [{ messageId: "<1@x>", uid: 1 }, { messageId: null, uid: 2 }] }]);
    assert.equal(await count(db, sender), 2);
    // A server without WITHIN returns the whole day again: two old, one new.
    await add(db, [
      {
        sender,
        messages: [
          { messageId: "<1@x>", uid: 1 },
          { messageId: null, uid: 2 },
          { messageId: "<3@x>", uid: 3 },
        ],
      },
    ]);
    assert.equal(await count(db, sender), 3);
    // The same run retried changes nothing.
    await add(db, [{ sender, messages: [{ messageId: "<3@x>", uid: 3 }] }]);
    assert.equal(await count(db, sender), 3);
    // A later run whose one new message has no Message-ID: counted by uid.
    await add(db, [{ sender, messages: [{ messageId: null, uid: 4 }] }]);
    assert.equal(await count(db, sender), 4);
    await add(db, [{ sender, messages: [{ messageId: null, uid: 4 }] }]);
    assert.equal(await count(db, sender), 4);
  });
});

test("a count with no messages named only sets a floor, so repeating it adds nothing", async () => {
  await withDb(async (db) => {
    const sender = "legacy@example.com";
    await add(db, [{ sender, count: 5 }]);
    await add(db, [{ sender, count: 5 }]);
    assert.equal(await count(db, sender), 5);
    await add(db, [{ sender, count: 7 }]);
    assert.equal(await count(db, sender), 7, "a larger floor raises it");
    await add(db, [{ sender, count: 2 }]);
    assert.equal(await count(db, sender), 7, "a smaller one never lowers it");
  });
});

test("re-running an import changes nothing, and an older sighting cannot overwrite newer words", async () => {
  await withDb(async (db) => {
    await add(db, [{ sender: "pat@example.org", note: "newer note", lastSeenAt: "2026-10-05T00:00:00Z" }]);
    const batch = [
      { sender: "pat@example.org", count: 3, note: "older note", lastSeenAt: "2026-09-20T00:00:00Z" },
      { sender: "offers@deals.example.net", count: 2, lastSeenAt: "2026-09-21T00:00:00Z" },
    ];
    await add(db, batch);
    const once = (await list(db)).entries;
    await add(db, batch);
    const twice = (await list(db)).entries;
    assert.deepEqual(twice, once);
    const pat = twice.find((e) => e.sender === "pat@example.org")!;
    assert.equal(pat.messageCount, 3);
    assert.equal(pat.note, "newer note");
    assert.equal(pat.firstSeenAt, "2026-09-20T00:00:00.000Z");
    assert.equal(pat.lastSeenAt, "2026-10-05T00:00:00.000Z");
  });
});

test("a batch is written in one statement, so it is stored whole or not at all", async () => {
  await withDb(async (db, opened) => {
    opened.statements.length = 0;
    await add(db, [{ sender: "a@example.com" }, { sender: "b@example.com" }, { sender: "c@example.com" }]);
    const writes = opened.statements.filter((s) => /^\s*INSERT INTO/i.test(s));
    assert.equal(writes.length, 1);

    opened.failWhen(/INSERT INTO/);
    await assert.rejects(add(db, [{ sender: "d@example.com" }, { sender: "e@example.com" }]));
    opened.failWhen(null);
    assert.deepEqual((await list(db)).entries.map((e) => e.sender).sort(), [
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });
});

test("the remembered message identities stop at the newest few hundred, the count does not", async () => {
  await withDb(async (db) => {
    const ids = (from: number) => Array.from({ length: 200 }, (_, i) => `<${from + i}@x>`);
    for (const from of [0, 200, 400]) {
      await add(db, [{ sender: "storm@example.com", messageIds: ids(from) }]);
    }
    // One of the newest again: still remembered, so not counted twice.
    await add(db, [{ sender: "storm@example.com", messageIds: ["<599@x>"] }]);
    assert.equal(await count(db, "storm@example.com"), 600);
    const stored = await db.query<{ n: number; newest: string }>(
      `SELECT cardinality(message_ids) AS n, message_ids[cardinality(message_ids)] AS newest
         FROM ${NAMESPACE}.email_review_queue WHERE sender = $1`,
      ["storm@example.com"],
    );
    assert.equal(stored[0]!.n, STORED_MESSAGE_IDS);
    assert.equal(stored[0]!.newest, "<599@x>");
  });
});

test("a sender a rule already covers is not queued, by address or by domain", async () => {
  await withDb(async (db) => {
    for (const [pattern, ruleType] of [
      ["boss@example.com", "keep-always"],
      ["@noise.example.com", "auto-triage"],
    ] as const) {
      await writeSenderRule(db, { companyId: COMPANY, mailbox: "personal", pattern, ruleType, onExisting: "replace" });
    }
    const result = await add(db, [
      { sender: "boss@example.com" },
      { sender: "alerts@noise.example.com" },
      { sender: "new@example.com" },
    ]);
    assert.deepEqual(result.alreadyRuled, ["boss@example.com", "alerts@noise.example.com"]);
    assert.deepEqual(result.added, ["new@example.com"]);
    assert.deepEqual((await list(db)).entries.map((e) => e.sender), ["new@example.com"]);
  });
});

test("a rule clears the entries it settles and nothing else", async () => {
  await withDb(async (db) => {
    await add(db, [
      { sender: "a@shop.example.com" },
      { sender: "b@shop.example.com" },
      { sender: "@shop.example.com" },
      { sender: "c@mail.shop.example.com" },
      { sender: "d@notshop.example.com" },
      { sender: "pat@example.com" },
    ]);
    const clear = (pattern: string) =>
      clearReviewEntriesForRule(db, { companyId: COMPANY, mailbox: "personal", pattern });
    assert.equal(await clear("pat@example.com"), 1);
    assert.equal(await clear("@shop.example.com"), 3, "both addresses in the domain and the domain entry");
    assert.equal(await clear("subject: Big sale"), 0, "a subject rule names no sender");
    assert.deepEqual((await list(db)).entries.map((e) => e.sender).sort(), [
      "c@mail.shop.example.com",
      "d@notshop.example.com",
    ]);
  });
});

test("writeSenderRule writes the rule and clears the entry, even when the rule already existed", async () => {
  await withDb(async (db) => {
    await add(db, [{ sender: "promo@shop.example.com" }]);
    const rule = (ruleType: "auto-triage" | "keep-always", onExisting: "keep" | "replace") =>
      writeSenderRule(db, {
        companyId: COMPANY,
        mailbox: "personal",
        pattern: "promo@shop.example.com",
        ruleType,
        onExisting,
      });
    assert.deepEqual(await rule("auto-triage", "keep"), { written: true, clearedReviewEntries: 1 });

    // An entry left over from before rules learned to clear: relearning the
    // same sender writes nothing new but still clears it.
    await db.execute(
      `INSERT INTO ${NAMESPACE}.email_review_queue (company_id, mailbox_key, sender) VALUES ($1, $2, $3)`,
      [COMPANY, "personal", "promo@shop.example.com"],
    );
    assert.deepEqual(await rule("auto-triage", "keep"), { written: false, clearedReviewEntries: 1 });

    // "keep" never overwrites an operator's choice, "replace" does.
    await rule("keep-always", "replace");
    await rule("auto-triage", "keep");
    const rules = await db.query<{ rule_type: string }>(
      `SELECT rule_type FROM ${NAMESPACE}.email_sender_rules WHERE sender_pattern = $1`,
      ["promo@shop.example.com"],
    );
    assert.deepEqual(rules.map((r) => r.rule_type), ["keep-always"]);
  });
});

test("a failed clear never fails the rule: it is stored and the entry stays hidden", async () => {
  await withDb(async (db, opened) => {
    await add(db, [{ sender: "promo@shop.example.com" }]);
    opened.failWhen(/DELETE FROM \S*email_review_queue/);
    const result = await writeSenderRule(db, {
      companyId: COMPANY,
      mailbox: "personal",
      pattern: "promo@shop.example.com",
      ruleType: "mute",
      onExisting: "replace",
    });
    opened.failWhen(null);
    assert.equal(result.written, true);
    assert.equal(result.clearedReviewEntries, 0);
    assert.match(result.clearError ?? "", /simulated database failure/);
    const rules = await db.query<{ rule_type: string }>(
      `SELECT rule_type FROM ${NAMESPACE}.email_sender_rules WHERE sender_pattern = $1`,
      ["promo@shop.example.com"],
    );
    assert.deepEqual(rules.map((r) => r.rule_type), ["mute"]);
    assert.equal((await list(db)).total, 0, "listings leave out senders a rule covers");
  });
});

test("the queue is cleared under the configured key even when the rule uses another spelling", async () => {
  await withDb(async (db) => {
    await add(db, [{ sender: "promo@shop.example.com" }], "personal");
    const result = await writeSenderRule(db, {
      companyId: COMPANY,
      mailbox: "PERSONAL",
      queueMailbox: "personal",
      pattern: "promo@shop.example.com",
      ruleType: "keep-always",
      onExisting: "replace",
    });
    assert.equal(result.clearedReviewEntries, 1);
    // And the rule, filed under the caller's spelling, still covers the sender.
    const again = await add(db, [{ sender: "promo@shop.example.com" }], "personal");
    assert.deepEqual(again.alreadyRuled, ["promo@shop.example.com"]);
  });
});

test("an entry with no new mail within the expiry drops out of listings and is pruned", async () => {
  await withDb(async (db, opened) => {
    await add(db, [
      { sender: "stale@example.com", lastSeenAt: "2026-08-01T00:00:00Z" },
      { sender: "fresh@example.com", lastSeenAt: "2026-10-08T00:00:00Z" },
    ]);
    const shown = await list(db, "personal", COMPANY, CUTOFF);
    assert.deepEqual(shown.entries.map((e) => e.sender), ["fresh@example.com"]);
    assert.equal(shown.total, 1);

    await addToReviewQueue(db, {
      companyId: COMPANY,
      mailbox: "personal",
      entries: entries([{ sender: "another@example.com" }]),
      expiresBefore: CUTOFF,
    });
    const rows = await opened.pg.query<{ sender: string }>(
      `SELECT sender FROM ${NAMESPACE}.email_review_queue ORDER BY sender`,
    );
    assert.deepEqual(rows.rows.map((r) => r.sender), ["another@example.com", "fresh@example.com"]);
  });
});

test("a rule written without clearing still hides the entry from the list", async () => {
  await withDb(async (db) => {
    await add(db, [{ sender: "old@example.com" }, { sender: "new@example.com" }]);
    await db.execute(
      `INSERT INTO ${NAMESPACE}.email_sender_rules (company_id, mailbox_key, sender_pattern, rule_type)
       VALUES ($1, $2, $3, $4)`,
      [COMPANY, "personal", "old@example.com", "mute"],
    );
    const { entries: waiting, total } = await list(db);
    assert.deepEqual(waiting.map((e) => e.sender), ["new@example.com"]);
    assert.equal(total, 1);
  });
});

test("Dismiss clears the address and its domain's whole-domain entry, and nothing else", async () => {
  await withDb(async (db) => {
    await add(db, [
      { sender: "promo@shop.example.com" },
      { sender: "@shop.example.com" },
      { sender: "sales@shop.example.com" },
      { sender: "pat@example.com" },
    ]);
    const dismiss = (sender: string) => dismissReviewEntry(db, { companyId: COMPANY, mailbox: "personal", sender });
    assert.equal(await dismiss("promo@shop.example.com"), 2);
    assert.deepEqual((await list(db)).entries.map((e) => e.sender).sort(), [
      "pat@example.com",
      "sales@shop.example.com",
    ]);
  });
});

test("dismissing an @domain clears the domain entry and every address in it", async () => {
  await withDb(async (db) => {
    await add(db, [
      { sender: "@shop.example.com" },
      { sender: "sales@shop.example.com" },
      { sender: "news@mail.shop.example.com" },
    ]);
    assert.equal(await dismissReviewEntry(db, { companyId: COMPANY, mailbox: "personal", sender: "@shop.example.com" }), 2);
    assert.deepEqual((await list(db)).entries.map((e) => e.sender), ["news@mail.shop.example.com"]);
  });
});

test("one company or mailbox never sees, nor clears, another's entries", async () => {
  await withDb(async (db) => {
    await add(db, [{ sender: "pat@example.com" }], "personal", COMPANY);
    await add(db, [{ sender: "pat@example.com" }], "sales", COMPANY);
    await add(db, [{ sender: "pat@example.com" }], "personal", OTHER_COMPANY);
    await writeSenderRule(db, {
      companyId: COMPANY,
      mailbox: "personal",
      pattern: "pat@example.com",
      ruleType: "keep-always",
      onExisting: "replace",
    });
    await dismissReviewEntry(db, { companyId: COMPANY, mailbox: "personal", sender: "pat@example.com" });
    assert.equal((await list(db, "personal", COMPANY)).total, 0);
    assert.equal((await list(db, "sales", COMPANY)).total, 1);
    assert.equal((await list(db, "personal", OTHER_COMPANY)).total, 1);
  });
});

// ── The agent's own moves into the triage folder (loose mode) ───────────────

test("mail the agent moved into the triage folder is not learned as a rule, and its entry stays", async () => {
  await withDb(async (db) => {
    // A loose-mode run: queue the unknown sender, then move its mail.
    await add(db, [{ sender: "guess@noisy.example.com", messages: [{ messageId: "<g1@x>", uid: 10 }] }]);
    await recordAgentTriageMoves(db, { companyId: COMPANY, mailbox: "personal", messageKeys: ["<g1@x>"] });
    // A message with no Message-ID, recorded by its new UID in the folder.
    await recordAgentTriageMoves(db, { companyId: COMPANY, mailbox: "personal", messageKeys: ["uid:31"] });
    // Meanwhile the operator drags a message from another queued sender.
    await add(db, [{ sender: "decided@example.com" }]);

    const learned = await learnFromTriageHeaders(
      { db, logger: quietLogger },
      { key: "personal", companyId: COMPANY },
      [
        { uid: 30, messageId: "<g1@x>", from: "Guess <guess@noisy.example.com>" },
        { uid: 31, messageId: null, from: "anon@noisy.example.com" },
        { uid: 32, messageId: "<d1@x>", from: "Decided <decided@example.com>" },
      ],
    );
    assert.deepEqual(learned, { inserted: 1, senders: 1, agentMoves: 2 });
    const rules = await db.query<{ sender_pattern: string }>(
      `SELECT sender_pattern FROM ${NAMESPACE}.email_sender_rules ORDER BY sender_pattern`,
    );
    assert.deepEqual(rules.map((r) => r.sender_pattern), ["decided@example.com"]);
    assert.deepEqual((await list(db)).entries.map((e) => e.sender), ["guess@noisy.example.com"]);
  });
});

test("agent moves are kept per mailbox and pruned after a fortnight", async () => {
  await withDb(async (db) => {
    const headers = [{ uid: 5, messageId: "<m@x>" }];
    await recordAgentTriageMoves(db, {
      companyId: COMPANY,
      mailbox: "personal",
      messageKeys: ["<m@x>"],
      now: new Date("2026-09-01T00:00:00Z"),
    });
    assert.deepEqual(await withoutAgentMoves(db, "sales", headers), headers, "another mailbox's move");
    assert.deepEqual(await withoutAgentMoves(db, "personal", headers), []);
    await recordAgentTriageMoves(db, {
      companyId: COMPANY,
      mailbox: "personal",
      messageKeys: ["<later@x>"],
      now: new Date("2026-09-20T00:00:00Z"),
    });
    assert.deepEqual(await withoutAgentMoves(db, "personal", headers), headers, "pruned after 14 days");
  });
});

// ── Source invariants ───────────────────────────────────────────────────────

/** Files, other than sender-rules.ts, that write a sender rule. */
function ruleWritesOutsideSenderRules(files: Array<{ name: string; code: string }>): string[] {
  const offenders: string[] = [];
  for (const { name, code } of files) {
    if (name === "sender-rules.ts") continue;
    const live = code
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // Names bound to the rules table, as in `const RULES = \`${NS}.email_sender_rules\``.
    const aliases = [
      ...live.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*email_sender_rules/g),
    ].map((m) => m[1]!.replace(/\$/g, "\\$"));
    const viaAlias = aliases.length > 0 ? `|\\$\\{\\s*(?:${aliases.join("|")})\\s*\\}` : "";
    const write = new RegExp(`(?:INSERT\\s+INTO|UPDATE)\\s+(?:[^\\s(]*email_sender_rules${viaAlias})`, "i");
    if (write.test(live)) offenders.push(name);
  }
  return offenders;
}

test("the rule-write guard catches every spelling of a write to the rules table", () => {
  const caught = (code: string) => ruleWritesOutsideSenderRules([{ name: "x.ts", code }]).length === 1;
  assert.ok(caught("db.execute(`INSERT INTO plugin_email_tools_7cbee3fdf3.email_sender_rules (a) VALUES ($1)`)"));
  assert.ok(caught("db.execute(`INSERT INTO ${NS}.email_sender_rules (a) VALUES ($1)`)"));
  assert.ok(caught('const RULES = "plugin_email_tools_7cbee3fdf3.email_sender_rules";\ndb.execute(`INSERT INTO ${RULES} (a) VALUES ($1)`)'));
  assert.ok(caught("const T = `${NS}.email_sender_rules`;\ndb.execute(`UPDATE ${T} SET rule_type = $1`)"));
  assert.ok(!caught("// db.execute(`INSERT INTO ${NS}.email_sender_rules (a) VALUES ($1)`)"));
  assert.ok(!caught("db.execute(`DELETE FROM ${NS}.email_sender_rules WHERE id = $1`)"));
  assert.ok(!caught("db.execute(`INSERT INTO ${NS}.email_review_queue (a) VALUES ($1)`)"));
});

test("no file but sender-rules.ts writes a sender rule", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, code: readFileSync(new URL(name, dir), "utf8") }));
  assert.deepEqual(ruleWritesOutsideSenderRules(files), [], "write rules through writeSenderRule");
});

test("the agent's email_move records moves into the triage folder, the operator's move does not", () => {
  const worker = readFileSync(new URL("./worker.ts", import.meta.url), "utf8");
  const block = (start: string, end: string) => {
    const from = worker.indexOf(start);
    assert.ok(from >= 0, `missing ${start}`);
    return worker.slice(from, worker.indexOf(end, from + start.length));
  };
  assert.match(block('"email_move",', "ctx.tools.register("), /recordAgentTriageMoves\(/);
  assert.doesNotMatch(block('"email.move-message"', "ctx.actions.register("), /recordAgentTriageMoves/);
});

test("the review-queue migration only does what the host allows", () => {
  const sql = readFileSync(new URL("../migrations/004_review_queue.sql", import.meta.url), "utf8");
  // The host strips quoted strings before comments when it scans a
  // migration, so an apostrophe in a comment can swallow real SQL.
  for (const line of sql.split(/\r?\n/)) {
    if (line.trim().startsWith("--")) {
      assert.doesNotMatch(line, /['";]/, `comment line must not hold quotes or semicolons: ${line}`);
    }
  }
  const statements = sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements.length, 3);
  for (const s of statements) {
    assert.match(s, /^CREATE /);
    assert.match(s, new RegExp(`${NAMESPACE}\\.email_(review_queue|agent_triage_moves)`));
  }
});
