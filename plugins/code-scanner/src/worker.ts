import {
  definePlugin,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";
import { runSecretScan } from "./scanners/secret.js";
import { runDeadExportScan } from "./scanners/deadExports.js";
import { runTodoAgeScan } from "./scanners/todoAge.js";
import { runDocDriftScan } from "./scanners/docDrift.js";
import { runAgentObservability } from "./scanners/agentObservability.js";

interface RepoConfig {
  key?: string;
  displayName?: string;
  path?: string;
  allowedCompanies?: string[];
}

interface InstanceConfig {
  repos?: RepoConfig[];
  todoAgeMonths?: number;
  gitleaksBinary?: string;
  knipBinary?: string;
}

interface ResolvedRepo {
  key: string;
  path: string;
  displayName: string;
  allowedCompanies: string[];
}

function resolveRepo(
  ctx: PluginContext,
  config: InstanceConfig,
  toolName: string,
  repoKey: string | undefined,
  companyId: string,
): ResolvedRepo {
  if (!repoKey) {
    throw new Error("[EINVALID_INPUT] `repoKey` is required.");
  }
  const repos = (config.repos ?? []).filter((r): r is RepoConfig => Boolean(r?.key));
  const match = repos.find((r) => r.key === repoKey);
  if (!match) {
    throw new Error(
      `[ENO_REPO] Unknown repoKey '${repoKey}'. Configured: ${repos.map((r) => r.key).join(", ") || "(none)"}.`,
    );
  }
  if (!match.path) {
    throw new Error(`[ENO_REPO_PATH] Repo '${repoKey}' has no path configured.`);
  }
  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `repo '${repoKey}'`,
    resourceKey: repoKey,
    allowedCompanies: match.allowedCompanies,
    companyId,
  });
  return {
    key: match.key!,
    path: match.path,
    displayName: match.displayName ?? match.key!,
    allowedCompanies: match.allowedCompanies ?? [],
  };
}

async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.telemetry.track(`code-scanner.${tool}`, {
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // best-effort; never fail a tool because telemetry hiccupped.
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("code-scanner plugin setup");

    const config = (await ctx.config.get()) as InstanceConfig;
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      ctx.logger.warn(
        "code-scanner: no repos configured. Add at least one on /instance/settings/plugins/code-scanner.",
      );
    } else {
      const summary = repos
        .map((r) => {
          const k = r.key ?? "(no-key)";
          const allowed = r.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          return `${k} [${access}]`;
        })
        .join(", ");
      ctx.logger.info(`code-scanner: ready. Repos — ${summary}`);
    }

    ctx.tools.register(
      "code_secret_scan",
      {
        displayName: "Scan repo for secrets",
        description: "gitleaks-style secret detection. Read-only.",
        parametersSchema: {
          type: "object",
          properties: {
            repoKey: { type: "string" },
            maxFindings: { type: "number" },
          },
          required: ["repoKey"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { repoKey?: string; maxFindings?: number };
        try {
          const repo = resolveRepo(ctx, config, "code_secret_scan", p.repoKey, runCtx.companyId);
          const findings = await runSecretScan({
            repoPath: repo.path,
            binary: config.gitleaksBinary ?? "gitleaks",
            maxFindings: clampMax(p.maxFindings, 200, 1000),
          });
          await track(ctx, runCtx, "code_secret_scan", {
            repoKey: repo.key,
            findings: findings.length,
          });
          return {
            content: `gitleaks: ${findings.length} finding(s) in ${repo.displayName}.`,
            data: { repoKey: repo.key, findings },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "code_dead_export_scan",
      {
        displayName: "Scan repo for dead exports",
        description: "knip-based dead-export detection. Read-only.",
        parametersSchema: {
          type: "object",
          properties: {
            repoKey: { type: "string" },
            maxFindings: { type: "number" },
          },
          required: ["repoKey"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { repoKey?: string; maxFindings?: number };
        try {
          const repo = resolveRepo(ctx, config, "code_dead_export_scan", p.repoKey, runCtx.companyId);
          const findings = await runDeadExportScan({
            repoPath: repo.path,
            binary: config.knipBinary ?? "npx knip",
            maxFindings: clampMax(p.maxFindings, 200, 1000),
          });
          await track(ctx, runCtx, "code_dead_export_scan", {
            repoKey: repo.key,
            findings: findings.length,
          });
          return {
            content: `knip: ${findings.length} dead-export finding(s) in ${repo.displayName}.`,
            data: { repoKey: repo.key, findings },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "code_todo_age_scan",
      {
        displayName: "Scan repo for aged TODOs",
        description: "git grep + git blame; reports TODO/FIXME/XXX older than N months. Read-only.",
        parametersSchema: {
          type: "object",
          properties: {
            repoKey: { type: "string" },
            minAgeMonths: { type: "number" },
            maxFindings: { type: "number" },
          },
          required: ["repoKey"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { repoKey?: string; minAgeMonths?: number; maxFindings?: number };
        try {
          const repo = resolveRepo(ctx, config, "code_todo_age_scan", p.repoKey, runCtx.companyId);
          const minAgeMonths = p.minAgeMonths ?? config.todoAgeMonths ?? 6;
          const findings = await runTodoAgeScan({
            repoPath: repo.path,
            minAgeMonths,
            maxFindings: clampMax(p.maxFindings, 100, 500),
          });
          await track(ctx, runCtx, "code_todo_age_scan", {
            repoKey: repo.key,
            findings: findings.length,
            minAgeMonths,
          });
          return {
            content: `${findings.length} TODO/FIXME/XXX finding(s) older than ${minAgeMonths}m in ${repo.displayName}.`,
            data: { repoKey: repo.key, findings },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "code_doc_drift_scan",
      {
        displayName: "Scan README/AGENTS.md for stale code references",
        description:
          "Read-only doc-drift heuristic. Extracts code-style refs from README/AGENTS.md and confirms each via git grep.",
        parametersSchema: {
          type: "object",
          properties: {
            repoKey: { type: "string" },
            maxFindings: { type: "number" },
          },
          required: ["repoKey"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { repoKey?: string; maxFindings?: number };
        try {
          const repo = resolveRepo(ctx, config, "code_doc_drift_scan", p.repoKey, runCtx.companyId);
          const findings = await runDocDriftScan({
            repoPath: repo.path,
            maxFindings: clampMax(p.maxFindings, 50, 200),
          });
          await track(ctx, runCtx, "code_doc_drift_scan", {
            repoKey: repo.key,
            findings: findings.length,
          });
          return {
            content: `${findings.length} doc-drift finding(s) in ${repo.displayName}.`,
            data: { repoKey: repo.key, findings },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "agent_observability_query",
      {
        displayName: "Query cross-company agent observability",
        description:
          "Surfaces paused agents, agents with stale lastHeartbeatAt, and agents in error state across the portfolio. Read-only.",
        parametersSchema: {
          type: "object",
          properties: {
            staleHoursThreshold: { type: "number" },
            includeIdleStatuses: { type: "boolean" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { staleHoursThreshold?: number; includeIdleStatuses?: boolean };
        try {
          const findings = await runAgentObservability(ctx, {
            staleHoursThreshold: p.staleHoursThreshold ?? 24,
            includeIdleStatuses: Boolean(p.includeIdleStatuses),
          });
          await track(ctx, runCtx, "agent_observability_query", {
            findings: findings.length,
          });
          return {
            content: `${findings.length} agent-observability finding(s) across the portfolio.`,
            data: { findings },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );
  },
});

function clampMax(value: number | undefined, fallback: number, hardMax: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), hardMax);
}

export default plugin;
