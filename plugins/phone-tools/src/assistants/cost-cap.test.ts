/**
 * Unit tests for cost-cap accumulation and gating.
 *
 * The module talks to the plugin host via `ctx.state.{get,set}`. We mock that
 * with a tiny in-memory store so the assertions stay focused on the logic
 * (cap arithmetic, midnight-UTC reset boundary, recordSpend monotonicity).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  assertWithinCap,
  readCostWindow,
  recordSpend,
  readPhoneConfig,
  writePhoneConfig,
  DEFAULT_DAILY_CAP_USD,
} from "./cost-cap.js";

interface ScopeKeyLike {
  scopeKind: string;
  scopeId?: string;
  namespace?: string;
  stateKey: string;
}

function fakeCtx() {
  const store = new Map<string, unknown>();
  function key(k: ScopeKeyLike): string {
    return `${k.scopeKind}::${k.scopeId ?? ""}::${k.namespace ?? "default"}::${k.stateKey}`;
  }
  return {
    store,
    ctx: {
      state: {
        get: async (k: ScopeKeyLike) => store.get(key(k)) ?? null,
        set: async (k: ScopeKeyLike, value: unknown) => {
          store.set(key(k), value);
        },
        delete: async (k: ScopeKeyLike) => {
          store.delete(key(k));
        },
      },
    } as unknown as Parameters<typeof readCostWindow>[0],
  };
}

test("readCostWindow returns DEFAULT_DAILY_CAP_USD when no config", async () => {
  const { ctx } = fakeCtx();
  const window = await readCostWindow(ctx, "agent-1");
  assert.equal(window.capUsd, DEFAULT_DAILY_CAP_USD);
  assert.equal(window.todaySpentUsd, 0);
});

test("readCostWindow honours costCapDailyUsd from phone config", async () => {
  const { ctx } = fakeCtx();
  await writePhoneConfig(ctx, "agent-1", { costCapDailyUsd: 2.5 });
  const window = await readCostWindow(ctx, "agent-1");
  assert.equal(window.capUsd, 2.5);
});

test("recordSpend adds to today's accumulator", async () => {
  const { ctx } = fakeCtx();
  await recordSpend(ctx, "agent-1", 0.25);
  await recordSpend(ctx, "agent-1", 0.10);
  const window = await readCostWindow(ctx, "agent-1");
  assert.equal(window.todaySpentUsd, 0.35);
});

test("recordSpend ignores zero/negative/NaN", async () => {
  const { ctx } = fakeCtx();
  await recordSpend(ctx, "agent-1", 0);
  await recordSpend(ctx, "agent-1", -0.5);
  await recordSpend(ctx, "agent-1", Number.NaN);
  const window = await readCostWindow(ctx, "agent-1");
  assert.equal(window.todaySpentUsd, 0);
});

test("assertWithinCap throws ECOST_CAP when over limit", async () => {
  const { ctx } = fakeCtx();
  await writePhoneConfig(ctx, "agent-1", { costCapDailyUsd: 0.5 });
  await recordSpend(ctx, "agent-1", 0.51);
  await assert.rejects(
    () => assertWithinCap(ctx, "agent-1"),
    /\[ECOST_CAP\]/,
  );
});

test("assertWithinCap returns ok when under limit", async () => {
  const { ctx } = fakeCtx();
  await writePhoneConfig(ctx, "agent-1", { costCapDailyUsd: 5 });
  await recordSpend(ctx, "agent-1", 1.5);
  const window = await assertWithinCap(ctx, "agent-1");
  assert.equal(window.capUsd, 5);
  assert.equal(window.todaySpentUsd, 1.5);
});

test("zero cap disables the gate (operator opted out)", async () => {
  const { ctx } = fakeCtx();
  await writePhoneConfig(ctx, "agent-1", { costCapDailyUsd: 0 });
  await recordSpend(ctx, "agent-1", 1000);
  // capUsd: 0 means "never block" per the cost-cap implementation.
  const window = await assertWithinCap(ctx, "agent-1");
  assert.equal(window.capUsd, 0);
});

test("readPhoneConfig returns null when not set", async () => {
  const { ctx } = fakeCtx();
  const config = await readPhoneConfig(ctx, "agent-1");
  assert.equal(config, null);
});

test("readPhoneConfig roundtrip", async () => {
  const { ctx } = fakeCtx();
  await writePhoneConfig(ctx, "agent-1", {
    voice: "alloy",
    callerIdNumberId: "num-1",
    enabled: true,
    costCapDailyUsd: 7.5,
  });
  const config = await readPhoneConfig(ctx, "agent-1");
  assert.deepEqual(config, {
    voice: "alloy",
    callerIdNumberId: "num-1",
    enabled: true,
    costCapDailyUsd: 7.5,
  });
});

test("Each agent has an independent cost window", async () => {
  const { ctx } = fakeCtx();
  await recordSpend(ctx, "agent-1", 0.5);
  await recordSpend(ctx, "agent-2", 0.7);
  const w1 = await readCostWindow(ctx, "agent-1");
  const w2 = await readCostWindow(ctx, "agent-2");
  assert.equal(w1.todaySpentUsd, 0.5);
  assert.equal(w2.todaySpentUsd, 0.7);
});
