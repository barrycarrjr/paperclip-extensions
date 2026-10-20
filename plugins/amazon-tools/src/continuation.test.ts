import test from "node:test";
import assert from "node:assert/strict";
import { AmazonError, type Shape } from "./safety.js";
import { REPORT_TYPES } from "./manifest.js";
import { CursorStore, PAGE_BYTES, PAGE_NODES, projectRecord, type Batch } from "./paging.js";
import { COMPANY, MARKET, CREDS, account, fixture, json } from "./fixtures.js";

// Synthetic records shaped from Amazon's official models. All values invented.
const code = (name: string) => (e: unknown) => e instanceof AmazonError && e.code === name;
const cur = (a: number) => ({ currencyCode: "USD", currencyAmount: a });
const tx = (i: number) => ({ transactionType: "Shipment", transactionId: `t${i}`, transactionStatus: "RELEASED", description: "Order Payment", postedDate: "2026-09-01T00:00:00Z", totalAmount: cur(9),
  marketplaceDetails: { marketplaceId: MARKET, marketplaceName: "Amazon.com" },
  relatedIdentifiers: [{ relatedIdentifierName: "ORDER_ID", relatedIdentifierValue: "123-1234567-1234567" }, { relatedIdentifierName: "SHIPMENT_ID", relatedIdentifierValue: "s" }, { relatedIdentifierName: "FINANCIAL_EVENT_GROUP_ID", relatedIdentifierValue: "g" }],
  breakdowns: [{ breakdownType: "Sales", breakdownAmount: cur(10), breakdowns: [{ breakdownType: "ProductCharges", breakdownAmount: cur(10) }] }, { breakdownType: "Expenses", breakdownAmount: cur(-1), breakdowns: [{ breakdownType: "AmazonFees", breakdownAmount: cur(-1) }] }] });
const summary = (i: number) => ({ asin: `B0000000${String(i).padStart(2, "0")}`, fnSku: `X00000${i}`, sellerSku: `SKU-${i}`, condition: "NewItem", lastUpdatedTime: "2026-10-01T00:00:00Z", productName: "Example", totalQuantity: 10,
  inventoryDetails: { fulfillableQuantity: 5, inboundWorkingQuantity: 0, inboundShippedQuantity: 0, inboundReceivingQuantity: 0,
    reservedQuantity: { totalReservedQuantity: 1, pendingCustomerOrderQuantity: 1, pendingTransshipmentQuantity: 0, fcProcessingQuantity: 0 },
    researchingQuantity: { totalResearchingQuantity: 0, researchingQuantityBreakdown: [{ name: "researchingQuantityInShortTerm", quantity: 0 }, { name: "researchingQuantityInMidTerm", quantity: 0 }, { name: "researchingQuantityInLongTerm", quantity: 0 }] },
    unfulfillableQuantity: { totalUnfulfillableQuantity: 0, customerDamagedQuantity: 0, warehouseDamagedQuantity: 0, distributorDamagedQuantity: 0, carrierDamagedQuantity: 0, defectiveQuantity: 0, expiredQuantity: 0 } } });
const order = (i: number, items: number, extra: Record<string, unknown> = {}) => ({ orderId: `123-1234567-${String(1000000 + i)}`, createdTime: "2026-10-01T00:00:00Z", lastUpdatedTime: "2026-10-01T00:00:00Z", programs: [], salesChannel: { channelName: "AMAZON", marketplaceId: MARKET, marketplaceName: "Amazon.com" }, proceeds: { grandTotal: { amount: "10.00", currencyCode: "USD" } }, fulfillment: { fulfillmentStatus: "SHIPPED", fulfilledBy: "AMAZON", fulfillmentServiceLevel: "STANDARD" },
  orderItems: Array.from({ length: items }, (_, j) => ({ orderItemId: `${i}-${j}`, quantityOrdered: 1, product: { asin: "B012345678", sellerSku: "SKU", title: "Example" }, proceeds: { proceedsTotal: { amount: "10.00", currencyCode: "USD" } }, fulfillment: { quantityFulfilled: 1, quantityUnfulfilled: 0 } })), ...extra });
