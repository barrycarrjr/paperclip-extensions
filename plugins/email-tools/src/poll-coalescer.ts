/**
 * Collapses a burst of IMAP IDLE notifications into a single poll per mailbox.
 *
 * The server sends an `exists` or `expunge` notification per affected message,
 * and a poll that auto-triages mail generates more of them by moving messages
 * out of the folder. Firing a poll per notification meant one delivery could
 * queue a dozen identical polls, each opening its own connection and asking the
 * host to resolve the mailbox password again. Observed on a live install: about
 * fifteen polls for the same mailbox inside a single millisecond.
 *
 * The contract:
 *
 * - Notifications arriving inside the debounce window produce **one** poll.
 * - Notifications arriving while a poll is running produce **one** follow-up
 *   poll, no matter how many arrive, so nothing is missed but nothing piles up.
 * - Polls for the same mailbox never overlap.
 * - Different mailboxes are independent.
 */

/** Quiet period after a notification before the coalesced poll runs. */
export const IDLE_POLL_DEBOUNCE_MS = 1_500;

interface MailboxState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** A notification arrived while the poll was in flight. */
  again: boolean;
}

export interface PollCoalescerOptions {
  /** Work to perform for a mailbox. Rejections are reported, never thrown. */
  run: (mailboxKey: string) => Promise<unknown>;
  /** Debounce window. Defaults to {@link IDLE_POLL_DEBOUNCE_MS}. */
  debounceMs?: number;
  /** Called when `run` rejects. */
  onError?: (mailboxKey: string, err: unknown) => void;
}

export class PollCoalescer {
  private readonly run: (mailboxKey: string) => Promise<unknown>;
  private readonly debounceMs: number;
  private readonly onError: (mailboxKey: string, err: unknown) => void;
  private states = new Map<string, MailboxState>();
  private idleWaiters: Array<() => void> = [];

  constructor(options: PollCoalescerOptions) {
    this.run = options.run;
    this.debounceMs = options.debounceMs ?? IDLE_POLL_DEBOUNCE_MS;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Register a notification for `mailboxKey`. Cheap and synchronous: callers
   * fire this from an event handler and never await it.
   */
  schedule(mailboxKey: string): void {
    const state = this.stateFor(mailboxKey);

    // A poll is already queued and will cover this notification too.
    if (state.timer !== null) return;

    // A poll is in flight. Whatever this notification is about may have
    // arrived after that poll read the folder, so ask for exactly one more.
    if (state.running) {
      state.again = true;
      return;
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.execute(mailboxKey, state);
    }, this.debounceMs);

    // Don't hold the worker process open just for a pending poll.
    state.timer.unref?.();
  }

  /** Drop any pending poll for one mailbox. In-flight work is left to finish. */
  cancel(mailboxKey: string): void {
    const state = this.states.get(mailboxKey);
    if (!state) return;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.again = false;
    this.settleIfIdle();
  }

  /** Drop every pending poll. Called on shutdown. */
  cancelAll(): void {
    for (const key of Array.from(this.states.keys())) this.cancel(key);
  }

  /** True while any mailbox has a poll queued or running. */
  get busy(): boolean {
    for (const state of this.states.values()) {
      if (state.timer !== null || state.running) return true;
    }
    return false;
  }

  /**
   * Resolves once nothing is queued or running. Test helper, and a way for
   * shutdown to let an in-flight poll finish.
   */
  whenIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private stateFor(mailboxKey: string): MailboxState {
    let state = this.states.get(mailboxKey);
    if (!state) {
      state = { timer: null, running: false, again: false };
      this.states.set(mailboxKey, state);
    }
    return state;
  }

  private async execute(mailboxKey: string, state: MailboxState): Promise<void> {
    state.running = true;
    try {
      await this.run(mailboxKey);
    } catch (err) {
      this.onError(mailboxKey, err);
    } finally {
      state.running = false;
    }

    if (state.again) {
      state.again = false;
      this.schedule(mailboxKey);
      return;
    }
    this.settleIfIdle();
  }

  private settleIfIdle(): void {
    if (this.busy) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
