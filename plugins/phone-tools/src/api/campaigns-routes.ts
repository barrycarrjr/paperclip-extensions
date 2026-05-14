/**
 * HTTP routes backing the Campaigns UI page (v0.5.1).
 *
 * Mirrors the agent-tool surface — every route here wraps the same
 * campaign state CRUD that `phone_campaign_*` / `phone_lead_*` /
 * `phone_dnc_*` tools call. The split exists because the UI is
 * board-authed (operator's session cookie) while tools run under the
 * agent runtime. Both paths converge on the same `campaigns/state.ts`
 * helpers — no duplicated business logic.
 *
 * Mutation gating is enforced consistently: every mutation route
 * reads `allowMutations` from the plugin config and returns 403 if
 * disabled, matching the agent-side `gateMutation` check.
 */

import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { getResolvedAccount } from "../engines/registry.js";
import { assertPreflight } from "../campaigns/preflight.js";
import { normalizeToE164, parseCsv, rowToLead } from "../campaigns/csv.js";
import {
  DEFAULT_PACING,
  DEFAULT_RETRY,
  type Campaign,
  type CampaignLead,
  type CampaignLeadStatus,
  type CompliancePreflight,
} from "../campaigns/types.js";
import {
  addDncEntry,
  checkDnc,
  listCompanyCampaigns,
  listLeads,
  listLeadsByStatus,
  readCampaign,
  readCounters,
  readDncList,
  readLead,
  writeCampaign,
  writeLead,
} from "../campaigns/state.js";
import { readPhoneConfig } from "../assistants/cost-cap.js";
import type { InstanceConfig } from "../engines/types.js";

function ok(body: unknown): PluginApiResponse {
  return { status: 200, body };
}
function created(body: unknown): PluginApiResponse {
  return { status: 201, body };
}
function badRequest(message: string): PluginApiResponse {
  return { status: 400, body: { error: message } };
}
function notFound(message: string): PluginApiResponse {
  return { status: 404, body: { error: message } };
}
function forbidden(message: string): PluginApiResponse {
  return { status: 403, body: { error: message } };
}
function serverError(message: string): PluginApiResponse {
  return { status: 500, body: { error: message } };
}

function readBodyAsObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

async function assertMutationsAllowed(
  ctx: PluginContext,
): Promise<PluginApiResponse | null> {
  const cfg = (await ctx.config.get()) as InstanceConfig;
  if (cfg.allowMutations) return null;
  return forbidden(
    "[EDISABLED] Campaign mutations are disabled. Toggle 'Allow place-call / hangup / assistant mutations' on /instance/settings/plugins/phone-tools.",
  );
}

