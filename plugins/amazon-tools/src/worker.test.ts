import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin, { validateConfig } from "./worker.js";
import { assertReadOnly, clearTokenCache, retryPolicy } from "./spApi.js";

// All data below is made up.
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const MKT = "ATVPDKIKX0DER";
const REFS = {
  lwaClientIdRef: "aaaaaaaa-0000-4000-8000-000000000001",
  lwaClientSecretRef: "aaaaaaaa-0000-4000-8000-000000000002",
  refreshTokenRef: "aaaaaaaa-0000-4000-8000-000000000003",
};
// The harness resolves a secret ref to "resolved:<ref>".
const SECRET_VALUES = Object.values(REFS).map((r) => `resolved:${r}`);
const ACCESS_TOKEN = "Atza|fake-access-token-value";

const CONFIG = {
  defaultAccount: "demo-store",
  accounts: [
    {
      key: "demo-store",
      name: "Demo Store",
      region: "na",
      marketplaceIds: [MKT],
      sellerId: "A1FAKESELLER",
      ...REFS,
      allowedCompanies: [COMPANY],
    },
  ],
};

interface Call {
  method: string;
  url: URL;
  body?: unknown;
  headers: Record<string, string>;
}
type Route = (call: Call) => { status?: number; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
const realSleep = retryPolicy.sleep;
let calls: Call[] = [];
let routes: Array<[RegExp, Route]> = [];
let lwaCalls = 0;

function route(pattern: RegExp, handler: Route) {
  routes.unshift([pattern, handler]);
}

function installFetch() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    if (url.href === "https://api.amazon.com/auth/o2/token") {
      lwaCalls++;
      return json(200, { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: "bearer" });
    }
    const call = { method, url, body, headers };
    calls.push(call);
    const hit = routes.find(([re]) => re.test(url.pathname) || re.test(url.href));
    assert.ok(hit, `unexpected fetch ${method} ${url.href}`);
    const res = hit[1](call);
    if (res.raw) {
      return new Response(res.raw, { status: res.status ?? 200, headers: res.headers });
    }
    return json(res.status ?? 200, res.body ?? {}, res.headers);
  }) as typeof fetch;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

let harness: TestHarness;

async function run(tool: string, params: Record<string, unknown> = {}, companyId = COMPANY) {
  return (await harness.executeTool(tool, params, { companyId })) as ToolResult;
}

function assertNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const s of [...SECRET_VALUES, ACCESS_TOKEN]) {
    assert.ok(!text.includes(s), `secret value leaked: ${s}`);
  }
}

beforeEach(async () => {
  calls = [];
  routes = [];
  lwaCalls = 0;
  clearTokenCache();
  retryPolicy.sleep = async () => {};
  installFetch();
  harness = createTestHarness({ manifest, config: structuredClone(CONFIG) });
  await plugin.definition.setup(harness.ctx);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  retryPolicy.sleep = realSleep;
});

