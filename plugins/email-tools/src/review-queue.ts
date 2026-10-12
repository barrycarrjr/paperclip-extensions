/**
 * The triage review queue: senders the triage routine surfaced for a
 * decision, waiting for the operator to give them a rule or dismiss them.
 *
 * This used to be a "Review queue" section each triage run appended to a
 * Markdown document on a rules-home issue. An issue is a unit of work, not a
 * place to keep standing data, and that document grew a section per run,
 * could not be queried, and never learned that a sender had since been given
 * a rule. Here, next to the rules, every entry has a way out: any rule that
 * covers the sender clears it (see sender-rules.ts), Dismiss clears it, and an
 * entry with no new mail for the configured number of days drops out.
 *
 * It is a different list from the "awaiting your call" rows on the Morning
 * Brief, which are worked out live from unread mail. Mail the routine moved
 * out of INBOX, or that someone read in their own mail program, drops off that
 * list, but the routine's view that the sender deserves a rule, and its note
 * on why, stays here until someone decides or the sender goes quiet.
 *
 * Counting. A run cannot tell which messages an earlier run already saw: the
 * search window overlaps the last run, and on a server without the IMAP
 * WITHIN extension a search by date returns the whole day. So each message is
 * counted once by its identity (the Message-ID, or uid:N when it has none),
 * and a call that names no messages only sets a floor ("at least N"), which a
 * repeat of the same call cannot raise.
 *
 * Database access goes through the narrow ReviewQueueDb interface so the SQL
 * can be tested against a real Postgres, host restrictions included. The host
 * offers no transactions, so every write is a single statement: a batch is
 * stored whole or not at all, and running it again changes nothing.
 */
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { isRuleType, rulePatternKind, type RuleType } from "./rule-patterns.js";

export type ReviewQueueDb = Pick<PluginDatabaseClient, "query" | "execute">;

const NS = "plugin_email_tools_7cbee3fdf3";
const QUEUE = `${NS}.email_review_queue`;
const RULES = `${NS}.email_sender_rules`;

/** Entries accepted in one call. A run surfaces a handful, an import a few hundred. */
export const MAX_ENTRIES_PER_CALL = 500;
/** Message identities remembered per sender (newest kept), so each message counts once. */
export const STORED_MESSAGE_IDS = 500;
/** Days without new mail before an entry drops out, unless configured otherwise. */
export const DEFAULT_EXPIRY_DAYS = 30;
const MAX_IDS_PER_ENTRY = 200;
const MAX_COUNT = 100_000;
const MAX_NOTE = 2000;
const MAX_SUBJECT = 300;
const MAX_DISPLAY_NAME = 200;
/** Rows read per list call before rule filtering. Far above any real queue. */
const LIST_READ_CAP = 2000;

