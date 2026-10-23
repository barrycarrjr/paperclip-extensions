import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configProblem, runNotificationWatch, type NotificationWatchConfig } from "./notificationWatch.js";

interface FakeIssue {
  id: string;
  status: string;
  title: string;
  description?: string;
  priority?: string;
  assigneeAgentId?: string;
  comments: string[];
}

function fakeContext() {
  const state = new Map<string, unknown>();
  const issues = new Map<string, FakeIssue>();
  const stateId = (key: { namespace?: string; stateKey: string }) => `${key.namespace ?? "default"}/${key.stateKey}`;
  const ctx = {
    secrets: { resolve: async () => "test-token" },
    state: {
      get: async (key: { namespace?: string; stateKey: string }) => state.get(stateId(key)) ?? null,
      set: async (key: { namespace?: string; stateKey: string }, value: unknown) => {
        state.set(stateId(key), value);
      },
    },
    issues: {
      get: async (id: string) => issues.get(id) ?? null,
      create: async (input: Omit<FakeIssue, "id" | "comments">) => {
        const issue = { ...input, id: `issue-${issues.size + 1}`, comments: [] };
        issues.set(issue.id, issue);
        return issue;
      },
      createComment: async (id: string, body: string) => {
        issues.get(id)!.comments.push(body);
        return { id: "comment" };
      },
      update: async (id: string, patch: { status: string }) => {
        Object.assign(issues.get(id)!, patch);
        return issues.get(id);
      },
    },
  } as unknown as PluginContext;
  return { ctx, state, issues };
}

