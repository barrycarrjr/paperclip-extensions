import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_HISTORY, asHistory, describeHealth, recordRun } from "./history.js";

// Made-up policies and dates.
const ren = { policy: "Policy 0000001", title: "Renewal", posted: "2026-03-30" };
const end = { policy: "Policy 0000001", title: "Endorsement", posted: "2024-05-22" };

test("a document missed on one run is retried and reported as recovered when it comes through", () => {
  const first = recordRun(EMPTY_HISTORY, { at: "2026-11-01", outcome: "ok", got: [ren], missed: [end] }, "Fake");
  assert.deepEqual(first.report.stillMissing.map((m) => [m.title, m.tries]), [["Endorsement", 1]]);
  assert.deepEqual(describeHealth(first.report), ["Still missing: Policy 0000001, Endorsement, posted 2024-05-22."]);

  const second = recordRun(first.history, { at: "2026-12-01", outcome: "ok", got: [ren], missed: [end] }, "Fake");
  assert.deepEqual(describeHealth(second.report), ["Still missing after 2 runs: Policy 0000001, Endorsement, posted 2024-05-22."]);

  const third = recordRun(second.history, { at: "2027-01-01", outcome: "ok", got: [ren, end], missed: [] }, "Fake");
  assert.deepEqual(third.report.recovered, [end]);
  assert.deepEqual(third.history.missing, []);
});

test("a run that did not see a missing document keeps it listed with its count unchanged", () => {
  const first = recordRun(EMPTY_HISTORY, { at: "2026-11-01", outcome: "ok", got: [ren], missed: [end] }, "Fake");
  const currentOnly = recordRun(first.history, { at: "2026-12-01", outcome: "ok", got: [ren], missed: [] }, "Fake");
  assert.deepEqual(currentOnly.report.stillMissing.map((m) => m.tries), [1]);
});

test("nothing found twice in a row raises an alert; a run that found only already-saved files does not", () => {
  const a = recordRun(EMPTY_HISTORY, { at: "2026-11-01", outcome: "ok", got: [], missed: [] }, "Fake");
  assert.equal(a.report.alert, null);
  const b = recordRun(a.history, { at: "2026-12-01", outcome: "ok", got: [], missed: [] }, "Fake");
  assert.match(b.report.alert ?? "", /found no documents on two runs in a row/);
  // Documents already saved count as found.
  const c = recordRun(EMPTY_HISTORY, { at: "2026-11-01", outcome: "ok", got: [ren], missed: [] }, "Fake");
  const d = recordRun(c.history, { at: "2026-12-01", outcome: "ok", got: [ren], missed: [] }, "Fake");
  assert.equal(d.report.alert, null);
});

test("a failed sign-in is said plainly, and more strongly the second time", () => {
  const a = recordRun(EMPTY_HISTORY, { at: "2026-11-01", outcome: "signin_failed", got: [], missed: [] }, "Fake");
  assert.match(a.report.alert ?? "", /^Fake: sign-in failed\. If the next run fails too/);
  const b = recordRun(a.history, { at: "2026-12-01", outcome: "signin_failed", got: [], missed: [] }, "Fake");
  assert.match(b.report.alert ?? "", /sign-in failed on the last two runs/);
  assert.match(describeHealth(b.report)[0], /^ALERT: /);
});

test("a failed run keeps the missing list as it was, and the record keeps the last ten runs", () => {
  const first = recordRun(EMPTY_HISTORY, { at: "2026-11-01", outcome: "ok", got: [ren], missed: [end] }, "Fake");
  const failed = recordRun(first.history, { at: "2026-11-02", outcome: "error", got: [], missed: [] }, "Fake");
  assert.deepEqual(failed.history.missing, first.history.missing);
  let h = EMPTY_HISTORY;
  for (let i = 0; i < 14; i++) h = recordRun(h, { at: `2026-11-${10 + i}`, outcome: "ok", got: [ren], missed: [] }, "Fake").history;
  assert.equal(h.runs.length, 10);
});

test("a stored value of the wrong shape is read as an empty record", () => {
  assert.deepEqual(asHistory(null), EMPTY_HISTORY);
  assert.deepEqual(asHistory({ runs: "x", missing: [null] }), EMPTY_HISTORY);
});