export interface ReviewEntry {
  /** Lowercased full address or @domain. */
  sender: string;
  /** Identities of the messages counted: the Message-ID, or uid:N. */
  messageKeys: string[];
  /** The entry holds at least this many messages, named or not. */
  atLeast: number;
  displayName: string | null;
  subject: string | null;
  note: string | null;
  suggestedRule: RuleType | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SkippedEntry {
  index: number;
  sender: unknown;
  reason: string;
}

export interface ReviewQueueEntry {
  sender: string;
  displayName: string | null;
  messageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSubject: string | null;
  note: string | null;
  suggestedRule: RuleType | null;
}

export interface AddResult {
  added: string[];
  updated: string[];
  /** Covered by an existing rule, so already decided and not queued. */
  alreadyRuled: string[];
  /** Entries that could not be stored, each with the reason. */
  skipped: SkippedEntry[];
}

/** The configured expiry, kept to whole days between 1 and 365. */
export function resolveExpiryDays(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_EXPIRY_DAYS;
  return Math.min(365, Math.max(1, Math.floor(raw)));
}

/** Entries last seen before this have dropped out. */
export function expiryCutoff(now: Date, expiryDays: number): Date {
  return new Date(now.getTime() - expiryDays * 86_400_000);
}

/**
 * The sender an entry is keyed on: a full address or an @domain, the two
 * forms a rule can settle. A From header ("Pat Example <pat@example.com>") is
 * what an agent usually has to hand, so the address is taken out of one.
 */
export function normalizeReviewSender(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angled = /<([^<>]+)>\s*$/.exec(s);
  if (angled) s = angled[1]!.trim();
  s = s.replace(/^[`'"]+|[`'"]+$/g, "").trim().toLowerCase();
  const kind = rulePatternKind(s);
  return kind === "address" || kind === "domain" ? s : null;
}

/** A rule on the exact address, or on its @domain, covers the sender. */
export function isCoveredByRules(sender: string, rulePatterns: ReadonlySet<string>): boolean {
  if (rulePatterns.has(sender)) return true;
  if (sender.startsWith("@")) return false;
  const at = sender.lastIndexOf("@");
  return at > 0 && rulePatterns.has(sender.slice(at));
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function optionalDate(value: unknown, now: Date): Date | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return undefined;
  // A future date would sort the entry above everything real, for ever.
  return new Date(Math.min(ms, now.getTime()));
}

/**
 * The identities of the messages an entry names, and how many it named
 * without one. `messages` takes items straight from email_search
 * ({ messageId, uid }); `messageIds` takes bare Message-IDs. A null or blank
 * Message-ID falls back to the UID, and failing that the message is still
 * counted, just not by name.
 */
function messageIdentities(e: Record<string, unknown>): { keys: string[]; unnamed: number } {
  const keys = new Set<string>();
  let unnamed = 0;
  const named = (id: unknown): string | null =>
    typeof id === "string" && id.trim() ? id.trim() : null;
  if (Array.isArray(e.messages)) {
    for (const item of e.messages) {
      const m = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const id = named(m.messageId);
      const uid = typeof m.uid === "number" && Number.isInteger(m.uid) && m.uid > 0 ? m.uid : null;
      if (id) keys.add(id);
      else if (uid !== null) keys.add(`uid:${uid}`);
      else unnamed += 1;
    }
  }
  if (Array.isArray(e.messageIds)) {
    for (const id of e.messageIds) {
      const key = named(id);
      if (key) keys.add(key);
      else unnamed += 1;
    }
  }
  return { keys: [...keys].slice(0, MAX_IDS_PER_ENTRY), unnamed };
}

/**
 * Validate a batch. A batch that is not a list fails whole; within it, an
 * entry that cannot be stored is skipped and reported with the reason, and
 * the rest go ahead. An entry last seen before `expiresBefore` would drop out
 * at once, so it is reported as too old instead of stored.
 *
 * The same sender twice in one batch is merged, which is what a run that
 * collected per message rather than per sender will send.
 */
export function parseReviewEntries(
  raw: unknown,
  now: Date,
  options: { expiresBefore: Date },
):
  | { ok: true; entries: ReviewEntry[]; skipped: SkippedEntry[] }
  | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "entries must be a non-empty array of { sender, ... }" };
  }
  if (raw.length > MAX_ENTRIES_PER_CALL) {
    return {
      ok: false,
      error: `entries has ${raw.length} items; at most ${MAX_ENTRIES_PER_CALL} per call`,
    };
  }

  const skipped: SkippedEntry[] = [];
  const merged = new Map<string, ReviewEntry>();
  raw.forEach((item, index) => {
    const skip = (sender: unknown, reason: string) => skipped.push({ index, sender, reason });
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skip(item, "not an object");
      return;
    }
    const e = item as Record<string, unknown>;
    const sender = normalizeReviewSender(e.sender);
    if (!sender) {
      skip(e.sender, "not an address or @domain a rule could match");
      return;
    }

    let count: number | null = null;
    if (e.count !== undefined && e.count !== null) {
      if (typeof e.count !== "number" || !Number.isInteger(e.count) || e.count < 1 || e.count > MAX_COUNT) {
        skip(e.sender, `count must be a whole number from 1 to ${MAX_COUNT}`);
        return;
      }
      count = e.count;
    }
    if (e.messages !== undefined && e.messages !== null && !Array.isArray(e.messages)) {
      skip(e.sender, "messages must be a list of { messageId, uid }");
      return;
    }
    if (e.messageIds !== undefined && e.messageIds !== null && !Array.isArray(e.messageIds)) {
      skip(e.sender, "messageIds must be a list");
      return;
    }
    const { keys, unnamed } = messageIdentities(e);

    const displayName = optionalText(e.displayName, MAX_DISPLAY_NAME);
    const subject = optionalText(e.subject, MAX_SUBJECT);
    const note = optionalText(e.note, MAX_NOTE);
    if (displayName === undefined || subject === undefined || note === undefined) {
      skip(e.sender, "displayName, subject and note must be text");
      return;
    }

    let suggestedRule: RuleType | null = null;
    if (e.suggestedRule !== undefined && e.suggestedRule !== null && e.suggestedRule !== "") {
      if (!isRuleType(e.suggestedRule)) {
        skip(e.sender, "suggestedRule must be 'auto-triage', 'keep-always' or 'mute'");
        return;
      }
      suggestedRule = e.suggestedRule;
    }

    const first = optionalDate(e.firstSeenAt, now);
    const last = optionalDate(e.lastSeenAt, now);
    if (first === undefined || last === undefined) {
      skip(e.sender, "firstSeenAt and lastSeenAt must be ISO dates");
      return;
    }
    const lastSeen = last ?? first ?? now;
    const firstSeen = first && first.getTime() <= lastSeen.getTime() ? first : lastSeen;
    if (lastSeen.getTime() < options.expiresBefore.getTime()) {
      skip(e.sender, `last seen ${lastSeen.toISOString().slice(0, 10)}, older than the review-queue expiry`);
      return;
    }

    const entry: ReviewEntry = {
      sender,
      messageKeys: keys,
      atLeast: count ?? Math.max(1, keys.length + unnamed),
      displayName,
      subject,
      note,
      suggestedRule,
      firstSeenAt: firstSeen.toISOString(),
      lastSeenAt: lastSeen.toISOString(),
    };
    const prior = merged.get(sender);
    merged.set(sender, prior ? mergeEntries(prior, entry) : entry);
  });

  return { ok: true, entries: [...merged.values()], skipped };
}