type Route = (url: URL, headers: Headers) => Response;
let routes: Route[] = [];
const realFetch = globalThis.fetch;

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  routes = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    for (const route of routes) {
      const response = route(url, headers);
      if (response) return response;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function notification(id: string, updatedAt: string, commentId: number, repo = "acme/app") {
  return {
    id,
    reason: "author",
    updated_at: updatedAt,
    subject: {
      title: `Thread ${id}`,
      type: "Issue",
      url: `https://api.github.com/repos/${repo}/issues/${id}`,
      latest_comment_url: `https://api.github.com/repos/${repo}/issues/comments/${commentId}`,
    },
    repository: { full_name: repo, html_url: `https://github.com/${repo}` },
  };
}

function serve(feed: unknown[], comments: Record<number, string>) {
  routes.push((url, headers) => {
    if (url.pathname === "/notifications") {
      if (headers.get("if-modified-since") === "unchanged") return new Response(null, { status: 304 });
      return json(feed, { "last-modified": "unchanged", "x-poll-interval": "60" });
    }
    if (url.pathname === "/user") return json({ login: "me" });
    const match = url.pathname.match(/\/issues\/comments\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      return json({ user: { login: comments[id] }, body: `comment ${id}`, html_url: `https://github.com/c/${id}` });
    }
    return undefined as unknown as Response;
  });
}

const config: NotificationWatchConfig = {
  enabled: true,
  tokenRef: "secret-1",
  targetCompanyId: "company-1",
  trustedLogins: ["maintainer"],
};
const t0 = new Date("2026-01-02T12:00:00Z");
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

test("configProblem explains what is missing", () => {
  assert.equal(configProblem(undefined), "disabled");
  assert.equal(configProblem({ enabled: true }), "no token secret configured");
  assert.equal(configProblem({ enabled: true, tokenRef: "x" }), "no target company configured");
  assert.equal(configProblem(config), null);
});

test("does nothing when disabled", async () => {
  const { ctx, issues } = fakeContext();
  const result = await runNotificationWatch(ctx, { ...config, enabled: false }, t0);
  assert.equal(result.skipped, "disabled");
  assert.equal(issues.size, 0);
});

test("creates one task per thread, flags trusted requests, skips own comments", async () => {
  const { ctx, issues } = fakeContext();
  serve(
    [
      notification("1", "2026-01-02T11:00:00Z", 10),
      notification("2", "2026-01-02T11:30:00Z", 20),
      notification("3", "2026-01-02T11:45:00Z", 30),
    ],
    { 10: "maintainer", 20: "stranger", 30: "me" },
  );
  const result = await runNotificationWatch(ctx, config, t0);
  assert.equal(result.created, 2);
  const [first, second] = [...issues.values()];
  assert.equal(first.priority, "high");
  assert.match(first.description!, /Request from @maintainer/);
  assert.equal(second.priority, "medium");
  assert.match(second.description!, /Information only, from @stranger/);
});

test("an unchanged feed (304) creates nothing", async () => {
  const { ctx, issues } = fakeContext();
  serve([notification("1", "2026-01-02T11:00:00Z", 10)], { 10: "maintainer" });
  await runNotificationWatch(ctx, config, t0);
  const result = await runNotificationWatch(ctx, config, later(15));
  assert.equal(result.fetched, 0);
  assert.equal(issues.size, 1);
});

test("new activity on a known thread comments on its task and reopens it", async () => {
  const { ctx, state, issues } = fakeContext();
  serve([notification("1", "2026-01-02T11:00:00Z", 10)], { 10: "maintainer" });
  await runNotificationWatch(ctx, config, t0);
  issues.get("issue-1")!.status = "done";

  routes = [];
  state.set("notification-watch/cursor", { since: "2026-01-02T11:00:00Z", lastModified: null, nextPollAt: null });
  serve([notification("1", "2026-01-02T12:30:00Z", 11)], { 11: "maintainer" });
  const result = await runNotificationWatch(ctx, config, later(60));
  assert.equal(result.updated, 1);
  assert.equal(issues.size, 1);
  const task = issues.get("issue-1")!;
  assert.equal(task.status, "todo");
  assert.match(task.comments[0], /comment 11/);
});

test("the repo filter skips other repos", async () => {
  const { ctx, issues } = fakeContext();
  serve(
    [notification("1", "2026-01-02T11:00:00Z", 10, "acme/app"), notification("2", "2026-01-02T11:10:00Z", 20, "other/lib")],
    { 10: "maintainer", 20: "maintainer" },
  );
  await runNotificationWatch(ctx, { ...config, repos: ["acme/app"] }, t0);
  assert.equal(issues.size, 1);
});

test("waits when GitHub's poll interval has not passed", async () => {
  const { ctx } = fakeContext();
  serve([], {});
  await runNotificationWatch(ctx, config, t0);
  const result = await runNotificationWatch(ctx, config, new Date(t0.getTime() + 10_000));
  assert.equal(result.skipped, "GitHub asked to wait before polling again");
});

function closedIssue(id: string, updatedAt: string) {
  const url = `https://api.github.com/repos/acme/app/issues/${id}`;
  return { ...notification(id, updatedAt, 0), subject: { title: `Thread ${id}`, type: "Issue", url, latest_comment_url: url } };
}

function serveClosedIssue(feed: unknown[], newest: { login: string; createdAt: string }) {
  serve(feed, {});
  routes.push((url) => {
    if (url.pathname.endsWith("/comments") && url.searchParams.get("page") === "3") {
      return json([{ user: { login: newest.login }, body: "Resolved in abc123.", html_url: "https://github.com/c/3", created_at: newest.createdAt }]);
    }
    if (/\/issues\/\d+$/.test(url.pathname)) {
      return json({ state: "closed", merged: false, html_url: "https://github.com/acme/app/issues/1", comments: 3 });
    }
    return undefined as unknown as Response;
  });
}

test("a closed issue carries the comment that closed it", async () => {
  const { ctx, issues } = fakeContext();
  serveClosedIssue([closedIssue("1", "2026-01-02T11:00:30Z")], { login: "maintainer", createdAt: "2026-01-02T11:00:10Z" });
  await runNotificationWatch(ctx, config, t0);
  const task = issues.get("issue-1")!;
  assert.match(task.description!, /Closed\./);
  assert.match(task.description!, /Request from @maintainer/);
  assert.match(task.description!, /Resolved in abc123/);
});

test("a closed issue does not repeat a comment older than the last check", async () => {
  const { ctx, issues } = fakeContext();
  serveClosedIssue([closedIssue("1", "2026-01-02T11:00:30Z")], { login: "maintainer", createdAt: "2026-01-01T09:00:00Z" });
  await runNotificationWatch(ctx, config, t0);
  const task = issues.get("issue-1")!;
  assert.match(task.description!, /Closed\./);
  assert.doesNotMatch(task.description!, /Resolved in abc123/);
});

test("new activity on a task waiting on a person hands it back to the triage agent", async () => {
  const { ctx, state, issues } = fakeContext();
  const withAgent = { ...config, assigneeAgentId: "agent-1" };
  serve([notification("1", "2026-01-02T11:00:00Z", 10)], { 10: "maintainer" });
  await runNotificationWatch(ctx, withAgent, t0);
  Object.assign(issues.get("issue-1")!, { assigneeAgentId: null, assigneeUserId: "user-1", status: "todo" });

  routes = [];
  state.set("notification-watch/cursor", { since: "2026-01-02T11:00:00Z", lastModified: null, nextPollAt: null });
  serve([notification("1", "2026-01-02T12:30:00Z", 11)], { 11: "maintainer" });
  await runNotificationWatch(ctx, withAgent, later(60));
  const task = issues.get("issue-1")! as FakeIssue & { assigneeUserId?: string | null };
  assert.equal(task.assigneeAgentId, "agent-1");
  assert.equal(task.assigneeUserId, null);
  assert.equal(task.status, "todo");
});

test("without an agent assignee, a task waiting on a person stays with them", async () => {
  const { ctx, state, issues } = fakeContext();
  serve([notification("1", "2026-01-02T11:00:00Z", 10)], { 10: "maintainer" });
  await runNotificationWatch(ctx, config, t0);
  Object.assign(issues.get("issue-1")!, { assigneeUserId: "user-1" });

  routes = [];
  state.set("notification-watch/cursor", { since: "2026-01-02T11:00:00Z", lastModified: null, nextPollAt: null });
  serve([notification("1", "2026-01-02T12:30:00Z", 11)], { 11: "maintainer" });
  await runNotificationWatch(ctx, config, later(60));
  assert.equal((issues.get("issue-1")! as FakeIssue & { assigneeUserId?: string }).assigneeUserId, "user-1");
});
