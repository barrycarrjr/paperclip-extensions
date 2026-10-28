/**
 * Email snooze: hide a message for a while, then bring it back unread.
 *
 * The message is moved to SNOOZE_FOLDER on the server and a row here remembers
 * when to return it. This file holds the bookkeeping and the wake-time rules;
 * the IMAP moves live in worker.ts. Every write is a single statement because
 * the host offers no transactions.
 */
import type { ReviewQueueDb } from "./review-queue.js";

export const SNOOZE_FOLDER = "_paperclip/snoozed";

const SNOOZES = "plugin_email_tools_7cbee3fdf3.email_snoozes";

/** A snooze shorter than this is a mistake; the wake job runs once a minute. */
export const MIN_SNOOZE_MS = 60_000;
/** Longer than a year is almost certainly a typo in a timestamp. */
export const MAX_SNOOZE_MS = 365 * 86_400_000;
/** After this many failed wake attempts the row stays but is no longer retried every minute. */
export const MAX_WAKE_ATTEMPTS = 5;

export interface SnoozeRow {
  id: string;
  company_id: string;
  mailbox_key: string;
  folder: string;
  snooze_folder: string;
  snooze_uid: number;
  message_id: string | null;
  subject: string | null;
  sender: string | null;
  wake_at: string;
  attempts: number;
  last_error: string | null;
}

/**
 * When to wake the message. `until` is an ISO timestamp (the Email view works
 * out "tomorrow morning" in the operator's own timezone, which the server does
 * not know); `minutes` is the same thing for agents. Throws a plain message the
 * operator can read.
 */
export function resolveWakeAt(
  input: { until?: unknown; minutes?: unknown },
  now: Date = new Date(),
): Date {
  let at: Date;
  if (typeof input.until === "string" && input.until.trim()) {
    at = new Date(input.until);
    if (Number.isNaN(at.getTime())) throw new Error("until must be an ISO timestamp");
  } else if (typeof input.minutes === "number" && Number.isFinite(input.minutes)) {
    at = new Date(now.getTime() + input.minutes * 60_000);
  } else {
    throw new Error("until (an ISO timestamp) or minutes is required");
  }
  const ms = at.getTime() - now.getTime();
  if (ms < MIN_SNOOZE_MS) throw new Error("Snooze time must be at least a minute from now");
  if (ms > MAX_SNOOZE_MS) throw new Error("Snooze time must be within a year");
  return at;
}

export async function recordSnooze(
  db: ReviewQueueDb,
  input: {
    companyId: string;
    mailbox: string;
    folder: string;
    snoozeUid: number;
    messageId: string | null;
    subject: string | null;
    sender: string | null;
    wakeAt: Date;
  },
): Promise<void> {
  await db.execute(
    `INSERT INTO ${SNOOZES}
       (company_id, mailbox_key, folder, snooze_folder, snooze_uid, message_id, subject, sender, wake_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
    [
      input.companyId,
      input.mailbox,
      input.folder,
      SNOOZE_FOLDER,
      input.snoozeUid,
      input.messageId,
      input.subject,
      input.sender,
      input.wakeAt.toISOString(),
    ],
  );
}

/** Snoozes whose time has come, oldest first, skipping ones that keep failing. */
export async function dueSnoozes(
  db: ReviewQueueDb,
  now: Date = new Date(),
  limit = 50,
): Promise<SnoozeRow[]> {
  return db.query<SnoozeRow>(
    `SELECT id, company_id, mailbox_key, folder, snooze_folder, snooze_uid, message_id,
            subject, sender, wake_at, attempts, last_error
       FROM ${SNOOZES}
      WHERE wake_at <= $1::timestamptz AND attempts < $2
      ORDER BY wake_at ASC
      LIMIT $3`,
    [now.toISOString(), MAX_WAKE_ATTEMPTS, limit],
  );
}

/** Snoozes still waiting (or stuck) for one company's mailbox, soonest first. */
export async function listSnoozes(
  db: ReviewQueueDb,
  companyId: string,
  mailbox: string,
): Promise<SnoozeRow[]> {
  return db.query<SnoozeRow>(
    `SELECT id, company_id, mailbox_key, folder, snooze_folder, snooze_uid, message_id,
            subject, sender, wake_at, attempts, last_error
       FROM ${SNOOZES}
      WHERE company_id = $1::uuid AND lower(mailbox_key) = lower($2)
      ORDER BY wake_at ASC`,
    [companyId, mailbox],
  );
}

export async function getSnooze(
  db: ReviewQueueDb,
  companyId: string,
  id: string,
): Promise<SnoozeRow | null> {
  const rows = await db.query<SnoozeRow>(
    `SELECT id, company_id, mailbox_key, folder, snooze_folder, snooze_uid, message_id,
            subject, sender, wake_at, attempts, last_error
       FROM ${SNOOZES} WHERE id = $1::uuid AND company_id = $2::uuid`,
    [id, companyId],
  );
  return rows[0] ?? null;
}

export async function deleteSnooze(db: ReviewQueueDb, id: string): Promise<void> {
  await db.execute(`DELETE FROM ${SNOOZES} WHERE id = $1::uuid`, [id]);
}

export async function recordWakeFailure(db: ReviewQueueDb, id: string, error: string): Promise<void> {
  await db.execute(
    `UPDATE ${SNOOZES} SET attempts = attempts + 1, last_error = $2 WHERE id = $1::uuid`,
    [id, error.slice(0, 500)],
  );
}