function mergeEntries(a: ReviewEntry, b: ReviewEntry): ReviewEntry {
  // The later sighting's words win: they describe the sender as it is now.
  const [older, newer] = a.lastSeenAt <= b.lastSeenAt ? [a, b] : [b, a];
  const keys = [...new Set([...a.messageKeys, ...b.messageKeys])].slice(0, MAX_IDS_PER_ENTRY);
  return {
    sender: a.sender,
    messageKeys: keys,
    // Never more than either sighting could prove: two entries naming the same
    // message must not count it twice.
    atLeast: Math.max(a.atLeast, b.atLeast, keys.length),
    displayName: newer.displayName ?? older.displayName,
    subject: newer.subject ?? older.subject,
    note: newer.note ?? older.note,
    suggestedRule: newer.suggestedRule ?? older.suggestedRule,
    firstSeenAt: a.firstSeenAt < b.firstSeenAt ? a.firstSeenAt : b.firstSeenAt,
    lastSeenAt: newer.lastSeenAt,
  };
}

// Rules keep the mailbox key as their caller spelled it, while queue entries
// use the configured key, and keys are case-insensitive (findConfigMailbox),
// so rules are matched on the key in any case.
async function rulePatterns(
  db: ReviewQueueDb,
  companyId: string,
  mailbox: string,
): Promise<Set<string>> {
  const rows = await db.query<{ sender_pattern: string }>(
    `SELECT sender_pattern FROM ${RULES} WHERE company_id = $1 AND lower(mailbox_key) = lower($2)`,
    [companyId, mailbox],
  );
  return new Set(rows.map((r) => r.sender_pattern.toLowerCase()));
}