const finance = { postedAfter: "2026-09-01T00:00:00Z", postedBefore: "2026-09-02T00:00:00Z" };
type F = ReturnType<typeof fixture>;
// Follows nextCursor to the end with unchanged arguments, checking every response stays bounded.
async function drain(f: F, operation: string, params: Record<string, unknown>, key: string, between = () => {}) {
  const all: any[] = [], sizes: number[] = []; let cursor: unknown, calls = 0;
  do {
    const out: any = await f.service.run(operation, cursor ? { ...params, cursor } : params, COMPANY);
    all.push(...out[key]); sizes.push(out[key].length); cursor = out.nextCursor; calls++;
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 96 * 1024);
    between();
  } while (cursor && calls < 200);
  return { all, sizes };
}
const apiCalls = (f: F, suffix: string) => f.calls.filter(c => c.url.pathname.endsWith(suffix));

test("R3-1: maximum omitted-end windows survive slow cached continuations and keep absolute provider dates", async () => {
  for (const [operation, days, startKey, endKey, tokenKey, key, suffix, rows] of [
    ["list_financial_events", 180, "postedAfter", "postedBefore", "nextToken", "transactions", "/transactions", Array.from({ length: 500 }, (_, i) => tx(i))],
    ["list_orders", 730, "createdAfter", "createdBefore", "paginationToken", "orders", "/orders", Array.from({ length: 100 }, (_, i) => order(i, 4))],
    ["list_orders", 730, "lastUpdatedAfter", "lastUpdatedBefore", "paginationToken", "orders", "/orders", Array.from({ length: 100 }, (_, i) => order(i, 4))],
  ] as const) {
    const f = fixture(c => operation === "list_orders"
      ? json(c.url.searchParams.has(tokenKey) ? { orders: [rows[0]] } : { orders: rows, pagination: { nextToken: "page2" } })
      : json({ payload: c.url.searchParams.has(tokenKey) ? { transactions: [rows[0]] } : { transactions: rows, nextToken: "page2" } }));
    const params = { [startKey]: new Date(f.deps.now() - days * 86400_000).toISOString(), ...(operation === "list_orders" ? { limit: 100 } : {}) };
    const first: any = await f.service.run(operation, params, COMPANY);
    f.advance(4 * 60_000);
    const retryParams = { ...params, cursor: first.nextCursor };
    const second: any = await f.service.run(operation, retryParams, COMPANY);
    const replay: any = await f.service.run(operation, retryParams, COMPANY);
    assert.deepEqual(second[key], replay[key]);
    await assert.rejects(f.service.run(operation, { ...retryParams, [startKey]: "wrong" }, COMPANY), code("ECURSOR"));
    const all = [...first[key], ...second[key]]; let cursor = second.nextCursor;
    while (cursor) {
      f.advance(4 * 60_000);
      const out: any = await f.service.run(operation, { ...params, cursor }, COMPANY);
      all.push(...out[key]); cursor = out.nextCursor;
    }
    assert.equal(all.length, rows.length + 1);
    const calls = apiCalls(f, suffix); assert.equal(calls.length, 2);
    assert.equal(calls[1].url.searchParams.get(startKey), calls[0].url.searchParams.get(startKey));
    assert.equal(calls[1].url.searchParams.get(endKey), calls[0].url.searchParams.get(endKey));
    // An unbound new query still validates the current maximum window.
    await assert.rejects(f.service.run(operation, params, COMPANY), code("EINPUT"));
  }
});

