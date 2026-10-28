/**
 * Tests for email snooze bookkeeping: the wake time must be sane, a snooze is
 * due only once its time has come, a snooze that keeps failing stops being
 * retried every minute but stays visible, and one company never sees another's.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { openPluginDb } from "./pglite-db.js";
import {
  MAX_WAKE_ATTEMPTS,
  SNOOZE_FOLDER,
  deleteSnooze,
  dueSnoozes,
  getSnooze,
  listSnoozes,
  recordSnooze,
  recordWakeFailure,
  resolveWakeAt,
} from "./snooze.js";

const NOW = new Date("2026-10-28T12:00:00Z");
const CO_A = "11111111-1111-4111-8111-111111111111";
const CO_B = "22222222-2222-4222-8222-222222222222";

const base = (wakeAt: Date, over: Record<string, unknown> = {}) => ({
  companyId: CO_A,
  mailbox: "personal",
  folder: "INBOX",
  snoozeUid: 7,
  messageId: "<a@x>",
  subject: "Hello",
  sender: "a@x",
  wakeAt,
  ...over,
});

test("resolveWakeAt accepts a timestamp or minutes and rejects silly times", () => {
  assert.equal(resolveWakeAt({ minutes: 180 }, NOW).toISOString(), "2026-10-28T15:00:00.000Z");
  assert.equal(resolveWakeAt({ until: "2026-10-29T08:00:00Z" }, NOW).toISOString(), "2026-10-29T08:00:00.000Z");
  assert.throws(() => resolveWakeAt({}, NOW), /required/);
  assert.throws(() => resolveWakeAt({ until: "nonsense" }, NOW), /ISO/);
  assert.throws(() => resolveWakeAt({ minutes: 0 }, NOW), /at least a minute/);
  assert.throws(() => resolveWakeAt({ until: "2026-10-28T11:00:00Z" }, NOW), /at least a minute/);
  assert.throws(() => resolveWakeAt({ minutes: 60 * 24 * 400 }, NOW), /within a year/);
});

test("a snooze is due only once its time has come", async () => {
  const { db } = await openPluginDb();
  await recordSnooze(db, base(new Date("2026-10-28T13:00:00Z")));
  assert.equal((await dueSnoozes(db, NOW)).length, 0);
  const due = await dueSnoozes(db, new Date("2026-10-28T13:00:01Z"));
  assert.equal(due.length, 1);
  assert.equal(due[0]!.snooze_folder, SNOOZE_FOLDER);
  assert.equal(due[0]!.snooze_uid, 7);
});

test("due snoozes come oldest first", async () => {
  const { db } = await openPluginDb();
  await recordSnooze(db, base(new Date("2026-10-28T11:30:00Z"), { snoozeUid: 2 }));
  await recordSnooze(db, base(new Date("2026-10-28T11:00:00Z"), { snoozeUid: 1 }));
  assert.deepEqual((await dueSnoozes(db, NOW)).map((r) => r.snooze_uid), [1, 2]);
});

test("a snooze that keeps failing stops being retried but is still listed", async () => {
  const { db } = await openPluginDb();
  await recordSnooze(db, base(new Date("2026-10-28T11:00:00Z")));
  const [row] = await dueSnoozes(db, NOW);
  for (let i = 0; i < MAX_WAKE_ATTEMPTS; i++) await recordWakeFailure(db, row!.id, "imap down");
  assert.equal((await dueSnoozes(db, NOW)).length, 0);
  const listed = await listSnoozes(db, CO_A, "personal");
  assert.equal(listed[0]!.last_error, "imap down");
  assert.equal(listed[0]!.attempts, MAX_WAKE_ATTEMPTS);
});

test("deleting a snooze removes it, and other companies cannot see or fetch it", async () => {
  const { db } = await openPluginDb();
  await recordSnooze(db, base(new Date("2026-10-28T11:00:00Z")));
  const [row] = await listSnoozes(db, CO_A, "PERSONAL");
  assert.ok(row, "mailbox key matches case-insensitively");
  assert.equal((await listSnoozes(db, CO_B, "personal")).length, 0);
  assert.equal(await getSnooze(db, CO_B, row!.id), null);
  await deleteSnooze(db, row!.id);
  assert.equal((await listSnoozes(db, CO_A, "personal")).length, 0);
});
