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
import { enforceUidGt } from "./imap.js";

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
