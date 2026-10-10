/**
 * The agent tools for long runs, through the SDK's in-memory host: start a
 * fetch in the background, ask how it is doing, and never start a second run
 * (a second sign-in, a second login code) for a carrier already running.
 * A stand-in replaces the real fetch: no browser, no network.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin, { setFetchForTests } from "./worker.js";

const CO_A = "11111111-1111-1111-1111-111111111111";
const CO_B = "22222222-2222-2222-2222-222222222222";

let harness: TestHarness;
let calls: Array<{ carrier: unknown; companyId: string }>;
let release: () => void;

beforeEach(async () => {
  calls = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  release = open;
  setFetchForTests(async (_ctx, _cfg, params, companyId) => {
    calls.push({ carrier: params.carrier, companyId });
    await gate;
    return { content: `Fake: found 2 document(s).`, data: { files: [], notes: [] } } as ToolResult;
  });
  harness = createTestHarness({ manifest, config: { allowedCompanies: [CO_A, CO_B] } });
  await plugin.definition.setup(harness.ctx);
});

afterEach(() => {
  release();
  setFetchForTests(null);
});

const start = (carrier: string, companyId = CO_A) =>
  harness.executeTool<ToolResult>("insurance_start_fetch", { carrier, destination: "Insurance/Test" }, { companyId });
const status = (jobId: string, waitSeconds = 0, companyId = CO_A) =>
  harness.executeTool<ToolResult>("insurance_fetch_status", { jobId, waitSeconds }, { companyId });
const idOf = (r: ToolResult) => (r.data as { jobId: string }).jobId;

test("a second start for a carrier already running returns the same job and starts nothing", async () => {
  const first = await start("selective");
  const again = await start("selective");
  assert.equal(idOf(again), idOf(first));
  assert.equal((again.data as { reused: boolean }).reused, true);
  assert.match(again.content ?? "", /already running/);
  // The operator action shares the same rule.
  const op = await harness.performAction<{ jobId: string; reused: boolean }>("start-fetch", {
    carrier: "selective",
    destination: "Insurance/Test",
    hostScope: { companyId: CO_A },
  });
  assert.equal(op.jobId, idOf(first));
  assert.equal(op.reused, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1, "only one sign-in");
});

test("status says still running, then returns the result once the run ends", async () => {
  const id = idOf(await start("liberty_mutual"));
  const running = await status(id, 0);
  assert.match(running.content ?? "", /still running/);
  release();
  const done = await status(id, 5);
  assert.match(done.content ?? "", /is done\.\nFake: found 2 document\(s\)\./);
  // After it finished, starting again is a new run.
  const next = await start("liberty_mutual");
  assert.notEqual(idOf(next), id);
});

test("a switched-off carrier is refused before any job starts", async () => {
  harness.setConfig({ allowedCompanies: [CO_A], enableSelective: false });
  const r = await start("selective");
  assert.match(r.error ?? "", /ECARRIER_OFF/);
  assert.equal(calls.length, 0);
});

test("an unknown job, or another company's job, is not found", async () => {
  const id = idOf(await start("foremost"));
  assert.match((await status("no-such-job")).error ?? "", /ENOT_FOUND/);
  assert.match((await status(id, 0, CO_B)).error ?? "", /ENOT_FOUND/);
});
