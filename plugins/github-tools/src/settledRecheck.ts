import type { Octokit } from "@octokit/rest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  type NotificationWatchConfig,
  ORIGIN_KIND,
  configProblem,
  createWatchClient,
  handBackPatch,
} from "./notificationWatch.js";

export const SETTLED_RECHECK_JOB_KEY = "recheck-settled-github-tasks";
const MAX_TASKS = 100;

/** What a watch task's title says about its GitHub thread. */
export type TaskThread =
  | { kind: "numbered"; repo: string; number: number }
  | { kind: "workflow"; repo: string; workflow: string; branch: string };

export interface SettledRecheckSummary {
  skipped?: string;
  checked: number;
  handedBack: number;
}

const handedBackKey = (issueId: string) =>
  ({ scopeKind: "instance", namespace: "settled-recheck", stateKey: `handed-back:${issueId}` }) as const;

/**
 * Reads the thread back out of a watch task title: `GitHub: owner/repo#12 Title`
 * for issues and pull requests, or `GitHub: owner/repo <Workflow> workflow run
 * failed for <branch> branch` for Actions runs. Anything else is not checked.
 */
export function parseTaskThread(title: string): TaskThread | null {
  const numbered = /^GitHub: ([\w.-]+\/[\w.-]+)#(\d+) /.exec(title);
  if (numbered) return { kind: "numbered", repo: numbered[1], number: Number(numbered[2]) };
  const workflow = /^GitHub: ([\w.-]+\/[\w.-]+) (.+) workflow run (?:failed|cancelled) for (.+) branch$/.exec(title);
  if (workflow) return { kind: "workflow", repo: workflow[1], workflow: workflow[2], branch: workflow[3] };
  return null;
}

/**
 * Once a day, looks up every watch task that is waiting on a person. When its
 * thread has settled on GitHub, the task goes back to the triage agent with the
 * reason, and the triage agent decides whether to close it. Each task is
 * handed back at most once for the same reason, so a task the agent returns
 * to the person stays with them.
 */
export async function runSettledRecheck(
  ctx: PluginContext,
  cfg: NotificationWatchConfig | undefined,
): Promise<SettledRecheckSummary> {
  const summary: SettledRecheckSummary = { checked: 0, handedBack: 0 };
  const problem = configProblem(cfg);
  if (problem || !cfg) return { ...summary, skipped: problem ?? "disabled" };
  if (!cfg.assigneeAgentId) return { ...summary, skipped: "no triage agent configured" };

  const companyId = cfg.targetCompanyId!;
  const tasks = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, status: "todo", limit: MAX_TASKS });
  const waiting = tasks.filter((task) => handBackPatch(task, cfg));
  if (waiting.length === 0) return summary;

  const client = await createWatchClient(ctx, cfg);
  for (const task of waiting) {
    const thread = parseTaskThread(task.title);
    if (!thread) continue;
    summary.checked += 1;
    const reason = await settledReason(client, thread);
    if (!reason) continue;
    const key = handedBackKey(task.id);
    if ((await ctx.state.get(key)) === reason) continue;
    await ctx.issues.createComment(task.id, `Settled on GitHub: ${reason} Handing back to triage.`, companyId);
    await ctx.issues.update(task.id, handBackPatch(task, cfg)!, companyId);
    await ctx.state.set(key, reason);
    summary.handedBack += 1;
  }
  return summary;
}

/** A one-sentence reason the thread needs nobody, or null when it may still. */
export async function settledReason(client: Octokit, thread: TaskThread): Promise<string | null> {
  const [owner, repo] = thread.repo.split("/");
  try {
    if (thread.kind === "numbered") {
      const { data: issue } = await client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner, repo, issue_number: thread.number,
      });
      if (issue.state !== "closed") return null;
      if (!issue.pull_request) return `${thread.repo}#${thread.number} is closed.`;
      const { data: pull } = await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner, repo, pull_number: thread.number,
      });
      return pull.merged
        ? `${thread.repo}#${thread.number} was merged.`
        : `${thread.repo}#${thread.number} was closed without merging.`;
    }
    return await settledWorkflowReason(client, owner, repo, thread.workflow, thread.branch);
  } catch {
    return null;
  }
}

async function settledWorkflowReason(
  client: Octokit,
  owner: string,
  repo: string,
  workflow: string,
  branch: string,
): Promise<string | null> {
  try {
    await client.request("GET /repos/{owner}/{repo}/branches/{branch}", { owner, repo, branch });
  } catch (err) {
    if ((err as { status?: number }).status === 404) return `the ${branch} branch no longer exists.`;
    throw err;
  }
  const { data } = await client.request("GET /repos/{owner}/{repo}/actions/runs", {
    owner, repo, branch, per_page: 20,
  });
  const latest = data.workflow_runs.find((run) => run.name === workflow && run.status === "completed");
  return latest?.conclusion === "success"
    ? `the latest ${workflow} run on ${branch} passed.`
    : null;
}