// One statement for the whole batch, so it is stored whole or not at all.
// The entries travel as JSON text: the host binds an array parameter as a
// parenthesised list, which Postgres would read as a row.
//
// On conflict the count grows by the message identities not already
// recorded, and never drops below what this call could prove
// (EXCLUDED.message_count is that number), so repeating a call changes
// nothing. The newest STORED_MESSAGE_IDS identities are kept. Text fields
// take this call's words only if this call saw the sender at least as
// recently as the stored entry did, so importing old sightings cannot
// overwrite a newer note. The dates only ever widen.
const BATCH_UPSERT_SQL = `INSERT INTO ${QUEUE} AS q
  (company_id, mailbox_key, sender, display_name, last_subject, note, suggested_rule,
   message_ids, message_count, first_seen_at, last_seen_at)
SELECT $1::uuid, $2, e.sender, e.display_name, e.last_subject, e.note, e.suggested_rule,
       ARRAY(SELECT jsonb_array_elements_text(e.message_keys)),
       greatest(jsonb_array_length(e.message_keys), e.at_least),
       e.first_seen_at, e.last_seen_at
  FROM jsonb_to_recordset($3::jsonb) AS e(
       sender text, display_name text, last_subject text, note text, suggested_rule text,
       message_keys jsonb, at_least integer, first_seen_at timestamptz, last_seen_at timestamptz)
ON CONFLICT (company_id, mailbox_key, sender) DO UPDATE SET
  message_count = greatest(
    q.message_count + (
      SELECT count(*)::int FROM unnest(EXCLUDED.message_ids) AS m(id) WHERE m.id <> ALL (q.message_ids)
    ),
    EXCLUDED.message_count),
  message_ids = (
    SELECT s.ids[greatest(cardinality(s.ids) - ${STORED_MESSAGE_IDS - 1}, 1):]
    FROM (SELECT q.message_ids || ARRAY(
      SELECT m.id FROM unnest(EXCLUDED.message_ids) AS m(id) WHERE m.id <> ALL (q.message_ids)
    ) AS ids) AS s
  ),
  display_name = CASE WHEN EXCLUDED.last_seen_at >= q.last_seen_at
    THEN coalesce(EXCLUDED.display_name, q.display_name) ELSE coalesce(q.display_name, EXCLUDED.display_name) END,
  last_subject = CASE WHEN EXCLUDED.last_seen_at >= q.last_seen_at
    THEN coalesce(EXCLUDED.last_subject, q.last_subject) ELSE coalesce(q.last_subject, EXCLUDED.last_subject) END,
  note = CASE WHEN EXCLUDED.last_seen_at >= q.last_seen_at
    THEN coalesce(EXCLUDED.note, q.note) ELSE coalesce(q.note, EXCLUDED.note) END,
  suggested_rule = CASE WHEN EXCLUDED.last_seen_at >= q.last_seen_at
    THEN coalesce(EXCLUDED.suggested_rule, q.suggested_rule) ELSE coalesce(q.suggested_rule, EXCLUDED.suggested_rule) END,
  first_seen_at = least(q.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at = greatest(q.last_seen_at, EXCLUDED.last_seen_at),
  updated_at = now()`;

/**
 * Add or update queue entries for one mailbox. A sender a rule already covers
 * has been decided, so it is reported back rather than queued. Entries that
 * have dropped out (no new mail within the expiry) are pruned first.
 */
export async function addToReviewQueue(
  db: ReviewQueueDb,
  input: {
    companyId: string;
    mailbox: string;
    entries: ReviewEntry[];
    skipped?: SkippedEntry[];
    expiresBefore: Date;
  },
): Promise<AddResult> {
  const { companyId, mailbox } = input;
  await pruneExpiredReviewEntries(db, { companyId, mailbox, expiresBefore: input.expiresBefore });
  const patterns = await rulePatterns(db, companyId, mailbox);
  const existing = new Set(
    (
      await db.query<{ sender: string }>(
        `SELECT sender FROM ${QUEUE} WHERE company_id = $1 AND mailbox_key = $2`,
        [companyId, mailbox],
      )
    ).map((r) => r.sender),
  );

  const result: AddResult = { added: [], updated: [], alreadyRuled: [], skipped: input.skipped ?? [] };
  const rows: Record<string, unknown>[] = [];
  for (const e of input.entries) {
    if (isCoveredByRules(e.sender, patterns)) {
      result.alreadyRuled.push(e.sender);
      continue;
    }
    rows.push({
      sender: e.sender,
      display_name: e.displayName,
      last_subject: e.subject,
      note: e.note,
      suggested_rule: e.suggestedRule,
      message_keys: e.messageKeys,
      at_least: e.atLeast,
      first_seen_at: e.firstSeenAt,
      last_seen_at: e.lastSeenAt,
    });
    (existing.has(e.sender) ? result.updated : result.added).push(e.sender);
  }
  if (rows.length > 0) {
    await db.execute(BATCH_UPSERT_SQL, [companyId, mailbox, JSON.stringify(rows)]);
  }
  return result;
}

/** Remove the entries whose sender has sent nothing within the expiry. */
export async function pruneExpiredReviewEntries(
  db: ReviewQueueDb,
  input: { companyId: string; mailbox: string; expiresBefore: Date },
): Promise<number> {
  const r = await db.execute(
    `DELETE FROM ${QUEUE} WHERE company_id = $1 AND mailbox_key = $2 AND last_seen_at < $3`,
    [input.companyId, input.mailbox, input.expiresBefore.toISOString()],
  );
  return r.rowCount;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms).toISOString();
  }
  return String(value);
}

/**
 * The entries still waiting, noisiest first. An entry a rule now covers is
 * left out even if it is still stored, so a rule written by some path that
 * did not clear it can never keep a decided sender on the list, and so is an
 * entry past the expiry that no write has pruned yet.
 */
