/**
 * Per-account dial-decision audit log.
 *
 * Every dial attempt (and skip-decision) appends an entry. The log is
 * the regulatory evidence trail — it's what an operator hands to
 * counsel if a TCPA complaint lands.
 *
 * State key: `audit:<accountKey>:<YYYY-MM-DD>` → AuditEntry[]
 *
 * One bucket per UTC day so the size stays bounded (a 200-call/day
 * campaign produces a 200-entry array). Reads can paginate by date;
 * the export tool concatenates a date range.
 *
 * Retention: state has a 30-day default TTL on most plugin keys.
 * Operators wanting longer retention (FTC suggests at least 5 years
 * for sales-call records) should periodically dump the audit log to
 * external cold storage via the export tool. We don't try to
 * implement a 5-year hot store inside ctx.state.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";

export type DialDecision =
  | "dialed"
  | "skipped-account-dnc"
  | "skipped-federal-dnc"
  | "skipped-out-of-hours"
  | "skipped-concurrency-cap"
  | "skipped-daily-cap"
  | "skipped-hourly-cap"
  | "skipped-retry-cap"
  | "skipped-duplicate"
  | "error";

export interface AuditEntry {
  /** ISO 8601 with millisecond precision. */
  at: string;
  /** Empty string if the decision was an account-level skip not tied to a specific number. */
  phoneE164: string;
  decision: DialDecision;
  /** Free-form human-readable note. Avoid PII; this gets dumped to cold storage. */
  note?: string;
  /** Source campaign for cross-reference. Empty for non-campaign-driven dials. */
  campaignId?: string;
  /** Engine call ID, if the dial actually went out. */
  callId?: string;
  /** Acting agent / actor ID for accountability. */
  actor?: string;
}

const STATE_KEY_PREFIX = "audit";

function todayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function bucketKey(accountKey: string, dateIso: string): string {
  return `${STATE_KEY_PREFIX}:${accountKey}:${dateIso}`;
}

/**
 * Append an audit entry to today's bucket. Idempotent in spirit
 * (duplicate entries are harmless — better to over-log than under-
 * log) but doesn't dedup; the caller decides if the same dial
 * decision should be logged twice.
 *
 * The append is a read-modify-write — if two events fire in the
 * same millisecond, one might overwrite the other's append. This
 * matches the existing pattern in `state.ts`'s appendLeadIndex.
 * For audit volume at the plugin's expected throughput (a few
 * hundred dials/day), the race is acceptable.
 */
export async function appendAudit(
  ctx: PluginContext,
  accountKey: string,
  entry: Omit<AuditEntry, "at"> & { at?: string },
): Promise<void> {
  const at = entry.at ?? new Date().toISOString();
  const key = bucketKey(accountKey, todayKey(new Date(at)));
  const prev = await ctx.state.get({ scopeKind: "instance", stateKey: key });
  const list: AuditEntry[] = Array.isArray(prev)
    ? (prev.filter((e): e is AuditEntry => !!e && typeof e === "object") as AuditEntry[])
    : [];
  list.push({ ...entry, at });
  await ctx.state.set({ scopeKind: "instance", stateKey: key }, list);
}

/**
 * Read entries for a single date bucket.
 */
export async function readAuditDay(
  ctx: PluginContext,
  accountKey: string,
  dateIso: string,
): Promise<AuditEntry[]> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: bucketKey(accountKey, dateIso),
  });
  if (Array.isArray(value)) {
    return value.filter((e): e is AuditEntry => !!e && typeof e === "object") as AuditEntry[];
  }
  return [];
}

/**
 * Read entries spanning a date range (inclusive). Returns entries
 * concatenated in chronological order — useful for export to CSV
 * or for surfacing in the UI.
 *
 * Date range is treated as UTC days. `since` and `until` are
 * inclusive; bad inputs default to today only.
 */
export async function readAuditRange(
  ctx: PluginContext,
  accountKey: string,
  sinceIso: string,
  untilIso: string,
): Promise<AuditEntry[]> {
  const since = sliceDate(sinceIso) ?? todayKey();
  const until = sliceDate(untilIso) ?? since;
  const start = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return [];
  }
  const days: string[] = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    days.push(d.toISOString().slice(0, 10));
  }
  const out: AuditEntry[] = [];
  for (const day of days) {
    const entries = await readAuditDay(ctx, accountKey, day);
    out.push(...entries);
  }
  return out;
}

function sliceDate(iso: string | undefined): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  // Allow full ISO timestamps too — slice the date part.
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Render a chronological audit list as CSV — what an operator hands
 * to counsel or external compliance review. Columns are stable so
 * downstream tools (spreadsheet pivots, retention archives) can
 * depend on them.
 */
export function renderAuditCsv(entries: AuditEntry[]): string {
  const header = "at,decision,phoneE164,campaignId,callId,actor,note";
  const rows = entries.map((e) =>
    [
      e.at,
      e.decision,
      e.phoneE164,
      e.campaignId ?? "",
      e.callId ?? "",
      e.actor ?? "",
      csvEscape(e.note ?? ""),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function csvEscape(s: string): string {
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