describe("read-only guard", () => {
  it("allows the read calls and the one create-report POST", () => {
    assertReadOnly("GET", "/orders/v0/orders");
    assertReadOnly("GET", "/orders/v0/orders/111-0000000-0000000/orderItems");
    assertReadOnly("GET", "/finances/v0/financialEventGroups/G1/financialEvents");
    assertReadOnly("POST", "/reports/2021-06-30/reports");
  });

  it("blocks every write-shaped call", () => {
    const blocked: Array<[string, string]> = [
      ["PUT", "/listings/2021-08-01/items/S/SKU"],
      ["PATCH", "/listings/2021-08-01/items/S/SKU"],
      ["DELETE", "/listings/2021-08-01/items/S/SKU"],
      ["POST", "/feeds/2021-06-30/feeds"],
      ["POST", "/orders/v0/orders/111-0000000-0000000/shipment"],
      ["POST", "/messaging/v1/orders/111/messages/confirmOrderDetails"],
      ["DELETE", "/reports/2021-06-30/reports/123"],
      ["GET", "/tokens/2021-03-01/restrictedDataToken"],
      ["GET", "/orders/v0/orders/111/buyerInfo"],
      ["GET", "/orders/v0/orders/111/address"],
    ];
    for (const [m, p] of blocked) {
      assert.throws(() => assertReadOnly(m, p), /EWRITE_BLOCKED/, `${m} ${p}`);
    }
  });

  it("every tool only reaches Amazon with GET, apart from create report", async () => {
    route(/.*/, (c) => {
      if (c.url.pathname.includes("/documents/")) return { body: { url: "https://example-bucket.s3.amazonaws.com/doc", compressionAlgorithm: undefined } };
      if (c.url.hostname.endsWith("s3.amazonaws.com")) return { raw: new TextEncoder().encode("sku\tqty\nA\t1\n") };
      if (/\/reports\/2021-06-30\/reports\/[^/]+$/.test(c.url.pathname)) {
        return { body: { reportId: "R1", reportType: "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA", processingStatus: "DONE", reportDocumentId: "D1" } };
      }
      return { body: { payload: {}, reportId: "R1" } };
    });
    await run("amazon_list_orders");
    await run("amazon_get_order", { orderId: "111-0000000-0000000" });
    await run("amazon_list_settlements");
    await run("amazon_get_settlement", { settlementId: "G1" });
    await run("amazon_list_financial_events", { postedAfter: "2026-01-01T00:00:00Z" });
    await run("amazon_get_inventory_summary");
    await run("amazon_get_inventory_summary", { channel: "merchant", skus: ["SKU-1"] });
    await run("amazon_request_report", { reportType: "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA" });
    await run("amazon_list_reports");
    await run("amazon_get_report", { reportId: "R1" });

    const amazonCalls = calls.filter((c) => c.url.hostname === "sellingpartnerapi-na.amazon.com");
    assert.ok(amazonCalls.length >= 10);
    for (const c of amazonCalls) {
      if (c.method === "GET") continue;
      assert.equal(c.method, "POST");
      assert.equal(c.url.pathname, "/reports/2021-06-30/reports");
    }
    for (const c of calls.filter((c) => c.url.hostname.endsWith("s3.amazonaws.com"))) {
      assert.equal(c.method, "GET");
    }
  });
});

describe("orders", () => {
  const fullOrder = {
    AmazonOrderId: "111-0000000-0000001",
    PurchaseDate: "2026-01-02T10:00:00Z",
    OrderStatus: "Shipped",
    FulfillmentChannel: "AFN",
    OrderTotal: { CurrencyCode: "USD", Amount: "19.99" },
    MarketplaceId: MKT,
    BuyerInfo: { BuyerEmail: "test-buyer@example.invalid", BuyerName: "Pat Example" },
    ShippingAddress: {
      Name: "Pat Example",
      AddressLine1: "1 Example Way",
      City: "Exampletown",
      PostalCode: "ZZ-POSTAL",
      Phone: "555-0100",
      StateOrRegion: "TX",
      CountryCode: "US",
    },
  };

  it("never returns buyer personal details", async () => {
    route(/\/orders\/v0\/orders$/, () => ({ body: { payload: { Orders: [fullOrder], NextToken: "NT" } } }));
    route(/orderItems$/, () => ({
      body: {
        payload: {
          OrderItems: [
            { ASIN: "B000000000", SellerSKU: "SKU-1", QuantityOrdered: 1, BuyerInfo: { GiftMessageText: "Happy birthday Pat" }, ProductInfo: { NumberOfItems: "1" } },
          ],
        },
      },
    }));
    route(/\/orders\/v0\/orders\/[^/]+$/, () => ({ body: { payload: fullOrder } }));

    const list = await run("amazon_list_orders");
    const one = await run("amazon_get_order", { orderId: fullOrder.AmazonOrderId });
    for (const res of [list, one]) {
      assert.equal(res.error, undefined);
      const text = JSON.stringify(res.data);
      for (const pii of ["Pat Example", "test-buyer@example.invalid", "1 Example Way", "Exampletown", "ZZ-POSTAL", "555-0100", "Happy birthday", "BuyerInfo"]) {
        assert.ok(!text.includes(pii), `leaked ${pii}`);
      }
      assert.ok(text.includes('"CountryCode":"US"'));
      assert.ok(text.includes('"StateOrRegion":"TX"'));
    }
    assert.equal((list.data as { nextToken: string }).nextToken, "NT");
    const items = (one.data as { items: Array<Record<string, unknown>> }).items;
    assert.equal(items[0]!.SellerSKU, "SKU-1");
    assert.equal(items[0]!.NumberOfItems, "1");
  });

  it("sends the access token as x-amz-access-token and defaults to the last 7 days", async () => {
    route(/\/orders\/v0\/orders$/, () => ({ body: { payload: { Orders: [] } } }));
    await run("amazon_list_orders");
    const c = calls[0]!;
    assert.equal(c.headers["x-amz-access-token"], ACCESS_TOKEN);
    assert.equal(c.url.searchParams.get("MarketplaceIds"), MKT);
    const after = Date.parse(c.url.searchParams.get("CreatedAfter")!);
    assert.ok(Math.abs(Date.now() - 7 * 86400_000 - after) < 60_000);
  });

  it("rejects a marketplace that is not on the account", async () => {
    const res = await run("amazon_list_orders", { marketplaceIds: ["A1F83G8C2ARO7P"] });
    assert.match(res.error!, /EINVALID_INPUT/);
    assert.equal(calls.length, 0);
  });
});

