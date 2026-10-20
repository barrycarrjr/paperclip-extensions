// Mirror NEW_AGENT_GRACE_DAYS and IDLE_AGENT_DAYS in core structural-findings.ts.
// The build brief uses the 7-day grace for idle eligibility. Core currently
// applies its 30-day cutoff to candidate age too; see README compatibility note.
export const ROSTER_THRESHOLDS = { newAgentDays: 7, idleDays: 30, lowUseRuns: 4, historyDays: 90 } as const;
export const DAY_MS = 86_400_000;
export type Usage = "Idle" | "Low use" | "Active" | "New";
export type Verdict = Usage | "Kept on purpose";
export interface KeepMark { note: string; markedBy: string | null; markedAt: string }
export interface RosterRow {
  id: string; name: string; role: string; status: string; createdAt: string;
  lastRunAt: string | null; lastHeartbeatAt: string | null;
  runs30: number; runs90: number; costCents30: number; openIssues: number; verdict: Verdict;
  keep?: KeepMark | null; usage?: Usage;
}
export interface RosterData {
  companyId: string; generatedAt: string; rows: RosterRow[];
  idleCount: number; idleCostCents30: number; canPause?: boolean;
}
export function usageOf(row: Omit<RosterRow, "verdict">, now: number): Usage {
  // The core treats the exact 30-day boundary as idle-eligible, and also
  // respects lastHeartbeatAt even if the corresponding run is unavailable.
  if (Date.parse(row.createdAt) > now - ROSTER_THRESHOLDS.newAgentDays * DAY_MS) return "New";
  if (row.runs30 === 0 && (!row.lastHeartbeatAt || Date.parse(row.lastHeartbeatAt) <= now - ROSTER_THRESHOLDS.idleDays * DAY_MS)) return "Idle";
  return row.runs30 < ROSTER_THRESHOLDS.lowUseRuns && row.openIssues === 0 ? "Low use" : "Active";
}
export function verdict(row: Omit<RosterRow, "verdict">, now: number): Verdict {
  const usage = usageOf(row, now);
  return row.keep && (usage === "Idle" || usage === "Low use") ? "Kept on purpose" : usage;
}
export const GUIDANCE = "An agent earns its place with a recurring job from the Hand-off audit or regular assigned work. Add a new agent only for a job the audit found, not from a fixed template. Review one company at a time and decide keep, pause or terminate on the evidence.";
export function companyPath(prefix: string | null, path: string): string {
  return `${prefix ? `/${encodeURIComponent(prefix)}` : ""}/${path}`;
}
export function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
