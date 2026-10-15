import { Octokit } from "@octokit/rest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  type GithubNotification,
  type LatestComment,
  type NotificationDetail,
  type SubjectState,
  describeNotification,
  hasNewComment,
  hasSubjectState,
  isOwnActivity,
  newestCommentUrl,
  repoAllowed,
  sortOldestFirst,
} from "./notificationEvents.js";
import { wrapGithubError } from "./githubClient.js";

export const NOTIFICATION_WATCH_JOB_KEY = "watch-github-notifications";
const ORIGIN_KIND = "plugin:github-tools" as const;
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_PAGES = 5;
const PER_PAGE = 50;
const REOPEN_STATUSES = new Set(["done", "cancelled"]);

export interface NotificationWatchConfig {
  enabled?: boolean;
  tokenRef?: string;
  targetCompanyId?: string;
  assigneeUserId?: string;
  assigneeAgentId?: string;
  trustedLogins?: string[];
  repos?: string[];
  initialLookbackHours?: number;
}

interface WatchCursor {
  /** ISO time: notifications updated after this are new. */
  since: string;
  /** GitHub's Last-Modified header, replayed so an unchanged feed costs nothing. */
  lastModified: string | null;
  /** Earliest time GitHub allows the next poll (X-Poll-Interval). */
  nextPollAt: string | null;
}

interface ThreadRecord {
  issueId: string;
  lastUpdatedAt: string;
}

const cursorKey = { scopeKind: "instance", namespace: "notification-watch", stateKey: "cursor" } as const;
const loginKey = { scopeKind: "instance", namespace: "notification-watch", stateKey: "login" } as const;
const threadKey = (threadId: string) =>
  ({ scopeKind: "instance", namespace: "notification-watch", stateKey: `thread:${threadId}` }) as const;

export interface WatchRunSummary {
  skipped?: string;
  fetched: number;
  created: number;
  updated: number;
}

/** Returns a reason the watch cannot run, or null when the config is usable. */
export function configProblem(cfg: NotificationWatchConfig | undefined): string | null {
  if (!cfg?.enabled) return "disabled";
  if (!cfg.tokenRef) return "no token secret configured";
  if (!cfg.targetCompanyId) return "no target company configured";
  return null;
}

export async function runNotificationWatch(
  ctx: PluginContext,
  cfg: NotificationWatchConfig | undefined,
  now: Date = new Date(),
): Promise<WatchRunSummary> {
  const summary: WatchRunSummary = { fetched: 0, created: 0, updated: 0 };
  const problem = configProblem(cfg);
  if (problem || !cfg) return { ...summary, skipped: problem ?? "disabled" };

  const cursor = await readCursor(ctx, cfg, now);
  if (cursor.nextPollAt && new Date(cursor.nextPollAt) > now) {
    return { ...summary, skipped: "GitHub asked to wait before polling again" };
  }

  const token = await ctx.secrets.resolve(cfg.tokenRef!);
  if (!token) throw new Error("[ECONFIG] notification watch token secret did not resolve.");
  const client = new Octokit({
    auth: token,
    userAgent: "paperclip-plugin-github-tools",
    request: { retries: 2 },
    // Octokit logs every 304 as an error; failures are rethrown and reported by the job run instead.
    log: { debug: () => {}, info: () => {}, warn: console.warn, error: () => {} },
  });

  const page = await fetchNotifications(client, cursor);
  if (!page) {
    await ctx.state.set(cursorKey, { ...cursor, nextPollAt: null });
    return summary;
  }
  summary.fetched = page.notifications.length;

  const login = await watchedLogin(ctx, client);
  const trusted = cfg.trustedLogins ?? [];
  let newest = cursor.since;
  for (const notification of sortOldestFirst(page.notifications)) {
    if (notification.updated_at > newest) newest = notification.updated_at;
    if (!repoAllowed(notification.repository.full_name, cfg.repos)) continue;
    const outcome = await handleThread(ctx, client, cfg, notification, login, trusted, cursor.since);
    if (outcome === "created") summary.created += 1;
    if (outcome === "updated") summary.updated += 1;
  }

  await ctx.state.set(cursorKey, {
    since: newest,
    lastModified: page.lastModified,
    nextPollAt: new Date(now.getTime() + page.pollIntervalSec * 1000).toISOString(),
  } satisfies WatchCursor);
  return summary;
}

async function readCursor(ctx: PluginContext, cfg: NotificationWatchConfig, now: Date): Promise<WatchCursor> {
  const stored = (await ctx.state.get(cursorKey)) as WatchCursor | null;
  if (stored?.since) return stored;
  const lookbackHours = cfg.initialLookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  return {
    since: new Date(now.getTime() - lookbackHours * 3600 * 1000).toISOString(),
    lastModified: null,
    nextPollAt: null,
  };
}

interface NotificationPage {
  notifications: GithubNotification[];
  lastModified: string | null;
  pollIntervalSec: number;
}

