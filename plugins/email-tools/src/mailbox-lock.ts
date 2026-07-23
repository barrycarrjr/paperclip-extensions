/**
 * Per-mailbox mutual exclusion for IMAP work.
 *
 * Two operations on the same mailbox must not interleave: a poll that is
 * moving auto-triaged mail out of INBOX and a rule sweep working the same
 * folder would fight over UIDs. Callers hold this lock for the whole
 * operation, keyed by mailbox (plus a suffix when a mailbox has independent
 * workstreams, e.g. `"personal:apply-rule"`).
 *
 * How the wait loop is safe: when the holder releases, every waiter's `await`
 * resolves, but each waiter then runs from the top of the loop through
 * `set(key, lock)` without an intervening `await`. JavaScript runs that stretch
 * to completion before another waiter's continuation is scheduled, so exactly
 * one waiter claims the lock and the rest see it held and wait again.
 *
 * Note what this does *not* do: it serializes, it does not deduplicate. Ten
 * callers queue as ten sequential runs. Collapsing repeat work is the job of
 * {@link ./poll-coalescer.js | PollCoalescer}, which is why IDLE notifications
 * go through that before they ever reach this lock.
 */

const mailboxLocks = new Map<string, Promise<void>>();

export async function withMailboxLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (mailboxLocks.has(key)) {
    await mailboxLocks.get(key);
  }
  let release: () => void = () => {};
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  mailboxLocks.set(key, lock);
  try {
    return await fn();
  } finally {
    mailboxLocks.delete(key);
    release();
  }
}

/** True while `key` is held. Diagnostics and test helper. */
export function isMailboxLocked(key: string): boolean {
  return mailboxLocks.has(key);
}
