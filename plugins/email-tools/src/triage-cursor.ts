/**
 * The triage routine's "how far did I get last time" cursor.
 *
 * This used to be a `last-run:` line of prose inside a Markdown document on a
 * rules-home issue, which meant the agent re-derived the lookback window from
 * an English description on every run. It now lives in plugin state, and the
 * two decisions that used to be prose (how far to overlap, what to do with no
 * cursor) are made here so they are the same every time and can be tested.
 *
 * Kept free of I/O: the worker supplies the stored value and the clock.
 */

/**
 * Separate from the poll loop's `imap` namespace on purpose. Those keys are
 * instance-scoped IMAP UID cursors owned by the poll loop and the triage-folder
 * learner; this is a company-scoped wall-clock timestamp owned by the triage
 * routine. Sharing a namespace would let one overwrite the other.
 */
export const TRIAGE_STATE_NAMESPACE = "triage";

/** No cursor means we have no idea how far back to look, so look back a day. */
export const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * Rewind slightly from the stored cursor. Mail can be delivered with a
 * timestamp fractionally before the moment the previous run recorded, so
 * starting exactly at the cursor can skip a message that arrived mid-run.
 */
export const OVERLAP_MINUTES = 5;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

export interface TriageCursorScope {
  scopeKind: "company";
  scopeId: string;
  namespace: string;
  stateKey: string;
}

/**
 * Per company and per mailbox, matching how sender rules are scoped.
 *
 * Company rather than routine: the skill also runs ad-hoc ("triage my inbox")
 * with no routine to key on, and two routines pointed at the same mailbox
 * should share one cursor instead of each processing what the other already
 * did.
 */
export function triageCursorScope(companyId: string, mailboxKey: string): TriageCursorScope {
  return {
    scopeKind: "company",
    scopeId: companyId,
    namespace: TRIAGE_STATE_NAMESPACE,
    stateKey: `${mailboxKey}:last-run`,
  };
}

/**
 * Read whatever is in the state row back into an ISO timestamp.
 *
 * Tolerates a bare string as well as the `{ lastRunAt }` shape this module
 * writes, so a hand-seeded value does not silently read as "no cursor" and
 * quietly widen the window to 24 hours.
 */
export function parseStoredCursor(raw: unknown): string | null {
  const candidate =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "lastRunAt" in raw
        ? (raw as { lastRunAt: unknown }).lastRunAt
        : null;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

export interface ResolvedSince {
  /** ISO timestamp the search should start from. */
  since: string;
  /** Whether that came from a stored cursor or the fallback window. */
  source: "cursor" | "fallback";
}

/**
 * Turn a stored cursor into the timestamp to search from.
 *
 * A cursor dated in the future (clock skew, or a hand-seeded mistake) would
 * otherwise produce a `since` after `now` and match nothing at all, silently
 * reporting a clean inbox. Clamp to `now` so the worst case is finding nothing
 * new rather than skipping real mail.
 */
export function resolveSince(storedIso: string | null, now: Date): ResolvedSince {
  const cursor = parseStoredCursor(storedIso);
  if (!cursor) {
    return {
      since: new Date(now.getTime() - DEFAULT_LOOKBACK_HOURS * MS_PER_HOUR).toISOString(),
      source: "fallback",
    };
  }
  const withOverlap = Date.parse(cursor) - OVERLAP_MINUTES * MS_PER_MINUTE;
  return {
    since: new Date(Math.min(withOverlap, now.getTime())).toISOString(),
    source: "cursor",
  };
}

export interface CursorAdvance {
  ok: boolean;
  /** The value that should be stored, when `ok`. */
  lastRunAt?: string;
  /** Why the write was refused, when not `ok`. */
  reason?: string;
}

/**
 * Decide whether a proposed cursor write should land.
 *
 * Refusing to move backwards matters because a retried or slow run finishing
 * after a newer one would otherwise rewind the cursor and make the next run
 * reprocess everything in between. `force` exists for the deliberate reseed.
 */
export function planCursorAdvance(
  storedIso: string | null,
  proposedIso: string,
  opts: { force?: boolean } = {},
): CursorAdvance {
  const proposed = parseStoredCursor(proposedIso);
  if (!proposed) return { ok: false, reason: `Unparseable timestamp: ${proposedIso}` };
  if (opts.force) return { ok: true, lastRunAt: proposed };

  const current = parseStoredCursor(storedIso);
  if (current && Date.parse(proposed) < Date.parse(current)) {
    return {
      ok: false,
      reason: `Refusing to move the cursor backwards (stored ${current}, proposed ${proposed}). Pass force to override.`,
    };
  }
  return { ok: true, lastRunAt: proposed };
}
