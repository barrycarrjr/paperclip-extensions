/**
 * Per-assistant daily cost cap.
 *
 * State key: `assistants:cost-window:<agentId>:<YYYY-MM-DD>` → running USD total.
 * Reset key boundaries: midnight UTC. Operator-timezone reset is a Phase B
 * enhancement once we ship a per-operator timezone setting.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";

export const DEFAULT_DAILY_CAP_USD = 10;

function todayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function stateKeyFor(agentId: string, date: Date = new Date()): string {
  return `assistants:cost-window:${agentId}:${todayKey(date)}`;
}

export interface CostWindowReadResult {
  capUsd: number;
  todaySpentUsd: number;
}

export async function readCostWindow(
  ctx: PluginContext,
  agentId: string,
): Promise<CostWindowReadResult> {
  const config = await readPhoneConfig(ctx, agentId);
  const capUsd = typeof config?.costCapDailyUsd === "number" && Number.isFinite(config.costCapDailyUsd)
    ? Math.max(0, config.costCapDailyUsd)
    : DEFAULT_DAILY_CAP_USD;
  const stored = await ctx.state.get({
    scopeKind: "agent",
    scopeId: agentId,
    stateKey: stateKeyFor(agentId),
  });
  const todaySpentUsd = typeof stored === "number" && Number.isFinite(stored)
    ? Math.max(0, stored)
    : 0;
  return { capUsd, todaySpentUsd };
}

export async function assertWithinCap(
  ctx: PluginContext,
  agentId: string,
): Promise<CostWindowReadResult> {
  const window = await readCostWindow(ctx, agentId);
  if (window.capUsd > 0 && window.todaySpentUsd >= window.capUsd) {
    throw new Error(
      `[ECOST_CAP] Daily phone cost cap reached for assistant ${agentId} ($${window.todaySpentUsd.toFixed(2)} / $${window.capUsd.toFixed(2)}). Resets at UTC midnight.`,
    );
  }
  return window;
}

export async function recordSpend(
  ctx: PluginContext,
  agentId: string,
  costUsd: number,
): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  const stored = await ctx.state.get({
    scopeKind: "agent",
    scopeId: agentId,
    stateKey: stateKeyFor(agentId),
  });
  const previous = typeof stored === "number" && Number.isFinite(stored) ? Math.max(0, stored) : 0;
  await ctx.state.set(
    {
      scopeKind: "agent",
      scopeId: agentId,
      stateKey: stateKeyFor(agentId),
    },
    previous + costUsd,
  );
}

// ---------------------------------------------------------------------------
// Per-agent phone config — shape mirrored to plugin state.
// ---------------------------------------------------------------------------

export interface PhoneConfig {
  voice?: string;
  callerIdNumberId?: string;
  costCapDailyUsd?: number;
  enabled?: boolean;
  vapiAssistantId?: string;
  firstMessage?: string;
  systemPrompt?: string;
  account?: string;
  wizardAnswers?: Record<string, unknown>;
  guardrails?: Record<string, unknown>;
}

function configStateKey(agentId: string): string {
  return `phone-config:${agentId}`;
}

export async function readPhoneConfig(
  ctx: PluginContext,
  agentId: string,
): Promise<PhoneConfig | null> {
  const value = await ctx.state.get({
    scopeKind: "agent",
    scopeId: agentId,
    stateKey: configStateKey(agentId),
  });
  if (!value || typeof value !== "object") return null;
  return value as PhoneConfig;
}

export async function writePhoneConfig(
  ctx: PluginContext,
  agentId: string,
  config: PhoneConfig,
): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "agent",
      scopeId: agentId,
      stateKey: configStateKey(agentId),
    },
    config,
  );
}
