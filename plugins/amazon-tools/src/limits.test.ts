import test from "node:test";
import assert from "node:assert/strict";
import { AmazonError } from "./safety.js";
import { AmazonService } from "./amazon.js";
import { REPORT_TYPES, TIMEOUT_MARGIN_MS, TOOLS } from "./manifest.js";
import { RateLimiter, USAGE } from "./rate.js";
import { COMPANY, MARKET, REF, CREDS, ACCESS, LWA_FAILURES, HOST_FAILURES, account, fixture, json } from "./fixtures.js";

const code = (name: string) => (e: unknown) => e instanceof AmazonError && e.code === name;
const settlement = (c: { url: URL }, rows = 60) => c.url.pathname.endsWith("/reports/r1") ? json({ reportId: "r1", reportType: REPORT_TYPES[0], processingStatus: "DONE", reportDocumentId: "d1" })
  : c.url.pathname.endsWith("/documents/d1") ? json({ url: "https://d34o8swod1owfl.cloudfront.net/r" })
  : { status: 200, headers: { "content-type": "text/plain;charset=UTF-8" }, body: Buffer.from("settlement-id\tamount\n" + Array.from({ length: rows }, (_, i) => `s1\t${i}`).join("\n")) };
const recent = () => ({ createdAfter: new Date(Date.now() - 86400_000).toISOString() });

test("R3-L3: host lookup failures distinguish known permanent refusals from transient or unknown failures", async () => {
  for (const c of HOST_FAILURES) {
    for (const operation of ["test_connection", "request_report"]) {
      const f = fixture();
      const reject = async () => { throw Object.assign(new Error(c.message), { code: c.rpc }); };
      if (c.lookup === "secret") f.ctx.secrets.resolve = reject; else f.ctx.config.get = reject;
      await assert.rejects(f.service.run(operation, operation === "request_report" ? { reportType: REPORT_TYPES[1] } : {}, COMPANY), e => {
        assert.ok(e instanceof AmazonError); assert.equal(e.code, c.code); assert.equal(e.dispatch, undefined);
        assert.ok(!e.message.includes(c.message)); return true;
      });
      assert.equal(f.calls.length, 0);
    }
  }
  for (const lookup of ["secret", "config"]) {
    const f = fixture(() => { throw Error("no provider request expected"); });
    const resolve = lookup === "secret" ? f.ctx.secrets.resolve : f.ctx.config.get;
    let count = 0;
    const flaky = async (...args: any[]) => {
      if (++count > 1) throw Error(CREDS.clientSecret);
      return (resolve as any)(...args);
    };
    if (lookup === "secret") f.ctx.secrets.resolve = flaky; else f.ctx.config.get = flaky;
    await assert.rejects(f.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), code("EHOST"));
    assert.equal(f.calls.length, 0, "rechecks fail before LWA and report POST");
  }
});

test("R3-1: delayed sales-report approval keeps omitted ends legal, explicit dates exact and new queries validated", async () => {
  const start = Date.now() - 30 * 86400_000;
  const params = { reportType: REPORT_TYPES[3], dataStartTime: new Date(start).toISOString() };
  for (const delay of [0, 60 * 60_000, 8 * 60 * 60_000]) {
    const f = fixture(() => json({ reportId: "123456789012" }, 202)); f.advance(delay);
    await f.service.run("request_report", params, COMPANY);
    const posts = f.calls.filter(c => c.url.pathname.endsWith("/reports")); assert.equal(posts.length, 1);
    const body = JSON.parse(posts[0].body!);
    assert.equal(body.dataStartTime, params.dataStartTime);
    assert.equal(Date.parse(body.dataEndTime), Math.min(f.deps.now() - 180_000, start + 30 * 86400_000));
    assert.ok(Date.parse(body.dataEndTime) <= f.deps.now() - 120_000);
  }
  const exact = fixture(() => json({ reportId: "123456789012" }, 202)); exact.advance(8 * 60 * 60_000);
  const end = new Date(start + 86400_000).toISOString();
  await exact.service.run("request_report", { ...params, dataEndTime: end }, COMPANY);
  assert.equal(JSON.parse(exact.calls.at(-1)!.body!).dataEndTime, end);
  for (const p of [
    { reportType: REPORT_TYPES[3] },
    { ...params, dataEndTime: new Date(start + 31 * 86400_000).toISOString() },
    { ...params, dataStartTime: new Date(Date.now() + 86400_000).toISOString() },
    { ...params, dataStartTime: "2020-01-01T00:00:00Z" },
    { reportType: REPORT_TYPES[1], dataStartTime: params.dataStartTime },
    { reportType: REPORT_TYPES[2], dataEndTime: end },
  ]) {
    const f = fixture(); await assert.rejects(f.service.run("request_report", p, COMPANY), code("EINPUT")); assert.equal(f.calls.length, 0);
  }
});

