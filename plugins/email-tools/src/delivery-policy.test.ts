/**
 * Tests for the decisions around a send.
 *
 * The behaviours worth pinning: a send that is already too late never starts
 * (so its "failed" is true), follow-ups are only waited for inside the host's
 * time limit, only real losses earn a warning, and a forward cannot mark a
 * message it does not name precisely.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  FOLLOW_UP_DEADLINE_MS,
  HOST_CALL_LIMIT_MS,
  SEND_START_DEADLINE_MS,
  assertTimeToSend,
  copyMissing,
  followUpBudget,
  markMissing,
  parseBridgeForwardOf,
  parseToolForwardOf,
} from "./delivery-policy.js";

test("both limits sit inside the host's 30 second limit, follow-ups first", () => {
  assert.ok(FOLLOW_UP_DEADLINE_MS < SEND_START_DEADLINE_MS);
  assert.ok(SEND_START_DEADLINE_MS < HOST_CALL_LIMIT_MS);
});

test("follow-ups get what is left of the first 20 seconds", () => {
  assert.equal(followUpBudget(1_000, 1_000), 20_000);
  assert.equal(followUpBudget(1_000, 16_000), 5_000);
  assert.ok(followUpBudget(1_000, 30_000) <= 0);
});

test("a send too close to the limit refuses before anything goes out, and says so", () => {
  assert.doesNotThrow(() => assertTimeToSend(0, SEND_START_DEADLINE_MS));
  assert.throws(() => assertTimeToSend(0, SEND_START_DEADLINE_MS + 1), (err: Error) => {
    assert.match(err.message, /^\[ESEND_TOO_LATE\] Nothing was sent/);
    assert.match(err.message, /Try again\.$/);
    return true;
  });
});

test("only a copy known to be missing counts as missing", () => {
  assert.equal(copyMissing(undefined), false);
  assert.equal(copyMissing({ ok: true, folder: "INBOX.Sent Items" }), false);
  assert.equal(copyMissing({ ok: true, filedBy: "Gmail" }), false);
  assert.equal(copyMissing({ ok: false, pending: true }), false);
  assert.equal(copyMissing({ ok: false, error: "no Sent folder" }), true);
});

test("only a mark that should have been set and was not counts as missing", () => {
  const base = { ok: false, flag: "$Forwarded", folder: "INBOX" };
  assert.equal(markMissing(undefined), false);
  assert.equal(markMissing({ ...base, ok: true, uid: 5 }), false);
  assert.equal(markMissing({ ...base, uid: 5, pending: true }), false);
  assert.equal(markMissing({ ...base, uid: 5, unsupported: true, error: "not stored" }), false);
  // Looked for by Message-ID only, and not in the watched folder: nobody asked.
  assert.equal(markMissing({ ...base, notFound: true, error: "not here" }), false);
  // Named by UID and gone, or refused: the operator should hear about it.
  assert.equal(markMissing({ ...base, uid: 5, notFound: true, error: "gone" }), true);
  assert.equal(markMissing({ ...base, uid: 5, error: "did not keep the flag" }), true);
});

test("a bridge forward must name its folder, and carries a checkable Message-ID", () => {
  assert.deepEqual(parseBridgeForwardOf(undefined), { ok: true });
  assert.equal(parseBridgeForwardOf({ uid: 42 }).ok, false);
  assert.equal(parseBridgeForwardOf({ uid: 42, folder: "   " }).ok, false);
  assert.equal(parseBridgeForwardOf({ uid: "42", folder: "INBOX" }).ok, false);
  assert.equal(parseBridgeForwardOf({ uid: 4.2, folder: "INBOX" }).ok, false);
  assert.equal(parseBridgeForwardOf("INBOX/42").ok, false);
  assert.deepEqual(parseBridgeForwardOf({ uid: 42, folder: " INBOX ", messageId: " <m1> " }), {
    ok: true,
    target: { folder: "INBOX", uid: 42, messageId: "<m1>", flag: "$Forwarded" },
  });
  assert.deepEqual(parseBridgeForwardOf({ uid: 42, folder: "INBOX" }), {
    ok: true,
    target: { folder: "INBOX", uid: 42, messageId: undefined, flag: "$Forwarded" },
  });
});

test("an agent's forward must name its folder too", () => {
  assert.deepEqual(parseToolForwardOf(undefined, undefined), { ok: true });
  const noFolder = parseToolForwardOf(812, undefined);
  assert.equal(noFolder.ok, false);
  assert.match(noFolder.ok ? "" : noFolder.error, /forward_of_folder is required/);
  assert.equal(parseToolForwardOf(8.12, "INBOX").ok, false);
  assert.deepEqual(parseToolForwardOf(812, "INBOX.Clients"), {
    ok: true,
    target: { folder: "INBOX.Clients", uid: 812, messageId: undefined, flag: "$Forwarded" },
  });
  // With a Message-ID, the plugin checks it before marking, as for the pages.
  assert.deepEqual(parseToolForwardOf(812, "INBOX.Clients", " <c1@x> "), {
    ok: true,
    target: { folder: "INBOX.Clients", uid: 812, messageId: "<c1@x>", flag: "$Forwarded" },
  });
});
