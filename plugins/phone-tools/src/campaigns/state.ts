/**
 * State CRUD for campaigns / leads / DNC.
 *
 * All reads/writes go through `ctx.state` (instance scope). Helpers
 * here are the ONLY place that touches the state-key strings — every
 * worker tool and the runner skill go through these. Keeps the key
 * convention auditable in one file.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  Campaign,
  CampaignDailyCounters,
  CampaignLead,
  CampaignLeadStatus,
  DncEntry,
  DncList,
} from "./types.js";

// ─── Key builders ──────────────────────────────────────────────────────

function campaignKey(campaignId: string): string {
  return `campaign:${campaignId}`;
}

function campaignLeadKey(campaignId: string, phoneE164: string): string {
  return `campaign:${campaignId}:lead:${phoneE164}`;
}

function campaignLeadIndexKey(campaignId: string): string {
  return `campaign:${campaignId}:lead-index`;
}

function campaignCountersKey(campaignId: string, dateIso: string): string {
  return `campaign:${campaignId}:counters:${dateIso}`;
}

function companyCampaignsIndexKey(companyId: string): string {
  return `campaigns:${companyId}`;
}

function dncKey(accountKey: string): string {
  return `dnc:${accountKey}`;
}

function todayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

// ─── Campaigns ─────────────────────────────────────────────────────────

export async function readCampaign(
  ctx: PluginContext,
  campaignId: string,
): Promise<Campaign | null> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: campaignKey(campaignId),
  });
  return (value as Campaign | null) ?? null;
}

export async function writeCampaign(ctx: PluginContext, campaign: Campaign): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: campaignKey(campaign.id) },
    campaign,
  );
  await appendCompanyCampaignsIndex(ctx, campaign.companyId, campaign.id);
}

export async function listCompanyCampaigns(
  ctx: PluginContext,
  companyId: string,
): Promise<Campaign[]> {
  const ids = await readCompanyCampaignsIndex(ctx, companyId);
  const campaigns: Campaign[] = [];
  for (const id of ids) {
    const c = await readCampaign(ctx, id);
    if (c) campaigns.push(c);
  }
  return campaigns;
}

async function readCompanyCampaignsIndex(
  ctx: PluginContext,
  companyId: string,
): Promise<string[]> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: companyCampaignsIndexKey(companyId),
  });
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

async function appendCompanyCampaignsIndex(
  ctx: PluginContext,
  companyId: string,
  campaignId: string,
): Promise<void> {
  const existing = await readCompanyCampaignsIndex(ctx, companyId);
  if (existing.includes(campaignId)) return;
  existing.push(campaignId);
  await ctx.state.set(
    { scopeKind: "instance", stateKey: companyCampaignsIndexKey(companyId) },
    existing,
  );
}

// ─── Leads ─────────────────────────────────────────────────────────────

export async function readLead(
  ctx: PluginContext,
  campaignId: string,
  phoneE164: string,
): Promise<CampaignLead | null> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: campaignLeadKey(campaignId, phoneE164),
  });
  return (value as CampaignLead | null) ?? null;
}

export async function writeLead(ctx: PluginContext, lead: CampaignLead): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: campaignLeadKey(lead.campaignId, lead.phoneE164) },
    lead,
  );
  await appendLeadIndex(ctx, lead.campaignId, lead.phoneE164);
}

export async function readLeadIndex(
  ctx: PluginContext,
  campaignId: string,
): Promise<string[]> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: campaignLeadIndexKey(campaignId),
  });
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

async function appendLeadIndex(
  ctx: PluginContext,
  campaignId: string,
  phoneE164: string,
): Promise<void> {
  const existing = await readLeadIndex(ctx, campaignId);
  if (existing.includes(phoneE164)) return;
  existing.push(phoneE164);
  await ctx.state.set(
    { scopeKind: "instance", stateKey: campaignLeadIndexKey(campaignId) },
    existing,
  );
}

export async function listLeadsByStatus(
  ctx: PluginContext,
  campaignId: string,
): Promise<Record<CampaignLeadStatus, number>> {
  const phones = await readLeadIndex(ctx, campaignId);
  const counts: Record<CampaignLeadStatus, number> = {
    pending: 0,
    calling: 0,
    called: 0,
    "no-answer": 0,
    busy: 0,
    qualified: 0,
    disqualified: 0,
    transferred: 0,
    dnc: 0,
    voicemail: 0,
  };
  for (const p of phones) {
    const lead = await readLead(ctx, campaignId, p);
    if (lead) counts[lead.status] = (counts[lead.status] ?? 0) + 1;
  }
  return counts;
}

export async function listLeads(
  ctx: PluginContext,
  campaignId: string,
  filter?: { status?: CampaignLeadStatus; limit?: number },
): Promise<CampaignLead[]> {
  const phones = await readLeadIndex(ctx, campaignId);
  const out: CampaignLead[] = [];
  for (const p of phones) {
    const lead = await readLead(ctx, campaignId, p);
    if (!lead) continue;
    if (filter?.status && lead.status !== filter.status) continue;
    out.push(lead);
    if (filter?.limit && out.length >= filter.limit) break;
  }
  return out;
}

// ─── Counters ──────────────────────────────────────────────────────────

export async function readCounters(
  ctx: PluginContext,
  campaignId: string,
  date: Date = new Date(),
): Promise<CampaignDailyCounters> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: campaignCountersKey(campaignId, todayKey(date)),
  });
  if (value && typeof value === "object") return value as CampaignDailyCounters;
  return { attempted: 0, qualified: 0, disqualified: 0, noAnswer: 0, transferred: 0, costUsd: 0 };
}

export async function bumpCounter(
  ctx: PluginContext,
  campaignId: string,
  field: keyof CampaignDailyCounters,
  delta: number = 1,
): Promise<void> {
  const counters = await readCounters(ctx, campaignId);
  counters[field] = (counters[field] ?? 0) + delta;
  await ctx.state.set(
    { scopeKind: "instance", stateKey: campaignCountersKey(campaignId, todayKey()) },
    counters,
  );
}

// ─── DNC ───────────────────────────────────────────────────────────────

export async function readDncList(
  ctx: PluginContext,
  accountKey: string,
): Promise<DncList> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: dncKey(accountKey),
  });
  if (value && typeof value === "object" && Array.isArray((value as DncList).entries)) {
    return value as DncList;
  }
  return { accountKey, entries: [] };
}

export async function writeDncList(ctx: PluginContext, list: DncList): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: dncKey(list.accountKey) },
    list,
  );
}

export async function addDncEntry(
  ctx: PluginContext,
  accountKey: string,
  entry: DncEntry,
): Promise<{ added: boolean; alreadyPresent: boolean }> {
  const list = await readDncList(ctx, accountKey);
  if (list.entries.some((e) => e.phoneE164 === entry.phoneE164)) {
    return { added: false, alreadyPresent: true };
  }
  list.entries.push(entry);
  await writeDncList(ctx, list);
  return { added: true, alreadyPresent: false };
}

export async function checkDnc(
  ctx: PluginContext,
  accountKey: string,
  phoneE164: string,
): Promise<DncEntry | null> {
  const list = await readDncList(ctx, accountKey);
  return list.entries.find((e) => e.phoneE164 === phoneE164) ?? null;
}

export async function removeDncEntry(
  ctx: PluginContext,
  accountKey: string,
  phoneE164: string,
): Promise<{ removed: boolean }> {
  const list = await readDncList(ctx, accountKey);
  const before = list.entries.length;
  list.entries = list.entries.filter((e) => e.phoneE164 !== phoneE164);
  if (list.entries.length === before) return { removed: false };
  await writeDncList(ctx, list);
  return { removed: true };
}
