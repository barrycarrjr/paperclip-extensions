import type { PluginContext } from "@paperclipai/plugin-sdk";

// These two mirror IDLE_AGENT_DAYS and NEW_AGENT_GRACE_DAYS in Paperclip's
// server/src/services/structural-findings.ts, so the roster and the
// structural-findings API call the same agents idle.
export const IDLE_AGENT_DAYS = 30;
export const NEW_AGENT_GRACE_DAYS = 7;
export const LOW_USE_MAX_RUNS = 3;
const LONG_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Verdict = "idle" | "low_use" | "active" | "new" | "kept";

export interface KeepMark {
  note: string;
  markedBy: string | null;
  markedAt: string;
}

export interface RosterRow {
  agentId: string;
  name: string;
  role: string;
  title: string | null;
  status: string;
  createdAt: string;
  lastRunAt: string | null;
  runsLast30Days: number;
  runsLast90Days: number;
  costCentsLast30Days: number;
  openIssues: number;
  keep: KeepMark | null;
  /** What the numbers alone say, before any keep mark. */
  usage: Exclude<Verdict, "kept">;
  verdict: Verdict;
}

export interface RosterSummary {
  agentCount: number;
  idleCount: number;
  lowUseCount: number;
  keptCount: number;
  /** Last 30 days' cost of the agents counted in idleCount and lowUseCount. */
  flaggedCostCentsLast30Days: number;
}

export interface Roster {
  rows: RosterRow[];
  summary: RosterSummary;
}

export type RosterStats = Omit<RosterRow, "usage" | "verdict">;

const VERDICT_ORDER: Record<Verdict, number> = { idle: 0, low_use: 1, kept: 2, active: 3, new: 4 };

export function usageOf(stats: Pick<RosterStats, "createdAt" | "lastRunAt" | "runsLast30Days" | "openIssues">, now: Date): RosterRow["usage"] {
  const ageMs = now.getTime() - new Date(stats.createdAt).getTime();
  if (ageMs < NEW_AGENT_GRACE_DAYS * DAY_MS) return "new";
  const lastRunMs = stats.lastRunAt ? new Date(stats.lastRunAt).getTime() : null;
  if (lastRunMs === null || now.getTime() - lastRunMs > IDLE_AGENT_DAYS * DAY_MS) return "idle";
  if (stats.runsLast30Days <= LOW_USE_MAX_RUNS && stats.openIssues === 0) return "low_use";
  return "active";
}

export function buildRoster(stats: RosterStats[], now: Date): Roster {
  const rows = stats.map((agent): RosterRow => {
    const usage = usageOf(agent, now);
    const flagged = usage === "idle" || usage === "low_use";
    return { ...agent, usage, verdict: flagged && agent.keep ? "kept" : usage };
  });
  rows.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.name.localeCompare(b.name));
  const flagged = rows.filter((row) => row.verdict === "idle" || row.verdict === "low_use");
  return {
    rows,
    summary: {
      agentCount: rows.length,
      idleCount: rows.filter((row) => row.verdict === "idle").length,
      lowUseCount: rows.filter((row) => row.verdict === "low_use").length,
      keptCount: rows.filter((row) => row.verdict === "kept").length,
      flaggedCostCentsLast30Days: flagged.reduce((total, row) => total + row.costCentsLast30Days, 0),
    },
  };
}

type Db = Pick<PluginContext["db"], "namespace" | "query">;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string | Date).toISOString();
}

function byAgent<T extends { agent_id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.agent_id, row]));
}

// The host's plugin SQL allows only a short list of functions (no sum or
// coalesce), so cost is avg times count, and missing rows become zero here.
export async function readRosterStats(db: Db, companyId: string, now: Date): Promise<RosterStats[]> {
  const since30 = new Date(now.getTime() - IDLE_AGENT_DAYS * DAY_MS).toISOString();
  const since90 = new Date(now.getTime() - LONG_WINDOW_DAYS * DAY_MS).toISOString();
  const [agents, runs, costs, issues, marks] = await Promise.all([
    db.query<{ id: string; name: string; role: string; title: string | null; status: string; created_at: string }>(
      "SELECT id, name, role, title, status, created_at FROM public.agents WHERE company_id = $1 AND status <> 'terminated'",
      [companyId],
    ),
    db.query<{ agent_id: string; last_run_at: string | null; runs_30: string | number; runs_90: string | number }>(
      `SELECT agent_id, max(started_at) AS last_run_at,
              count(*) FILTER (WHERE started_at >= $2) AS runs_30,
              count(*) FILTER (WHERE started_at >= $3) AS runs_90
         FROM public.heartbeat_runs WHERE company_id = $1 GROUP BY agent_id`,
      [companyId, since30, since90],
    ),
    db.query<{ agent_id: string; avg_cents: string | number; events: string | number }>(
      `SELECT agent_id, avg(cost_cents) AS avg_cents, count(*) AS events
         FROM public.cost_events WHERE company_id = $1 AND occurred_at >= $2 GROUP BY agent_id`,
      [companyId, since30],
    ),
    db.query<{ agent_id: string; open_issues: string | number }>(
      `SELECT assignee_agent_id AS agent_id, count(*) AS open_issues
         FROM public.issues
        WHERE company_id = $1 AND assignee_agent_id IS NOT NULL AND status NOT IN ('done', 'cancelled')
        GROUP BY assignee_agent_id`,
      [companyId],
    ),
    db.query<{ agent_id: string; note: string; marked_by: string | null; marked_at: string }>(
      `SELECT agent_id, note, marked_by, marked_at FROM ${db.namespace}.keep_marks WHERE company_id = $1`,
      [companyId],
    ),
  ]);
  const runsBy = byAgent(runs);
  const costsBy = byAgent(costs);
  const issuesBy = byAgent(issues);
  const marksBy = byAgent(marks);
  return agents.map((agent) => {
    const run = runsBy.get(agent.id);
    const cost = costsBy.get(agent.id);
    const mark = marksBy.get(agent.id);
    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      createdAt: iso(agent.created_at)!,
      lastRunAt: iso(run?.last_run_at),
      runsLast30Days: Number(run?.runs_30 ?? 0),
      runsLast90Days: Number(run?.runs_90 ?? 0),
      costCentsLast30Days: cost ? Math.round(Number(cost.avg_cents) * Number(cost.events)) : 0,
      openIssues: Number(issuesBy.get(agent.id)?.open_issues ?? 0),
      keep: mark ? { note: mark.note, markedBy: mark.marked_by, markedAt: iso(mark.marked_at)! } : null,
    };
  });
}