/** Null means GitHub answered 304: nothing changed since the last poll. */
async function fetchNotifications(client: Octokit, cursor: WatchCursor): Promise<NotificationPage | null> {
  const notifications: GithubNotification[] = [];
  let lastModified: string | null = null;
  let pollIntervalSec = 60;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    try {
      const response = await client.request("GET /notifications", {
        all: true,
        since: cursor.since,
        per_page: PER_PAGE,
        page,
        headers: page === 1 && cursor.lastModified ? { "if-modified-since": cursor.lastModified } : {},
      });
      if (page === 1) {
        lastModified = (response.headers["last-modified"] as string | undefined) ?? null;
        pollIntervalSec = Number(response.headers["x-poll-interval"] ?? 60) || 60;
      }
      const batch = response.data as unknown as GithubNotification[];
      notifications.push(...batch);
      if (batch.length < PER_PAGE) break;
    } catch (err) {
      if ((err as { status?: number }).status === 304) return null;
      throw new Error(wrapGithubError(err));
    }
  }
  return { notifications, lastModified, pollIntervalSec };
}

async function watchedLogin(ctx: PluginContext, client: Octokit): Promise<string> {
  const cached = (await ctx.state.get(loginKey)) as string | null;
  if (cached) return cached;
  const { data } = await client.request("GET /user");
  await ctx.state.set(loginKey, data.login);
  return data.login;
}

/**
 * When the newest event is not a comment (an issue closed or reopened),
 * GitHub points latest_comment_url at the subject itself. The comment that
 * came with that event is then read from the conversation, if it is newer
 * than `since`, so a "Resolved in abc123" reply still reaches the task.
 */
async function fetchDetail(
  client: Octokit,
  notification: GithubNotification,
  since: string,
): Promise<NotificationDetail> {
  const subject = hasSubjectState(notification)
    ? await fetchSubjectState(client, notification.subject.url!)
    : null;
  if (hasNewComment(notification)) {
    const comment = await fetchComment(client, notification.subject.latest_comment_url!);
    return { notification, comment, subject };
  }
  const url = subject ? newestCommentUrl(notification.subject.url!, subject.comments) : null;
  const comment = url ? await fetchNewestComment(client, url, since) : null;
  return { notification, comment, subject };
}

interface CommentBody {
  user?: { login?: string } | null;
  body?: string | null;
  html_url?: string;
  created_at?: string;
}

function toLatestComment(body: CommentBody): LatestComment {
  return { author: body.user?.login ?? null, body: body.body ?? "", htmlUrl: body.html_url ?? null };
}

async function fetchComment(client: Octokit, url: string): Promise<LatestComment | null> {
  try {
    const { data } = await client.request(`GET ${url}`);
    return toLatestComment(data as CommentBody);
  } catch {
    return null;
  }
}

async function fetchNewestComment(client: Octokit, url: string, since: string): Promise<LatestComment | null> {
  try {
    const { data } = await client.request(`GET ${url}`);
    const newest = (data as CommentBody[])[0];
    if (!newest?.created_at || newest.created_at <= since) return null;
    return toLatestComment(newest);
  } catch {
    return null;
  }
}

async function fetchSubjectState(client: Octokit, url: string): Promise<SubjectState | null> {
  try {
    const { data } = await client.request(`GET ${url}`);
    const body = data as { state?: string; merged?: boolean; html_url?: string; comments?: number };
    return {
      state: body.state ?? null,
      merged: !!body.merged,
      htmlUrl: body.html_url ?? null,
      comments: body.comments ?? 0,
    };
  } catch {
    return null;
  }
}

async function handleThread(
  ctx: PluginContext,
  client: Octokit,
  cfg: NotificationWatchConfig,
  notification: GithubNotification,
  login: string,
  trusted: string[],
  cursorSince: string,
): Promise<"created" | "updated" | "skipped"> {
  const record = (await ctx.state.get(threadKey(notification.id))) as ThreadRecord | null;
  if (record && notification.updated_at <= record.lastUpdatedAt) return "skipped";

  const detail = await fetchDetail(client, notification, record?.lastUpdatedAt ?? cursorSince);
  if (isOwnActivity(detail, login)) {
    if (record) await ctx.state.set(threadKey(notification.id), { ...record, lastUpdatedAt: notification.updated_at });
    return "skipped";
  }

  const task = describeNotification(detail, trusted);
  const companyId = cfg.targetCompanyId!;
  const existing = record ? await ctx.issues.get(record.issueId, companyId) : null;

  if (existing) {
    await ctx.issues.createComment(existing.id, task.body, companyId);
    if (REOPEN_STATUSES.has(existing.status)) {
      await ctx.issues.update(existing.id, { status: "todo" }, companyId);
    }
    await ctx.state.set(threadKey(notification.id), {
      issueId: existing.id,
      lastUpdatedAt: notification.updated_at,
    } satisfies ThreadRecord);
    return "updated";
  }

  const issue = await ctx.issues.create({
    companyId,
    title: task.title,
    description: task.body,
    status: "todo",
    priority: task.isRequest ? "high" : "medium",
    originKind: ORIGIN_KIND,
    originId: `notification-thread:${notification.id}`,
    ...(cfg.assigneeAgentId ? { assigneeAgentId: cfg.assigneeAgentId } : {}),
    ...(cfg.assigneeUserId ? { assigneeUserId: cfg.assigneeUserId } : {}),
  });
  await ctx.state.set(threadKey(notification.id), {
    issueId: issue.id,
    lastUpdatedAt: notification.updated_at,
  } satisfies ThreadRecord);
  return "created";
}