describe("company isolation", () => {
  it("refuses an account the calling company is not allowed to use, before any network call", async () => {
    const res = await run("amazon_list_orders", {}, OTHER_COMPANY);
    assert.match(res.error!, /ECOMPANY_NOT_ALLOWED/);
    assert.equal(calls.length, 0);
    assert.equal(lwaCalls, 0);
  });

  it("list_accounts shows only this company's accounts and no secret refs", async () => {
    const mine = await run("amazon_list_accounts");
    const theirs = await run("amazon_list_accounts", {}, OTHER_COMPANY);
    assert.equal((mine.data as { accounts: unknown[] }).accounts.length, 1);
    assert.equal((theirs.data as { accounts: unknown[] }).accounts.length, 0);
    const text = JSON.stringify(mine);
    for (const ref of Object.values(REFS)) assert.ok(!text.includes(ref));
  });
});

describe("secrets", () => {
  it("never appear in tool output, errors, activity or logs, even if Amazon echoes them", async () => {
    route(/\/orders\/v0\/orders$/, () => ({
      status: 400,
      body: { errors: [{ code: "InvalidInput", message: `bad token ${ACCESS_TOKEN} for ${SECRET_VALUES[0]}` }] },
    }));
    const res = await run("amazon_list_orders");
    assert.match(res.error!, /EAMAZON_INVALID/);
    assert.match(res.error!, /\[REDACTED\]/);
    assertNoSecrets(res);
    assertNoSecrets(harness.activity);
    assertNoSecrets(harness.logs);
  });

  it("signs in separately per company, never sharing a client across companies", async () => {
    const cfg = structuredClone(CONFIG);
    cfg.accounts[0]!.allowedCompanies = [COMPANY, OTHER_COMPANY];
    harness.setConfig(cfg);
    route(/.*/, () => ({ body: { payload: {} } }));
    await run("amazon_list_orders");
    await run("amazon_list_orders", {}, OTHER_COMPANY);
    await run("amazon_list_orders");
    assert.equal(lwaCalls, 2);
  });

  it("reuses one access token across calls", async () => {
    route(/.*/, () => ({ body: { payload: {} } }));
    await run("amazon_list_orders");
    await run("amazon_list_settlements");
    await run("amazon_get_inventory_summary");
    assert.equal(lwaCalls, 1);
  });
});

