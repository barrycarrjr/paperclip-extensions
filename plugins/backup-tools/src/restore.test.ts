/**
 * The Restore tab's Preview and Apply work, and only for instance admins.
 *
 * Both called page actions the plugin never registered, so they failed at
 * once, as Run now did before 0.1.32. Behind them the restore could not have
 * worked either: it posted the decrypted dump to Paperclip's own HTTP API,
 * which a worker cannot reach, and it skipped the archive's envelope in a way
 * that lost the rest of any archive longer than one read.
 *
 * A preview checks the whole archive in the plugin and keeps nothing. An
 * apply writes the decrypted dump to a private folder for Paperclip, and no
 * backup may run beside it.
 *
 * The archive here is real: a real backup of a stub dump to a local folder.
 * Paperclip's side, ctx.system.restoreSnapshot, is a stub that keeps a copy
 * of the dump it was handed.
 */
import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { PluginApiRequestInput, ToolResult } from "@paperclipai/plugin-sdk";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "./manifest.js";
import plugin, { type SystemRestoreCall } from "./worker.js";

const COMPANY = "company-1";
const DESTINATION = "local-restore";
/** What the harness resolves the passphrase secret to, for the backup and the restore alike. */
const PASSPHRASE = "resolved:BACKUP_PASSPHRASE";
const CONFIRM = "RESTORE THIS INSTANCE";
const ADMIN = { hostScope: { companyId: COMPANY, userId: "admin-1", isInstanceAdmin: true } };
const MEMBER = { hostScope: { companyId: COMPANY, userId: "user-1", isInstanceAdmin: false } };

type Started = { restoreId: string; mode: string; status: string };
type RestoreView = {
  restoreId: string;
  mode: string;
  status: string;
  stage: string | null;
  requestedBy: string | null;
  archive: { createdAt: string; instanceId: string; cadence: string; tables: number; rows: number } | null;
  result: { applied: boolean; dryRun: boolean; warnings: string[] } | null;
  error: string | null;
};
type RestoreStatus = { isInstanceAdmin: boolean; restore: RestoreView | null };

