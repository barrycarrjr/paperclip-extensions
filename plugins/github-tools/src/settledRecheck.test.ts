import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { NotificationWatchConfig } from "./notificationWatch.js";
import { parseTaskThread, runSettledRecheck } from "./settledRecheck.js";

interface FakeIssue {
  id: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  comments: string[];
}

function fakeContext(tasks: Array<Omit<FakeIssue, "comments" | "status" | "assigneeAgentId" | "assigneeUserId"> & Partial<FakeIssue>>) {
  const state = new Map<string, unknown>();
  const wakeups: string[] = [];
  const issues = new Map<string, FakeIssue>(tasks.map((task) => [task.id, {
    status: "todo", assigneeAgentId: null, assigneeUserId: "user-1", comments: [], ...task,
  }]));
  const stateId = (key: { namespace?: string; stateKey: string }) => `${key.namespace}/${key.stateKey}`;
  const ctx = {
    secrets: { resolve: async () => "test-token" },
    state: {
      get: async (key: { namespace?: string; stateKey: string }) => state.get(stateId(key)) ?? null,
      set: async (key: { namespace?: string; stateKey: string }, value: unknown) => {
        state.set(stateId(key), value);
      },
    },
    issues: {
      list: async (input: { status?: string }) => [...issues.values()].filter((issue) => issue.status === input.status),
      requestWakeup: async (id: string) => {
        wakeups.push(id);
        return { queued: true };
      },
      createComment: async (id: string, body: string) => {
        issues.get(id)!.comments.push(body);
        return { id: "comment" };
      },
      update: async (id: string, patch: Partial<FakeIssue>) => Object.assign(issues.get(id)!, patch),
    },
  } as unknown as PluginContext;
  return { ctx, issues, wakeups };
}

type Route = (url: URL) => Response | undefined;
let routes: Route[] = [];
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  routes = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    for (const route of routes) {
      const response = route(url);
      if (response) return response;
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const config: NotificationWatchConfig = {
  enabled: true,
  tokenRef: "secret-1",
  targetCompanyId: "company-1",
  assigneeAgentId: "agent-1",
};

test("parseTaskThread reads numbered threads and failed workflow runs", () => {
  assert.deepEqual(parseTaskThread("GitHub: acme/app#12 Fix the thing"), { kind: "numbered", repo: "acme/app", number: 12 });
  assert.deepEqual(parseTaskThread("GitHub: acme/app PR workflow run failed for fix/x branch"), {
    kind: "workflow", repo: "acme/app", workflow: "PR", branch: "fix/x",
  });
  assert.equal(parseTaskThread("GitHub: acme/app Release v1"), null);
});

test("a merged pull request is handed back once, with the reason", async () => {
  const { ctx, issues, wakeups } = fakeContext([{ id: "t1", title: "GitHub: acme/app#7 Add feature" }]);
  routes.push((url) => {
    if (url.pathname === "/repos/acme/app/issues/7") return json({ state: "closed", pull_request: {} });
    if (url.pathname === "/repos/acme/app/pulls/7") return json({ merged: true });
    return undefined;
  });
  const first = await runSettledRecheck(ctx, config);
  assert.deepEqual(first, { checked: 1, handedBack: 1 });
  const task = issues.get("t1")!;
  assert.equal(task.assigneeAgentId, "agent-1");
  assert.equal(task.assigneeUserId, null);
  assert.match(task.comments[0], /^Settled on GitHub: acme\/app#7 was merged\./);
  assert.deepEqual(wakeups, ["t1"]);

  Object.assign(task, { assigneeAgentId: null, assigneeUserId: "user-1" });
  const second = await runSettledRecheck(ctx, config);
  assert.equal(second.handedBack, 0, "a task the agent gave back stays with the person");
  assert.equal(task.assigneeUserId, "user-1");
});

test("an open issue stays with the person", async () => {
  const { ctx, issues } = fakeContext([{ id: "t1", title: "GitHub: acme/app#8 Question" }]);
  routes.push((url) => (url.pathname === "/repos/acme/app/issues/8" ? json({ state: "open" }) : undefined));
  const result = await runSettledRecheck(ctx, config);
  assert.equal(result.handedBack, 0);
  assert.equal(issues.get("t1")!.assigneeUserId, "user-1");
});

test("a failed run is settled when its branch is gone or a later run passed", async () => {
  const { ctx, issues } = fakeContext([
    { id: "gone", title: "GitHub: acme/app PR workflow run failed for old branch" },
    { id: "passed", title: "GitHub: acme/app PR workflow run failed for main branch" },
    { id: "still", title: "GitHub: acme/app Lint workflow run failed for main branch" },
  ]);
  routes.push((url) => {
    if (url.pathname === "/repos/acme/app/branches/main") return json({ name: "main" });
    if (url.pathname === "/repos/acme/app/actions/runs") {
      return json({ workflow_runs: [
        { name: "Lint", status: "completed", conclusion: "failure" },
        { name: "PR", status: "completed", conclusion: "success" },
      ] });
    }
    return undefined;
  });
  const result = await runSettledRecheck(ctx, config);
  assert.equal(result.handedBack, 2);
  assert.match(issues.get("gone")!.comments[0], /the old branch no longer exists/);
  assert.match(issues.get("passed")!.comments[0], /the latest PR run on main passed/);
  assert.equal(issues.get("still")!.assigneeUserId, "user-1");
});

test("skips tasks already with an agent, and does nothing without an agent assignee", async () => {
  const { ctx, issues } = fakeContext([{ id: "t1", title: "GitHub: acme/app#7 Add feature", assigneeAgentId: "agent-1", assigneeUserId: null }]);
  assert.deepEqual(await runSettledRecheck(ctx, config), { checked: 0, handedBack: 0 });
  assert.equal((await runSettledRecheck(ctx, { ...config, assigneeAgentId: undefined })).skipped, "no triage agent configured");
  assert.equal(issues.get("t1")!.comments.length, 0);
});
