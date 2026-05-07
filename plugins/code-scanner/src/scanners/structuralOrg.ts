import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fingerprint } from "./fingerprint.js";

export const STRUCTURAL_FINDING_KINDS = [
  "orphan_no_manager",
  "idle_agent",
] as const;
export type StructuralFindingKind = (typeof STRUCTURAL_FINDING_KINDS)[number];

export interface StructuralFinding {
  kind: StructuralFindingKind;
  fingerprint: string;
  severity: "low" | "medium" | "high";
  subjectType: "agent";
  subjectId: string;
  companyId: string;
  companyName: string;
  agentName: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface StructuralOrgOptions {
  newAgentGraceDays: number;
  idleAgentDays: number;
  rootRoles: string[];
  kinds?: StructuralFindingKind[];
}

const DEFAULT_OPTIONS: StructuralOrgOptions = {
  newAgentGraceDays: 7,
  idleAgentDays: 30,
  rootRoles: ["ceo"],
};

function dayCutoff(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === "string" ? Date.parse(value) : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export async function runStructuralOrgScan(
  ctx: PluginContext,
  optsInput: Partial<StructuralOrgOptions> = {},
): Promise<StructuralFinding[]> {
  const opts: StructuralOrgOptions = { ...DEFAULT_OPTIONS, ...optsInput };
  const requestedKinds = new Set<StructuralFindingKind>(
    opts.kinds && opts.kinds.length > 0 ? opts.kinds : STRUCTURAL_FINDING_KINDS,
  );
  const rootRoles = new Set(opts.rootRoles.map((r) => r.toLowerCase()));

  const findings: StructuralFinding[] = [];
  const newAgentCutoff = dayCutoff(opts.newAgentGraceDays);
  const idleCutoff = dayCutoff(opts.idleAgentDays);

  const companies = await ctx.companies.list();
  for (const company of companies) {
    let agents;
    try {
      agents = await ctx.agents.list({ companyId: company.id, limit: 500 });
    } catch (err) {
      ctx.logger.warn("structural-org: agents.list failed for company", {
        companyId: company.id,
        error: (err as Error).message,
      });
      continue;
    }

    for (const agent of agents) {
      const status = String(agent.status ?? "");
      if (status === "archived" || status === "terminated") continue;

      const createdMs = toMillis(agent.createdAt);
      const heartbeatMs = toMillis(agent.lastHeartbeatAt);
      const role = String(agent.role ?? "").toLowerCase();
      const matureAgent = createdMs !== null && createdMs <= newAgentCutoff;

      if (
        requestedKinds.has("orphan_no_manager") &&
        matureAgent &&
        !agent.reportsTo &&
        !rootRoles.has(role)
      ) {
        findings.push({
          kind: "orphan_no_manager",
          fingerprint: fingerprint("orphan-no-manager", agent.id),
          severity: "low",
          subjectType: "agent",
          subjectId: agent.id,
          companyId: company.id,
          companyName: company.name,
          agentName: agent.name,
          summary: `Agent ${agent.name} (${role}) has no manager`,
          detail: {
            agentId: agent.id,
            role,
            createdAt: agent.createdAt instanceof Date ? agent.createdAt.toISOString() : agent.createdAt,
            recommendation:
              "Set reportsTo to the appropriate parent agent, or archive the agent if it's no longer needed.",
          },
        });
      }

      if (requestedKinds.has("idle_agent") && matureAgent) {
        const heartbeatStale = heartbeatMs === null || heartbeatMs < idleCutoff;
        if (heartbeatStale) {
          findings.push({
            kind: "idle_agent",
            fingerprint: fingerprint("idle-agent", agent.id),
            severity: "low",
            subjectType: "agent",
            subjectId: agent.id,
            companyId: company.id,
            companyName: company.name,
            agentName: agent.name,
            summary: `Agent ${agent.name} has had no heartbeat in ${opts.idleAgentDays}+ days`,
            detail: {
              agentId: agent.id,
              role,
              status,
              lastHeartbeatAt:
                agent.lastHeartbeatAt instanceof Date
                  ? agent.lastHeartbeatAt.toISOString()
                  : (agent.lastHeartbeatAt ?? null),
              recommendation:
                "Archive or repurpose — extended inactivity usually means the role no longer matches the work.",
            },
          });
        }
      }
    }
  }

  return findings;
}
