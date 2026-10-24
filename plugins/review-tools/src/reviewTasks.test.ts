/**
 * One parent task per location, subtasks underneath, closed when the review
 * gets its reply. The host is a small in-memory stand-in for ctx.issues and
 * ctx.state that records every call.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { closeReviewIssue, ensureParentIssue, parentIssueStateKey, reopenReviewIssue, taskIsSettled } from "./reviewTasks.js";
import type { LocationConfig } from "./types.js";

const LOCATION: LocationConfig = {
  key: "main-st",
  displayName: "Main St Store",
  googleAccountId: "111",
  locationId: "222",
  accountKey: "owner",
  targetCompanyId: "company-a",
};

function fakeHost(seed: { issues?: Record<string, { id: string; status: string }>; state?: Record<string, unknown> } = {}) {
  const issues = new Map(Object.entries(seed.issues ?? {}));
  const state = new Map(Object.entries(seed.state ?? {}));
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let next = 1;
  const ctx = {
    issues: {
      async get(id: string) {
        return issues.get(id) ?? null;
      },
      async create(input: Record<string, unknown>) {
        created.push(input);
        const id = `issue-${next++}`;
        issues.set(id, { id, status: "backlog" });
        return { id, status: "backlog" };
      },
      async update(id: string, patch: Record<string, unknown>) {
        updated.push({ id, patch });
        const row = issues.get(id)!;
        row.status = String(patch.status ?? row.status);
        return row;
      },
    },
    state: {
      async get(key: { stateKey: string }) {
        return state.get(key.stateKey) ?? null;
      },
      async set(key: { stateKey: string }, value: unknown) {
        state.set(key.stateKey, value);
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { ctx: ctx as unknown as Parameters<typeof ensureParentIssue>[0], created, updated, state, issues };
}

test("the first review for a location opens one parent task and remembers it", async () => {
  const host = fakeHost();
  const first = await ensureParentIssue(host.ctx, LOCATION);
  const second = await ensureParentIssue(host.ctx, LOCATION);
  assert.equal(first, second, "the same parent is reused");
  assert.equal(host.created.length, 1);
  assert.match(String(host.created[0]!.title), /Google reviews awaiting a reply: Main St Store/);
  assert.equal(host.created[0]!.originId, "location/main-st");
  assert.equal(host.state.get(parentIssueStateKey("main-st").stateKey), first);
});

test("a parent somebody closed is not reopened; a fresh one is started", async () => {
  const host = fakeHost({
    issues: { "issue-old": { id: "issue-old", status: "done" } },
    state: { [parentIssueStateKey("main-st").stateKey]: "issue-old" },
  });
  const id = await ensureParentIssue(host.ctx, LOCATION);
  assert.notEqual(id, "issue-old");
  assert.equal(host.updated.length, 0, "the closed one is left alone");
  assert.equal(host.created.length, 1);
});

test("a recorded parent that no longer exists is replaced", async () => {
  const host = fakeHost({ state: { [parentIssueStateKey("main-st").stateKey]: "issue-gone" } });
  const id = await ensureParentIssue(host.ctx, LOCATION);
  assert.equal(id, "issue-1");
});

test("closing a subtask marks it done once, and names what happened each time", async () => {
  const host = fakeHost({ issues: { "issue-7": { id: "issue-7", status: "todo" } } });
  assert.equal(await closeReviewIssue(host.ctx, "company-a", "issue-7", "posted"), "closed");
  assert.deepEqual(host.updated, [{ id: "issue-7", patch: { status: "done" } }]);

  // Already done: nothing further, but the person still has nothing to do,
  // which is why this is told apart from a failure.
  assert.equal(await closeReviewIssue(host.ctx, "company-a", "issue-7", "replied-on-google"), "already-closed");
  assert.equal(host.updated.length, 1);

  // Gone, or never recorded: nothing to do and no error.
  assert.equal(await closeReviewIssue(host.ctx, "company-a", "issue-nope", "posted"), "none");
  assert.equal(await closeReviewIssue(host.ctx, "company-a", null, "posted"), "none");

  // Only the first two mean the receipt can say the task is finished.
  assert.equal(taskIsSettled("closed"), true);
  assert.equal(taskIsSettled("already-closed"), true);
  assert.equal(taskIsSettled("none"), false);
  assert.equal(taskIsSettled("failed"), false);
});

test("a host error while closing is swallowed: the public reply is what matters", async () => {
  const host = fakeHost({ issues: { "issue-7": { id: "issue-7", status: "todo" } } });
  (host.ctx as unknown as { issues: { update: () => Promise<never> } }).issues.update = async () => {
    throw new Error("host down");
  };
  assert.equal(await closeReviewIssue(host.ctx, "company-a", "issue-7", "posted"), "failed");
});

test("a skipped review's task is cancelled, not done, and only that is reopened by an undo", async () => {
  const host = fakeHost({
    issues: {
      "issue-7": { id: "issue-7", status: "backlog" },
      "issue-8": { id: "issue-8", status: "done" },
    },
  });
  assert.equal(await closeReviewIssue(host.ctx, "company-a", "issue-7", "skipped"), "closed");
  assert.deepEqual(host.updated, [{ id: "issue-7", patch: { status: "cancelled" } }]);

  // Undo puts it back where the sync files review tasks.
  assert.equal(await reopenReviewIssue(host.ctx, "company-a", "issue-7", "unskipped"), "reopened");
  assert.deepEqual(host.updated[1], { id: "issue-7", patch: { status: "backlog" } });

  // A task somebody finished is theirs: an undo does not drag it back.
  assert.equal(await reopenReviewIssue(host.ctx, "company-a", "issue-8", "unskipped"), "not-cancelled");
  assert.equal(await reopenReviewIssue(host.ctx, "company-a", null, "review-edited"), "none");
  assert.equal(host.updated.length, 2);
});