// A temp folder of the tests' own, so the decrypted dumps, and the sweep of
// leftovers when the plugin starts, stay inside it.
const realTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
const testTemp = await mkdtemp(join(tmpdir(), "backup-tools-restore-temp-"));
process.env.TEMP = testTemp;
process.env.TMP = testTemp;
process.env.TMPDIR = testTemp;
const workDir = await mkdtemp(join(tmpdir(), "backup-tools-restore-"));
after(async () => {
  for (const [name, value] of Object.entries(realTemp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(testTemp, { recursive: true, force: true });
});

const CONFIG = {
  allowedCompanies: [COMPANY],
  passphraseSecretRef: "BACKUP_PASSPHRASE",
  mutationsEnabled: true,
  destinations: [
    { id: DESTINATION, kind: "local", label: "Local disk", enabled: true, config: { path: join(workDir, "archives") } },
  ],
  schedules: [],
};

const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean | Promise<boolean>, ms = 45_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Fail, rather than hang, when a caller waits for the whole restore. */
async function answeredWithin<T>(work: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms: the caller waited for the restore`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Decrypted dumps in the temp folder: the apply's folders, and the loose files older versions wrote. */
function decryptedOnDisk(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("pcback-restore-") || name.startsWith("pcback-decrypt-"));
}

/** Paperclip's side of a restore. Keeps each dump it is handed, and can be held or made to refuse. */
function paperclipRestore(harness: TestHarness) {
  const calls: Array<{
    filePath: string;
    mode: string;
    conflictMode?: string;
    requestedByUserId?: string | null;
    dump: Buffer;
    fileMode: number;
  }> = [];
  let gate: Promise<void> | null = null;
  let refusal: Error | null = null;
  const restoreSnapshot: SystemRestoreCall = async (input) => {
    calls.push({ ...input, dump: await readFile(input.filePath), fileMode: statSync(input.filePath).mode & 0o777 });
    if (gate) await gate;
    if (refusal) throw refusal;
    return { applied: input.mode === "apply", dryRun: input.mode === "preview", touchedTables: [], warnings: [] };
  };
  (harness.ctx.system as unknown as { restoreSnapshot: SystemRestoreCall }).restoreSnapshot = restoreSnapshot;
  return {
    calls,
    /** Hold the next answer until the returned function is called. */
    hold(): () => void {
      let open!: () => void;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    refuse(err: Error) {
      refusal = err;
    },
  };
}

/** Snapshots for backups, counted, each held until the test fails it. */
function heldSnapshots(harness: TestHarness) {
  const held: Array<(err: Error) => void> = [];
  let asked = 0;
  harness.ctx.system.createSnapshot = () => {
    asked += 1;
    return new Promise((_resolve, reject) => {
      held.push(reject);
    });
  };
  return {
    asked: () => asked,
    failAll() {
      for (const fail of held.splice(0)) fail(new Error("[ETEST] snapshot refused"));
    },
  };
}

async function startPlugin(config: Record<string, unknown> = CONFIG) {
  const harness = createTestHarness({ manifest, config });
  const paperclip = paperclipRestore(harness);
  await plugin.definition.setup(harness.ctx);
  return { harness, paperclip };
}

/** The restore once it has finished, read the way the page reads it. */
async function finished(harness: TestHarness, restoreId: string): Promise<RestoreView> {
  let view: RestoreView | null = null;
  await waitFor(async () => {
    const status = await harness.getData<RestoreStatus>("restore.status", ADMIN);
    view = status.restore?.restoreId === restoreId && status.restore.status !== "running" ? status.restore : null;
    return view !== null;
  });
  return view!;
}

function apply(archiveKey: string, extra: Record<string, unknown> = {}) {
  return { ...ADMIN, destinationId: DESTINATION, archiveKey, confirmPhrase: CONFIRM, ...extra };
}

function failureWrites(harness: TestHarness, backupId: string) {
  return harness.dbExecutes.filter((e) => e.sql.includes("SET status = 'failed'") && e.params?.[0] === backupId);
}

let made: Promise<{ key: string; dump: Buffer }> | null = null;

/** One real archive for the whole file, made by a real backup. */
function archive() {
  made ??= (async () => {
    // Longer than one read of the archive file (64 KiB) and than one encrypted
    // chunk (4 MiB), so skipping the envelope and joining chunks both count.
    const dump = randomBytes(4 * 1024 * 1024 + 300 * 1024);
    const dumpPath = join(workDir, "dump.sql.gz");
    await writeFile(dumpPath, dump);
    const { harness } = await startPlugin();
    const stubSnapshot = harness.ctx.system.createSnapshot.bind(harness.ctx.system);
    harness.ctx.system.createSnapshot = async () => ({ ...(await stubSnapshot()), filePath: dumpPath });

    const started = await harness.performAction<{ backupId: string }>("backups.run-now", ADMIN);
    const done = () =>
      harness.dbExecutes.find((e) => e.sql.includes("manifest_json = $4") && e.params?.[0] === started.backupId);
    await waitFor(() => done() !== undefined);
    assert.equal(done()!.params?.[1], "succeeded");
    // Let the backup's turn end before a test asks whether one is running.
    for (let i = 0; i < 5; i++) await settle();

    const [key] = readdirSync(join(workDir, "archives")).filter((name) => name.endsWith(".pcback"));
    assert.ok(key, "the backup should have written an archive");
    return { key, dump };
  })();
  return made;
}

/** A copy of the archive, changed by `change`, under a new key. */
async function alteredArchive(key: string, name: string, change: (bytes: Buffer) => Buffer): Promise<string> {
  const altered = `${name}-${key}`;
  await writeFile(join(workDir, "archives", altered), change(await readFile(join(workDir, "archives", key))));
  return altered;
}

function apiCall(overrides: Partial<PluginApiRequestInput>): PluginApiRequestInput {
  return {
    routeKey: "restore.preview",
    method: "POST",
    path: "/restore/preview",
    params: {},
    query: { companyId: COMPANY },
    body: {},
    actor: { actorType: "user", actorId: "admin-2", userId: "admin-2" },
    companyId: COMPANY,
    headers: {},
    ...overrides,
  };
}

test("a preview checks every part of the archive and keeps nothing of it", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const seenOnDisk = new Set<string>();
  const watch = setInterval(() => decryptedOnDisk().forEach((name) => seenOnDisk.add(name)), 2);
  try {
    // A blank passphrase means this instance's own key.
    const started = await answeredWithin(
      harness.performAction<Started>("restore.preview", {
        ...ADMIN,
        destinationId: DESTINATION,
        archiveKey: key,
        passphrase: "",
        conflictMode: "overwrite",
      }),
    );
    assert.equal(started.status, "running");
    assert.equal(started.mode, "preview");

    const view = await finished(harness, started.restoreId);
    assert.equal(view.status, "succeeded", view.error ?? "");
    assert.deepEqual(view.result, { applied: false, dryRun: true, warnings: [] });
    assert.equal(view.archive?.instanceId, "stub-instance");
    assert.doesNotMatch(JSON.stringify(view), new RegExp(PASSPHRASE));
  } finally {
    clearInterval(watch);
  }
  // Paperclip reads an archive only to apply it, and the database never reached the disk.
  assert.equal(paperclip.calls.length, 0);
  assert.deepEqual([...seenOnDisk], []);
});

test("an apply hands Paperclip the dump from a private folder, says who asked, and files it once done", { timeout: 90_000 }, async () => {
  const { key, dump } = await archive();
  const { harness, paperclip } = await startPlugin();

  await assert.rejects(
    harness.performAction("restore.apply", apply(key, { confirmPhrase: "restore this instance" })),
    /EBACKUP_RESTORE_NOT_CONFIRMED/,
  );
  assert.equal(paperclip.calls.length, 0);

  const started = await answeredWithin(harness.performAction<Started>("restore.apply", apply(key, { passphrase: PASSPHRASE })));
  const view = await finished(harness, started.restoreId);
  assert.equal(view.status, "succeeded", view.error ?? "");
  assert.equal(view.result?.applied, true);
  assert.equal(view.requestedBy, "admin-1");

  assert.equal(paperclip.calls.length, 1);
  const call = paperclip.calls[0];
  assert.equal(call.mode, "apply");
  assert.equal(call.conflictMode, "overwrite");
  assert.equal(call.requestedByUserId, "admin-1");
  assert.ok(call.dump.equals(dump), "Paperclip should get exactly the dump the backup took");
  // Alone in a fresh folder of its own, readable by this account only.
  assert.equal(dirname(dirname(call.filePath)), tmpdir());
  assert.match(basename(dirname(call.filePath)), new RegExp(`^pcback-restore-${process.pid}-`));
  if (process.platform !== "win32") assert.equal(call.fileMode, 0o600);
  assert.equal(existsSync(dirname(call.filePath)), false, "the decrypted dump should be gone afterwards");

  const filed = harness.activity.find((entry) => entry.message === "backup.restore.applied");
  assert.ok(filed, "the apply should be in the activity log");
  // The harness records the whole entry; its type leaves out the company.
  assert.equal((filed as { companyId?: string }).companyId, COMPANY);
  assert.equal(filed.metadata?.requestedByUserId, "admin-1");
  assert.equal(filed.metadata?.restoreId, started.restoreId);
  const logged = harness.logs.filter((entry) => /^restore apply (started|finished)$/.test(entry.message));
  assert.deepEqual(logged.map((entry) => entry.meta?.requestedBy), ["admin-1", "admin-1"]);
});

test("only an instance admin can preview or apply a restore, or see one", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const latestBefore = (await harness.getData<RestoreStatus>("restore.status", ADMIN)).restore?.restoreId;

  const notAdmins = [
    MEMBER,
    // An older Paperclip, which did not say.
    { hostScope: { companyId: COMPANY, userId: "user-1" } },
    // A claim the browser made, outside what the host stamped.
    { ...MEMBER, isInstanceAdmin: true },
  ];
  for (const caller of notAdmins) {
    for (const action of ["restore.preview", "restore.apply"]) {
      await assert.rejects(
        harness.performAction(action, { ...caller, destinationId: DESTINATION, archiveKey: key, confirmPhrase: CONFIRM }),
        /EBACKUP_RESTORE_NOT_ADMIN/,
      );
    }
    assert.deepEqual(await harness.getData("restore.status", caller), { isInstanceAdmin: false, restore: null });
  }

  assert.equal(paperclip.calls.length, 0);
  const latestAfter = (await harness.getData<RestoreStatus>("restore.status", ADMIN)).restore?.restoreId;
  assert.equal(latestAfter, latestBefore, "no restore should have started");
});

test("a restore answers while Paperclip is still at work, and a second one waits its turn", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const release = paperclip.hold();
  try {
    const started = await answeredWithin(harness.performAction<Started>("restore.apply", apply(key)));
    await waitFor(() => paperclip.calls.length === 1);
    const running = (await harness.getData<RestoreStatus>("restore.status", ADMIN)).restore;
    assert.equal(running?.restoreId, started.restoreId);
    assert.equal(running?.status, "running");
    assert.equal(running?.stage, "paperclip");

    await assert.rejects(
      harness.performAction("restore.preview", { ...ADMIN, destinationId: DESTINATION, archiveKey: key }),
      /EBACKUP_RESTORE_RUNNING/,
    );

    release();
    assert.equal((await finished(harness, started.restoreId)).status, "succeeded");
    assert.equal(paperclip.calls.length, 1);
  } finally {
    release();
  }
});

test("while an apply runs, Run now is refused on the page, the API and the agent tool", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const snapshots = heldSnapshots(harness);
  const release = paperclip.hold();
  try {
    const started = await harness.performAction<Started>("restore.apply", apply(key));
    await waitFor(() => paperclip.calls.length === 1);

    await assert.rejects(harness.performAction("backups.run-now", ADMIN), /EBACKUP_RESTORE_RUNNING/);
    const tool = await harness.executeTool<ToolResult>("backup_run_now", {}, { companyId: COMPANY });
    assert.match(String(tool.error), /EBACKUP_RESTORE_RUNNING/);
    const api = await plugin.definition.onApiRequest!(
      apiCall({ routeKey: "backups.run-now", path: "/backups/run-now", body: {} }),
    );
    assert.equal(api.status, 409);
    assert.equal(snapshots.asked(), 0);

    release();
    assert.equal((await finished(harness, started.restoreId)).status, "succeeded");
  } finally {
    release();
  }
});

test("a scheduled backup that comes due during an apply waits for it, then runs", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin({
    ...CONFIG,
    schedules: [{ id: "nightly", cadence: "daily", destinationIds: [DESTINATION] }],
  });
  const db = harness.ctx.db as { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };
  const query = db.query.bind(db);
  db.query = async (sql, params) =>
    sql.includes("schedule_state") && sql.includes("next_run_after <= now()") && params?.[0] === "daily"
      ? [{ schedule_id: "nightly" }]
      : query(sql, params);
  const snapshots = heldSnapshots(harness);
  const release = paperclip.hold();
  let job: Promise<void> | null = null;
  try {
    const started = await harness.performAction<Started>("restore.apply", apply(key));
    await waitFor(() => paperclip.calls.length === 1);

    job = harness.runJob("cadence_daily");
    await sleep(100);
    assert.equal(snapshots.asked(), 0, "the scheduled backup should wait for the apply");

    release();
    assert.equal((await finished(harness, started.restoreId)).status, "succeeded");
    await waitFor(() => snapshots.asked() === 1);
  } finally {
    release();
    snapshots.failAll();
    await job;
    for (let i = 0; i < 5; i++) await settle();
  }
});

test("apply is refused while a backup runs", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const snapshots = heldSnapshots(harness);
  const backup = await harness.performAction<{ backupId: string }>("backups.run-now", ADMIN);

  await assert.rejects(harness.performAction("restore.apply", apply(key)), /EBACKUP_BACKUP_RUNNING/);
  assert.equal(paperclip.calls.length, 0);

  // End the backup so the next test starts with none running.
  snapshots.failAll();
  await waitFor(() => failureWrites(harness, backup.backupId).length > 0);
  for (let i = 0; i < 5; i++) await settle();
});

test("apply is refused while a backup its deadline gave up on is still at work", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  // 0.002 minutes is 120 ms.
  const { harness, paperclip } = await startPlugin({ ...CONFIG, maxRunMinutes: 0.002 });
  const snapshots = heldSnapshots(harness);
  const backup = await harness.performAction<{ backupId: string }>("backups.run-now", ADMIN);
  // The deadline records it as failed and frees the queue; its snapshot is still going.
  await waitFor(() => failureWrites(harness, backup.backupId).some((e) => String(e.params?.[1]).includes("EBACKUP_TIMED_OUT")), 3_000);

  await assert.rejects(harness.performAction("restore.apply", apply(key)), /EBACKUP_BACKUP_RUNNING/);
  assert.equal(paperclip.calls.length, 0);

  // Once it has really stopped, an apply may go ahead.
  snapshots.failAll();
  for (let i = 0; i < 5; i++) await settle();
  const started = await harness.performAction<Started>("restore.apply", apply(key));
  assert.equal((await finished(harness, started.restoreId)).status, "succeeded");
});

test("a wrong passphrase fails the preview with a reason, before anything reaches Paperclip", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const started = await harness.performAction<Started>("restore.preview", {
    ...ADMIN,
    destinationId: DESTINATION,
    archiveKey: key,
    passphrase: "not-the-passphrase",
  });

  const view = await finished(harness, started.restoreId);
  assert.equal(view.status, "failed");
  assert.match(String(view.error), /EBACKUP_INTEGRITY_FAILED/);
  assert.equal(paperclip.calls.length, 0);
});

test("a preview fails an archive that is cut off, or that has more after its end", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness } = await startPlugin();
  const cut = await alteredArchive(key, "cut", (bytes) => bytes.subarray(0, bytes.length - 100));
  const padded = await alteredArchive(key, "padded", (bytes) => Buffer.concat([bytes, Buffer.from("trailing bytes")]));

  for (const [archiveKey, reason] of [[cut, /cut off/], [padded, /data after its end marker/]] as const) {
    const started = await harness.performAction<Started>("restore.preview", { ...ADMIN, destinationId: DESTINATION, archiveKey });
    const view = await finished(harness, started.restoreId);
    assert.equal(view.status, "failed", `${archiveKey} should not preview as whole`);
    assert.match(String(view.error), /EBACKUP_INTEGRITY_FAILED/);
    assert.match(String(view.error), reason);
  }
});

test("an apply of a damaged archive fails, and leaves no decrypted part of it on disk", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  // Break the last chunk, so the first one has decrypted and been written by then.
  const damaged = await alteredArchive(key, "damaged", (bytes) => {
    const copy = Buffer.from(bytes);
    copy[copy.length - 10] ^= 0xff;
    return copy;
  });

  const started = await harness.performAction<Started>("restore.apply", apply(damaged));
  const view = await finished(harness, started.restoreId);
  assert.equal(view.status, "failed");
  assert.match(String(view.error), /EBACKUP_INTEGRITY_FAILED/);
  assert.equal(paperclip.calls.length, 0);
  assert.deepEqual(decryptedOnDisk(), []);
});

test("Paperclip's refusal is reported, such as a backup holding its lock", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  paperclip.refuse(new Error("ESNAPSHOT_IN_FLIGHT: cannot restore while a backup is running"));
  const started = await harness.performAction<Started>("restore.apply", apply(key));

  const view = await finished(harness, started.restoreId);
  assert.equal(view.status, "failed");
  assert.match(String(view.error), /ESNAPSHOT_IN_FLIGHT/);
  assert.equal(paperclip.calls.length, 1);
  assert.equal(existsSync(dirname(paperclip.calls[0].filePath)), false, "the decrypted dump should be gone afterwards");
  assert.ok(harness.activity.some((entry) => entry.message === "backup.restore.failed"));
});

test("a build without Paperclip's restore call says so instead of crashing", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness } = await startPlugin();
  delete (harness.ctx.system as unknown as { restoreSnapshot?: unknown }).restoreSnapshot;
  const started = await harness.performAction<Started>("restore.apply", apply(key));

  const view = await finished(harness, started.restoreId);
  assert.equal(view.status, "failed");
  assert.match(String(view.error), /EBACKUP_RESTORE_UNSUPPORTED/);
  assert.deepEqual(decryptedOnDisk(), []);
});

test("the restore API routes start a restore, say who asked, and restore.get follows it", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const api = plugin.definition.onApiRequest!;

  const preview = await answeredWithin(api(apiCall({ body: { destinationId: DESTINATION, archiveKey: key } })));
  assert.equal(preview.status, 202);
  await finished(harness, (preview.body as Started).restoreId);
  assert.equal(paperclip.calls.length, 0);

  const unconfirmed = await api(
    apiCall({ routeKey: "restore.apply", path: "/restore/apply", body: { destinationId: DESTINATION, archiveKey: key } }),
  );
  assert.equal(unconfirmed.status, 400);

  const applied = await answeredWithin(
    api(
      apiCall({
        routeKey: "restore.apply",
        path: "/restore/apply",
        body: { destinationId: DESTINATION, archiveKey: key, confirmPhrase: CONFIRM },
      }),
    ),
  );
  assert.equal(applied.status, 202);
  const { restoreId } = applied.body as Started;
  await finished(harness, restoreId);

  const got = await api(apiCall({ routeKey: "restore.get", method: "GET", path: `/restore/${restoreId}`, params: { id: restoreId } }));
  assert.equal(got.status, 200);
  assert.equal((got.body as RestoreView).status, "succeeded");
  assert.equal((got.body as RestoreView).requestedBy, "admin-2");
  assert.equal(paperclip.calls[0]?.requestedByUserId, "admin-2");

  const missing = await api(apiCall({ routeKey: "restore.get", method: "GET", path: "/restore/other", params: { id: "other" } }));
  assert.equal(missing.status, 404);
});

test("starting the plugin removes decrypted dumps a stopped worker left, and keeps a running one's", { timeout: 90_000 }, async () => {
  // A process that has already exited, and one that is running.
  const stopped = spawnSync(process.execPath, ["-e", ""]).pid;
  const leftover = join(tmpdir(), `pcback-restore-${stopped}-left`);
  const running = join(tmpdir(), `pcback-restore-${process.ppid}-busy`);
  const older = join(tmpdir(), `pcback-decrypt-${randomUUID()}.sql.gz`);
  for (const dir of [leftover, running]) {
    await mkdir(dir);
    await writeFile(join(dir, "dump.sql.gz"), "the whole database");
  }
  await writeFile(older, "the whole database, from an older version");
  try {
    await startPlugin();

    assert.equal(existsSync(leftover), false);
    assert.equal(existsSync(older), false);
    assert.equal(existsSync(running), true, "another worker's restore must be left alone");
  } finally {
    await rm(running, { recursive: true, force: true });
  }
});

test("stopping the worker removes the dump of an apply still under way", { timeout: 90_000 }, async () => {
  const { key } = await archive();
  const { harness, paperclip } = await startPlugin();
  const release = paperclip.hold();
  try {
    const started = await harness.performAction<Started>("restore.apply", apply(key));
    await waitFor(() => paperclip.calls.length === 1);
    const folder = dirname(paperclip.calls[0].filePath);
    assert.equal(existsSync(folder), true);

    await plugin.definition.onShutdown!();
    assert.equal(existsSync(folder), false);

    release();
    await finished(harness, started.restoreId);
  } finally {
    release();
  }
});