export async function listReviewQueue(
  db: ReviewQueueDb,
  input: { companyId: string; mailbox: string; limit: number; expiresBefore: Date },
): Promise<{ entries: ReviewQueueEntry[]; total: number }> {
  const { companyId, mailbox } = input;
  const patterns = await rulePatterns(db, companyId, mailbox);
  const rows = await db.query<{
    sender: string;
    display_name: string | null;
    last_subject: string | null;
    note: string | null;
    suggested_rule: string | null;
    message_count: number;
    first_seen_at: unknown;
    last_seen_at: unknown;
  }>(
    `SELECT sender, display_name, last_subject, note, suggested_rule, message_count,
            first_seen_at, last_seen_at
       FROM ${QUEUE}
      WHERE company_id = $1 AND mailbox_key = $2 AND last_seen_at >= $3
      ORDER BY message_count DESC, last_seen_at DESC, sender
      LIMIT ${LIST_READ_CAP}`,
    [companyId, mailbox, input.expiresBefore.toISOString()],
  );
  const waiting = rows
    .filter((r) => !isCoveredByRules(r.sender, patterns))
    .map(
      (r): ReviewQueueEntry => ({
        sender: r.sender,
        displayName: r.display_name,
        messageCount: Number(r.message_count),
        firstSeenAt: toIso(r.first_seen_at),
        lastSeenAt: toIso(r.last_seen_at),
        lastSubject: r.last_subject,
        note: r.note,
        suggestedRule: isRuleType(r.suggested_rule) ? r.suggested_rule : null,
      }),
    );
  return { entries: waiting.slice(0, Math.max(0, input.limit)), total: waiting.length };
}

/**
 * Clear the entries a rule settles: the exact address for an address rule,
 * and every address in the domain (and the domain entry itself) for an
 * @domain rule. A subject rule names no sender, so it settles nothing here.
 */
export async function clearReviewEntriesForRule(
  db: ReviewQueueDb,
  input: { companyId: string; mailbox: string; pattern: string },
): Promise<number> {
  const pattern = input.pattern.trim().toLowerCase();
  const kind = rulePatternKind(pattern);
  if (kind === "address") {
    const r = await db.execute(
      `DELETE FROM ${QUEUE} WHERE company_id = $1 AND mailbox_key = $2 AND sender = $3`,
      [input.companyId, input.mailbox, pattern],
    );
    return r.rowCount;
  }
  if (kind === "domain") {
    const r = await db.execute(
      `DELETE FROM ${QUEUE} WHERE company_id = $1 AND mailbox_key = $2 AND split_part(sender, '@', 2) = $3`,
      [input.companyId, input.mailbox, pattern.slice(1)],
    );
    return r.rowCount;
  }
  return 0;
}

/**
 * The operator decided without a rule. Dismissing an address also clears the
 * whole-domain entry for its domain: the operator has looked at that mail and
 * chosen no rule, and nothing else would ever take that entry off the list.
 * Dismissing an @domain clears the domain entry and every address in it.
 * `sender` must already be normalized (normalizeReviewSender).
 */
export async function dismissReviewEntry(
  db: ReviewQueueDb,
  input: { companyId: string; mailbox: string; sender: string },
): Promise<number> {
  if (input.sender.startsWith("@")) {
    const r = await db.execute(
      `DELETE FROM ${QUEUE} WHERE company_id = $1 AND mailbox_key = $2 AND split_part(sender, '@', 2) = $3`,
      [input.companyId, input.mailbox, input.sender.slice(1)],
    );
    return r.rowCount;
  }
  const domain = input.sender.slice(input.sender.lastIndexOf("@"));
  const r = await db.execute(
    `DELETE FROM ${QUEUE} WHERE company_id = $1 AND mailbox_key = $2 AND (sender = $3 OR sender = $4)`,
    [input.companyId, input.mailbox, input.sender, domain],
  );
  return r.rowCount;
}

/** One line for an agent: what happened to the batch it sent. */
export function describeAddResult(mailbox: string, r: AddResult): string {
  const parts = [`${r.added.length} added`, `${r.updated.length} updated`];
  if (r.alreadyRuled.length > 0) {
    parts.push(`${r.alreadyRuled.length} already covered by a rule, not queued`);
  }
  if (r.skipped.length > 0) {
    parts.push(`${r.skipped.length} skipped (see skipped for why)`);
  }
  return `Review queue for "${mailbox}": ${parts.join(", ")}.`;
}