test("F1: a 500-transaction provider page is delivered whole across cursors before Amazon's next page is requested", async () => {
  const f = fixture(c => c.url.searchParams.get("nextToken") === "page2" ? json({ payload: { transactions: [tx(500), tx(501), tx(502)] } }) : json({ payload: { transactions: Array.from({ length: 500 }, (_, i) => tx(i)), nextToken: "page2" } }));
  const { all, sizes } = await drain(f, "list_financial_events", finance, "transactions");
  assert.ok(sizes[0] > 0 && sizes[0] < 500, "the first page is size-limited");
  assert.deepEqual(all.map(t => t.transactionId), Array.from({ length: 503 }, (_, i) => `t${i}`), "every record exactly once, in order");
  assert.ok(all.every(t => t.breakdowns.length === 2 && t.relatedIdentifiers.length === 3), "records are whole");
  const pages = apiCalls(f, "/transactions");
  assert.equal(pages.length, 2, "the cached remainder is served before the provider token is used");
  assert.equal(pages[1].url.searchParams.get("nextToken"), "page2");
  assert.equal(pages[1].url.searchParams.get("postedAfter"), finance.postedAfter, "listTransactions continues with the same arguments");
});

test("R2-1: fresh local cursors keep undocumented finance tokens and 24-hour order tokens reachable", async () => {
  const financePage = fixture(c => c.url.searchParams.get("nextToken") ? json({ payload: { transactions: [tx(500)] } }) : json({ payload: { transactions: Array.from({ length: 500 }, (_, i) => tx(i)), nextToken: "page2" } }));
  const transactions = await drain(financePage, "list_financial_events", finance, "transactions", () => financePage.advance(60_000));
  assert.ok(transactions.sizes.length > 15, "the chain exceeds 15 minutes in total");
  assert.deepEqual(transactions.all.map(t => t.transactionId), Array.from({ length: 501 }, (_, i) => `t${i}`));
  assert.equal(apiCalls(financePage, "/transactions").length, 2);
  const ordersPage = fixture(c => c.url.searchParams.get("paginationToken") ? json({ orders: [order(100, 4)] }) : json({ orders: Array.from({ length: 100 }, (_, i) => order(i, 4)), pagination: { nextToken: "page2" } }));
  const orders = await drain(ordersPage, "list_orders", { createdAfter: new Date(Date.now() - 86400_000).toISOString(), limit: 100 }, "orders", () => ordersPage.advance(5 * 60_000));
  assert.ok(orders.sizes.length > 3);
  assert.deepEqual(orders.all.map(o => o.orderId), Array.from({ length: 101 }, (_, i) => order(i, 4).orderId));
  assert.equal(apiCalls(ordersPage, "/orders").length, 2);
});

test("R2-1: Orders provider tokens expire at 24 hours while each local cursor still expires at 15 minutes", async () => {
  const f = fixture(() => json({ orders: [], pagination: { nextToken: "next" } }));
  const p = { createdAfter: new Date(Date.now() - 86400_000).toISOString() };
  const first = await f.service.run("list_orders", p, COMPANY);
  const state = (f.service as any).cursors.get(first.nextCursor, [...(f.service as any).cursors.cursors.values()][0].binding, f.deps.now());
  assert.equal(state.tokenExpires - f.deps.now(), 24 * 60 * 60_000);
  assert.equal(state.expires - f.deps.now(), 15 * 60_000);
  // Simulate a long chain of cached remainders without manufacturing thousands
  // of large orders. Only the local cursor is fresh; Amazon's token is not.
  f.advance(24 * 60 * 60_000);
  const cursor = (f.service as any).cursors.put({ ...state, expires: f.deps.now() + 900_000 }, f.deps.now());
  const before = f.calls.length;
  await assert.rejects(f.service.run("list_orders", { ...p, cursor }, COMPANY), e => code("EPAGE_EXPIRED")(e) && !/FBA|sku/.test((e as Error).message));
  assert.equal(f.calls.length, before, "an expired Orders token is never sent");
  const g = fixture(() => json({ payload: { transactions: [tx(0)], nextToken: "n" } }));
  const start = await g.service.run("list_financial_events", finance, COMPANY);
  g.advance(900_000);
  await assert.rejects(g.service.run("list_financial_events", { ...finance, cursor: start.nextCursor }, COMPANY), code("ECURSOR"));
  assert.equal(apiCalls(g, "/transactions").length, 1);
});

