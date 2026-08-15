/**
 * Tests for per-mailbox mutual exclusion.
 *
 * These exist to settle a question raised by the IDLE poll storm: were the
 * duplicate polls running concurrently (a broken lock) or queued behind each
 * other (a working lock with nothing collapsing the duplicates)? The answers
 * below say the lock is sound, which is why the fix went into the coalescer
 * rather than here.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isMailboxLocked, withMailboxLock } from "./mailbox-lock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("holders of the same key never overlap", async () => {
  let active = 0;
  let maxActive = 0;

  await Promise.all(
    Array.from({ length: 15 }, () =>
      withMailboxLock("personal", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(2);
        active -= 1;
      }),
    ),
  );

  assert.equal(maxActive, 1, "exactly one holder at a time");
  assert.equal(active, 0);
});

test("every queued caller runs; the lock serializes, it does not deduplicate", async () => {
  const order: number[] = [];

  await Promise.all(
    Array.from({ length: 15 }, (_unused, i) =>
      withMailboxLock("personal", async () => {
        await sleep(1);
        order.push(i);
      }),
    ),
  );

  assert.equal(order.length, 15, "all 15 callers ran, none were collapsed");
});

test("different keys run in parallel", async () => {
  let active = 0;
  let maxActive = 0;
  const body = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active -= 1;
  };

  await Promise.all([
    withMailboxLock("personal", body),
    withMailboxLock("shared-inbox", body),
    withMailboxLock("ib-barry", body),
  ]);

  assert.equal(maxActive, 3);
});

test("a thrown error releases the lock", async () => {
  await assert.rejects(
    () =>
      withMailboxLock("personal", async () => {
        throw new Error("Socket timeout");
      }),
    /Socket timeout/,
  );

  assert.equal(isMailboxLocked("personal"), false);

  let ran = false;
  await withMailboxLock("personal", async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("the lock is released before the caller's promise settles", async () => {
  await withMailboxLock("personal", async () => {
    assert.equal(isMailboxLocked("personal"), true, "held while the body runs");
  });
  assert.equal(isMailboxLocked("personal"), false);
});