describe("rate limits", () => {
  it("backs off on 429 and then succeeds, honouring Retry-After", async () => {
    const waits: number[] = [];
    retryPolicy.sleep = async (ms) => {
      waits.push(ms);
    };
    let n = 0;
    route(/\/finances\/v0\/financialEventGroups$/, () =>
      ++n < 3 ? { status: 429, body: { errors: [{ code: "QuotaExceeded" }] }, headers: { "retry-after": "2" } } : { body: { payload: { FinancialEventGroupList: [] } } },
    );
    const res = await run("amazon_list_settlements");
    assert.equal(res.error, undefined);
    assert.equal(n, 3);
    assert.deepEqual(waits, [2000, 2000]);
  });

  it("gives up with EAMAZON_RATE_LIMIT after the retry budget", async () => {
    route(/\/finances\/v0\/financialEventGroups$/, () => ({ status: 429, body: { errors: [{ code: "QuotaExceeded" }] } }));
    const res = await run("amazon_list_settlements");
    assert.match(res.error!, /EAMAZON_RATE_LIMIT/);
    assert.equal(calls.length, retryPolicy.maxRetries + 1);
  });
});

describe("finance", () => {
  it("trims settlements and drops the bank account tail", async () => {
    route(/financialEventGroups$/, () => ({
      body: {
        payload: {
          FinancialEventGroupList: [
            { FinancialEventGroupId: "G1", ProcessingStatus: "Closed", OriginalTotal: { CurrencyCode: "USD", CurrencyAmount: 100 }, AccountTail: "999", TraceId: "T" },
          ],
        },
      },
    }));
    const res = await run("amazon_list_settlements");
    const s = (res.data as { settlements: Array<Record<string, unknown>> }).settlements[0]!;
    assert.equal(s.FinancialEventGroupId, "G1");
    assert.equal(s.AccountTail, undefined);
    assert.equal(s.TraceId, undefined);
  });

  it("summarises settlement events, drops empty lists and caps each list", async () => {
    const shipments = Array.from({ length: 5 }, (_, i) => ({ AmazonOrderId: `111-${i}`, ShipmentItemList: [] }));
    route(/financialEventGroups\/G1\/financialEvents$/, () => ({
      body: { payload: { FinancialEvents: { ShipmentEventList: shipments, RefundEventList: [], ServiceFeeEventList: [{ FeeReason: "x" }] } } },
    }));
    const res = await run("amazon_get_settlement", { settlementId: "G1", maxPerType: 2 });
    const d = res.data as { counts: Record<string, number>; events: Record<string, unknown[]>; truncated: boolean };
    assert.deepEqual(d.counts, { ShipmentEventList: 5, ServiceFeeEventList: 1 });
    assert.equal(d.events.ShipmentEventList!.length, 2);
    assert.equal(d.events.RefundEventList, undefined);
    assert.equal(d.truncated, true);
  });

  it("keeps PostedBefore at least a few minutes in the past", async () => {
    route(/financialEvents$/, () => ({ body: { payload: { FinancialEvents: {} } } }));
    await run("amazon_list_financial_events", { postedAfter: "2026-01-01T00:00:00Z", postedBefore: "2999-01-01T00:00:00Z" });
    const before = Date.parse(calls[0]!.url.searchParams.get("PostedBefore")!);
    assert.ok(before <= Date.now() - 2 * 60_000);
  });
});

