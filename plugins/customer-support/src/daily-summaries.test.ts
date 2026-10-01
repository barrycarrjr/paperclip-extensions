import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { previewSummary, sendDailySummary, summaryClock, summaryPolicy, runDailySummaries } from "./daily-summaries.js";
import type { Config } from "./routing.js";
const companyId = "11111111-1111-4111-8111-111111111111", otherCompanyId = "22222222-2222-4222-8222-222222222222";
const cfg: Config = { connections: [{ id: "example", source: "slack", externalAccountId: "TEXAMPLE01", ingestAgentId: "agent", botTokenRef: "example-secret-reference", allowedCompanies: [companyId], routes: [{ externalRouteId: "CEXAMPLE01", companyId }] }], dailySummaries: [{ companyId, connectionId: "example", channelId: "CEXAMPLE02", timezone: "America/New_York", sendAt: "09:00", enabled: true }] };
const now = new Date("2026-09-30T14:00:00Z");
async function fixture() {
  const db = new PGlite(), namespace = "plugin_customer_support_0c69412611";
  await db.exec(`CREATE SCHEMA ${namespace}`);
  for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  let posts = 0, mode = "sent";
  const ctx = { db: { namespace, query: async (sql: string, values: unknown[]) => (await db.query(sql, values)).rows, execute: async (sql: string, values: unknown[]) => ({ rowCount: (await db.query(sql, values)).affectedRows }) }, secrets: { resolve: async () => "synthetic-token" }, activity: { log: async () => {} }, http: { fetch: async (url: string) => {
    if (url.endsWith("auth.test")) return Response.json({ ok: true, team_id: "TEXAMPLE01" });
    posts++;
    if (mode === "unknown") throw new Error("Synthetic timeout after provider acceptance");
    return Response.json({ ok: true, channel: "CEXAMPLE02", ts: "1800000000.000001" });
  } } } as unknown as PluginContext;
  return { ctx, db, posts: () => posts, setMode: (value: string) => { mode = value; } };
}
test("summary clocks use company calendar days across DST and deny ambiguous/foreign configuration", () => {
  assert.deepEqual(summaryClock(cfg.dailySummaries![0]!, now), { reportDay: "2026-09-29", due: true });
  assert.deepEqual(summaryClock(cfg.dailySummaries![0]!, new Date("2026-11-01T05:30:00Z")), { reportDay: "2026-10-31", due: false });
  assert.equal(summaryClock({ ...cfg.dailySummaries![0]!, enabled: false }, now).due, false);
  assert.throws(() => summaryPolicy({ ...cfg, dailySummaries: [...cfg.dailySummaries!, ...cfg.dailySummaries!] }, companyId));
  assert.throws(() => summaryPolicy(cfg, otherCompanyId));
  assert.throws(() => summaryPolicy({ ...cfg, dailySummaries: [{ ...cfg.dailySummaries![0]!, timezone: "Invalid/Zone" }] }, companyId));
});
test("real summary SQL isolates companies and excludes ticket text; concurrent/repeated sends get one receipt", async () => {
  const f = await fixture();
  try {
    for (const company of [companyId, otherCompanyId]) await f.db.query(`INSERT INTO plugin_customer_support_0c69412611.support_cases(company_id,connection_id,source,external_route_id,external_conversation_id,title,first_message_at,last_message_at,created_at) VALUES($1,'example','slack','CEXAMPLE01','example','Synthetic private requester content',now(),now(),'2026-09-29T15:00:00Z')`, [company]);
    const preview = await previewSummary(f.ctx, cfg, companyId, now);
    assert.match(preview.body, /New cases: 1/); assert.match(preview.body, /Open cases now: 1/);
    assert.doesNotMatch(preview.body, /private requester content/);
    await Promise.all([sendDailySummary(f.ctx, async () => cfg, companyId, now), sendDailySummary(f.ctx, async () => cfg, companyId, now)]);
    assert.equal(f.posts(), 1);
    assert.equal((await sendDailySummary(f.ctx, async () => cfg, companyId, now)).status, "sent");
    assert.equal(f.posts(), 1);
  } finally { await f.db.close(); }
});
test("unknown delivery never replays and revoked policy prevents a first attempt", async () => {
  const f = await fixture();
  try {
    f.setMode("unknown");
    assert.equal((await sendDailySummary(f.ctx, async () => cfg, companyId, now)).status, "unknown");
    await sendDailySummary(f.ctx, async () => cfg, companyId, now);
    assert.equal(f.posts(), 1);
    await f.db.query("DELETE FROM plugin_customer_support_0c69412611.support_daily_summaries");
    let calls = 0;
    await assert.rejects(sendDailySummary(f.ctx, async () => ++calls === 1 ? cfg : { ...cfg, dailySummaries: [{ ...cfg.dailySummaries![0]!, enabled: false }] }, companyId, now), /changed/);
    assert.equal(f.posts(), 1);
    await f.db.query(`INSERT INTO plugin_customer_support_0c69412611.support_daily_summaries(company_id,report_day,timezone,config_sha256,connection_id,channel_id,body,started_at) VALUES($1,'2026-09-29','UTC','example','example','CEXAMPLE02','Example',now()-interval '1 hour')`, [companyId]);
    await runDailySummaries(f.ctx, async () => ({ ...cfg, dailySummaries: [] }));
    assert.equal((await f.db.query<{ status: string }>("SELECT status FROM plugin_customer_support_0c69412611.support_daily_summaries")).rows[0]!.status, "unknown");
  } finally { await f.db.close(); }
});
