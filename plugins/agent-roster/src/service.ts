import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { DAY_MS, ROSTER_THRESHOLDS, usageOf, verdict, type KeepMark, type RosterData, type RosterRow } from "./roster.js";
import { isCompanyAllowed } from "./company-access.js";

export class RosterError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function allowed(ctx: PluginContext, companyId: string): Promise<boolean> {
  const config = await ctx.config.get();
  return isCompanyAllowed(config?.allowedCompanies, companyId);
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
  const marks = await ctx.db.query<{ agent_id: string; note: string; marked_by: string | null; marked_at: string | Date }>(
    `SELECT agent_id, note, marked_by, marked_at FROM ${ctx.db.namespace}.keep_marks WHERE company_id = $1`, [companyId]);
  const keeps = new Map<string, KeepMark>(marks.map((mark) => [mark.agent_id, { note: mark.note, markedBy: mark.marked_by, markedAt: iso(mark.marked_at)! }]));
  const rows = await ctx.db.query<DbRow>(ROSTER_SQL, [companyId, now.toISOString(), new Date(+now - ROSTER_THRESHOLDS.idleDays * DAY_MS).toISOString(), new Date(+now - ROSTER_THRESHOLDS.historyDays * DAY_MS).toISOString()]);
  const result = rows.map((item): RosterRow => {
    const row = { id: item.id, name: item.name, role: item.role, status: item.status,
      createdAt: iso(item.created_at)!, lastRunAt: iso(item.last_run_at), lastHeartbeatAt: iso(item.last_heartbeat_at),
      // The host permits jsonb_agg but does not allow SUM in plugin SQL.
      runs30: Number(item.runs30), runs90: Number(item.runs90), costCents30: (item.costs_cents30 ?? []).reduce<number>((total, cents) => total + Number(cents), 0), openIssues: Number(item.open_issues) };
    const keptRow = { ...row, keep: keeps.get(item.id) ?? null };
    return { ...keptRow, usage: usageOf(keptRow, +now), verdict: verdict(keptRow, +now) };
  });
  const order = { Idle: 0, "Low use": 1, "Kept on purpose": 2, Active: 3, New: 4 };
  result.sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const idle = result.filter((row) => row.verdict === "Idle");
  return { companyId, generatedAt: now.toISOString(), rows: result, idleCount: idle.length, idleCostCents30: idle.reduce((sum, row) => sum + row.costCents30, 0) };
}

export async function handleApiRequest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  try {
    if (input.actor.actorType !== "user" || !input.actor.actorId) throw new RosterError(403, "Only the board can access the agent roster.");
    await authorize(ctx, input.companyId);
    if (input.routeKey === "roster.list" && input.method === "GET") return { status: 200, body: await readRoster(ctx, input.companyId) };
    // Scoped API actors have a permission stamp, but no current admin attestation.
    // Keep the old route fail closed. Only the host-stamped action may pause.
    if (input.routeKey === "roster.pause") throw new RosterError(403, "Pause requires the instance-admin roster action.");
    throw new RosterError(404, "Roster route not found.");
  } catch (error) { return errorResponse(ctx, error); }
}

function errorResponse(ctx: PluginContext, error: unknown): PluginApiResponse {
  if (error instanceof RosterError) return { status: error.status, body: { error: error.message } };
  ctx.logger.error("Agent roster request failed");
  return { status: 503, body: { error: "Agent roster could not complete this request. Refresh the agent status before retrying; check the plugin worker health and permissions." } };
}

export async function handlePauseAction(ctx: PluginContext, params: Record<string, unknown>): Promise<PluginApiResponse> {
  try {
    const companyId = await bridgeCompany(ctx, params);
    const scope = params.hostScope as { userId?: unknown; isInstanceAdmin?: unknown };
    // The host rechecks this flag on every action. Admins have the host's
    // agents:create exemption. A company grant alone must not broaden PR14.
    if (scope.isInstanceAdmin !== true || typeof scope.userId !== "string" || !scope.userId) throw new RosterError(403, "Only an instance admin can pause an agent from the roster.");
    const input = { companyId, params: { agentId: typeof params.agentId === "string" ? params.agentId : "" }, body: params,
      actor: { userId: scope.userId, actorId: scope.userId } };
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
  } catch (error) { return errorResponse(ctx, error); }
}

export const MAX_KEEP_NOTE_LENGTH = 500;
export async function changeKeep(ctx: PluginContext, params: Record<string, unknown>, kept: boolean) {
  const companyId = await bridgeCompany(ctx, params);
  const scope = params.hostScope as { userId?: unknown };
  if (typeof scope.userId !== "string" || !scope.userId) throw new RosterError(403, "Only the board can change keep marks.");
  const agentId = params.agentId;
  if (typeof agentId !== "string" || !agentId) throw new RosterError(400, "Agent ID is required.");
  const note = typeof params.note === "string" ? params.note.trim() : "";
  if (kept && (!note || note.length > MAX_KEEP_NOTE_LENGTH)) throw new RosterError(400, "Say why this agent is kept, using 1 to 500 characters.");
  const agent = await ctx.agents.get(agentId, companyId);
  if (!agent || agent.companyId !== companyId) throw new RosterError(404, "Agent not found in this company.");
  if (agent.status === "terminated") throw new RosterError(409, "This agent cannot be changed from the roster.");
  const action = kept ? "roster.keep-agent" : "roster.unkeep-agent";
  const entry = { companyId, entityType: "agent", entityId: agentId,
    metadata: { action, requestedByUserId: scope.userId } };
  // A failed audit must not cause an unaudited keep decision. The note stays
  // in the company-scoped table; audit records only the actor and reference.
  await ctx.activity.log({ ...entry, message: kept ? "agent_roster.keep_requested" : "agent_roster.unkeep_requested" });
  if (kept) {
    await ctx.db.execute(`INSERT INTO ${ctx.db.namespace}.keep_marks (company_id, agent_id, note, marked_by, marked_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (company_id, agent_id) DO UPDATE SET note = $3, marked_by = $4, marked_at = now()`,
      [companyId, agentId, note, scope.userId]);
  } else {
    await ctx.db.execute(`DELETE FROM ${ctx.db.namespace}.keep_marks WHERE company_id = $1 AND agent_id = $2`, [companyId, agentId]);
  }
  try {
    await ctx.activity.log({ ...entry, message: kept ? "agent_roster.keep_completed" : "agent_roster.unkeep_completed" });
  } catch {
    throw new RosterError(502, "Keep decision saved, but completion logging failed. Refresh the roster and retry to finish logging.");
  }
  return { agentId, kept };
}