test("R3-L4: accepted report IDs share get_report validation, reject secret reflections and settle uncertain outcomes", async () => {
  for (const id of [undefined, 9, "", "x".repeat(129), "r1/extra", "r1\u0000", "r1\ud83d", "r1\n", CREDS.clientSecret, `id-${CREDS.refreshToken}`, CREDS.sellerId, ACCESS]) {
    const f = fixture(() => json({ reportId: id }, 202));
    await assert.rejects(f.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), e => code("EREPORT_UNKNOWN")(e) && (e as AmazonError).dispatch === "unknown");
    assert.equal(f.calls.filter(c => c.url.pathname.endsWith("/reports")).length, 1);
  }
  for (const id of ["123456789012", "r1.valid-id_2"]) {
    const f = fixture(c => c.method === "POST" ? json({ reportId: id }, 202) : json({ reportType: REPORT_TYPES[1], marketplaceIds: [MARKET], processingStatus: "IN_QUEUE" }));
    const result = await f.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY);
    assert.equal(result.reportId, id);
    await f.service.run("get_report", { reportId: id }, COMPANY);
  }
});

test("R2-2: LWA outages remain transient, permanent grants need reconnect, and no report POST is sent", async () => {
  for (const c of LWA_FAILURES) {
    for (const operation of ["test_connection", "request_report"]) {
      const f = fixture(() => json({ items: [], reportId: "r" }));
      let lwaCalls = 0;
      const service = new AmazonService(f.ctx, { ...f.deps, send: async () => { lwaCalls++; return c.reply(); } });
      await assert.rejects(service.run(operation, operation === "request_report" ? { reportType: REPORT_TYPES[1] } : {}, COMPANY), e => {
        assert.ok(e instanceof AmazonError); assert.equal(e.code, c.code, c.name);
        assert.equal(e.retryAfterSeconds, "retry" in c ? c.retry : undefined);
        assert.equal(e.dispatch, undefined); assert.ok(!e.message.includes(CREDS.clientSecret));
        return true;
      });
      assert.equal(lwaCalls, 1, "no automatic token or report retry"); assert.equal(f.calls.length, 0);
    }
  }
  const f = fixture();
  const slow = new AmazonService(f.ctx, { ...f.deps, send: async () => { f.advance(60_000); throw Error("deadline"); } });
  await assert.rejects(slow.run("test_connection", {}, COMPANY), code("EDEADLINE"));
  for (const [header, seconds] of [[new Date(f.deps.now() + 12_000).toUTCString(), 12], ["invalid", 1], ["Infinity", 1], ["0", 1]] as const) {
    const service = new AmazonService(f.ctx, { ...f.deps, send: async () => json({}, 429, { "retry-after": header }) });
    await assert.rejects(service.run("test_connection", {}, COMPANY), e => code("ERATE")(e) && (e as AmazonError).retryAfterSeconds === seconds);
  }
});

test("R2-3: an oversized transport response after a report POST remains uncertain, never a safe retry", async () => {
  const f = fixture(() => { throw new AmazonError("ERESPONSE"); });
  await assert.rejects(f.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), e => code("EREPORT_UNKNOWN")(e) && (e as AmazonError).dispatch === "unknown");
  assert.equal(f.calls.filter(c => c.url.hostname !== "api.amazon.com").length, 1);
});

test("F6: published bursts let later report and order pages run at once, and cached report rows avoid new downloads", async () => {
  const f = fixture(c => settlement(c));
  const first: any = await f.service.run("get_settlement", { reportId: "r1" }, COMPANY);
  const before = f.calls.length; f.advance(1000);
  const rows = [...first.rows]; let offset = first.nextOffset;
  while (offset !== null) { const out: any = await f.service.run("get_settlement", { reportId: "r1", offset }, COMPANY); rows.push(...out.rows); offset = out.nextOffset; }
  assert.deepEqual(rows.map(r => r.amount), Array.from({ length: 60 }, (_, i) => String(i)));
  assert.equal(f.calls.length, before, "later offsets call Amazon not at all"); assert.deepEqual(f.waits, []);
  const g = fixture(() => json({ reports: [] }));
  await g.service.run("list_settlements", {}, COMPANY); g.advance(1000);
  await g.service.run("list_reports", { reportType: REPORT_TYPES[1] }, COMPANY); assert.deepEqual(g.waits, []);
  const h = fixture(() => json({ orders: [], pagination: { nextToken: "p2" } }));
  const o = recent(); const a: any = await h.service.run("list_orders", o, COMPANY); h.advance(5000);
  await h.service.run("list_orders", { ...o, cursor: a.nextCursor }, COMPANY); assert.deepEqual(h.waits, []);
});