describe("inventory", () => {
  it("reads FBA inventory and flattens the quantities", async () => {
    route(/fba\/inventory/, () => ({
      body: {
        payload: {
          inventorySummaries: [
            {
              sellerSku: "SKU-1",
              asin: "B000000000",
              totalQuantity: 12,
              inventoryDetails: { fulfillableQuantity: 10, reservedQuantity: { totalReservedQuantity: 2 }, unfulfillableQuantity: { totalUnfulfillableQuantity: 0 } },
            },
          ],
        },
        pagination: { nextToken: "N2" },
      },
    }));
    const res = await run("amazon_get_inventory_summary", { skus: ["SKU-1"] });
    const d = res.data as { items: Array<Record<string, unknown>>; nextToken: string };
    assert.equal(d.items[0]!.fulfillableQuantity, 10);
    assert.equal(d.items[0]!.reservedQuantity, 2);
    assert.equal(d.nextToken, "N2");
    assert.equal(calls[0]!.url.searchParams.get("sellerSkus"), "SKU-1");
  });

  it("reads merchant-fulfilled quantity per SKU", async () => {
    route(/listings\/2021-08-01\/items/, () => ({
      body: {
        summaries: [{ marketplaceId: MKT, asin: "B000000000", itemName: "Demo widget", status: ["BUYABLE"] }],
        fulfillmentAvailability: [{ fulfillmentChannelCode: "DEFAULT", quantity: 7 }],
      },
    }));
    const res = await run("amazon_get_inventory_summary", { channel: "merchant", skus: ["SKU 1"] });
    const item = (res.data as { items: Array<Record<string, unknown>> }).items[0]!;
    assert.deepEqual(item.fulfillmentAvailability, [{ fulfillmentChannelCode: "DEFAULT", quantity: 7 }]);
    assert.equal(calls[0]!.url.pathname, "/listings/2021-08-01/items/A1FAKESELLER/SKU%201");
  });
});

