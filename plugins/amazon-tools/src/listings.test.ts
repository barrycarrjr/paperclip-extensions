import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";
import { assertReadOnly, clearTokenCache, retryPolicy, type ConfigAccount } from "./spApi.js";
import { contentSnapshot, diffSnapshots, statusSnapshot, trimItemOffers } from "./listings.js";
import { runCheck, runScheduledCheck } from "./watch.js";

// All data below is made up.
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const MKT = "ATVPDKIKX0DER";
const SELLER = "A1FAKESELLER";
const NAMESPACE = "plugin_amazon_d696b53491";
const ACCOUNT: ConfigAccount = {
  key: "demo-store",
  name: "Demo Store",
  region: "na",
  marketplaceIds: [MKT],
  sellerId: SELLER,
  lwaClientIdRef: "aaaaaaaa-0000-4000-8000-000000000001",
  lwaClientSecretRef: "aaaaaaaa-0000-4000-8000-000000000002",
  refreshTokenRef: "aaaaaaaa-0000-4000-8000-000000000003",
  allowedCompanies: [COMPANY],
  listingWatch: true,
};
const CONFIG = { defaultAccount: "demo-store", accounts: [ACCOUNT] };

// ─── Fake Amazon ─────────────────────────────────────────────────────────

interface Call {
  method: string;
  url: URL;
}

interface FakeListing {
  sku: string;
  asin: string;
  title: string;
  status: string[];
  issues: Array<{ code: string; severity: string; message: string }>;
  price: number;
  submittedTitle: string;
}

let listings: FakeListing[];
let offers: Record<string, { mine: boolean; sellers: Array<{ id: string; price: number; winner: boolean; mine?: boolean }> }>;
let offersFail: Set<string>;
let aplusForbidden: boolean;
let calls: Call[];
const realFetch = globalThis.fetch;
const realSleep = retryPolicy.sleep;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function listingItem(l: FakeListing, withAttributes = false) {
  return {
    sku: l.sku,
    summaries: [{ marketplaceId: MKT, asin: l.asin, itemName: l.title, status: l.status, productType: "BEAUTY", mainImage: { link: `https://m.media-amazon.com/images/I/${l.asin}.jpg` } }],
    issues: l.issues,
    offers: [{ marketplaceId: MKT, offerType: "B2C", price: { currencyCode: "USD", amount: String(l.price) } }],
    ...(withAttributes
      ? { attributes: { item_name: [{ value: l.submittedTitle, marketplace_id: MKT }], bullet_point: [{ value: "Bullet one", marketplace_id: MKT }] } }
      : {}),
  };
}

function installFetch() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.href === "https://api.amazon.com/auth/o2/token") {
      return json(200, { access_token: "Atza|fake-access-token", expires_in: 3600 });
    }
    calls.push({ method, url });
    const path = url.pathname;
    let m: RegExpExecArray | null;
    if (path === `/listings/2021-08-01/items/${SELLER}`) {
      return json(200, { numberOfResults: listings.length, items: listings.map((l) => listingItem(l)) });
    }
    if ((m = new RegExp(`^/listings/2021-08-01/items/${SELLER}/(.+)$`).exec(path))) {
      const l = listings.find((x) => x.sku === decodeURIComponent(m![1]!));
      return l ? json(200, listingItem(l, true)) : json(404, { errors: [{ code: "NOT_FOUND", message: "no listing" }] });
    }
    if ((m = /^\/catalog\/2022-04-01\/items\/([A-Z0-9]+)$/.exec(path))) {
      const l = listings.find((x) => x.asin === m![1]);
      return json(200, {
        asin: m[1],
        summaries: [{ marketplaceId: MKT, itemName: l?.title, brand: "Demo Brand", browseClassification: { displayName: "Bath Salts" } }],
        images: [{ marketplaceId: MKT, images: [{ variant: "MAIN", link: `https://m.media-amazon.com/images/I/${m[1]}.jpg` }] }],
        productTypes: [{ marketplaceId: MKT, productType: "BEAUTY" }],
      });
    }
    if ((m = /^\/products\/pricing\/v0\/items\/([A-Z0-9]+)\/offers$/.exec(path))) {
      if (offersFail.has(m[1]!)) return json(400, { errors: [{ code: "InvalidInput", message: "nope" }] });
      const o = offers[m[1]!] ?? { mine: true, sellers: [] };
      return json(200, {
        payload: {
          ASIN: m[1],
          Summary: { TotalOfferCount: o.sellers.length },
          Offers: o.sellers.map((s) => ({ SellerId: s.id, MyOffer: !!s.mine, IsBuyBoxWinner: s.winner, ListingPrice: { Amount: s.price, CurrencyCode: "USD" } })),
        },
      });
    }
    if (path === "/aplus/2020-11-01/contentPublishRecords") {
      if (aplusForbidden) return json(403, { errors: [{ code: "Unauthorized", message: "brand registry required" }] });
      return json(200, { publishRecordList: [{ contentReferenceKey: `K-${url.searchParams.get("asin")}` }] });
    }
    if ((m = /^\/aplus\/2020-11-01\/contentDocuments\/(.+)$/.exec(path))) {
      return json(200, { contentRecord: { contentReferenceKey: m[1], contentMetadata: { name: "Story", status: "APPROVED" }, contentDocument: { contentModuleList: [{ contentModuleType: "STANDARD_TEXT" }] } } });
    }
    if (path === "/sellers/v1/marketplaceParticipations") {
      return json(200, { payload: [{ marketplace: { id: MKT }, participation: { isParticipating: true } }] });
    }
    throw new Error(`unexpected fetch ${method} ${url.href}`);
  }) as typeof fetch;
}

