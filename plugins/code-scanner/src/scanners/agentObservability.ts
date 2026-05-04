import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fingerprint } from "./fingerprint.js";

export interface AgentObservabilityFinding {
  companyId: string;
  companyName: string;
  agentId: string;
  agentName: string;
  kind: "paused" | "stale-heartbeat" | "error-status";
  detail: string;
  lastHeartbeatAt: string | null;
  fingerprint: string;
}

export interface AgentObservabilityOptions {
  staleHoursThreshold: number;
  includeIdleStatuses: boolean;
}

export async function runAgentObservability(
  ctx: PluginContext,
  opts: AgentObservabilityOptions,
): Promise<AgentObservabilityFinding[]> {
  const findings: AgentObservabilityFinding[] = [];
  const staleMs = opts.staleHoursThreshold * 60 * 60 * 1000;
  const now = Date.now();

  const companies = await ctx.companies.list();
  for (const company of companies) {
    let agents;
    try {
      agents = await ctx.agents.list({ companyId: company.id, limit: 200 });
    } catch (err) {
      ctx.logger.warn("agent_observability: companies.list returned a company we can't read", {
        companyId: company.id,
        error: (err as Error).message,
      });
      continue;
    }

    for (const agent of agents) {
      const status = String(agent.status ?? "");

      if (status === "paused") {
        findings.push({
          companyId: company.id,
          companyName: company.name,
          agentId: agent.id,
          agentName: agent.name,
          kind: "paused",
          detail: `Agent is paused${agent.pauseReason ? `: ${agent.pauseReason}` : ""}`,
          lastHeartbeatAt: agent.lastHeartbeatAt
            ? new Date(agent.lastHeartbeatAt).toISOString()
            : null,
          fingerprint: fingerprint("agent-paused", agent.id),
        });
        continue;
      }

      if (status === "error" || status === "errored" || status === "failed") {
        findings.push({
          companyId: company.id,
          companyName: company.name,
          agentId: agent.id,
          agentName: agent.name,
          kind: "error-status",
          detail: `Agent is in error status: ${status}`,
          lastHeartbeatAt: agent.lastHeartbeatAt
            ? new Date(agent.lastHeartbeatAt).toISOString()
            : null,
          fingerprint: fingerprint("agent-error", agent.id),
        });
        continue;
      }

      if (!opts.includeIdleStatuses && status === "idle") continue;

      if (agent.lastHeartbeatAt) {
        const heartbeatMs =
          typeof agent.lastHeartbeatAt === "string"
            ? Date.parse(agent.lastHeartbeatAt)
            : new Date(agent.lastHeartbeatAt).getTime();
        if (Number.isFinite(heartbeatMs) && now - heartbeatMs > staleMs) {
          const ageHours = Math.floor((now - heartbeatMs) / (60 * 60 * 1000));
          findings.push({
            companyId: company.id,
            companyName: company.name,
            agentId: agent.id,
            agentName: agent.name,
            kind: "stale-heartbeat",
            detail: `lastHeartbeatAt is ${ageHours}h old (status=${status})`,
            lastHeartbeatAt: new Date(heartbeatMs).toISOString(),
            fingerprint: fingerprint("agent-stale-heartbeat", agent.id),
          });
        }
      }
    }
  }

  return findings;
}