describe("reports", () => {
  it("refuses report types that are not on the list", async () => {
    const req = await run("amazon_request_report", { reportType: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL" });
    assert.match(req.error!, /EREPORT_TYPE_BLOCKED/);
    const sys = await run("amazon_request_report", { reportType: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2" });
    assert.match(sys.error!, /cannot be requested/);
    assert.equal(calls.length, 0);
  });

  it("will not read an order report created outside Paperclip", async () => {
    route(/reports\/R9$/, () => ({
      body: { reportId: "R9", reportType: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL", processingStatus: "DONE", reportDocumentId: "D9" },
    }));
    const res = await run("amazon_get_report", { reportId: "R9" });
    assert.match(res.error!, /EREPORT_TYPE_BLOCKED/);
    assert.ok(!calls.some((c) => c.url.pathname.includes("/documents/")));
  });

  it("requests a report with only allowed options", async () => {
    route(/reports\/2021-06-30\/reports$/, () => ({ status: 202, body: { reportId: "R5" } }));
    const res = await run("amazon_request_report", {
      reportType: "GET_SALES_AND_TRAFFIC_REPORT",
      dataStartTime: "2026-01-01",
      reportOptions: { dateGranularity: "DAY" },
    });
    assert.equal((res.data as { reportId: string }).reportId, "R5");
    assert.deepEqual(calls[0]!.body, {
      reportType: "GET_SALES_AND_TRAFFIC_REPORT",
      marketplaceIds: [MKT],
      dataStartTime: "2026-01-01T00:00:00.000Z",
      reportOptions: { dateGranularity: "DAY" },
    });
    const bad = await run("amazon_request_report", { reportType: "GET_AFN_INVENTORY_DATA", reportOptions: { custom: "x" } });
    assert.match(bad.error!, /not allowed/);
  });

  it("downloads, unzips and pages a finished report, dropping address columns", async () => {
    const tsv = [
      "date/time\tsettlement id\ttype\torder id\tsku\torder city\torder state\torder postal\ttotal",
      "Jan 1\tS1\tOrder\t111-1\tSKU-1\tExampletown\tTX\t00000\t9.99",
      "Jan 2\tS1\tRefund\t111-2\tSKU-2\tExampleville\tCA\t00001\t-4.00",
      "Jan 3\tS1\tOrder\t111-3\tSKU-1\tExampletown\tTX\t00000\t9.99",
    ].join("\n");
    route(/reports\/R2$/, () => ({
      body: { reportId: "R2", reportType: "GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA", processingStatus: "DONE", reportDocumentId: "D2" },
    }));
    route(/documents\/D2$/, () => ({ body: { url: "https://example-bucket.s3.amazonaws.com/D2?sig=x", compressionAlgorithm: "GZIP" } }));
    route(/example-bucket/, () => ({ raw: gzipSync(Buffer.from(tsv)) }));

    const res = await run("amazon_get_report", { reportId: "R2", offset: 1, limit: 1 });
    const d = res.data as { totalRows: number; columns: string[]; rows: Array<Record<string, string>>; truncated: boolean };
    assert.equal(d.totalRows, 3);
    assert.deepEqual(d.columns, ["date/time", "settlement id", "type", "order id", "sku", "order state", "total"]);
    assert.deepEqual(d.rows, [{ "date/time": "Jan 2", "settlement id": "S1", type: "Refund", "order id": "111-2", sku: "SKU-2", "order state": "CA", total: "-4.00" }]);
    assert.equal(d.truncated, true);
    const download = calls.find((c) => c.url.hostname.endsWith("s3.amazonaws.com"))!;
    assert.equal(download.headers["x-amz-access-token"], undefined, "access token must not go to the download URL");
  });

  it("reports progress while a report is still building", async () => {
    route(/reports\/R3$/, () => ({ body: { reportId: "R3", reportType: "GET_AFN_INVENTORY_DATA", processingStatus: "IN_QUEUE" } }));
    const res = await run("amazon_get_report", { reportId: "R3" });
    assert.match(res.content!, /IN_QUEUE/);
  });

  it("list_reports hides types that are not on the list", async () => {
    route(/reports\/2021-06-30\/reports$/, () => ({
      body: { reports: [{ reportId: "A", reportType: "GET_AFN_INVENTORY_DATA" }, { reportId: "B", reportType: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL" }] },
    }));
    const res = await run("amazon_list_reports");
    assert.deepEqual((res.data as { reports: Array<{ reportId: string }> }).reports.map((r) => r.reportId), ["A"]);
  });
});

describe("activity log", () => {
  it("writes one entry per tool call, for success and failure", async () => {
    route(/\/orders\/v0\/orders$/, () => ({ body: { payload: { Orders: [] } } }));
    await run("amazon_list_orders");
    await run("amazon_list_orders", {}, OTHER_COMPANY);
    await run("amazon_list_accounts");
    assert.equal(harness.activity.length, 3);
    assert.match(harness.activity[2]!.message, /Amazon list accounts/);
    assert.match(harness.activity[0]!.message, /Amazon list orders \(demo-store\)/);
    assert.equal(harness.activity[0]!.metadata!.ok, true);
    assert.equal(harness.activity[1]!.metadata!.ok, false);
    assert.equal(harness.activity[1]!.metadata!.error, "ECOMPANY_NOT_ALLOWED");
  });
});

describe("connection test", () => {
  it("passes when the account sells in its marketplaces", async () => {
    route(/marketplaceParticipations/, () => ({
      body: { payload: [{ marketplace: { id: MKT }, participation: { isParticipating: true } }] },
    }));
    const result = await validateConfig(harness.ctx, structuredClone(CONFIG) as never);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("names a marketplace the account does not sell in", async () => {
    route(/marketplaceParticipations/, () => ({ body: { payload: [{ marketplace: { id: "A2EUQ1WTGCTBG2" } }] } }));
    const result = await validateConfig(harness.ctx, structuredClone(CONFIG) as never);
    assert.equal(result.ok, false);
    assert.match(result.errors!.join(" "), /not selling in marketplace ATVPDKIKX0DER/);
  });

  it("reports a sign-in failure without echoing secrets", async () => {
    globalThis.fetch = (async () =>
      json(400, { error: "invalid_grant", error_description: `The request has an invalid grant parameter : ${SECRET_VALUES[2]}` })) as typeof fetch;
    const result = await validateConfig(harness.ctx, structuredClone(CONFIG) as never);
    assert.equal(result.ok, false);
    assert.match(result.errors!.join(" "), /EAMAZON_AUTH/);
    assertNoSecrets(result);
  });

  it("flags missing fields without calling Amazon", async () => {
    const result = await validateConfig(harness.ctx, { accounts: [{ key: "x" }] });
    assert.equal(result.ok, false);
    assert.match(result.errors!.join(" "), /region/);
    assert.equal(calls.length, 0);
  });
});
