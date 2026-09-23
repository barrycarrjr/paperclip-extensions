/**
 * The decisions around a send that are not IMAP mechanics: how long a send may
 * take before it must not start, how long its follow-ups are waited for, which
 * follow-up outcomes deserve a warning, and what a forward must name.
 *
 * Kept apart from worker.ts, where the handlers live inside setup() and cannot
 * be called from a test, so each decision here can be pinned by one.
 */
import { FORWARDED_FLAG } from "./imap.js";
import type { MarkOutcome, MarkTarget, SentCopyOutcome } from "./sent-copy.js";

/**
 * The host abandons a plugin call at 30 seconds and tells the caller it
 * failed, even when this call has already sent its mail. The Email pages keep
 * a failed send open for another try and agents retry, so a call that overran
 * after sending would turn into the same message sent twice. Both limits below
 * keep a send inside that window.
 */
export const HOST_CALL_LIMIT_MS = 30_000;

/** How long after a call began its follow-ups may still be waited for. */
export const FOLLOW_UP_DEADLINE_MS = 20_000;

/**
 * After this long, a call that has not yet started SMTP gives up without
 * sending. Five seconds is too little to count on for SMTP and the trip back,
 * and refusing before anything is sent makes the resulting "failed" true. The
 * usual way to get here is a slow start: the mailbox's one shared connection
 * busy or stalled (a reply fetches its original over it), or a slow sign-in.
 */
export const SEND_START_DEADLINE_MS = 25_000;

/** Milliseconds left to wait for follow-ups; zero or less means do not wait. */
export function followUpBudget(startedAt: number, now: number): number {
  return FOLLOW_UP_DEADLINE_MS - (now - startedAt);
}

/** Throws, before anything is sent, when too little of the call is left to send in. */
export function assertTimeToSend(startedAt: number, now: number): void {
  const spent = now - startedAt;
  if (spent > SEND_START_DEADLINE_MS) {
    throw new Error(
      `[ESEND_TOO_LATE] Nothing was sent: the mailbox took ${Math.round(spent / 1000)} seconds to get ready, ` +
        `too close to the ${HOST_CALL_LIMIT_MS / 1000} second limit to send safely. Try again.`,
    );
  }
}

/** A copy known to be missing, rather than saved or still on its way. */
export function copyMissing(c: SentCopyOutcome | undefined): c is SentCopyOutcome {
  return !!c && !c.ok && !c.pending;
}

/**
 * A mark that should have been set and was not. Excluded: one still on its
 * way; a server that can never keep the flag (a fixed fact that Test
 * connection reports, not news on every send); and an original an agent's
 * email_send only named by Message-ID that is not in the watched folder, where
 * it was never asked to be marked and is often filed elsewhere.
 */
export function markMissing(o: MarkOutcome | undefined): o is MarkOutcome {
  if (!o || o.ok || o.pending || o.unsupported) return false;
  return !(o.notFound && o.uid === undefined);
}

export type ForwardParse = { ok: true; target?: MarkTarget } | { ok: false; error: string };

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * `email.send-new`'s `forwardOf`: `{ uid, folder, messageId? }`, or absent.
 * The folder is required because a UID only names a message within its own
 * folder; defaulting it would mark whatever message holds that number in the
 * inbox. The Message-ID, when given, is checked before anything is marked.
 */
export function parseBridgeForwardOf(value: unknown): ForwardParse {
  if (value === undefined || value === null) return { ok: true };
  const v = value as { uid?: unknown; folder?: unknown; messageId?: unknown };
  const folder = text(v.folder);
  if (typeof value !== "object" || !Number.isInteger(v.uid) || !folder) {
    return { ok: false, error: "forwardOf must be { uid, folder, messageId? } naming the message being forwarded" };
  }
  return {
    ok: true,
    target: { folder, uid: v.uid as number, messageId: text(v.messageId), flag: FORWARDED_FLAG },
  };
}

/**
 * `email_send`'s `forward_of_uid`, `forward_of_folder` and optional
 * `forward_of_message_id`, under the same rule, with the same Message-ID check
 * the Email pages' forwards get.
 */
export function parseToolForwardOf(uid: unknown, folder: unknown, messageId?: unknown): ForwardParse {
  if (uid === undefined || uid === null) return { ok: true };
  if (!Number.isInteger(uid)) return { ok: false, error: "forward_of_uid must be a message UID (a whole number)" };
  const where = text(folder);
  if (!where) {
    return {
      ok: false,
      error: "forward_of_folder is required with forward_of_uid: pass the folder the message was found in",
    };
  }
  return {
    ok: true,
    target: { folder: where, uid: uid as number, messageId: text(messageId), flag: FORWARDED_FLAG },
  };
}
