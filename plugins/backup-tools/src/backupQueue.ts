/**
 * One backup at a time, whatever started it.
 *
 * The host makes one instance snapshot at a time and refuses a second while
 * one is in flight. A scheduled backup that came due while Run now's backup
 * was snapshotting (or the other way round) failed at once, so every backup
 * waits its turn here, and Run now hands back the backup already running.
 *
 * Every turn has a deadline, the maxRunMinutes setting. A backup still going
 * when it passes is given up on: it is recorded as failed and the next backup
 * may start. Its work is not stopped, but it no longer holds anything up.
 */

/** Largest delay a Node timer accepts. Anything longer fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export type BackupTurnHooks = {
  /** Call once the backup's row exists and is marked running. */
  started(backupId: string): void;
  /**
   * Call before recording how the backup ended. Exactly one caller gets true:
   * the backup itself or its deadline, whichever asks first.
   */
  claimOutcome(): boolean;
};

export type BackupRequest = {
  /** Destinations the backup uploads to. */
  destinationIds: string[];
  /** How long the backup may hold its turn. */
  deadlineMs: number;
  run(hooks: BackupTurnHooks): Promise<unknown>;
  /**
   * Record as failed a backup that was given up on, or that stopped without
   * recording how it ended. `claimed` is false when the backup had claimed
   * its outcome but never finished writing it: only its row is left to close.
   */
  giveUp(backupId: string, reason: string, claimed: boolean): Promise<void>;
  report(message: string, err: unknown): void;
};

export type BackupTurn = {
  destinationIds: string[];
  /** Settles with the backup id once its row exists. */
  started: Promise<string>;
  /** Settles when the turn is over: the backup ended, or was given up on. */
  finished: Promise<void>;
};

export type BackupQueue = {
  /** The backup whose turn it is, if any. */
  current(): BackupTurn | null;
  /** Queue a backup behind every backup already queued. */
  enqueue(request: BackupRequest): BackupTurn;
};

export function createBackupQueue(): BackupQueue {
  /** In order: the first holds the turn, the rest wait for it. */
  const turns: BackupTurn[] = [];
  let tail: Promise<void> = Promise.resolve();

  function takeTurn(
    turn: BackupTurn,
    request: BackupRequest,
    resolveStarted: (backupId: string) => void,
    rejectStarted: (err: unknown) => void,
  ): Promise<void> {
    return new Promise<void>((endTurn) => {
      let backupId: string | null = null;
      let claimed = false;
      let over = false;
      const claimOutcome = () => {
        if (claimed) return false;
        claimed = true;
        return true;
      };
      const end = () => {
        if (over) return;
        over = true;
        const index = turns.indexOf(turn);
        if (index >= 0) turns.splice(index, 1);
        endTurn();
      };
      // With no row yet there is nothing to record. A backup that gets as far
      // as writing one later still records its own ending.
      const giveUp = (reason: string) =>
        backupId === null ? Promise.resolve() : request.giveUp(backupId, reason, claimOutcome());

      const deadline = setTimeout(() => {
        end();
        const reason = `[EBACKUP_TIMED_OUT] still running after ${request.deadlineMs / 60_000} minutes (maxRunMinutes)`;
        rejectStarted(new Error(reason));
        giveUp(reason).catch((err: unknown) => request.report("could not record a backup that ran out of time", err));
      }, Math.min(request.deadlineMs, MAX_TIMER_MS));
      // The worker stays up without it. Holding the process open would only
      // keep a finished test run waiting on a backup it left behind.
      deadline.unref();

      let work: Promise<unknown>;
      try {
        work = request.run({
          started(id) {
            backupId = id;
            resolveStarted(id);
          },
          claimOutcome,
        });
      } catch (err) {
        work = Promise.reject(err);
      }
      work.then(
        () => {
          clearTimeout(deadline);
          end();
        },
        (err: unknown) => {
          request.report("backup failed", err);
          rejectStarted(err);
          end();
          if (backupId === null) {
            clearTimeout(deadline);
            return;
          }
          // It stopped without recording how it ended. Close its row now; if
          // that fails as well, the deadline tries again.
          giveUp(err instanceof Error ? err.message : String(err)).then(
            () => clearTimeout(deadline),
            (closeErr: unknown) => request.report("could not record a failed backup", closeErr),
          );
        },
      );
    });
  }

  return {
    current: () => turns[0] ?? null,
    enqueue(request) {
      let resolveStarted!: (backupId: string) => void;
      let rejectStarted!: (err: unknown) => void;
      const started = new Promise<string>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      // A scheduled backup has nobody waiting on this, so a failure before
      // its row exists must not surface as an unhandled rejection.
      started.catch(() => {});
      const turn: BackupTurn = { destinationIds: request.destinationIds, started, finished: Promise.resolve() };
      turn.finished = tail.then(() => takeTurn(turn, request, resolveStarted, rejectStarted));
      tail = turn.finished;
      turns.push(turn);
      return turn;
    },
  };
}