// ─── Plugin database on PGlite ───────────────────────────────────────────

let pg: PGlite;

before(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA ${NAMESPACE}`);
  await pg.exec(await readFile(new URL("../migrations/0001_listing_watch.sql", import.meta.url), "utf8"));
});

after(async () => {
  await pg.close();
});

let harness: TestHarness;

beforeEach(async () => {
  await pg.exec(`DELETE FROM ${NAMESPACE}.listing_snapshots; DELETE FROM ${NAMESPACE}.listing_changes; DELETE FROM ${NAMESPACE}.listing_watch_runs;`);
  listings = [
    { sku: "FR-001", asin: "B000000001", title: "Steam Blend", status: ["BUYABLE", "DISCOVERABLE"], issues: [], price: 19.99, submittedTitle: "Steam Blend" },
    { sku: "FR-002", asin: "B000000002", title: "Bath Soak", status: ["BUYABLE", "DISCOVERABLE"], issues: [], price: 24.5, submittedTitle: "Bath Soak" },
  ];
  offers = {
    B000000001: { mine: true, sellers: [{ id: SELLER, price: 19.99, winner: true, mine: true }] },
    B000000002: { mine: true, sellers: [{ id: SELLER, price: 24.5, winner: true, mine: true }] },
  };
  offersFail = new Set();
  aplusForbidden = false;
  calls = [];
  clearTokenCache();
  retryPolicy.sleep = async () => {};
  installFetch();
  harness = createTestHarness({ manifest, config: structuredClone(CONFIG) });
  harness.ctx.db = {
    namespace: NAMESPACE,
    async query<T>(sql: string, params: unknown[] = []) { return (await pg.query<T>(sql, params)).rows; },
    async execute(sql: string, params: unknown[] = []) { return { rowCount: (await pg.query(sql, params)).affectedRows ?? 0 }; },
  };
  await plugin.definition.setup(harness.ctx);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  retryPolicy.sleep = realSleep;
});

async function run(tool: string, params: Record<string, unknown> = {}, companyId = COMPANY) {
  return (await harness.executeTool(tool, params, { companyId })) as ToolResult;
}

async function changes() {
  return (await pg.query<{ sku: string; kind: string; field: string; before: unknown; after: unknown }>(
    `SELECT sku, kind, field, before, after FROM ${NAMESPACE}.listing_changes ORDER BY sku, field`,
  )).rows;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("read-only guard for listing calls", () => {
  it("allows the new reads", () => {
    assertReadOnly("GET", `/listings/2021-08-01/items/${SELLER}`);
    assertReadOnly("GET", "/catalog/2022-04-01/items/B000000001");
    assertReadOnly("GET", "/products/pricing/v0/items/B000000001/offers");
    assertReadOnly("GET", "/aplus/2020-11-01/contentPublishRecords");
    assertReadOnly("GET", "/aplus/2020-11-01/contentDocuments/K-1");
  });

  it("still blocks every way of changing a listing, a price or A+ content", () => {
    const blocked: Array<[string, string]> = [
      ["PUT", `/listings/2021-08-01/items/${SELLER}/FR-001`],
      ["PATCH", `/listings/2021-08-01/items/${SELLER}/FR-001`],
      ["DELETE", `/listings/2021-08-01/items/${SELLER}/FR-001`],
      ["POST", "/aplus/2020-11-01/contentDocuments"],
      ["POST", "/aplus/2020-11-01/contentDocuments/K-1/approvalSubmission"],
      ["POST", "/products/pricing/v0/items/B000000001/offers"],
      ["POST", "/batches/products/pricing/v0/itemOffers"],
      ["PUT", "/catalog/2022-04-01/items/B000000001"],
    ];
    for (const [m, p] of blocked) assert.throws(() => assertReadOnly(m, p), /EWRITE_BLOCKED/, `${m} ${p}`);
  });

  it("every new tool reaches Amazon with GET only", async () => {
    await run("amazon_list_listings");
    await run("amazon_get_listing", { sku: "FR-001" });
    await run("amazon_get_catalog_item", { asin: "B000000001" });
    await run("amazon_get_item_offers", { asin: "B000000001" });
    await run("amazon_get_aplus_content", { asin: "B000000001" });
    assert.ok(calls.length >= 6);
    for (const c of calls) assert.equal(c.method, "GET", c.url.pathname);
  });
});

describe("listing tools", () => {
  it("lists listings with status, price and issues", async () => {
    listings[1]!.issues = [{ code: "90220", severity: "ERROR", message: "Missing image" }];
    const res = await run("amazon_list_listings");
    const data = res.data as { listings: Array<Record<string, unknown>> };
    assert.equal(data.listings.length, 2);
    assert.deepEqual(data.listings[0]!.status, ["BUYABLE", "DISCOVERABLE"]);
    assert.equal(data.listings[0]!.price, "USD 19.99");
    assert.equal((data.listings[1]!.issues as unknown[]).length, 1);
  });

  it("says who holds the Buy Box", async () => {
    offers.B000000001 = { mine: false, sellers: [{ id: SELLER, price: 19.99, winner: false, mine: true }, { id: "A2OTHER", price: 17.5, winner: true }] };
    const res = await run("amazon_get_item_offers", { asin: "B000000001" });
    const data = res.data as { buyBox: Record<string, unknown>; totalOfferCount: number };
    assert.deepEqual(data.buyBox, { holder: "other", sellerId: "A2OTHER", price: "USD 17.50" });
    assert.equal(data.totalOfferCount, 2);
  });

  it("needs the account's seller ID for listing calls", async () => {
    harness = createTestHarness({ manifest, config: { accounts: [{ ...ACCOUNT, sellerId: undefined }] } });
    await plugin.definition.setup(harness.ctx);
    const res = await run("amazon_list_listings");
    assert.match(res.error ?? "", /ECONFIG.*seller ID/);
  });

  it("rejects a malformed ASIN before calling Amazon", async () => {
    const res = await run("amazon_get_item_offers", { asin: "not-an-asin" });
    assert.match(res.error ?? "", /EINVALID_INPUT/);
    assert.equal(calls.length, 0);
  });

  it("refuses another company, including for the change log", async () => {
    for (const tool of ["amazon_list_listings", "amazon_list_listing_changes"]) {
      const res = await run(tool, {}, OTHER_COMPANY);
      assert.match(res.error ?? "", /ECOMPANY_NOT_ALLOWED/, tool);
    }
    assert.equal(calls.length, 0);
  });
});

describe("Listing Watch", () => {
  it("saves a baseline first, then records only what changed", async () => {
    const first = await runCheck(harness.ctx, ACCOUNT, "status");
    assert.equal(first.ok, true);
    assert.equal(first.changes, 0);
    assert.match(first.note ?? "", /baseline/);

    listings[0]!.status = ["DISCOVERABLE"];
    listings[0]!.issues = [{ code: "18027", severity: "ERROR", message: "Listing suppressed" }];
    offers.B000000002 = { mine: false, sellers: [{ id: SELLER, price: 24.5, winner: false, mine: true }, { id: "A2HIJACK", price: 12, winner: true }] };

    const second = await runCheck(harness.ctx, ACCOUNT, "status");
    assert.equal(second.ok, true);
    const rows = await changes();
    const fields = rows.map((r) => `${r.sku}:${r.field}`);
    assert.deepEqual(fields, [
      "FR-001:issues",
      "FR-001:status",
      "FR-002:buyBoxHolder",
      "FR-002:buyBoxPrice",
      "FR-002:offerCount",
      "FR-002:otherSellers",
    ]);
    const sellers = rows.find((r) => r.field === "otherSellers")!;
    assert.deepEqual(sellers.before, []);
    assert.deepEqual(sellers.after, ["A2HIJACK"]);
    assert.equal(second.changes, 6);
  });

  it("records listings that are added or removed after the baseline", async () => {
    await runCheck(harness.ctx, ACCOUNT, "status");
    listings = [listings[0]!, { sku: "FR-003", asin: "B000000003", title: "New One", status: ["BUYABLE"], issues: [], price: 9, submittedTitle: "New One" }];
    await runCheck(harness.ctx, ACCOUNT, "status");
    const rows = (await changes()).map((r) => `${r.sku}:${r.field}:${String(r.after)}`);
    assert.deepEqual(rows, ["FR-002:listing:removed", "FR-003:listing:added"]);
  });

  it("does not report a lost Buy Box when the offers call fails", async () => {
    await runCheck(harness.ctx, ACCOUNT, "status");
    offersFail.add("B000000001");
    const result = await runCheck(harness.ctx, ACCOUNT, "status");
    assert.equal(result.ok, true);
    assert.match(result.note ?? "", /offers unavailable for 1/);
    assert.deepEqual(await changes(), []);
  });

  it("content check catches Amazon showing a different title from the one submitted", async () => {
    await runCheck(harness.ctx, ACCOUNT, "content");
    listings[0]!.title = "Steam Blend by Someone Else";
    await runCheck(harness.ctx, ACCOUNT, "content");
    const rows = (await changes()).map((r) => `${r.sku}:${r.field}`);
    assert.deepEqual(rows, ["FR-001:liveTitle", "FR-001:titleOverridden"]);
  });

  it("keeps watching content when A+ is not readable, without recording A+ as removed", async () => {
    await runCheck(harness.ctx, ACCOUNT, "content");
    aplusForbidden = true;
    const result = await runCheck(harness.ctx, ACCOUNT, "content");
    assert.equal(result.ok, true);
    assert.match(result.note ?? "", /A\+ content not readable/);
    assert.deepEqual(await changes(), []);
  });

  it("only runs for accounts with Listing Watch on and a seller ID", async () => {
    harness = createTestHarness({
      manifest,
      config: { accounts: [{ ...ACCOUNT, listingWatch: false }, { ...ACCOUNT, key: "no-seller", sellerId: undefined }] },
    });
    harness.ctx.db = { namespace: NAMESPACE, query: async () => [], execute: async () => ({ rowCount: 0 }) };
    assert.deepEqual(await runScheduledCheck(harness.ctx, "status"), []);
    assert.equal(calls.length, 0);
  });

  it("marks a check as failed, without leaking secrets, when sign-in fails", async () => {
    globalThis.fetch = (async () => json(400, { error: "invalid_grant", error_description: "bad token resolved:aaaaaaaa-0000-4000-8000-000000000003" })) as typeof fetch;
    const result = await runCheck(harness.ctx, ACCOUNT, "status");
    assert.equal(result.ok, false);
    assert.match(result.note ?? "", /EAMAZON_AUTH/);
    assert.ok(!(result.note ?? "").includes("resolved:"));
    const run = (await pg.query<{ ok: boolean }>(`SELECT ok FROM ${NAMESPACE}.listing_watch_runs`)).rows;
    assert.deepEqual(run, [{ ok: false }]);
  });

  it("agents read the change log and the last checks through a tool", async () => {
    await runCheck(harness.ctx, ACCOUNT, "status");
    listings[0]!.price = 17.99;
    await runCheck(harness.ctx, ACCOUNT, "status");
    const res = await run("amazon_list_listing_changes", { field: "ourPrice" });
    const data = res.data as { changes: Array<Record<string, unknown>>; recentChecks: unknown[] };
    assert.equal(data.changes.length, 1);
    assert.equal(data.changes[0]!.before, "USD 19.99");
    assert.equal(data.changes[0]!.after, "USD 17.99");
    assert.equal(data.recentChecks.length, 2);
  });
});

describe("snapshot helpers", () => {
  it("diffs field by field and ignores order of other sellers", () => {
    const a = statusSnapshot({ asin: "B1", status: ["DISCOVERABLE", "BUYABLE"], price: "USD 1.00" }, trimItemOffers({ Summary: { TotalOfferCount: 2 }, Offers: [{ SellerId: "X", IsBuyBoxWinner: true }, { SellerId: "Y" }] }));
    const b = statusSnapshot({ asin: "B1", status: ["BUYABLE", "DISCOVERABLE"], price: "USD 1.00" }, trimItemOffers({ Summary: { TotalOfferCount: 2 }, Offers: [{ SellerId: "Y" }, { SellerId: "X", IsBuyBoxWinner: true }] }));
    assert.deepEqual(diffSnapshots(a, b), []);
  });

  it("flags a title override only when both titles are known and differ", () => {
    assert.equal(contentSnapshot({ title: "A" }, { title: "B" }, []).titleOverridden, true);
    assert.equal(contentSnapshot({ title: "A" }, { title: "A" }, []).titleOverridden, false);
    assert.equal(contentSnapshot({}, { title: "B" }, []).titleOverridden, false);
  });
});