test("R2-L2: optional finance arrays can be omitted on empty pages without losing continuation", async () => {
  for (const operation of ["list_financial_events", "get_balances"]) {
    const key = operation === "get_balances" ? "balances" : "transactions";
    const p = operation === "get_balances" ? {} : finance;
    const wrap = (v: Record<string, unknown>) => operation === "get_balances" ? v : { payload: v };
    for (const present of [false, true]) {
      const f = fixture(c => c.url.searchParams.get("nextToken") ? json(wrap({ [key]: [] })) : json(wrap({ ...(present ? { [key]: [] } : {}), nextToken: "page2" })));
      const first = await f.service.run(operation, p, COMPANY);
      assert.deepEqual(first[key], []); assert.ok(first.nextCursor);
      const second = await f.service.run(operation, { ...p, cursor: first.nextCursor }, COMPANY);
      assert.deepEqual(second[key], []); assert.equal(second.nextCursor, null);
      assert.equal(f.calls.at(-1)!.url.searchParams.get("nextToken"), "page2");
    }
    for (const invalid of [null, {}, "invalid", 1, false]) {
      const f = fixture(() => json(wrap({ [key]: invalid })));
      await assert.rejects(f.service.run(operation, p, COMPANY), code("ERESPONSE"));
    }
  }
  for (const payload of [null, [], "invalid", 1, false]) {
    const f = fixture(() => json({ payload }));
    await assert.rejects(f.service.run("list_financial_events", finance, COMPANY), code("ERESPONSE"));
  }
});

test("F1/L1: a 50-summary FBA page stays reachable past Amazon's 30-second token, then reports an expired provider token", async () => {
  const page = json({ payload: { inventorySummaries: Array.from({ length: 50 }, (_, i) => summary(i)) }, pagination: { nextToken: "page2" } });
  const late = fixture(c => c.url.searchParams.get("nextToken") ? json({ payload: { inventorySummaries: [summary(50)] } }) : page);
  const p = { fulfillment: "FBA", limit: 100 };
  const first: any = await late.service.run("get_inventory_summary", p, COMPANY);
  assert.ok(first.inventory.length > 0 && first.inventory.length < 50); assert.match(first.note, /30 seconds/);
  // Records already fetched are served from memory even after Amazon's token died.
  late.advance(60_000);
  const second: any = await late.service.run("get_inventory_summary", { ...p, cursor: first.nextCursor }, COMPANY);
  assert.deepEqual([...first.inventory, ...second.inventory].map((s: any) => s.sellerSku), Array.from({ length: 50 }, (_, i) => `SKU-${i}`));
  assert.equal(apiCalls(late, "/summaries").length, 1);
  assert.ok(second.inventory.every((s: any) => s.inventoryDetails.unfulfillableQuantity.expiredQuantity === 0));
  await assert.rejects(late.service.run("get_inventory_summary", { ...p, cursor: second.nextCursor }, COMPANY), code("EPAGE_EXPIRED"));
  assert.equal(apiCalls(late, "/summaries").length, 1, "an expired provider token is never sent");
  // Prompt continuation uses Amazon's token with the original filters.
  const prompt = fixture(c => c.url.searchParams.get("nextToken") ? json({ payload: { inventorySummaries: [summary(50)] } }) : page);
  const { all } = await drain(prompt, "get_inventory_summary", { fulfillment: "FBA" }, "inventory");
  assert.equal(all.length, 51); assert.equal(new Set(all.map(s => s.sellerSku)).size, 51);
  const next = apiCalls(prompt, "/summaries")[1].url.searchParams;
  assert.equal(next.get("nextToken"), "page2"); assert.equal(next.get("granularityId"), MARKET); assert.equal(next.get("details"), "true");
});