test("F6: after the burst the steady rate applies; a long wait returns ERATE without sleeping, per operation", async () => {
  const f = fixture(c => c.url.pathname.endsWith("/orders") ? json({ orders: [] }) : json({ order: { orderId: "123-1234567-1234567", salesChannel: { marketplaceId: MARKET } } }));
  const o = recent();
  for (let i = 0; i < 20; i++) await f.service.run("list_orders", o, COMPANY);
  await assert.rejects(f.service.run("list_orders", o, COMPANY), (e: unknown) => code("ERATE")(e) && (e as AmazonError).retryAfterSeconds === Math.ceil(1 / USAGE.searchOrders[0]));
  assert.deepEqual(f.waits, []);
  await f.service.run("get_order", { orderId: "123-1234567-1234567" }, COMPANY); assert.deepEqual(f.waits, [], "another operation has its own bucket");
  f.advance(Math.ceil(1000 / USAGE.searchOrders[0]));
  await f.service.run("list_orders", o, COMPANY);
});

test("F6: buckets are per seller and application, so one account's throttling or advertised rate never slows another", async () => {
  const REF2 = "44444444-4444-4444-8444-444444444444";
  const f = fixture(c => c.url.pathname.includes("/SELLERTWO") ? json({ items: [] }) : json({ items: [] }, 200, { "x-amzn-ratelimit-limit": "0.0001" }));
  f.setConfig({ accounts: [{ ...account(), key: "one" }, { ...account(), key: "two", credentialsRef: REF2 }] });
  f.ctx.secrets.resolve = async (ref: string, company?: string) => {
    if (company !== COMPANY) throw Error("wrong scope");
    if (ref === REF) return JSON.stringify(CREDS);
    if (ref === REF2) return JSON.stringify({ ...CREDS, clientId: "example-client-two-not-real", sellerId: "SELLERTWO" });
    throw Error("wrong ref");
  };
  for (let i = 0; i < 5; i++) await f.service.run("test_connection", { account: "one" }, COMPANY);
  await assert.rejects(f.service.run("test_connection", { account: "one" }, COMPANY), code("ERATE"));
  for (let i = 0; i < 5; i++) await f.service.run("test_connection", { account: "two" }, COMPANY);
  assert.deepEqual(f.waits, []);
  await f.service.run("test_connection", { account: "two" }, COMPANY);
  assert.deepEqual(f.waits, [1000 / USAGE.searchListingsItems[0]], "the other seller keeps the published rate");
});

test("F6: zero, negative or malformed advertised rates are ignored; a valid lower rate is honoured", async () => {
  for (const header of ["0", "-1", "abc", "Infinity", ""]) {
    const f = fixture(() => json({ asin: "B012345678" }, 200, { "x-amzn-ratelimit-limit": header }));
    for (let i = 0; i < 4; i++) await f.service.run("get_catalog_item", { asin: "B012345678" }, COMPANY);
    assert.deepEqual(f.waits, [500, 500], header);
  }
  const slow = fixture(() => json({ asin: "B012345678" }, 200, { "x-amzn-ratelimit-limit": "0.5" }));
  for (let i = 0; i < 3; i++) await slow.service.run("get_catalog_item", { asin: "B012345678" }, COMPANY);
  assert.deepEqual(slow.waits, [2000]);
  const r = new RateLimiter();
  assert.equal(r.acquire("k", "unknownOperation", 0, 0), 0); assert.equal(r.acquire("k", "unknownOperation", 0, 500), undefined);
  r.observe("k", "unknownOperation", 0, "0"); assert.ok(Number.isFinite(r.wait("k", "unknownOperation", 0)));
});

