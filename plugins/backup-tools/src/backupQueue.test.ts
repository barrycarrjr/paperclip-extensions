/**
 * The backup queue: one backup at a time, and a deadline that gives up on a
 * backup that runs too long instead of waiting for it.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createBackupQueue, type BackupRequest, type BackupTurnHooks } from "./backupQueue.js";

type GivenUp = { backupId: string; reason: string; claimed: boolean };

/** A backup the test drives by hand. */
function handDriven(overrides: Partial<BackupRequest> = {}) {
  let hooks: BackupTurnHooks | null = null;
  let finish: () => void = () => {};
  let fail: (err: unknown) => void = () => {};
  const givenUp: GivenUp[] = [];
  const request: BackupRequest = {
    destinationIds: ["local-1"],
    deadlineMs: 60_000,
    run(turnHooks) {
      hooks = turnHooks;
      return new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    async giveUp(backupId, reason, claimed) {
      givenUp.push({ backupId, reason, claimed });
    },
    report() {},
    ...overrides,
  };
  return {
    request,
    givenUp,
    hasRun: () => hooks !== null,
    hooks: () => {
      assert.ok(hooks, "the backup has not been started");
      return hooks;
    },
    finish: () => finish(),
    fail: (err: unknown) => fail(err),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a backup waits until the one ahead of it has finished", { timeout: 5_000 }, async () => {
  const queue = createBackupQueue();
  const first = handDriven();
  const second = handDriven();
  const firstTurn = queue.enqueue(first.request);
  const secondTurn = queue.enqueue(second.request);
  await settle();

  assert.equal(first.hasRun(), true);
  assert.equal(second.hasRun(), false);
  assert.equal(queue.current(), firstTurn);

  first.hooks().started("first");
  assert.equal(await firstTurn.started, "first");
  first.finish();
  await firstTurn.finished;
  await settle();

  assert.equal(second.hasRun(), true);
  assert.equal(queue.current(), secondTurn);
  second.hooks().started("second");
  second.finish();
  await secondTurn.finished;
  assert.equal(queue.current(), null);
});

test("the deadline gives up on a backup that runs too long and lets the next one start", { timeout: 5_000 }, async () => {
  const queue = createBackupQueue();
  const stuck = handDriven({ deadlineMs: 30 });
  const next = handDriven();
  const stuckTurn = queue.enqueue(stuck.request);
  const nextTurn = queue.enqueue(next.request);
  await settle();
  stuck.hooks().started("stuck");

  await stuckTurn.finished;
  assert.equal(stuck.givenUp.length, 1);
  assert.equal(stuck.givenUp[0].backupId, "stuck");
  assert.equal(stuck.givenUp[0].claimed, true);
  assert.match(stuck.givenUp[0].reason, /EBACKUP_TIMED_OUT/);
  await settle();
  assert.equal(next.hasRun(), true);

  // The stuck backup carries on, but may no longer record how it ended.
  assert.equal(stuck.hooks().claimOutcome(), false);
  stuck.finish();
  next.hooks().started("next");
  next.finish();
  await nextTurn.finished;
});

test("a backup already recording its ending when the deadline passes only has its row closed", { timeout: 5_000 }, async () => {
  const queue = createBackupQueue();
  const slow = handDriven({ deadlineMs: 30 });
  const turn = queue.enqueue(slow.request);
  await settle();
  slow.hooks().started("slow");
  assert.equal(slow.hooks().claimOutcome(), true);

  await turn.finished;
  assert.deepEqual(
    slow.givenUp.map((g) => [g.backupId, g.claimed]),
    [["slow", false]],
  );
  slow.finish();
});

test("a backup that fails without recording its ending has its row closed at once", { timeout: 5_000 }, async () => {
  const queue = createBackupQueue();
  const broken = handDriven();
  const turn = queue.enqueue(broken.request);
  await settle();
  broken.hooks().started("broken");
  // It got as far as recording its failure, and that write failed.
  broken.hooks().claimOutcome();
  broken.fail(new Error("database went away"));

  await turn.finished;
  await settle();
  assert.deepEqual(broken.givenUp, [{ backupId: "broken", reason: "database went away", claimed: false }]);
  assert.equal(queue.current(), null);
});

test("when closing that row fails as well, the deadline tries again", { timeout: 5_000 }, async () => {
  const queue = createBackupQueue();
  const closed: GivenUp[] = [];
  let attempts = 0;
  const broken = handDriven({
    deadlineMs: 40,
    async giveUp(backupId, reason, claimed) {
      attempts += 1;
      if (attempts === 1) throw new Error("still down");
      closed.push({ backupId, reason, claimed });
    },
  });
  const turn = queue.enqueue(broken.request);
  await settle();
  broken.hooks().started("broken");
  broken.hooks().claimOutcome();
  broken.fail(new Error("database went away"));
  await turn.finished;

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(attempts, 2);
  assert.deepEqual(closed.map((g) => [g.backupId, g.claimed]), [["broken", false]]);
  assert.match(closed[0].reason, /EBACKUP_TIMED_OUT/);
});

test("a backup that fails before its row exists tells its caller why and frees the turn", { timeout: 5_000 }, async () => {
  const queue = createBackupQueue();
  const early = handDriven();
  const turn = queue.enqueue(early.request);
  await settle();
  early.fail(new Error("[EBACKUP_NO_PASSPHRASE] too short"));

  await assert.rejects(turn.started, /EBACKUP_NO_PASSPHRASE/);
  await turn.finished;
  assert.deepEqual(early.givenUp, []);
  assert.equal(queue.current(), null);
});

test("a backup with no row by its deadline tells its caller it ran out of time", { timeout: 5_000 }, async () => {
  const queue = createBackupQueue();
  const stalled = handDriven({ deadlineMs: 30 });
  const turn = queue.enqueue(stalled.request);

  await assert.rejects(turn.started, /EBACKUP_TIMED_OUT/);
  await turn.finished;
  assert.deepEqual(stalled.givenUp, []);
  assert.equal(queue.current(), null);
  stalled.finish();
});