test("F1: default 25 orders with 4 items each are all returned whole", async () => {
  const f = fixture(() => json({ orders: Array.from({ length: 25 }, (_, i) => order(i, 4)) }));
  const { all, sizes } = await drain(f, "list_orders", { createdAfter: new Date(Date.now() - 86400_000).toISOString() }, "orders");
  assert.ok(sizes.length > 1, "the default page does not fit one response");
  assert.equal(all.length, 25); assert.equal(new Set(all.map(o => o.orderId)).size, 25);
  assert.ok(all.every(o => o.orderItems.length === 4 && o.fulfillment.fulfillmentStatus === "SHIPPED"));
  assert.equal(apiCalls(f, "/orders").length, 1);
});

test("F1: sales and traffic date and ASIN arrays have independent offsets and every row is reachable", async () => {
  const money = (a: number) => ({ amount: a, currencyCode: "USD" });
  const salesByDate = { orderedProductSales: money(1), orderedProductSalesB2B: money(0), unitsOrdered: 1, unitsOrderedB2B: 0, totalOrderItems: 1, totalOrderItemsB2B: 0, averageSalesPerOrderItem: money(1), averageSellingPrice: money(1), unitsRefunded: 0, refundRate: 0, claimsGranted: 0, claimsAmount: money(0), shippedProductSales: money(1), unitsShipped: 1, ordersShipped: 1 };
  const traffic = { browserPageViews: 1, browserPageViewsB2B: 0, mobileAppPageViews: 1, mobileAppPageViewsB2B: 0, pageViews: 2, pageViewsB2B: 0, browserSessions: 1, browserSessionsB2B: 0, mobileAppSessions: 1, mobileAppSessionsB2B: 0, sessions: 2, sessionsB2B: 0, buyBoxPercentage: 100, buyBoxPercentageB2B: 0, orderItemSessionPercentage: 50, orderItemSessionPercentageB2B: 0, unitSessionPercentage: 50, unitSessionPercentageB2B: 0 };
  const doc = { salesAndTrafficByDate: Array.from({ length: 25 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, salesByDate, trafficByDate: traffic })), salesAndTrafficByAsin: Array.from({ length: 25 }, (_, i) => ({ parentAsin: "B000000001", childAsin: `B0000000${String(i).padStart(2, "0")}`, sku: `SKU-${i}`, salesByAsin: { unitsOrdered: 1, orderedProductSales: money(1) }, trafficByAsin: traffic })) };
  const f = fixture(c => c.url.pathname.endsWith("/reports/s1") ? json({ reportId: "s1", reportType: REPORT_TYPES[3], marketplaceIds: [MARKET], processingStatus: "DONE", reportDocumentId: "d1" }) : c.url.pathname.endsWith("/documents/d1") ? json({ url: "https://d34o8swod1owfl.cloudfront.net/r" }) : json(doc));
  const first: any = await f.service.run("get_report", { reportId: "s1" }, COMPANY);
  assert.equal(first.dateCount, 25); assert.equal(first.asinCount, 25);
  assert.equal(first.salesAndTrafficByDate.length, 25); assert.equal(first.nextDateOffset, null);
  assert.ok(first.salesAndTrafficByAsin.length < 25 && first.nextAsinOffset === first.salesAndTrafficByAsin.length, "next offset counts delivered ASIN rows");
  const asins = [...first.salesAndTrafficByAsin]; let at = first.nextAsinOffset;
  while (at !== null) {
    const out: any = await f.service.run("get_report", { reportId: "s1", asinOffset: at }, COMPANY);
    assert.equal(out.salesAndTrafficByDate, undefined, "only the named array is read");
    asins.push(...out.salesAndTrafficByAsin); at = out.nextAsinOffset;
  }
  assert.deepEqual(asins.map(a => a.sku), Array.from({ length: 25 }, (_, i) => `SKU-${i}`));
  assert.ok(asins.every(a => a.trafficByAsin.sessions === 2));
  assert.equal(apiCalls(f, "/documents/d1").length, 1, "later offsets reuse the projected rows");
  await assert.rejects(f.service.run("get_report", { reportId: "s1", offset: 1, dateOffset: 1 }, COMPANY), code("EINPUT"));
});

