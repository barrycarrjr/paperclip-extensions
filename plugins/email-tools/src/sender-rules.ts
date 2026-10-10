/**
 * The one place a sender rule is written.
 *
 * A rule is the operator's decision about a sender, so writing one also
 * clears the review-queue entries it settles. Both paths that create rules go
 * through here: the set-rule action behind the Auto-triage / Keep / Mute
 * buttons, and the poll loop learning from mail dragged into the triage
 * folder. A test fails if a rule is inserted anywhere else, because a rule
 * written around this function would leave the queue reporting a sender the
 * operator has already decided on.
 *
 * The clear is best effort. The rule is the decision and is already stored by
 * then, so a failed clear must not turn into a failed rule (the set-rule
 * action would report an error and skip its inbox sweep, and the poll loop
 * would log a rule it had learned as not inserted). A leftover entry is still
 * hidden from every listing, because listings leave out senders a rule covers.
 */
import { clearReviewEntriesForRule, type ReviewQueueDb } from "./review-queue.js";
import type { RuleType } from "./rule-patterns.js";

const RULES = "plugin_email_tools_7cbee3fdf3.email_sender_rules";

export async function writeSenderRule(
  db: ReviewQueueDb,
  input: {
    companyId: string;
    /** The key the rule is stored under, as the caller passed it. */
    mailbox: string;
    /**
     * The configured key the review queue files entries under, when it can
     * differ from `mailbox` (a caller may spell a key in another case).
     */
    queueMailbox?: string;
    /** Already normalized (see normalizeRulePattern). */
    pattern: string;
    ruleType: RuleType;
    /**
     * "replace" changes the type of an existing rule (an operator choosing).
     * "keep" leaves an existing rule alone (the poll loop learning, which must
     * not overwrite a keep-always the operator set).
     */
    onExisting: "replace" | "keep";
  },
): Promise<{ written: boolean; clearedReviewEntries: number; clearError?: string }> {
  const sql =
    input.onExisting === "replace"
      ? `INSERT INTO ${RULES}
           (company_id, mailbox_key, sender_pattern, rule_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, mailbox_key, sender_pattern)
         DO UPDATE SET rule_type = $4, updated_at = now()`
      : `INSERT INTO ${RULES}
           (company_id, mailbox_key, sender_pattern, rule_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, mailbox_key, sender_pattern) DO NOTHING`;
  const result = await db.execute(sql, [
    input.companyId,
    input.mailbox,
    input.pattern,
    input.ruleType,
  ]);
  const written = result.rowCount > 0;
  try {
    // Cleared even when the rule already existed: the entry may have been
    // queued before an older version learned to clear it.
    const clearedReviewEntries = await clearReviewEntriesForRule(db, {
      companyId: input.companyId,
      mailbox: input.queueMailbox ?? input.mailbox,
      pattern: input.pattern,
    });
    return { written, clearedReviewEntries };
  } catch (err) {
    return { written, clearedReviewEntries: 0, clearError: (err as Error).message ?? String(err) };
  }
}
