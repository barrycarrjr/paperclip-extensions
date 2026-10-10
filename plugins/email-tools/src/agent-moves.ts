/**
 * Mail an agent moved into the triage folder itself.
 *
 * The poll loop learns an auto-triage rule from every new message in the
 * triage folder (learnFromTriageHeaders in poll.ts). That is right for mail
 * the operator dragged there from a mail program: the drag is the decision.
 * It is wrong for the triage routine's loose mode, which moves an unknown
 * sender's mail there on a guess and queues the sender for the operator to
 * decide. Learning from that move would make the decision for them, and the
 * rule would clear the very entry the same run had just queued. So the
 * email_move tool records what an agent puts in the triage folder, and the
 * learner skips it.
 *
 * A message is recorded by its Message-ID before the move (so the learner
 * cannot see it first) and by its UID in the triage folder after it (for mail
 * with no Message-ID). Rows are pruned after a fortnight, long after the poll
 * loop has looked at the folder.
 */
import type { ReviewQueueDb } from "./review-queue.js";

const MOVES = "plugin_email_tools_7cbee3fdf3.email_agent_triage_moves";
const KEEP_DAYS = 14;

export async function recordAgentTriageMoves(
  db: ReviewQueueDb,
  input: { companyId: string; mailbox: string; messageKeys: string[]; now?: Date },
): Promise<void> {
  const keys = [...new Set(input.messageKeys.map((k) => k.trim()).filter(Boolean))];
  if (keys.length === 0) return;
  const now = input.now ?? new Date();
  await db.execute(
    `INSERT INTO ${MOVES} (mailbox_key, message_key, company_id, moved_at)
     SELECT $1, t.k, $2::uuid, $3::timestamptz FROM jsonb_array_elements_text($4::jsonb) AS t(k)
     ON CONFLICT (mailbox_key, message_key) DO UPDATE SET moved_at = EXCLUDED.moved_at`,
    [input.mailbox, input.companyId, now.toISOString(), JSON.stringify(keys)],
  );
  await db.execute(`DELETE FROM ${MOVES} WHERE mailbox_key = $1 AND moved_at < $2`, [
    input.mailbox,
    new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString(),
  ]);
}

/** The headers left once the agent's own moves are taken out. */
export async function withoutAgentMoves<T extends { uid: number; messageId: string | null }>(
  db: ReviewQueueDb,
  mailbox: string,
  headers: T[],
): Promise<T[]> {
  if (headers.length === 0) return headers;
  const keysOf = (h: T): string[] => {
    const id = h.messageId?.trim();
    return id ? [id, `uid:${h.uid}`] : [`uid:${h.uid}`];
  };
  const rows = await db.query<{ message_key: string }>(
    `SELECT message_key FROM ${MOVES}
      WHERE mailbox_key = $1 AND message_key IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [mailbox, JSON.stringify(headers.flatMap(keysOf))],
  );
  const moved = new Set(rows.map((r) => r.message_key));
  return headers.filter((h) => !keysOf(h).some((k) => moved.has(k)));
}
