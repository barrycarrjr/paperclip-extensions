/**
 * Tests for the IMAP search helpers.
 *
 * The behaviour worth pinning: RFC 3501 makes a UID range `n:*` match the
 * newest message even when n is beyond it, so the raw search result can
 * contain one phantom "new" message on a quiet mailbox. enforceUidGt is the
 * strict greater-than contract; without it the poll counted phantom mail on
 * every tick, and wake-on-mail (v0.18.4) turned that into an all-night wake
 * loop across every mailbox that keeps a message in its inbox.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { ImapFlow } from "imapflow";
import { buildSearchObject, enforceUidGt, fetchHeaders, fetchParsedMessage, hasFlag, searchMessages } from "./imap.js";

test("the phantom newest message is filtered out on a quiet mailbox", () => {
  // Cursor at 102290, mailbox's newest message IS 102290: `102291:*`
  // still returns it. The strict filter must drop it.
  assert.deepEqual(enforceUidGt([102290], 102290), []);
});

test("genuinely new messages pass and old ones do not", () => {
  assert.deepEqual(enforceUidGt([100, 101, 102, 103], 101), [102, 103]);
});

test("no cursor means no filtering", () => {
  assert.deepEqual(enforceUidGt([1, 2, 3], undefined), [1, 2, 3]);
  assert.deepEqual(enforceUidGt([1, 2, 3], 0), [1, 2, 3]);
});

test("an empty result stays empty", () => {
  assert.deepEqual(enforceUidGt([], 500), []);
});

// The replied and forwarded icons in the Email pages read these two fields, so
// a message answered from Outlook or webmail shows as answered here too.
function clientWith(messages: Array<{ uid: number; flags: string[]; source?: string }>): ImapFlow {
  return {
    getMailboxLock: async () => ({ release: () => undefined }),
    fetch: async function* () {
      for (const m of messages) {
        yield {
          uid: m.uid,
          flags: new Set(m.flags),
          envelope: { from: [{ name: "Chris", address: "chris@example.com" }], subject: "Hi", date: new Date(0) },
        };
      }
    },
    fetchOne: async (uid: string) => {
      const m = messages.find((x) => String(x.uid) === uid);
      return m ? { uid: m.uid, flags: new Set(m.flags), source: Buffer.from(m.source ?? "Subject: Hi\r\n\r\nBody") } : false;
    },
  } as unknown as ImapFlow;
}

test("message rows say whether each message was replied to or forwarded", async () => {
  const rows = await fetchHeaders(
    clientWith([
      { uid: 1, flags: ["\\Seen", "\\Answered"] },
      { uid: 2, flags: ["$Forwarded"] },
      { uid: 3, flags: ["\\answered", "$forwarded"] },
      { uid: 4, flags: [] },
    ]),
    "INBOX",
    [1, 2, 3, 4],
  );
  const byUid = new Map(rows.map((r) => [r.uid, [r.answered, r.forwarded]]));
  assert.deepEqual(byUid.get(1), [true, false]);
  assert.deepEqual(byUid.get(2), [false, true]);
  assert.deepEqual(byUid.get(3), [true, true]);
  assert.deepEqual(byUid.get(4), [false, false]);
});

test("an opened message says whether it was replied to or forwarded", async () => {
  const client = clientWith([
    { uid: 7, flags: ["\\Answered"] },
    { uid: 8, flags: ["\\Seen"] },
  ]);
  const answered = await fetchParsedMessage(client, "INBOX", 7);
  assert.equal(answered?.answered, true);
  assert.equal(answered?.forwarded, false);
  const plain = await fetchParsedMessage(client, "INBOX", 8);
  assert.equal(plain?.answered, false);
});

test("hasFlag ignores case and copes with no flags at all", () => {
  assert.equal(hasFlag(new Set(["$FORWARDED"]), "$Forwarded"), true);
  assert.equal(hasFlag(["\\Seen"], "\\Answered"), false);
  assert.equal(hasFlag(undefined, "\\Answered"), false);
});

// A timestamp search must not lose the evening. Gmail decides which day a
// message arrived on in Pacific time while the search date is written from
// UTC, so "since 00:25 UTC on the 22nd" used to search from Pacific midnight
// and every message in between was invisible to the triage cursor.
function searchClient(arrivals: Array<{ uid: number; internalDate: Date | null }>, searched: unknown[]): ImapFlow {
  return {
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async (query: unknown) => {
      searched.push(query);
      return arrivals.map((a) => a.uid);
    },
    fetch: async function* (uids: number[]) {
      for (const a of arrivals) {
        if (uids.includes(a.uid)) yield { uid: a.uid, internalDate: a.internalDate ?? undefined };
      }
    },
  } as unknown as ImapFlow;
}

test("an exact-time search asks the server for a day more on each side", () => {
  const since = new Date("2026-10-22T00:25:30Z");
  const before = new Date("2026-10-22T03:00:00Z");
  const query = buildSearchObject({ folder: "INBOX", since, before, exactTimes: true });
  assert.equal((query.since as Date).toISOString(), "2026-10-21T00:25:30.000Z");
  assert.equal((query.before as Date).toISOString(), "2026-10-23T03:00:00.000Z");
});

test("a plain date search is sent unchanged", () => {
  const since = new Date("2026-10-21");
  const query = buildSearchObject({ folder: "INBOX", since });
  assert.equal((query.since as Date).toISOString(), "2026-10-21T00:00:00.000Z");
});

test("an exact-time search keeps mail that arrived after the cursor, even across the UTC date line", async () => {
  const searched: unknown[] = [];
  const client = searchClient(
    [
      { uid: 10, internalDate: new Date("2026-10-21T23:50:00Z") },
      { uid: 11, internalDate: new Date("2026-10-22T00:45:00Z") },
      { uid: 12, internalDate: new Date("2026-10-22T01:13:33Z") },
    ],
    searched,
  );
  const uids = await searchMessages(client, {
    folder: "INBOX",
    since: new Date("2026-10-22T00:25:30Z"),
    unseen: true,
    exactTimes: true,
  });
  assert.deepEqual(uids, [11, 12]);
  assert.equal(searched.length, 1);
});

test("an exact-time search drops mail at or after `before` and keeps mail with no arrival time", async () => {
  const client = searchClient(
    [
      { uid: 1, internalDate: new Date("2026-10-22T00:59:59Z") },
      { uid: 2, internalDate: new Date("2026-10-22T01:00:00Z") },
      { uid: 3, internalDate: null },
    ],
    [],
  );
  const uids = await searchMessages(client, {
    folder: "INBOX",
    before: new Date("2026-10-22T01:00:00Z"),
    exactTimes: true,
  });
  assert.deepEqual(uids, [1, 3]);
});