test("F6: a throttled or rejected report POST is never retried and leaves nothing dispatched", async () => {
  let posts = 0;
  const f = fixture(() => { posts++; return json({}, 429, { "retry-after": "30" }); });
  await assert.rejects(f.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), (e: unknown) => code("ERATE")(e) && (e as AmazonError).retryAfterSeconds === 30 && !(e as AmazonError).dispatch);
  assert.equal(posts, 1); assert.deepEqual(f.waits, []);
  for (const [reply, expected, dispatch] of [[json({}, 400), "EHTTP", undefined], [json({}, 403), "EAUTH", undefined], [json({}, 503), "EREPORT_UNKNOWN", "unknown"], [json({ reportId: 7 }, 202), "EREPORT_UNKNOWN", "unknown"]] as const) {
    const g = fixture(() => reply);
    await assert.rejects(g.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), (e: unknown) => code(expected)(e) && (e as AmazonError).dispatch === dispatch);
  }
  const unsent = fixture(() => { throw Object.assign(new AmazonError("ENETWORK"), { notSent: true }); });
  await assert.rejects(unsent.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), (e: unknown) => code("ENETWORK")(e) && !(e as AmazonError).dispatch);
  const sent = fixture(() => { throw Error("connection reset after request"); });
  await assert.rejects(sent.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), (e: unknown) => code("EREPORT_UNKNOWN")(e) && (e as AmazonError).dispatch === "unknown");
});

test("L3: every tool declares a host timeout that outlasts its own total deadline", () => {
  for (const t of TOOLS) {
    assert.ok(Number.isInteger(t.executionTimeoutMs) && t.executionTimeoutMs! >= 30_000 && t.executionTimeoutMs! <= 300_000, t.name);
    assert.ok(t.executionTimeoutMs! - TIMEOUT_MARGIN_MS >= 50_000, t.name);
  }
  assert.equal(TOOLS.find(t => t.name === "amazon_get_report")!.executionTimeoutMs, 120_000);
  assert.equal(TOOLS.find(t => t.name === "amazon_get_settlement")!.executionTimeoutMs, 120_000);
  assert.equal(TOOLS.find(t => t.name === "amazon_request_report")!.executionTimeoutMs, 70_000);
});

test("L3: host lookups, requests and rate waits are bounded by one total deadline", async () => {
  const budget = 70_000 - TIMEOUT_MARGIN_MS;
  const stuck = fixture(() => json({ items: [] }));
  stuck.ctx.config.get = () => new Promise(() => {});
  const started = Date.now();
  await assert.rejects(stuck.service.run("test_connection", {}, COMPANY, stuck.deps.now() - budget + 1500), code("EDEADLINE"));
  assert.ok(Date.now() - started < 10_000, "a host lookup that never answers is abandoned at the deadline");
  const slow = fixture(() => { slow.advance(budget + 1); throw Error("aborted at deadline"); });
  await assert.rejects(slow.service.run("get_catalog_item", { asin: "B012345678" }, COMPANY), code("EDEADLINE"));
  const post = fixture(() => { post.advance(budget + 1); throw Error("aborted at deadline"); });
  await assert.rejects(post.service.run("request_report", { reportType: REPORT_TYPES[1] }, COMPANY), (e: unknown) => code("EREPORT_UNKNOWN")(e) && (e as AmazonError).dispatch === "unknown");
  const late = fixture(() => json({ asin: "B012345678" }));
  await late.service.run("get_catalog_item", { asin: "B012345678" }, COMPANY); await late.service.run("get_catalog_item", { asin: "B012345678" }, COMPANY);
  await assert.rejects(late.service.run("get_catalog_item", { asin: "B012345678" }, COMPANY, late.deps.now() - budget + 5_200), code("ERATE"));
  assert.deepEqual(late.waits, [], "no sleep that would cross the deadline");
});

test("F6: cached report rows are reused only for the same company, connection and current credentials", async () => {
  const f = fixture(c => settlement(c, 30));
  const downloads = () => f.calls.filter(c => c.url.hostname.endsWith("cloudfront.net")).length;
  await f.service.run("get_settlement", { reportId: "r1" }, COMPANY);
  await f.service.run("get_settlement", { reportId: "r1", offset: 25 }, COMPANY); assert.equal(downloads(), 1);
  await f.service.run("get_report", { reportId: "r1" }, COMPANY); assert.equal(downloads(), 2, "another tool keeps its own entry");
  f.setSecret(JSON.stringify({ ...CREDS, refreshToken: "rotated-example-not-real" }));
  await f.service.run("get_settlement", { reportId: "r1", offset: 25 }, COMPANY); assert.equal(downloads(), 3, "rotated credentials never reuse rows");
  f.service.clear();
  await f.service.run("get_settlement", { reportId: "r1", offset: 25 }, COMPANY); assert.equal(downloads(), 4, "configuration changes clear cached rows");
  f.setConfig({ accounts: [{ ...account(), allowedCompanies: [] }] });
  await assert.rejects(f.service.run("get_settlement", { reportId: "r1", offset: 25 }, COMPANY), code("ECOMPANY"));
  assert.equal(downloads(), 4); assert.ok(f.service.cacheStats.reports <= 8);
});
