/**
 * Tests for the triage cursor.
 *
 * The behaviours worth pinning: the overlap is exactly the documented five
 * minutes rather than roughly it, a missing cursor widens to a day instead of
 * failing, a garbage or future-dated value can never produce a window that
 * silently matches nothing, and two mailboxes (or two companies) never share
 * a cursor.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  DEFAULT_LOOKBACK_HOURS,
  OVERLAP_MINUTES,
  TRIAGE_STATE_NAMESPACE,
  parseStoredCursor,
  planCursorAdvance,
  resolveSince,
  triageCursorScope,
} from "./triage-cursor.js";

const NOW = new Date("2026-08-12T12:00:00.000Z");

test("resolveSince subtracts exactly the overlap from a stored cursor", () => {
  const stored = "2026-08-12T09:30:00.000Z";
  const result = resolveSince(stored, NOW);
  assert.equal(result.source, "cursor");
  assert.equal(
    Date.parse(stored) - Date.parse(result.since),
    OVERLAP_MINUTES * 60_000,
  );
  assert.equal(result.since, "2026-08-12T09:25:00.000Z");
});

test("resolveSince falls back to the lookback window with no cursor", () => {
  const result = resolveSince(null, NOW);
  assert.equal(result.source, "fallback");
  assert.equal(
    Date.parse(NOW.toISOString()) - Date.parse(result.since),
    DEFAULT_LOOKBACK_HOURS * 3_600_000,
  );
});

test("resolveSince treats an unparseable cursor as no cursor", () => {
  for (const bad of ["", "   ", "not a date", "2026-13-45T99:99:99Z"]) {
    const result = resolveSince(bad, NOW);
    assert.equal(result.source, "fallback", `expected fallback for ${JSON.stringify(bad)}`);
  }
});

test("a future-dated cursor never yields a since after now", () => {
  const result = resolveSince("2027-01-01T00:00:00.000Z", NOW);
  assert.equal(result.source, "cursor");
  assert.ok(
    Date.parse(result.since) <= NOW.getTime(),
    `since ${result.since} should not be after ${NOW.toISOString()}`,
  );
  assert.equal(result.since, NOW.toISOString());
});

test("parseStoredCursor accepts both stored shapes and rejects the rest", () => {
  const iso = "2026-08-12T09:30:00.000Z";
  assert.equal(parseStoredCursor({ lastRunAt: iso }), iso);
  assert.equal(parseStoredCursor(iso), iso);
  // Normalises to ISO so a hand-seeded value compares cleanly later.
  assert.equal(parseStoredCursor("2026-08-12T09:30:00Z"), iso);

  for (const bad of [null, undefined, {}, { lastRunAt: 42 }, 42, [], "nope"]) {
    assert.equal(parseStoredCursor(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("cursor scopes are distinct per account, mailbox and company", () => {
  const a = triageCursorScope("company-1", "main");
  const b = triageCursorScope("company-1", "support");
  const c = triageCursorScope("company-2", "main");

  assert.notEqual(a.stateKey, b.stateKey);
  assert.notEqual(a.scopeId, c.scopeId);
  assert.equal(a.stateKey, c.stateKey);
  assert.equal(a.namespace, TRIAGE_STATE_NAMESPACE);
  assert.equal(a.scopeKind, "company");
});

test("two mailboxes under one account do not share a cursor", () => {
  const accountWide = triageCursorScope("company-1", "main");
  const boxA = triageCursorScope("company-1", "main", "101");
  const boxB = triageCursorScope("company-1", "main", "202");

  assert.notEqual(boxA.stateKey, boxB.stateKey);
  assert.notEqual(boxA.stateKey, accountWide.stateKey);
  // Omitting the mailbox and passing null mean the same thing: account-wide.
  assert.equal(triageCursorScope("company-1", "main", null).stateKey, accountWide.stateKey);
});

test("planCursorAdvance refuses to rewind unless forced", () => {
  const stored = "2026-08-12T09:30:00.000Z";
  const earlier = "2026-08-12T08:00:00.000Z";
  const later = "2026-08-12T11:00:00.000Z";

  const forward = planCursorAdvance(stored, later);
  assert.equal(forward.ok, true);
  assert.equal(forward.lastRunAt, later);

  const backward = planCursorAdvance(stored, earlier);
  assert.equal(backward.ok, false);
  assert.match(backward.reason ?? "", /backwards/i);

  const forced = planCursorAdvance(stored, earlier, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.lastRunAt, earlier);
});

test("planCursorAdvance accepts any first write and rejects garbage", () => {
  const first = planCursorAdvance(null, "2026-08-12T09:30:00.000Z");
  assert.equal(first.ok, true);

  const bad = planCursorAdvance(null, "not a date");
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /unparseable/i);
});
