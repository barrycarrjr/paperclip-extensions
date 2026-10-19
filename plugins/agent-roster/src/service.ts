import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { DAY_MS, ROSTER_THRESHOLDS, verdict, type RosterData, type RosterRow } from "./roster.js";

export class RosterError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function allowed(ctx: PluginContext, companyId: string): Promise<boolean> {
  const config = await ctx.config.get();
  const list = config?.allowedCompanies;
  return Boolean(companyId && Array.isArray(list) && list.length > 0
    && list.every((id) => typeof id === "string" && id.length > 0)
    && (list.includes("*") || list.includes(companyId)));
}
async function authorize(ctx: PluginContext, companyId: string): Promise<void> {
  if (!await allowed(ctx, companyId)) throw new RosterError(403, "Agent roster is not enabled for this company. Select it in plugin Configuration.");
}
export async function bridgeCompany(ctx: PluginContext, params: Record<string, unknown>): Promise<string> {
  const scope = params.hostScope as { companyId?: unknown } | undefined;
  const id = scope?.companyId;
  if (typeof id !== "string" || !id || (params.companyId !== undefined && params.companyId !== id)) {
    throw new RosterError(403, "A matching host-verified company is required.");
  }
  await authorize(ctx, id);
  return id;
}

export const COMPANY_PREFIX_SQL = "SELECT issue_prefix FROM public.companies WHERE id = $1";
export async function readCompanyPrefix(ctx: PluginContext, companyId: string): Promise<string> {
  await authorize(ctx, companyId);
  const [company] = await ctx.db.query<{ issue_prefix: string }>(COMPANY_PREFIX_SQL, [companyId]);
  if (!company?.issue_prefix) throw new RosterError(502, "The host did not return this company's route prefix.");
  return company.issue_prefix;
}

// Aggregate separately to avoid multiplying runs, costs and issues in joins.
export const ROSTER_SQL = `SELECT a.id, a.name, a.role, a.status, a.created_at, a.last_heartbeat_at,
  (SELECT MAX(h.started_at) FROM public.heartbeat_runs h WHERE h.company_id = $1 AND h.agent_id = a.id AND h.started_at <= $2) AS last_run_at,
  (SELECT COUNT(*) FROM public.heartbeat_runs h WHERE h.company_id = $1 AND h.agent_id = a.id AND h.started_at >= $3 AND h.started_at <= $2) AS runs30,
  (SELECT COUNT(*) FROM public.heartbeat_runs h WHERE h.company_id = $1 AND h.agent_id = a.id AND h.started_at >= $4 AND h.started_at <= $2) AS runs90,
  (SELECT jsonb_agg(c.cost_cents) FROM public.cost_events c WHERE c.company_id = $1 AND c.agent_id = a.id AND c.occurred_at >= $3 AND c.occurred_at <= $2) AS costs_cents30,
  (SELECT COUNT(*) FROM public.issues i WHERE i.company_id = $1 AND i.assignee_agent_id = a.id AND i.status NOT IN ('done', 'cancelled') AND i.hidden_at IS NULL) AS open_issues
  FROM public.agents a WHERE a.company_id = $1 AND a.status <> 'terminated'`;

interface DbRow {
  id: string; name: string; role: string; status: string; created_at: string | Date;
  last_heartbeat_at: string | Date | null; last_run_at: string | Date | null;
  runs30: number | string; runs90: number | string; costs_cents30: Array<number | string> | null; open_issues: number | string;
}
const iso = (date: string | Date | null) => date === null ? null : new Date(date).toISOString();
export async function readRoster(ctx: PluginContext, companyId: string, now = new Date()): Promise<RosterData> {
  await authorize(ctx, companyId);
  const rows = await ctx.db.query<DbRow>(ROSTER_SQL, [companyId, now.toISOString(), new Date(+now - ROSTER_THRESHOLDS.idleDays * DAY_MS).toISOString(), new Date(+now - ROSTER_THRESHOLDS.historyDays * DAY_MS).toISOString()]);
  const result = rows.map((item): RosterRow => {
    const row = { id: item.id, name: item.name, role: item.role, status: item.status,
      createdAt: iso(item.created_at)!, lastRunAt: iso(item.last_run_at), lastHeartbeatAt: iso(item.last_heartbeat_at),
      // The host permits jsonb_agg but does not allow SUM in plugin SQL.
      runs30: Number(item.runs30), runs90: Number(item.runs90), costCents30: (item.costs_cents30 ?? []).reduce<number>((total, cents) => total + Number(cents), 0), openIssues: Number(item.open_issues) };
    return { ...row, verdict: verdict(row, +now) };
  });
  const order = { Idle: 0, "Low use": 1, Active: 2, New: 3 };
  result.sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const idle = result.filter((row) => row.verdict === "Idle");
  return { companyId, generatedAt: now.toISOString(), rows: result, idleCount: idle.length, idleCostCents30: idle.reduce((sum, row) => sum + row.costCents30, 0) };
}

export async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    // Actor and company are stamped by the host, never taken from the body.
    if (input.actor.actorType !== "user" || !input.actor.actorId) throw new RosterError(403, "Only the board can access the agent roster.");
    await authorize(ctx, input.companyId);
    if (input.routeKey === "roster.list" && input.method === "GET") return { status: 200, body: await readRoster(ctx, input.companyId) };
    if (input.routeKey !== "roster.pause" || input.method !== "POST") throw new RosterError(404, "Roster route not found.");
    if (input.actor.grantedPermission !== "agents:create") throw new RosterError(403, "The host must authorize agents:create before pausing an agent.");
    const body = input.body as { confirmed?: unknown; requestId?: unknown } | null;
    if (body?.confirmed !== true || typeof body.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(body.requestId)) throw new RosterError(400, "Confirm the pause and supply a request ID.");
    const agentId = input.params.agentId;
    if (!agentId) throw new RosterError(400, "Agent ID is required.");
    const agent = await ctx.agents.get(agentId, input.companyId);
    if (!agent || agent.companyId !== input.companyId) throw new RosterError(404, "Agent not found in this company.");
    if (agent.status === "terminated" || agent.status === "pending_approval") throw new RosterError(409, "This agent cannot be paused from the roster.");
    const entry = { companyId: input.companyId, entityType: "agent", entityId: agentId, metadata: { requestedByUserId: input.actor.userId ?? input.actor.actorId, requestId: body.requestId } };
    // Fail closed if the request cannot be audited before changing an agent.
    // Each HTTP attempt is audited, including a retry after another operator
    // resumed the agent. Deduplicating logs by request ID could hide that pause.
    await ctx.activity.log({ ...entry, message: "agent_roster.pause_requested" });
    if (agent.status !== "paused") {
      const paused = await ctx.agents.pause(agentId, input.companyId);
      if (!paused || paused.companyId !== input.companyId || paused.status !== "paused") throw new RosterError(502, "The host did not confirm the pause. Refresh the agent status before retrying.");
    }
    try {
      await ctx.activity.log({ ...entry, message: "agent_roster.pause_completed" });
    } catch {
      return { status: 502, body: { error: "Agent is paused, but completion logging failed. Retry with the same request ID to finish logging; the pause request is already recorded.", paused: true } };
    }
    return { status: 200, body: { paused: true } };
  } catch (error) {
    if (error instanceof RosterError) return { status: error.status, body: { error: error.message } };
    ctx.logger.error("Agent roster request failed", { routeKey: input.routeKey });
    return { status: 503, body: { error: "Agent roster could not complete this request. Refresh the agent status before retrying; check the plugin worker health and permissions." } };
  }
}
