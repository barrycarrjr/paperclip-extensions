import { test } from "node:test";
import assert from "node:assert/strict";
import { JobStore, jobView } from "./jobs.js";

const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));

test("starting a carrier that is already running returns the same job: one run, one sign-in", async () => {
  const store = new JobStore<string>(50);
  let runs = 0;
  const run = () => {
    runs++;
    return later(200, "ok");
  };
  const a = store.start("co-1", "selective", run);
  const b = store.start("co-1", "selective", run);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(b.job.id, a.job.id);
  assert.equal(runs, 1);
  // Another carrier, or another company, is a separate job.
  const c = store.start("co-1", "foremost", run);
  const d = store.start("co-2", "selective", run);
  assert.notEqual(c.job.id, a.job.id);
  assert.notEqual(d.job.id, a.job.id);
  assert.equal(runs, 3);
  await Promise.all([a.job.done, c.job.done, d.job.done]);
  // Once finished, a new start is a new run.
  const e = store.start("co-1", "selective", run);
  assert.equal(e.reused, false);
  assert.equal(runs, 4);
  await e.job.done;
});

test("status waits for the job up to the limit, then says it is still running", async () => {
  const store = new JobStore<string>(50);
  const { job } = store.start("co-1", "liberty_mutual", () => later(300, "files"));
  const early = await store.wait(job.id, "co-1", 50);
  assert.equal(early?.status, "running");
  const finished = await store.wait(job.id, "co-1", 2_000);
  assert.equal(finished?.status, "done");
  assert.equal(finished?.result, "files");
  assert.equal("done" in jobView(finished!), false);
});

test("a job is not visible to another company, and an unknown id is null", async () => {
  const store = new JobStore<string>(50);
  const { job } = store.start("co-1", "foremost", () => later(10, "x"));
  assert.equal(store.get(job.id, "co-2"), null);
  assert.equal(await store.wait("no-such-job", "co-1", 10), null);
  await job.done;
});

test("a thrown error or an error result marks the job failed", async () => {
  const store = new JobStore<{ error?: string }>(50);
  const thrown = store.start("co-1", "foremost", async () => {
    throw new Error("[ELOGIN_REJECTED] nope");
  });
  const errResult = store.start("co-1", "selective", async () => ({ error: "[ECARRIER_OFF] off" }), (r) => r.error ?? null);
  await Promise.all([thrown.job.done, errResult.job.done]);
  assert.equal(thrown.job.status, "failed");
  assert.match(thrown.job.error ?? "", /ELOGIN_REJECTED/);
  assert.equal(errResult.job.status, "failed");
  assert.match(errResult.job.error ?? "", /ECARRIER_OFF/);
});
