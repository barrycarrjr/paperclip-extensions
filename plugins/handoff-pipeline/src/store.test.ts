import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AUDIT_SOURCES, type PipelineCommand, type PipelineState } from "./contracts.js";
import { PipelineStore, insertStateSql, selectStateSql, updateStateSql, type PipelineDatabase } from "./store.js";

const namespace = "plugin_handoff_dcdb27ff5a";
const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const now = "2026-10-15T18:00:00Z";
let pg: PGlite;
const calls: { kind: string; sql: string; params: unknown[] }[] = [];
let failWrites = false;
function assertCompatible(kind: "query" | "execute", sql: string, params: unknown[]): void {
  assert.match(sql, kind === "query" ? /^SELECT / : /^(?:WITH|INSERT INTO|UPDATE|DELETE FROM) /);
  assert.doesNotMatch(sql, /;/i);
  assert.equal(params.some(value => Array.isArray(value)), false);
  for (let index = 1; index <= params.length; index++) assert.ok(sql.includes(`$${index}`));
  calls.push({ kind, sql, params });
}
const db: PipelineDatabase = {
  namespace,
  async query<T>(sql: string, params: unknown[] = []) {
    assertCompatible("query", sql, params); return (await pg.query<T>(sql, params)).rows;
  },
  async execute(sql: string, params: unknown[] = []) {
    assertCompatible("execute", sql, params);
    if (failWrites) throw new Error("Database offline");
    return { rowCount: (await pg.query(sql, params)).affectedRows ?? 0 };
  },
};
before(async () => {
  pg = new PGlite(); await pg.exec(`CREATE SCHEMA ${namespace}`);
  await pg.exec(await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../migrations/0002_activity_outbox.sql", import.meta.url), "utf8"));
});
after(async () => { await pg.close(); });
const audit = (): PipelineCommand => ({ type: "create_audit", startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-31T00:00:00Z", sources: AUDIT_SOURCES.map(source => ({ source, status: "reviewed", evidence: [{ ref: `proof:${source}`, summary: "Observed records" }] })) });
async function reset() { await pg.exec(`DELETE FROM ${namespace}.activity_outbox; DELETE FROM ${namespace}.pipeline_companies`); calls.length = 0; failWrites = false; }

test("migration persists a company state and atomic event ledger, and survives a new store", async () => {
  await reset(); const store = new PipelineStore(db);
  assert.equal((await store.read(companyA)).version, 0);
  const written = await store.dispatch(companyA, audit(), { id: "audit", now });
  assert.deepEqual(await new PipelineStore(db).read(companyA), written);
  assert.equal(written.events.length, 1); assert.equal(written.version, 1);
  assert.deepEqual((await store.pendingActivities(companyA)).map(event => event.id), ["audit"]);
  await store.acknowledgeActivity(companyA, "audit");
  assert.deepEqual(await store.pendingActivities(companyA), []);
  await store.dispatch(companyA, audit(), { id: "audit-2", now });
  assert.equal((await store.read(companyA)).events.length, 2);
});
test("company-scoped reads and writes cannot see another company's records", async () => {
  await reset(); const store = new PipelineStore(db);
  await store.dispatch(companyA, audit(), { id: "audit-a", now });
  assert.deepEqual((await store.read(companyB)).audits, []);
  await store.dispatch(companyB, audit(), { id: "audit-b", now });
  assert.equal((await store.read(companyA)).audits[0].id, "audit-a");
  assert.equal((await store.read(companyB)).audits[0].id, "audit-b");
});
test("concurrent initial writes and updates retry without losing events", async () => {
  await reset(); const first = new PipelineStore(db); const second = new PipelineStore(db);
  await Promise.all([first.dispatch(companyA, audit(), { id: "initial-a", now }), second.dispatch(companyA, audit(), { id: "initial-b", now })]);
  await Promise.all([first.dispatch(companyA, audit(), { id: "update-a", now }), second.dispatch(companyA, audit(), { id: "update-b", now })]);
  const state = await first.read(companyA);
  assert.equal(state.version, 4); assert.equal(state.events.length, 4); assert.equal(state.audits.length, 4);
  assert.equal(new Set(state.events.map(event => event.id)).size, 4);
});
test("failed writes preserve both state and event ledger", async () => {
  await reset(); const store = new PipelineStore(db);
  const beforeState = await store.dispatch(companyA, audit(), { id: "audit", now }); failWrites = true;
  await assert.rejects(store.dispatch(companyA, audit(), { id: "missing", now }), /Database offline/);
  failWrites = false; assert.deepEqual(await store.read(companyA), beforeState);
});
test("concurrent identical runs are idempotent and conflicting output cannot overwrite them", async () => {
  await reset(); const store = new PipelineStore(db); await store.dispatch(companyA, audit(), { id: "audit", now });
  await store.dispatch(companyA, { type: "create_job", auditId: "audit", title: "Recurring job", evidenceRefs: ["proof:calendar"], occurrencesPerMonth: 4, manualMinutes: 60, agentMinutes: 10, initialDisposition: "draft", skillKey: `company/${companyA}/weekly`, skillContent: "Prepare report", companySkillId: "33333333-3333-4333-8333-333333333333" }, { id: "job", now });
  await store.dispatch(companyA, { type: "add_example", jobId: "job", sourceRef: "historical:1", input: "Historical input", actualOutcome: "Human outcome" }, { id: "example", now });
  const command: PipelineCommand = { type: "log_run", jobId: "job", revisionId: "job", mode: "historical", exampleId: "example", idempotencyKey: "external-key", originalOutput: "Original agent output", startedAt: now };
  await Promise.all([store.dispatch(companyA, command, { id: "run-a", now }), new PipelineStore(db).dispatch(companyA, command, { id: "run-b", now })]);
  const state = await store.read(companyA); assert.equal(state.jobs[0].runs.length, 1); assert.equal(state.events.length, 4);
  await assert.rejects(store.dispatch(companyA, { ...command, originalOutput: "Different" }, { id: "conflicting", now }), /different output/);
  assert.deepEqual(await store.read(companyA), state);
});
test("migration constraints reject mismatched company and version inside state", async () => {
  await reset(); const store = new PipelineStore(db); const state = await store.dispatch(companyA, audit(), { id: "audit", now });
  await assert.rejects(pg.query(`UPDATE ${namespace}.pipeline_companies SET state=$1::jsonb WHERE company_id=$2`, [JSON.stringify({ ...state, companyId: companyB }), companyA]), /pipeline_company_matches/);
  await assert.rejects(pg.query(`UPDATE ${namespace}.pipeline_companies SET version=99 WHERE company_id=$1`, [companyA]), /pipeline_version_matches/);
});
test("SQL builders bind all values and use only allowed query and mutation shapes", () => {
  const payload = "company' OR 1=1 --";
  const state: PipelineState = { companyId: payload, version: 1, audits: [], jobs: [], events: [{ id: "event", companyId: payload, type: "create_audit", jobId: null, at: now, detail: {} }] };
  for (const statement of [selectStateSql(namespace, payload), insertStateSql(namespace, state), updateStateSql(namespace, state, 0)]) {
    assert.equal(statement.params[0], payload); assert.equal(statement.sql.includes(payload), false);
  }
  for (const unsafe of ["x; DROP SCHEMA public", "a.b", "a\"", ""]) assert.throws(() => selectStateSql(unsafe, payload), /Unsafe/);
});
test("exhausted concurrent retries fail explicitly without reporting success", async () => {
  let writes = 0;
  const conflictDb: PipelineDatabase = { namespace, query: async () => [], execute: async () => { writes++; return { rowCount: 0 }; } };
  await assert.rejects(new PipelineStore(conflictDb, 3).dispatch(companyA, audit(), { id: "audit", now }), /changed concurrently/);
  assert.equal(writes, 3);
});
test("an expected version prevents a preflighted command from applying after another change", async () => {
  await reset(); const store = new PipelineStore(db);
  await store.dispatch(companyA, audit(), { id: "audit", now });
  await store.dispatch(companyA, audit(), { id: "other-change", now });
  await assert.rejects(store.dispatch(companyA, audit(), { id: "stale", now }, 1), /changed after rebuild preflight/);
  assert.equal((await store.read(companyA)).version, 2);
});
