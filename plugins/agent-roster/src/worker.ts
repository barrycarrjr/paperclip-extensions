import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { isCompanyAllowed, type RosterConfig } from "./company-access.js";
import { buildRoster, readRosterStats, type Roster, type RosterSummary } from "./roster.js";

const MAX_NOTE_LENGTH = 500;

interface HostScope {
  companyId: string;
  userId: string | null;
  isInstanceAdmin: boolean;
}

export class RosterError extends Error {}

// hostScope is stamped by the host after it checks the caller's access to the
// company, and the host drops any hostScope an agent sends. Params the page
// sends are never used to pick the company.
function hostScopeOf(params: Record<string, unknown>): HostScope | null {
  const scope = params.hostScope as Partial<HostScope> | undefined;
  if (!scope || typeof scope.companyId !== "string" || scope.companyId.length === 0) return null;
  return {
    companyId: scope.companyId,
    userId: typeof scope.userId === "string" ? scope.userId : null,
    isInstanceAdmin: scope.isInstanceAdmin === true,
  };
}

async function allowedScope(ctx: PluginContext, params: Record<string, unknown>): Promise<HostScope | null> {
  const scope = hostScopeOf(params);
  if (!scope) return null;
  const config = (await ctx.config.get()) as RosterConfig;
  return isCompanyAllowed(config.allowedCompanies, scope.companyId) ? scope : null;
}

async function requireAllowedScope(ctx: PluginContext, params: Record<string, unknown>): Promise<HostScope> {
  const scope = await allowedScope(ctx, params);
  if (!scope) throw new RosterError("Agent roster is not enabled for this company. Select it in the plugin settings.");
  return scope;
}

function agentIdOf(params: Record<string, unknown>): string {
  const agentId = params.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) throw new RosterError("agentId is required.");
  return agentId;
}

async function requireAgentInCompany(ctx: PluginContext, companyId: string, agentId: string) {
  const rows = await ctx.db.query<{ id: string; name: string; status: string }>(
    "SELECT id, name, status FROM public.agents WHERE id = $1 AND company_id = $2",
    [agentId, companyId],
  );
  const agent = rows[0];
  if (!agent || agent.status === "terminated") throw new RosterError("That agent is not in this company.");
  return agent;
}

async function readRoster(ctx: PluginContext, companyId: string): Promise<Roster> {
  const now = new Date();
  return buildRoster(await readRosterStats(ctx.db, companyId, now), now);
}

async function pauseAgent(ctx: PluginContext, params: Record<string, unknown>) {
  const scope = await requireAllowedScope(ctx, params);
  if (!scope.isInstanceAdmin) throw new RosterError("Only an instance admin can pause an agent from the roster.");
  const agent = await requireAgentInCompany(ctx, scope.companyId, agentIdOf(params));
  if (agent.status === "paused") return { agentId: agent.id, status: "paused", alreadyPaused: true };
  const paused = await ctx.agents.pause(agent.id, scope.companyId);
  await ctx.activity.log({
    companyId: scope.companyId,
    message: `Paused agent ${agent.name} from the agent roster`,
    entityType: "agent",
    entityId: agent.id,
    metadata: { action: "roster.pause-agent", requestedByUserId: scope.userId, previousStatus: agent.status },
  });
  return { agentId: agent.id, status: paused.status, alreadyPaused: false };
}

async function keepAgent(ctx: PluginContext, params: Record<string, unknown>) {
  const scope = await requireAllowedScope(ctx, params);
  const agent = await requireAgentInCompany(ctx, scope.companyId, agentIdOf(params));
  const note = typeof params.note === "string" ? params.note.trim() : "";
  if (note.length === 0) throw new RosterError("Say why this agent is kept, so the next review knows.");
  if (note.length > MAX_NOTE_LENGTH) throw new RosterError(`Keep the note under ${MAX_NOTE_LENGTH} characters.`);
  await ctx.db.execute(
    `INSERT INTO ${ctx.db.namespace}.keep_marks (company_id, agent_id, note, marked_by, marked_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (company_id, agent_id) DO UPDATE SET note = $3, marked_by = $4, marked_at = now()`,
    [scope.companyId, agent.id, note, scope.userId],
  );
  await ctx.activity.log({
    companyId: scope.companyId,
    message: `Marked agent ${agent.name} as kept on purpose in the agent roster`,
    entityType: "agent",
    entityId: agent.id,
    metadata: { action: "roster.keep-agent", requestedByUserId: scope.userId, note },
  });
  return { agentId: agent.id, kept: true };
}

async function unkeepAgent(ctx: PluginContext, params: Record<string, unknown>) {
  const scope = await requireAllowedScope(ctx, params);
  const agent = await requireAgentInCompany(ctx, scope.companyId, agentIdOf(params));
  const { rowCount } = await ctx.db.execute(
    `DELETE FROM ${ctx.db.namespace}.keep_marks WHERE company_id = $1 AND agent_id = $2`,
    [scope.companyId, agent.id],
  );
  if (rowCount > 0) {
    await ctx.activity.log({
      companyId: scope.companyId,
      message: `Removed the keep mark from agent ${agent.name} in the agent roster`,
      entityType: "agent",
      entityId: agent.id,
      metadata: { action: "roster.unkeep-agent", requestedByUserId: scope.userId },
    });
  }
  return { agentId: agent.id, kept: false };
}

export const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.data.register("roster.sidebar-visible", async (params) => ({ visible: (await allowedScope(ctx, params)) !== null }));
    ctx.data.register("roster.list", async (params) => {
      const scope = await requireAllowedScope(ctx, params);
      return { roster: await readRoster(ctx, scope.companyId), canPause: scope.isInstanceAdmin };
    });
    ctx.data.register("roster.summary", async (params): Promise<{ enabled: false } | { enabled: true; summary: RosterSummary }> => {
      const scope = await allowedScope(ctx, params);
      if (!scope) return { enabled: false };
      return { enabled: true, summary: (await readRoster(ctx, scope.companyId)).summary };
    });
    ctx.actions.register("roster.pause-agent", (params) => pauseAgent(ctx, params));
    ctx.actions.register("roster.keep-agent", (params) => keepAgent(ctx, params));
    ctx.actions.register("roster.unkeep-agent", (params) => unkeepAgent(ctx, params));
    const config = (await ctx.config.get()) as RosterConfig;
    if (!config.allowedCompanies?.length) ctx.logger.warn("Agent roster denies every company until allowedCompanies is configured.");
  },
  async onHealth() {
    return { status: "ok", message: "Agent roster ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