test("F1: the same cursor returns the same page, and a failed continuation does not consume it", async () => {
  let fail = false;
  const f = fixture(c => c.url.searchParams.get("nextToken") ? (fail ? json({}, 500) : json({ payload: { transactions: [tx(2)] } })) : json({ payload: { transactions: [tx(0), tx(1)], nextToken: "page2" } }));
  const first: any = await f.service.run("list_financial_events", finance, COMPANY);
  assert.deepEqual(first.transactions.map((t: any) => t.transactionId), ["t0", "t1"]);
  fail = true;
  await assert.rejects(f.service.run("list_financial_events", { ...finance, cursor: first.nextCursor }, COMPANY), code("EHTTP"));
  fail = false;
  const a: any = await f.service.run("list_financial_events", { ...finance, cursor: first.nextCursor }, COMPANY);
  const b: any = await f.service.run("list_financial_events", { ...finance, cursor: first.nextCursor }, COMPANY);
  assert.deepEqual(a.transactions, b.transactions); assert.equal(a.transactions[0].transactionId, "t2");
});

test("F1: oversized records are returned one per call, and one too large alone is trimmed and flagged, never an empty page", async () => {
  const long = (c: string) => c.repeat(60);
  const shape: Shape = { a: [{ b: [{ [long("c")]: true, [long("d")]: true }] }] };
  const raw = { a: Array.from({ length: 100 }, () => ({ b: Array.from({ length: 100 }, () => ({ [long("c")]: -1.2345678901234567e+300, [long("d")]: -1.2345678901234567e+300 })) })) };
  const rec = projectRecord(raw, shape, v => v);
  assert.ok(rec.bytes <= PAGE_BYTES); assert.equal(rec.truncated, true); assert.ok(rec.nodes < PAGE_NODES / 2 + 1, "projected again with fewer nodes");
  const big = (i: number) => ({ ...tx(i), items: Array.from({ length: 100 }, (_, n) => ({ totalAmount: cur(n), breakdowns: Array.from({ length: 20 }, () => ({ breakdownType: "x".repeat(200), breakdownAmount: cur(1) })) })) });
  const f = fixture(() => json({ payload: { transactions: [big(0), big(1), tx(2)] } }));
  const seen: string[] = []; let cursor: unknown, calls = 0;
  do {
    const out: any = await f.service.run("list_financial_events", cursor ? { ...finance, cursor } : finance, COMPANY);
    const ids = out.transactions.map((t: any) => t.transactionId);
    assert.ok(ids.length >= 1, "every call makes progress");
    if (ids.includes("t0") || ids.includes("t1")) assert.equal(out.truncated, true);
    seen.push(...ids); cursor = out.nextCursor; calls++;
  } while (cursor && calls < 10);
  assert.deepEqual(seen, ["t0", "t1", "t2"]); assert.equal(calls, 3);
});

test("F1: cached remainders hold projected, redacted records only, never raw buyer data or secrets", async () => {
  const privateValue = "example-buyer-should-never-be-cached";
  const f = fixture(() => json({ orders: Array.from({ length: 25 }, (_, i) => order(i, 4, { buyer: { buyerName: privateValue }, recipient: { deliveryAddress: privateValue }, salesChannel: { channelName: CREDS.clientSecret, marketplaceId: MARKET } })) }));
  const out: any = await f.service.run("list_orders", { createdAfter: new Date(Date.now() - 86400_000).toISOString() }, COMPANY);
  assert.ok(out.nextCursor);
  const cached = JSON.stringify([...((f.service as any).cursors.cursors as Map<string, { batch?: Batch }>).values()].map(c => c.batch?.recs));
  assert.ok(cached.includes("123-1234567-"), "the remainder is cached");
  assert.ok(!cached.includes(privateValue)); assert.ok(!cached.includes(CREDS.clientSecret)); assert.match(cached, /redacted/);
});

