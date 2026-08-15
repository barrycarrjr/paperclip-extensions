/**
 * Tests for IDLE notification collapsing.
 *
 * The bug these guard: a single mail delivery produced one poll per IMAP
 * notification, and a poll that moved auto-triaged mail produced more
 * notifications. A live install logged about fifteen polls for one mailbox
 * inside a single millisecond, each one asking the host to resolve the mailbox
 * password again.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PollCoalescer } from "./poll-coalescer.js";

const TEST_DEBOUNCE_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the coalescer to go quiet, then keep waiting well past the debounce
 * window and check again. Plain `whenIdle()` is not enough on its own: a broken
 * implementation can leave stray timers it no longer tracks, go briefly idle,
 * and fire them a moment later. The extra pass catches that.
 */
async function settle(coalescer: PollCoalescer): Promise<void> {
  await coalescer.whenIdle();
  await sleep(TEST_DEBOUNCE_MS * 6);
  await coalescer.whenIdle();
}

test("a burst of notifications produces exactly one poll", async () => {
  const runs: string[] = [];
  const coalescer = new PollCoalescer({
    debounceMs: TEST_DEBOUNCE_MS,
    run: async (key) => {
      runs.push(key);
    },
  });

  for (let i = 0; i < 15; i++) coalescer.schedule("personal");
  await settle(coalescer);

  assert.deepEqual(runs, ["personal"]);
});

test("notifications arriving during a poll produce exactly one follow-up", async () => {
  const runs: string[] = [];
  let releaseFirst: () => void = () => {};
  let signalStarted: () => void = () => {};
  const firstRunStarted = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  const coalescer = new PollCoalescer({
    debounceMs: TEST_DEBOUNCE_MS,
    run: async (key) => {
      runs.push(key);
      if (runs.length === 1) {
        signalStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
  });

  coalescer.schedule("personal");
  await firstRunStarted;
  // Ten more notifications land while the first poll is still running. This is
  // the auto-triage feedback case: the poll's own moves generate expunges.
  for (let i = 0; i < 10; i++) coalescer.schedule("personal");
  releaseFirst();
  await settle(coalescer);

  assert.equal(runs.length, 2, "one in-flight poll plus a single follow-up");
});

test("polls for the same mailbox never overlap", async () => {
  let active = 0;
  let maxActive = 0;
  const coalescer = new PollCoalescer({
    debounceMs: TEST_DEBOUNCE_MS,
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active -= 1;
    },
  });

  coalescer.schedule("personal");
  await sleep(TEST_DEBOUNCE_MS + 1);
  for (let i = 0; i < 5; i++) coalescer.schedule("personal");
  await settle(coalescer);

  assert.equal(maxActive, 1);
});

test("mailboxes are scheduled independently", async () => {
  const runs: string[] = [];
  const coalescer = new PollCoalescer({
    debounceMs: TEST_DEBOUNCE_MS,
    run: async (key) => {
      runs.push(key);
    },
  });

  coalescer.schedule("personal");
  coalescer.schedule("shared-inbox");
  coalescer.schedule("personal");
  coalescer.schedule("shared-inbox");
  await settle(coalescer);

  assert.equal(runs.length, 2);
  assert.deepEqual([...runs].sort(), ["personal", "shared-inbox"]);
});

test("a failing poll is reported and does not wedge the mailbox", async () => {
  const errors: string[] = [];
  let attempts = 0;
  const coalescer = new PollCoalescer({
    debounceMs: TEST_DEBOUNCE_MS,
    run: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Socket timeout");
    },
    onError: (key, err) => {
      errors.push(`${key}: ${(err as Error).message}`);
    },
  });

  coalescer.schedule("personal");
  await settle(coalescer);
  coalescer.schedule("personal");
  await settle(coalescer);

  assert.deepEqual(errors, ["personal: Socket timeout"]);
  assert.equal(attempts, 2, "the next notification still polls");
});

test("cancel drops a pending poll", async () => {
  let runs = 0;
  const coalescer = new PollCoalescer({
    debounceMs: TEST_DEBOUNCE_MS,
    run: async () => {
      runs += 1;
    },
  });

  coalescer.schedule("personal");
  coalescer.cancel("personal");
  await sleep(TEST_DEBOUNCE_MS * 3);

  assert.equal(runs, 0);
  assert.equal(coalescer.busy, false);
});
