/**
 * Run now answers as soon as the backup has started, not when it has finished.
 *
 * A backup takes about a minute and grows with the instance, while Paperclip
 * stops waiting for a plugin request after 30 seconds. A Run now that waited
 * for the whole backup reported a failure for a backup that went on to
 * succeed. The page's button also called an action key the worker never
 * registered, so it failed at once and started nothing.
 *
 * Every backup, scheduled or Run now, takes its turn in one queue, and the
 * plugin's API answers only the companies on its allowed list.
 *
 * Snapshots are held open here unless a test says otherwise, so the backups
 * under test are still running when each assertion is made.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginApiRequestInput, ToolResult } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import plugin from "./worker.js";

type RunNowResult = { backupId: string; status: string; alreadyRunning: boolean };

const ALLOWED_COMPANY = "company-1";
const OTHER_COMPANY = "company-2";
const PAGE_CALL = { hostScope: { companyId: ALLOWED_COMPANY, userId: "user-1" } };
const CONFIG = {
  allowedCompanies: [ALLOWED_COMPANY],
  mutationsEnabled: true,
  destinations: [{ id: "local-1", kind: "local", label: "Local disk", enabled: true }],
  schedules: [],
};
const SCHEDULED_CONFIG = {
  ...CONFIG,
  schedules: [
    { id: "nightly", cadence: "daily", destinationIds: ["local-1"] },
    { id: "every-hour", cadence: "hourly", destinationIds: ["local-1"] },
  ],
};

async function startPlugin(config: Record<string, unknown> = CONFIG) {
  const harness = createTestHarness({ manifest, config });
  let snapshotsAsked = 0;
  const held: Array<(err: Error) => void> = [];
  harness.ctx.system.createSnapshot = () => {
    snapshotsAsked += 1;
    return new Promise((_resolve, reject) => {
      held.push(reject);
    });
  };
  await plugin.definition.setup(harness.ctx);
  return {
    harness,
    snapshotsAsked: () => snapshotsAsked,
    /** Fail every held snapshot and wait until each backup has recorded it. */
    async finish(...backupIds: string[]) {
      for (const fail of held.splice(0)) fail(new Error("[ETEST] snapshot refused"));
      await waitFor(() => backupIds.every((id) => recordedFailure(harness, id)));
      // Let the run's own cleanup finish before the next test starts one.
      await settle();
      await settle();
    },
  };
}

/** Answer the cadence jobs' "which schedules are due" query. */
function dueSchedules(harness: TestHarness, byCadence: Record<string, string[]>) {
  const db = harness.ctx.db as { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };
  const query = db.query.bind(db);
  db.query = async (sql, params) => {
    if (sql.includes("schedule_state") && sql.includes("next_run_after <= now()")) {
      return (byCadence[String(params?.[0])] ?? []).map((scheduleId) => ({ schedule_id: scheduleId }));
    }
    return query(sql, params);
  };
}

function backupInserts(harness: TestHarness) {
  return harness.dbExecutes.filter((e) => /INSERT INTO \S+\.backups \(/.test(e.sql));
}

function failureWrites(harness: TestHarness, backupId: string) {
  return harness.dbExecutes.filter((e) => e.sql.includes("SET status = 'failed'") && e.params?.[0] === backupId);
}

function recordedFailure(harness: TestHarness, backupId: string) {
  return failureWrites(harness, backupId).length > 0;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await settle();
  }
}