test("F1: cursor memory is bounded by count and bytes, shared pages count once, and eviction answers ECURSOR", () => {
  const batch = (bytes: number): Batch => ({ recs: [{ json: "{}", bytes, nodes: 1, truncated: false }, { json: "{}", bytes, nodes: 1, truncated: false }], bytes: 2 * bytes });
  const state = (b?: Batch) => ({ binding: "b", query: {}, batch: b, index: 1, tokenExpires: 0, expires: 10_000 });
  const store = new CursorStore(3, 1000);
  const shared = batch(200);
  const a = store.put(state(shared), 0), b = store.put(state(shared), 0);
  assert.equal(store.cachedBytes, 400, "a shared page is counted once");
  store.put(state(batch(150)), 0); store.put(state(), 0);
  assert.equal(store.size, 3); assert.throws(() => store.get(a, "b", 0), code("ECURSOR"), "the oldest cursor is evicted by count");
  assert.equal(store.get(b, "b", 0).index, 1); assert.equal(store.cachedBytes, 700);
  store.put(state(batch(300)), 0);
  assert.ok(store.cachedBytes <= 1000); assert.throws(() => store.get(b, "b", 0), code("ECURSOR"), "the oldest cursor is evicted by bytes");
  assert.throws(() => store.get(store.put(state(), 0), "other", 0), code("ECURSOR"), "a cursor never crosses bindings");
  const fresh = store.put(state(), 0); assert.throws(() => store.get(fresh, "b", 10_000), code("ECURSOR"), "expired after its TTL");
});

test("L4: clearing caches during a continuation is safe, and a mid-call config change is a clean error", async () => {
  let svc: any, n = 0;
  const f = fixture(() => { if (++n === 2) svc.clear(); return json({ payload: { transactions: [tx(n)], nextToken: "next" } }); });
  svc = f.service;
  const first: any = await f.service.run("list_financial_events", finance, COMPANY);
  const second: any = await f.service.run("list_financial_events", { ...finance, cursor: first.nextCursor }, COMPANY);
  assert.equal(second.transactions[0].transactionId, "t2"); assert.ok(second.nextCursor);
  let m = 0;
  const g = fixture(() => { if (++m === 2) { g.setConfig({ accounts: [{ ...account(), allowedCompanies: [] }] }); (g.service as any).clear(); } return json({ payload: { transactions: [tx(m)], nextToken: "next" } }); });
  const start: any = await g.service.run("list_financial_events", finance, COMPANY);
  await assert.rejects(g.service.run("list_financial_events", { ...finance, cursor: start.nextCursor }, COMPANY), code("ECOMPANY"));
});

test("L5: a text-heavy A+ document pages whole modules instead of failing", async () => {
  const para = "A".repeat(2000);
  const modules = Array.from({ length: 8 }, (_, i) => ({ contentModuleType: "STANDARD_TEXT", standardText: { headline: { value: `Headline ${i}` }, body: { textList: Array.from({ length: 9 }, () => ({ value: para })) } } }));
  const f = fixture(() => json({ contentRecord: { contentReferenceKey: "k1", contentMetadata: { name: "n", marketplaceId: MARKET, status: "APPROVED", badgeSet: [], updateTime: "2026-01-01T00:00:00Z" }, contentDocument: { name: "n", contentType: "EBC", locale: "en-US", contentModuleList: modules } } }));
  const got: any[] = []; let offset: number | null = 0, calls = 0;
  while (offset !== null) {
    const out: any = await f.service.run("get_aplus_content", { contentReferenceKey: "k1", moduleOffset: offset }, COMPANY);
    assert.ok(out.content.modules.length >= 1); assert.equal(out.moduleCount, 8); assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 96 * 1024);
    got.push(...out.content.modules); offset = out.nextModuleOffset; calls++;
  }
  assert.ok(calls > 1); assert.equal(got.length, 8);
  assert.deepEqual(got.map(m => m.texts[0]), Array.from({ length: 8 }, (_, i) => `Headline ${i}`));
  assert.ok(got.every(m => m.texts.length === 10 && m.texts.slice(1).every((t: string) => t.length === 1500)), "no module text is dropped or replaced by empty strings");
  assert.ok(PAGE_BYTES < 96 * 1024);
});
