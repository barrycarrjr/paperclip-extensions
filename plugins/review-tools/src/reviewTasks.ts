/**
 * One task per location, with a subtask per review that needs a reply.
 *
 * The first sync after the Google connection was fixed opened 115 separate
 * tasks in one company, one per unreplied review going back to 2013. That
 * is a list nobody can work from. Now each location has one parent task,
 * "Google reviews awaiting a reply", and each review is a subtask under it,
 * so the board shows one line that expands rather than a wall.
 *
 * A subtask closes itself when the review gets its reply, however that
 * happened: posted from the Reviews page, posted by an agent, or written in
 * Google's own console and noticed by the next sync. Nobody should have to
 * tick off a task for a reply they have already written.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { LocationConfig } from "./types.js";

type Ctx = Pick<PluginContext, "issues" | "state" | "logger">;

/** Where the parent task's id is kept: one instance-wide key per location. */
export function parentIssueStateKey(locationKey: string) {
  return { scopeKind: "instance" as const, stateKey: `review-parent-issue:${locationKey}` };
}

export function parentIssueTitle(location: LocationConfig): string {
  return `Google reviews awaiting a reply: ${location.displayName}`;
}

export function parentIssueBody(location: LocationConfig): string {
  return [
    `Each subtask here is one review on the ${location.displayName} Google listing that has no reply yet.`,
    "",
    "A subtask closes by itself once the review has a reply, whether it was posted from the Reviews page in Paperclip, by an agent, or written in Google's own console.",
    "",
    "To reply: open Reviews inside this company, pick the location, and choose the review.",
  ].join("\n");
}

/** A status the host treats as finished. */
const DONE_STATUSES = new Set(["done", "cancelled"]);

/**
 * The open parent task for a location, created if there is none or if the
 * recorded one has since been closed or deleted. A closed parent is not
 * reopened: closing it is how somebody says "start a fresh list".
 */
export async function ensureParentIssue(ctx: Ctx, location: LocationConfig): Promise<string> {
  const key = parentIssueStateKey(location.key);
  const recorded = await ctx.state.get(key).catch(() => null);
  if (typeof recorded === "string" && recorded) {
    const existing = await ctx.issues.get(recorded, location.targetCompanyId).catch(() => null);
    if (existing && !DONE_STATUSES.has(existing.status)) return existing.id;
  }
  const created = await ctx.issues.create({
    companyId: location.targetCompanyId,
    title: parentIssueTitle(location),
    description: parentIssueBody(location),
    priority: "medium",
    originKind: "plugin:review-tools",
    originId: `location/${location.key}`,
    ...(location.targetProjectId ? { projectId: location.targetProjectId } : {}),
  });
  await ctx.state.set(key, created.id);
  ctx.logger.info("review-tools: opened the parent task for a location", {
    locationKey: location.key,
    issueId: created.id,
  });
  return created.id;
}

/**
 * Close the subtask for a review that now has a reply. Quiet about a task
 * that is already closed or gone: the reply is what matters, and a missing
 * task is not a reason to fail a post that has already been made public.
 */
export async function closeReviewIssue(
  ctx: Ctx,
  companyId: string,
  issueId: string | null | undefined,
  reason: "posted" | "replied-on-google",
): Promise<boolean> {
  if (!issueId) return false;
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue || DONE_STATUSES.has(issue.status)) return false;
    await ctx.issues.update(issueId, { status: "done" }, companyId);
    ctx.logger.info("review-tools: closed a review subtask", { issueId, reason });
    return true;
  } catch (err) {
    ctx.logger.warn("review-tools: could not close the review subtask", {
      issueId,
      reason,
      error: (err as Error).message,
    });
    return false;
  }
}
