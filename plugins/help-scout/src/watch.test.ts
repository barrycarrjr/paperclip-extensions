/**
 * Tests for the wake-on-mail watcher.
 *
 * The behaviours worth pinning: a wake fires only when conversations exist
 * past the cursor and never on an empty poll, the cursor is never advanced by
 * the watcher (that stays the agent's move), a half-configured watch surfaces
 * as a logged skip rather than a silent no-op, one broken account cannot stop
 * the others from being checked, the due-gate really gates and a manual
 * trigger really bypasses it, and the idempotency key tracks the newest
 * modification stamp so identical unread state produces identical keys.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { InstanceConfig, ResolvedAccount } from "./helpScoutClient.js";
import { triageCursorScope } from "./triage-cursor.js";
import {
  DEFAULT_WATCH_INTERVAL_MINUTES,
  WATCH_LAST_POLL_KEY,
  WATCH_STATE_NAMESPACE,
  buildWakeReason,
  clampWatchIntervalMs,
  collectWatchTargets,
  isWatchDue,
  newestModifiedAt,
  runWatch,
  toHelpScoutTimestamp,
  wakeIdempotencyKey,
} from "./watch.js";

const NOW = new Date("2026-08-31T16:00:00.000Z");
const COMPANY = "aaaaaaaa-1111-4222-8333-444444444444";
const ISSUE = "bbbbbbbb-5555-4666-8777-888888888888";

interface MockCtx {
  ctx: PluginContext;
  stateStore: Map<string, unknown>;
  stateWrites: Array<{ scope: unknown; value: unknown }>;
  wakeups: Array<{ issueId: string; companyId: string; options: Record<string, unknown> }>;
  warns: Array<Record<string, unknown>>;
  errors: Array<Record<string, unknown>>;
}

function mockCtx(): MockCtx {
  const stateStore = new Map<string, unknown>();
  const stateWrites: MockCtx["stateWrites"] = [];
  const wakeups: MockCtx["wakeups"] = [];
  const warns: MockCtx["warns"] = [];
  const errors: MockCtx["errors"] = [];
  const ctx = {
    state: {
      get: async (scope: unknown) => stateStore.get(JSON.stringify(scope)),
      set: async (scope: unknown, value: unknown) => {
        stateStore.set(JSON.stringify(scope), value);
        stateWrites.push({ scope, value });
      },
    },
    issues: {
      requestWakeup: async (issueId: string, companyId: string, options: Record<string, unknown>) => {
        wakeups.push({ issueId, companyId, options });
        return { requested: true };
      },
    },
    logger: {
      info: () => undefined,
      warn: (_msg: string, meta?: Record<string, unknown>) => {
        warns.push(meta ?? {});
      },
      error: (_msg: string, meta?: Record<string, unknown>) => {
        errors.push(meta ?? {});
      },
    },
    telemetry: { track: async () => undefined },
  } as unknown as PluginContext;
  return { ctx, stateStore, stateWrites, wakeups, warns, errors };
}

const RESOLVED = { accountKey: "industry-bureau" } as unknown as ResolvedAccount;

function watchedConfig(overrides: Record<string, unknown> = {}): InstanceConfig {
  return {
    accounts: [
      {
        key: "industry-bureau",
        allowedCompanies: [COMPANY],
        watchEnabled: true,
        watchIssueId: ISSUE,
        ...overrides,
      },
    ],
  } as InstanceConfig;
}

function conversationsResponse(conversations: Array<Record<string, unknown>>, total?: number) {
  return {
    status: 200,
    body: {
      _embedded: { conversations },
      page: { totalElements: total ?? conversations.length },
    },
  };
}

// ─── pure helpers ────────────────────────────────────────────────────────────

test("clampWatchIntervalMs defaults and clamps to the documented bounds", () => {
  assert.equal(clampWatchIntervalMs(undefined), DEFAULT_WATCH_INTERVAL_MINUTES * 60_000);
  assert.equal(clampWatchIntervalMs("junk"), DEFAULT_WATCH_INTERVAL_MINUTES * 60_000);
  assert.equal(clampWatchIntervalMs(Number.NaN), DEFAULT_WATCH_INTERVAL_MINUTES * 60_000);
  assert.equal(clampWatchIntervalMs(0), 60_000);
  assert.equal(clampWatchIntervalMs(500), 3_600_000);
  assert.equal(clampWatchIntervalMs(5), 300_000);
});

test("isWatchDue treats missing or garbage last-poll values as due now", () => {
  for (const bad of [undefined, null, "", "   ", "not a date", 12345]) {
    assert.equal(isWatchDue(bad, NOW, 120_000), true, `expected due for ${String(bad)}`);
  }
});

test("isWatchDue compares elapsed time against the interval", () => {
  const twoMinutes = 120_000;
  assert.equal(isWatchDue("2026-08-31T15:57:00.000Z", NOW, twoMinutes), true);
  assert.equal(isWatchDue("2026-08-31T15:59:30.000Z", NOW, twoMinutes), false);
  assert.equal(isWatchDue("2026-08-31T15:58:00.000Z", NOW, twoMinutes), true);
});

test("collectWatchTargets ignores unwatched accounts and reports misconfigured ones", () => {
  const { targets, skipped } = collectWatchTargets({
    accounts: [
      { key: "off", allowedCompanies: [COMPANY] },
      { key: "no-issue", allowedCompanies: [COMPANY], watchEnabled: true },
      { key: "good", allowedCompanies: [COMPANY], watchEnabled: true, watchIssueId: ISSUE },
    ],
  } as InstanceConfig);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].accountKey, "good");
  assert.equal(targets[0].companyId, COMPANY);
  assert.equal(targets[0].mailboxId, null);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].accountKey, "no-issue");
  assert.match(skipped[0].reason, /Issue to wake/);
});

test("collectWatchTargets derives the company only when exactly one is allowed", () => {
  const base = { key: "a", watchEnabled: true, watchIssueId: ISSUE };
  const single = collectWatchTargets({
    accounts: [{ ...base, allowedCompanies: [COMPANY] }],
  } as InstanceConfig);
  assert.equal(single.targets[0]?.companyId, COMPANY);

  for (const allowed of [["*"], [COMPANY, "other-company"], []]) {
    const result = collectWatchTargets({
      accounts: [{ ...base, allowedCompanies: allowed }],
    } as InstanceConfig);
    assert.equal(result.targets.length, 0, `expected skip for ${JSON.stringify(allowed)}`);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /Watch company/);
  }

  const explicit = collectWatchTargets({
    accounts: [{ ...base, allowedCompanies: ["*"], watchCompanyId: COMPANY }],
  } as InstanceConfig);
  assert.equal(explicit.targets[0]?.companyId, COMPANY);
});

test("newestModifiedAt prefers userUpdatedAt, skips garbage, and falls back", () => {
  const newest = newestModifiedAt(
    [
      { userUpdatedAt: "2026-08-31T15:10:00.000Z", modifiedAt: "2026-08-31T15:59:00.000Z" },
      { modifiedAt: "2026-08-31T15:20:00.000Z" },
      { userUpdatedAt: "garbage" },
      {},
    ],
    "2026-08-31T00:00:00.000Z",
  );
  assert.equal(newest, "2026-08-31T15:20:00.000Z");
  assert.equal(newestModifiedAt([], "2026-08-31T00:00:00.000Z"), "2026-08-31T00:00:00.000Z");
});

test("toHelpScoutTimestamp strips milliseconds and leaves clean stamps alone", () => {
  assert.equal(toHelpScoutTimestamp("2026-08-31T14:55:00.000Z"), "2026-08-31T14:55:00Z");
  assert.equal(toHelpScoutTimestamp("2026-08-31T14:55:00.5Z"), "2026-08-31T14:55:00Z");
  assert.equal(toHelpScoutTimestamp("2026-08-31T14:55:00Z"), "2026-08-31T14:55:00Z");
});

test("wakeIdempotencyKey is stable for identical unread state", () => {
  const a = wakeIdempotencyKey("industry-bureau", null, "2026-08-31T15:20:00.000Z");
  const b = wakeIdempotencyKey("industry-bureau", null, "2026-08-31T15:20:00.000Z");
  assert.equal(a, b);
  assert.equal(a, "helpscout-watch:industry-bureau:default:2026-08-31T15:20:00.000Z");
  assert.notEqual(a, wakeIdempotencyKey("industry-bureau", "123", "2026-08-31T15:20:00.000Z"));
});

// ─── runWatch ────────────────────────────────────────────────────────────────

test("an empty poll requests no wakeup and never writes the cursor", async () => {
  const m = mockCtx();
  let requests = 0;
  const summary = await runWatch(
    m.ctx,
    watchedConfig(),
    {},
    {
      now: () => NOW,
      getAccount: async () => RESOLVED,
      request: (async () => {
        requests += 1;
        return conversationsResponse([]);
      }) as never,
    },
  );
  assert.equal(summary.ran, true);
  assert.equal(summary.targetsChecked, 1);
  assert.equal(summary.wakesRequested, 0);
  assert.equal(requests, 1);
  assert.equal(m.wakeups.length, 0);
  // The only state write is the instance-level last-poll stamp.
  assert.equal(m.stateWrites.length, 1);
  const scope = m.stateWrites[0].scope as Record<string, string>;
  assert.equal(scope.namespace, WATCH_STATE_NAMESPACE);
  assert.equal(scope.stateKey, WATCH_LAST_POLL_KEY);
  assert.equal(scope.scopeKind, "instance");
});

test("mail past the cursor requests exactly one wakeup with the right shape", async () => {
  const m = mockCtx();
  const cursorScope = triageCursorScope(COMPANY, "industry-bureau", null);
  m.stateStore.set(JSON.stringify(cursorScope), { lastRunAt: "2026-08-31T15:00:00.000Z" });

  let seenQuery: Record<string, unknown> | undefined;
  const summary = await runWatch(
    m.ctx,
    watchedConfig(),
    {},
    {
      now: () => NOW,
      getAccount: async () => RESOLVED,
      request: (async (_resolved: unknown, path: string, opts: { query: Record<string, unknown> }) => {
        assert.equal(path, "/conversations");
        seenQuery = opts.query;
        return conversationsResponse(
          [
            { userUpdatedAt: "2026-08-31T15:40:00.000Z" },
            { userUpdatedAt: "2026-08-31T15:45:00.000Z" },
          ],
          3,
        );
      }) as never,
    },
  );

  assert.equal(summary.wakesRequested, 1);
  assert.equal(m.wakeups.length, 1);
  const wake = m.wakeups[0];
  assert.equal(wake.issueId, ISSUE);
  assert.equal(wake.companyId, COMPANY);
  assert.equal(wake.options.contextSource, "help-scout.watch-new-mail");
  assert.equal(
    wake.options.idempotencyKey,
    "helpscout-watch:industry-bureau:default:2026-08-31T15:45:00.000Z",
  );
  assert.equal(wake.options.reason, buildWakeReason(3, "industry-bureau", "2026-08-31T15:45:00.000Z"));
  // Cursor untouched: still exactly the value the agent last wrote.
  assert.deepEqual(m.stateStore.get(JSON.stringify(cursorScope)), {
    lastRunAt: "2026-08-31T15:00:00.000Z",
  });
  // Search started from cursor minus overlap, status active. Help Scout
  // rejects millisecond timestamps, so the query form must carry none.
  assert.equal(seenQuery?.status, "active");
  assert.equal(seenQuery?.modifiedSince, "2026-08-31T14:55:00Z");
  assert.equal(seenQuery?.mailbox, undefined);
});

test("a mailbox-scoped watch filters the search and keys the wake by mailbox", async () => {
  const m = mockCtx();
  let seenQuery: Record<string, unknown> | undefined;
  await runWatch(
    m.ctx,
    watchedConfig({ watchMailboxId: "271444" }),
    {},
    {
      now: () => NOW,
      getAccount: async () => RESOLVED,
      request: (async (_r: unknown, _p: string, opts: { query: Record<string, unknown> }) => {
        seenQuery = opts.query;
        return conversationsResponse([{ userUpdatedAt: "2026-08-31T15:50:00.000Z" }]);
      }) as never,
    },
  );
  assert.equal(seenQuery?.mailbox, "271444");
  assert.equal(
    m.wakeups[0]?.options.idempotencyKey,
    "helpscout-watch:industry-bureau:271444:2026-08-31T15:50:00.000Z",
  );
});

test("one broken account cannot stop the next one from being checked", async () => {
  const m = mockCtx();
  const config = {
    accounts: [
      {
        key: "broken",
        allowedCompanies: [COMPANY],
        watchEnabled: true,
        watchIssueId: "11111111-1111-1111-1111-111111111111",
      },
      {
        key: "industry-bureau",
        allowedCompanies: [COMPANY],
        watchEnabled: true,
        watchIssueId: ISSUE,
      },
    ],
  } as InstanceConfig;
  const summary = await runWatch(
    m.ctx,
    config,
    {},
    {
      now: () => NOW,
      getAccount: async (_ctx, _companyId, _label, accountKey) => {
        if (accountKey === "broken") throw new Error("[ECONFIG] secret did not resolve");
        return RESOLVED;
      },
      request: (async () =>
        conversationsResponse([{ userUpdatedAt: "2026-08-31T15:50:00.000Z" }])) as never,
    },
  );
  assert.equal(summary.errors, 1);
  assert.equal(summary.wakesRequested, 1);
  assert.equal(m.errors.length, 1);
  assert.equal(m.errors[0].account, "broken");
  assert.equal(m.wakeups[0]?.issueId, ISSUE);
});

test("a refused wakeup is logged and the run still completes", async () => {
  const m = mockCtx();
  (m.ctx.issues as { requestWakeup: unknown }).requestWakeup = async () => {
    throw new Error("Issue is blocked by unresolved blockers");
  };
  const summary = await runWatch(
    m.ctx,
    watchedConfig(),
    {},
    {
      now: () => NOW,
      getAccount: async () => RESOLVED,
      request: (async () =>
        conversationsResponse([{ userUpdatedAt: "2026-08-31T15:50:00.000Z" }])) as never,
    },
  );
  assert.equal(summary.errors, 1);
  assert.equal(summary.wakesRequested, 0);
  // Last-poll still stamped, so a stuck issue cannot turn into a hot loop.
  assert.equal(m.stateWrites.length, 1);
});

test("the due-gate skips early ticks and a manual trigger bypasses it", async () => {
  const m = mockCtx();
  m.stateStore.set(
    JSON.stringify({
      scopeKind: "instance",
      namespace: WATCH_STATE_NAMESPACE,
      stateKey: WATCH_LAST_POLL_KEY,
    }),
    "2026-08-31T15:59:30.000Z",
  );
  let requests = 0;
  const deps = {
    now: () => NOW,
    getAccount: async () => RESOLVED,
    request: (async () => {
      requests += 1;
      return conversationsResponse([]);
    }) as never,
  };
  const gated = await runWatch(m.ctx, watchedConfig(), {}, deps);
  assert.equal(gated.ran, false);
  assert.equal(requests, 0);

  const manual = await runWatch(m.ctx, watchedConfig(), { bypassDueGate: true }, deps);
  assert.equal(manual.ran, true);
  assert.equal(requests, 1);
});

test("misconfigured watches are logged as warnings with their reason", async () => {
  const m = mockCtx();
  const summary = await runWatch(
    m.ctx,
    { accounts: [{ key: "a", allowedCompanies: [COMPANY], watchEnabled: true }] } as InstanceConfig,
    { bypassDueGate: true },
    { now: () => NOW, getAccount: async () => RESOLVED, request: (async () => conversationsResponse([])) as never },
  );
  assert.equal(summary.skipped.length, 1);
  assert.equal(m.warns.length, 1);
  assert.equal(m.warns[0].accountKey, "a");
});
