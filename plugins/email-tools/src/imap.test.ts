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
import { enforceUidGt, fetchHeaders, fetchParsedMessage, hasFlag } from "./imap.js";

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