/** Fail, rather than hang, when a caller waits for the whole backup. */
async function answeredWithin<T>(work: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms: the caller waited for the backup`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

function apiCall(overrides: Partial<PluginApiRequestInput> = {}): PluginApiRequestInput {
  return {
    routeKey: "backups.run-now",
    method: "POST",
    path: "/backups/run-now",
    params: {},
    query: { companyId: ALLOWED_COMPANY },
    body: {},
    actor: { actorType: "user", actorId: "user-1", userId: "user-1" },
    companyId: ALLOWED_COMPANY,
    headers: {},
    ...overrides,
  };
}

test("the page's Run now starts a backup and answers while it is still running", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  const started = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));

  assert.equal(started.status, "running");
  assert.equal(started.alreadyRunning, false);
  assert.equal(run.snapshotsAsked(), 1);
  assert.equal(backupInserts(run.harness).length, 1);
  assert.equal(backupInserts(run.harness)[0].params?.[0], started.backupId);

  await run.finish(started.backupId);
});

test("a second Run now while one is going reports that backup instead of starting another", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  const first = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
  const second = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));

  assert.deepEqual(second, { backupId: first.backupId, status: "running", alreadyRunning: true });
  assert.equal(run.snapshotsAsked(), 1);
  assert.equal(backupInserts(run.harness).length, 1);

  // Once it has finished, Run now starts a fresh backup again.
  await run.finish(first.backupId);
  const third = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
  assert.equal(third.alreadyRunning, false);
  assert.notEqual(third.backupId, first.backupId);
  await run.finish(third.backupId);
});

test("the backups.run-now API route answers 202 while the backup runs", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  const response = await answeredWithin(plugin.definition.onApiRequest!(apiCall()));

  assert.equal(response.status, 202);
  const body = response.body as RunNowResult;
  assert.equal(body.status, "running");
  assert.equal(run.snapshotsAsked(), 1);

  await run.finish(body.backupId);
});

test("the backup_run_now agent tool answers while the backup runs", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  const result = await answeredWithin(
    run.harness.executeTool<ToolResult>("backup_run_now", {}, { companyId: ALLOWED_COMPANY }),
  );

  assert.equal(result.error, undefined);
  const data = result.data as RunNowResult;
  assert.equal(data.status, "running");
  assert.match(String(result.content), /backup_get_status/);

  await run.finish(data.backupId);
});

test("Run now from a company that is not on the allow-list starts nothing", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  await assert.rejects(
    answeredWithin(run.harness.performAction("backups.run-now", { hostScope: { companyId: OTHER_COMPANY, userId: "user-1" } })),
    /ECOMPANY_NOT_ALLOWED/,
  );
  assert.equal(run.snapshotsAsked(), 0);
  assert.equal(backupInserts(run.harness).length, 0);
});

test("Run now with no enabled destination says so instead of taking a snapshot", { timeout: 10_000 }, async () => {
  const run = await startPlugin({ ...CONFIG, destinations: [] });
  await assert.rejects(
    answeredWithin(run.harness.performAction("backups.run-now", PAGE_CALL)),
    /EBACKUP_NO_DESTINATIONS/,
  );
  assert.equal(run.snapshotsAsked(), 0);
});

test("starting the plugin closes a backup a stopped worker left marked running", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  const closed = run.harness.dbExecutes.find(
    (e) => e.sql.includes("SET status = 'failed'") && e.sql.includes("WHERE status = 'running'"),
  );
  assert.ok(closed, "setup should close backups left running");
  assert.match(String(closed.params?.[0]), /EBACKUP_INTERRUPTED/);
});

test("the plugin's API routes refuse a company that is not on the allowed list", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  const asOtherCompany = (routeKey: string, method: string, path: string, params: Record<string, string> = {}) =>
    answeredWithin(
      plugin.definition.onApiRequest!(
        apiCall({ routeKey, method, path, params, query: { companyId: OTHER_COMPANY }, companyId: OTHER_COMPANY }),
      ),
    );

  const runNow = await asOtherCompany("backups.run-now", "POST", "/backups/run-now");
  assert.equal(runNow.status, 403);
  assert.match(String((runNow.body as { error?: string }).error), /ECOMPANY_NOT_ALLOWED/);
  assert.equal(run.snapshotsAsked(), 0);
  assert.equal(backupInserts(run.harness).length, 0);

  assert.equal((await asOtherCompany("backups.list", "GET", "/backups")).status, 403);
  const archives = await asOtherCompany("destinations.list-archives", "GET", "/destinations/local-1/list-archives", { id: "local-1" });
  assert.equal(archives.status, 403);
  const health = await asOtherCompany("destinations.health", "POST", "/destinations/local-1/health", { id: "local-1" });
  assert.equal(health.status, 403);
});

test("dashboard.health answers only the companies on the allowed list", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  await assert.rejects(
    run.harness.getData("dashboard.health", { hostScope: { companyId: OTHER_COMPANY, userId: "user-1" } }),
    /ECOMPANY_NOT_ALLOWED/,
  );
  assert.deepEqual(await run.harness.getData("dashboard.health", PAGE_CALL), { lastRun: null, nextRunAfter: null });
});

test("a scheduled backup that comes due during Run now's backup waits for it, then runs", { timeout: 10_000 }, async () => {
  const run = await startPlugin(SCHEDULED_CONFIG);
  dueSchedules(run.harness, { daily: ["nightly"] });
  const manual = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));

  let jobDone = false;
  const job = run.harness.runJob("cadence_daily").then(() => {
    jobDone = true;
  });
  await sleep(50);
  // Starting beside Run now's backup failed at once: the host makes one snapshot at a time.
  assert.equal(run.snapshotsAsked(), 1);
  assert.equal(backupInserts(run.harness).length, 1);

  await run.finish(manual.backupId);
  await waitFor(() => backupInserts(run.harness).length === 2);
  const scheduled = backupInserts(run.harness)[1];
  assert.equal(scheduled.params?.[2], "daily");
  assert.equal(scheduled.params?.[3], "nightly");
  assert.equal(run.snapshotsAsked(), 2);
  assert.equal(jobDone, false);

  await run.finish(String(scheduled.params?.[0]));
  await job;
});

test("Run now during a scheduled backup hands back that backup", { timeout: 10_000 }, async () => {
  const run = await startPlugin(SCHEDULED_CONFIG);
  dueSchedules(run.harness, { daily: ["nightly"] });
  const job = run.harness.runJob("cadence_daily");
  await waitFor(() => backupInserts(run.harness).length === 1);
  const scheduledId = String(backupInserts(run.harness)[0].params?.[0]);

  const clicked = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
  assert.deepEqual(clicked, { backupId: scheduledId, status: "running", alreadyRunning: true });
  assert.equal(run.snapshotsAsked(), 1);

  await run.finish(scheduledId);
  await job;
});

test("two schedules that come due at once run one after the other", { timeout: 10_000 }, async () => {
  const run = await startPlugin(SCHEDULED_CONFIG);
  dueSchedules(run.harness, { hourly: ["every-hour"], daily: ["nightly"] });
  const jobs = Promise.all([run.harness.runJob("cadence_hourly"), run.harness.runJob("cadence_daily")]);
  await waitFor(() => backupInserts(run.harness).length === 1);
  await sleep(50);
  assert.equal(backupInserts(run.harness).length, 1);
  assert.equal(run.snapshotsAsked(), 1);

  await run.finish(String(backupInserts(run.harness)[0].params?.[0]));
  await waitFor(() => backupInserts(run.harness).length === 2);
  await run.finish(String(backupInserts(run.harness)[1].params?.[0]));
  await jobs;
});

test("a backup still running after maxRunMinutes is marked failed and stops blocking Run now", { timeout: 10_000 }, async () => {
  // 0.002 minutes is 120 ms.
  const run = await startPlugin({ ...CONFIG, maxRunMinutes: 0.002 });
  const stuck = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
  await waitFor(() => recordedFailure(run.harness, stuck.backupId), 3_000);
  assert.match(String(failureWrites(run.harness, stuck.backupId)[0].params?.[1]), /EBACKUP_TIMED_OUT/);

  const next = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
  assert.equal(next.alreadyRunning, false);
  assert.notEqual(next.backupId, stuck.backupId);

  // The stuck backup finally ends. It must not write over the timeout.
  await run.finish(next.backupId);
  await settle();
  assert.equal(failureWrites(run.harness, stuck.backupId).length, 1);
});

test("a backup whose failure could not be recorded still has its row closed, and Run now works again", { timeout: 10_000 }, async () => {
  const run = await startPlugin();
  const db = run.harness.ctx.db as { execute: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> };
  const execute = db.execute.bind(db);
  let refused = false;
  db.execute = async (sql, params) => {
    // The backup's own failure write fails once, as if the database blinked.
    if (!refused && sql.includes("SET status = 'failed'") && !sql.includes("status = 'running'")) {
      refused = true;
      throw new Error("database went away");
    }
    return execute(sql, params);
  };

  const broken = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
  await run.finish(broken.backupId);
  assert.equal(refused, true);
  assert.ok(failureWrites(run.harness, broken.backupId).some((e) => e.sql.includes("AND status = 'running'")));

  const next = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
  assert.equal(next.alreadyRunning, false);
  await run.finish(next.backupId);
});

test("a backup that succeeds clears any earlier reason left on its row", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "backup-tools-test-"));
  try {
    const dump = join(dir, "dump.sql.gz");
    await writeFile(dump, "select 1;\n");
    const harness = createTestHarness({
      manifest,
      config: {
        ...CONFIG,
        destinations: [{ id: "local-ok", kind: "local", label: "Local disk", enabled: true, config: { path: join(dir, "archives") } }],
      },
    });
    const stubSnapshot = harness.ctx.system.createSnapshot.bind(harness.ctx.system);
    harness.ctx.system.createSnapshot = async () => ({ ...(await stubSnapshot()), filePath: dump });
    await plugin.definition.setup(harness.ctx);

    const started = await answeredWithin(harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));
    const finished = () =>
      harness.dbExecutes.find((e) => e.sql.includes("manifest_json = $4") && e.params?.[0] === started.backupId);
    await waitFor(() => finished() !== undefined, 45_000);
    await settle();

    const done = finished()!;
    assert.equal(done.params?.[1], "succeeded");
    assert.match(done.sql, /error_summary = NULL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a request for other destinations while a backup runs is refused rather than handed that backup", { timeout: 10_000 }, async () => {
  const run = await startPlugin({
    ...CONFIG,
    destinations: [
      { id: "local-1", kind: "local", label: "Local disk", enabled: true },
      { id: "local-2", kind: "local", label: "Second disk", enabled: true },
    ],
  });
  const running = await answeredWithin(run.harness.performAction<RunNowResult>("backups.run-now", PAGE_CALL));

  const tool = await answeredWithin(
    run.harness.executeTool<ToolResult>("backup_run_now", { destinationId: "local-2" }, { companyId: ALLOWED_COMPANY }),
  );
  assert.match(String(tool.error), /a backup is already running, try again when it finishes/);

  const api = await answeredWithin(plugin.definition.onApiRequest!(apiCall({ body: { destinationIds: ["local-1"] } })));
  assert.equal(api.status, 409);

  // Asking for exactly the destinations it is using gets that backup.
  const same = await answeredWithin(
    plugin.definition.onApiRequest!(apiCall({ body: { destinationIds: ["local-2", "local-1"] } })),
  );
  assert.equal(same.status, 202);
  assert.equal((same.body as RunNowResult).backupId, running.backupId);
  assert.equal(run.snapshotsAsked(), 1);

  await run.finish(running.backupId);
});

test("backup_run_now no longer claims to honour an idempotency key", () => {
  const tool = manifest.tools?.find((t) => t.name === "backup_run_now");
  assert.ok(tool);
  assert.doesNotMatch(tool.description, /idempotency/i);
  const properties = (tool.parametersSchema as { properties: Record<string, { description?: string }> }).properties;
  assert.doesNotMatch(String(properties.idempotencyKey?.description), /short-circuit/i);
});