function generateCampaignId(): string {
  return `c_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function syntheticRunCtx(input: PluginApiRequestInput): ToolRunContext {
  return {
    agentId: input.actor.agentId ?? "",
    runId: input.actor.runId ?? "api-route",
    companyId: input.companyId,
    projectId: "",
  };
}

export async function handleCampaignsApi(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse | null> {
  switch (input.routeKey) {
    case "campaigns.list":
      return listCampaigns(ctx, input);
    case "campaigns.create":
      return createCampaign(ctx, input);
    case "campaigns.get":
      return getCampaign(ctx, input);
    case "campaigns.start":
      return startCampaign(ctx, input);
    case "campaigns.pause":
      return pauseCampaign(ctx, input);
    case "campaigns.resume":
      return resumeCampaign(ctx, input);
    case "campaigns.stop":
      return stopCampaign(ctx, input);
    case "campaigns.leads":
      return listCampaignLeads(ctx, input);
    case "campaigns.import-csv":
      return importCsv(ctx, input);
    case "campaigns.dnc.list":
      return dncList(ctx, input);
    case "campaigns.assistants":
      return eligibleAssistants(ctx, input);
    default:
      return null;
  }
}

// ─── Handlers ──────────────────────────────────────────────────────────

async function listCampaigns(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const all = await listCompanyCampaigns(ctx, input.companyId);
  const statusQuery = typeof input.query.status === "string" ? input.query.status : null;
  const filtered = statusQuery ? all.filter((c) => c.status === statusQuery) : all;
  // Enrich with today's counters and lead-status counts for the table.
  const enriched = await Promise.all(
    filtered.map(async (c) => {
      const counters = await readCounters(ctx, c.id);
      const leadsByStatus = await listLeadsByStatus(ctx, c.id);
      const totalLeads = Object.values(leadsByStatus).reduce((sum, n) => sum + (n ?? 0), 0);
      const done =
        (leadsByStatus.qualified ?? 0) +
        (leadsByStatus.disqualified ?? 0) +
        (leadsByStatus.transferred ?? 0) +
        (leadsByStatus.dnc ?? 0) +
        (leadsByStatus.voicemail ?? 0);
      return { campaign: c, counters, leadsByStatus, totalLeads, done };
    }),
  );
  return ok({ campaigns: enriched });
}

async function getCampaign(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const campaignId = input.params.campaignId;
  if (!campaignId) return badRequest("Missing campaignId.");
  const campaign = await readCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== input.companyId) {
    return notFound(`Campaign ${campaignId} not found.`);
  }
  const counters = await readCounters(ctx, campaign.id);
  const leadsByStatus = await listLeadsByStatus(ctx, campaign.id);
  return ok({ campaign, counters, leadsByStatus });
}

async function listCampaignLeads(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const campaignId = input.params.campaignId;
  if (!campaignId) return badRequest("Missing campaignId.");
  const campaign = await readCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== input.companyId) {
    return notFound(`Campaign ${campaignId} not found.`);
  }
  const statusQ = typeof input.query.status === "string" ? input.query.status : undefined;
  const limit = Number(input.query.limit ?? 200);
  const leads = await listLeads(ctx, campaignId, {
    status: statusQ as CampaignLeadStatus | undefined,
    limit: Number.isFinite(limit) ? Math.min(limit, 1000) : 200,
  });
  return ok({ leads });
}

async function createCampaign(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const gate = await assertMutationsAllowed(ctx);
  if (gate) return gate;

  const body = readBodyAsObject(input.body);
  const assistantAgentId = typeof body.assistantAgentId === "string" ? body.assistantAgentId : "";
  const name = typeof body.name === "string" ? body.name : "";
  const purpose = typeof body.purpose === "string" ? body.purpose : "";
  const preflight = body.preflight as CompliancePreflight | undefined;
  const accountKey = typeof body.account === "string" ? body.account : undefined;
  const pacing = body.pacing as Campaign["pacing"] | undefined;
  const retry = body.retry as Campaign["retry"] | undefined;
  const outcomeIssueProjectId =
    typeof body.outcomeIssueProjectId === "string" ? body.outcomeIssueProjectId : undefined;

  if (!assistantAgentId) return badRequest("assistantAgentId is required.");
  if (!name) return badRequest("name is required.");
  if (!purpose) return badRequest("purpose is required.");
  if (!preflight || typeof preflight !== "object") {
    return badRequest("preflight is required.");
  }

  let resolvedAccountKey = accountKey;
  try {
    const resolved = await getResolvedAccount(
      ctx,
      syntheticRunCtx(input),
      "campaigns-api",
      accountKey,
    );
    resolvedAccountKey = resolved.accountKey;
  } catch (err) {
    return badRequest((err as Error).message);
  }

  // Validate assistant has transferTarget on its phone config.
  const phoneCfg = await readPhoneConfig(ctx, assistantAgentId);
  if (!phoneCfg?.transferTarget) {
    return badRequest(
      "[ECAMPAIGN_NO_TRANSFER] Assistant has no transferTarget on its phone config. Configure warm transfer on the agent's Phone tab first.",
    );
  }

  const campaign: Campaign = {
    id: generateCampaignId(),
    companyId: input.companyId,
    accountKey: resolvedAccountKey!,
    assistantAgentId,
    name,
    purpose,
    preflight,
    pacing: { ...DEFAULT_PACING, ...(pacing ?? {}) },
    retry: { ...DEFAULT_RETRY, ...(retry ?? {}) },
    outcomeIssueProjectId: outcomeIssueProjectId ?? phoneCfg.transferIssueProjectId,
    status: "draft",
    createdAt: new Date().toISOString(),
    createdBy: input.actor.userId ?? input.actor.agentId ?? "operator",
  };

  // Validate preflight at creation (passes leadCount=1 because the
  // emptiness check applies at start time, not create time).
  try {
    assertPreflight(campaign.preflight, {
      assistantHasTransferTarget: true,
      leadCount: 1,
    });
  } catch (err) {
    return badRequest((err as Error).message);
  }

  await writeCampaign(ctx, campaign);
  return created({ campaign });
}

async function startCampaign(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const gate = await assertMutationsAllowed(ctx);
  if (gate) return gate;
  const campaignId = input.params.campaignId;
  if (!campaignId) return badRequest("Missing campaignId.");
  const campaign = await readCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== input.companyId) {
    return notFound(`Campaign ${campaignId} not found.`);
  }
  if (campaign.status !== "draft" && campaign.status !== "paused") {
    return badRequest(`[ECAMPAIGN_BAD_STATE] Cannot start from status '${campaign.status}'.`);
  }
  const phoneCfg = await readPhoneConfig(ctx, campaign.assistantAgentId);
  if (!phoneCfg?.transferTarget) {
    return badRequest("[ECAMPAIGN_NO_TRANSFER] Assistant's transferTarget was cleared since campaign creation.");
  }
  const leadCount = (await listLeads(ctx, campaign.id)).length;
  try {
    assertPreflight(campaign.preflight, {
      assistantHasTransferTarget: true,
      leadCount,
    });
  } catch (err) {
    return badRequest((err as Error).message);
  }
  const next: Campaign = {
    ...campaign,
    status: "running",
    startedAt: campaign.startedAt ?? new Date().toISOString(),
    pausedAt: undefined,
  };
  await writeCampaign(ctx, next);
  return ok({ campaign: next });
}

async function pauseCampaign(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const gate = await assertMutationsAllowed(ctx);
  if (gate) return gate;
  const campaignId = input.params.campaignId;
  if (!campaignId) return badRequest("Missing campaignId.");
  const campaign = await readCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== input.companyId) {
    return notFound(`Campaign ${campaignId} not found.`);
  }
  if (campaign.status !== "running") {
    return badRequest(`[ECAMPAIGN_BAD_STATE] Cannot pause from status '${campaign.status}'.`);
  }
  const next: Campaign = {
    ...campaign,
    status: "paused",
    pausedAt: new Date().toISOString(),
  };
  await writeCampaign(ctx, next);
  return ok({ campaign: next });
}

async function resumeCampaign(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const gate = await assertMutationsAllowed(ctx);
  if (gate) return gate;
  const campaignId = input.params.campaignId;
  if (!campaignId) return badRequest("Missing campaignId.");
  const campaign = await readCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== input.companyId) {
    return notFound(`Campaign ${campaignId} not found.`);
  }
  if (campaign.status !== "paused") {
    return badRequest(`[ECAMPAIGN_BAD_STATE] Cannot resume from status '${campaign.status}'.`);
  }
  const next: Campaign = { ...campaign, status: "running", pausedAt: undefined };
  await writeCampaign(ctx, next);
  return ok({ campaign: next });
}

async function stopCampaign(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const gate = await assertMutationsAllowed(ctx);
  if (gate) return gate;
  const campaignId = input.params.campaignId;
  if (!campaignId) return badRequest("Missing campaignId.");
  const campaign = await readCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== input.companyId) {
    return notFound(`Campaign ${campaignId} not found.`);
  }
  if (campaign.status === "stopped" || campaign.status === "completed") {
    return badRequest(`[ECAMPAIGN_BAD_STATE] Already in status '${campaign.status}'.`);
  }
  const body = readBodyAsObject(input.body);
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const pending = await listLeads(ctx, campaign.id, { status: "pending" });
  for (const lead of pending) {
    await writeLead(ctx, {
      ...lead,
      status: "disqualified",
      outcome: { summary: `campaign-stopped${reason ? `: ${reason}` : ""}`, transferred: false },
    });
  }
  const next: Campaign = { ...campaign, status: "stopped", stoppedAt: new Date().toISOString() };
  await writeCampaign(ctx, next);
  return ok({ campaign: next, disqualifiedCount: pending.length });
}

async function importCsv(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const gate = await assertMutationsAllowed(ctx);
  if (gate) return gate;
  const campaignId = input.params.campaignId;
  if (!campaignId) return badRequest("Missing campaignId.");
  const campaign = await readCampaign(ctx, campaignId);
  if (!campaign || campaign.companyId !== input.companyId) {
    return notFound(`Campaign ${campaignId} not found.`);
  }
  const body = readBodyAsObject(input.body);
  const csvText = typeof body.csvText === "string" ? body.csvText : "";
  const mapping = body.mapping as {
    phone?: string;
    name?: string;
    businessName?: string;
    website?: string;
    timezone?: string;
  } | undefined;
  if (!csvText) return badRequest("csvText is required.");
  if (!mapping?.phone) return badRequest("mapping.phone is required.");

  const parsed = parseCsv(csvText);
  if (parsed.rows.length === 0) return badRequest("[ECSV_EMPTY] CSV has no data rows.");
  if (parsed.rows.length > 10000) {
    return badRequest("[ECSV_TOO_LARGE] CSV has >10000 rows; split before importing.");
  }
  if (!parsed.headers.includes(mapping.phone)) {
    return badRequest(
      `[ECSV_BAD_MAPPING] CSV has no header named '${mapping.phone}'. Available: ${parsed.headers.join(", ")}.`,
    );
  }
  let added = 0;
  const skipped: Array<{ phone: string; reason: string }> = [];
  for (const row of parsed.rows) {
    const result = rowToLead(campaign.id, row, mapping as { phone: string });
    if (!result.ok || !result.lead) {
      skipped.push({ phone: row[mapping.phone] ?? "", reason: result.reason ?? "unknown" });
      continue;
    }
    const dnc = await checkDnc(ctx, campaign.accountKey, result.lead.phoneE164);
    if (dnc) {
      skipped.push({ phone: result.lead.phoneE164, reason: "dnc" });
      continue;
    }
    const existing = await readLead(ctx, campaign.id, result.lead.phoneE164);
    if (existing) {
      skipped.push({ phone: result.lead.phoneE164, reason: "duplicate" });
      continue;
    }
    await writeLead(ctx, result.lead);
    added++;
  }
  return ok({ added, skipped, total: parsed.rows.length });
}

async function dncList(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const accountKey = typeof input.query.account === "string" ? input.query.account : undefined;
  let resolvedAccountKey: string;
  try {
    const resolved = await getResolvedAccount(
      ctx,
      syntheticRunCtx(input),
      "campaigns-dnc",
      accountKey,
    );
    resolvedAccountKey = resolved.accountKey;
  } catch (err) {
    return badRequest((err as Error).message);
  }
  const list = await readDncList(ctx, resolvedAccountKey);
  return ok({ accountKey: resolvedAccountKey, entries: list.entries });
}

/**
 * List the company's `assistant`-role agents that have a
 * transferTarget configured (and thus are eligible to drive a
 * campaign). The wizard uses this to populate the assistant dropdown
 * — listing every agent regardless of phone config would surface
 * choices that fail compliance on submit.
 */
async function eligibleAssistants(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  // The SDK doesn't currently expose a per-company "list all agents"
  // method; we only have ctx.agents.get(id, companyId). Operators can
  // pass an explicit `ids` query param of agent UUIDs (comma-separated)
  // when they want pre-filtering. With no ids, we return an empty
  // list and surface a helper message — the wizard then falls back to
  // a free-text agentId input.
  const ids = typeof input.query.ids === "string" ? input.query.ids.split(",").filter(Boolean) : [];
  if (ids.length === 0) {
    return ok({
      assistants: [],
      note: "Pass ?ids=<agentId1>,<agentId2>,... to list specific candidates. Wizard can also accept a free-text agentId.",
    });
  }
  const results: Array<{
    agentId: string;
    name: string;
    transferTarget?: string;
    eligible: boolean;
    reason?: string;
  }> = [];
  for (const agentId of ids) {
    const agent = await ctx.agents.get(agentId, input.companyId).catch(() => null);
    if (!agent) {
      results.push({ agentId, name: "(not found)", eligible: false, reason: "agent-not-found" });
      continue;
    }
    if (String(agent.role) !== "assistant") {
      results.push({
        agentId,
        name: agent.name,
        eligible: false,
        reason: `role is '${agent.role}', not 'assistant'`,
      });
      continue;
    }
    const cfg = await readPhoneConfig(ctx, agentId);
    if (!cfg?.transferTarget) {
      results.push({
        agentId,
        name: agent.name,
        eligible: false,
        reason: "no transferTarget on phone config",
      });
      continue;
    }
    results.push({
      agentId,
      name: agent.name,
      transferTarget: cfg.transferTarget,
      eligible: true,
    });
  }
  return ok({ assistants: results });
}
