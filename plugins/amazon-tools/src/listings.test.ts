// Adapted 0.2.0 listing/diff/watch scenarios run through the reviewed service.
import test from "node:test";
import assert from "node:assert/strict";
import { watchFixture, ASIN } from "./watchFixtures.js";
import { COMPANY, OTHER, MARKET, account, CREDS } from "./fixtures.js";
import { assertRequest } from "./requestGuard.js";
import { contentSnapshot, diffSnapshots, statusSnapshot } from "./listings.js";

test("legacy: allows the new reads",()=>{
  for(const [op,path] of [["searchListingsItems","/listings/2021-08-01/items/SELLEREXAMPLE"],["getCatalogItem",`/catalog/2022-04-01/items/${ASIN}`],["getItemOffers",`/products/pricing/v0/items/${ASIN}/offers`],["searchContentPublishRecords","/aplus/2020-11-01/contentPublishRecords"],["getContentDocument","/aplus/2020-11-01/contentDocuments/K-1"]])assert.doesNotThrow(()=>assertRequest(op,"GET",path));
});
test("legacy: blocks listing, price, A+ writes and arbitrary paths",()=>{
  for(const method of ["POST","PUT","PATCH","DELETE"])for(const path of ["/listings/2021-08-01/items/SELLEREXAMPLE/SKU-1","/aplus/2020-11-01/contentDocuments","/batches/products/pricing/v0/itemOffers","https://example.com/"])assert.throws(()=>assertRequest("getListingsItem",method,path),/EWRITE_BLOCKED/);
  assert.throws(()=>assertRequest("createReport","POST","/reports/2021-06-30/reports"),/EWRITE_BLOCKED/);
});
test("legacy: every listing tool reaches Amazon with GET only",async t=>{
  const f=await watchFixture();t.after(f.close);
  for(const [op,p] of [["list_listings",{}],["get_listing",{sku:"SKU-1"}],["get_catalog_item",{asin:ASIN}],["get_item_offers",{asin:ASIN}],["get_aplus_content",{asin:ASIN}]] as const)await f.service.run(op,p,COMPANY);
  assert.ok(f.calls.length>=6);assert.ok(f.calls.filter(c=>c.url.hostname!=="api.amazon.com").every(c=>c.method==="GET"));
  await assert.rejects(f.service.read("request_report",{},COMPANY,f.deps.now()+50000),/EWRITE_BLOCKED/);
});
test("legacy: lists listings with status, price and safe issues",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({status:[]});const out=await f.service.run("list_listings",{},COMPANY) as any;
  assert.equal(out.listings.length,2);assert.equal(out.listings[0].offers[0].price.amount,10);assert.equal(out.listings[0].issues[0].code,"EXAMPLE");assert.equal(out.listings[0].issues[0].message,undefined);
});
test("legacy: says who holds the Buy Box without location data",async t=>{
  const f=await watchFixture();t.after(f.close);const out=await f.service.run("get_item_offers",{asin:ASIN},COMPANY) as any;
  assert.equal(out.offers.Offers[0].MyOffer,true);assert.equal(out.offers.Offers[0].ShipsFrom,undefined);
});
test("legacy: requires seller ID in legacy credentials before listing calls",async t=>{
  const f=await watchFixture();t.after(f.close);f.setSecret(JSON.stringify({...CREDS,sellerId:undefined}));await assert.rejects(f.service.run("list_listings",{},COMPANY),/ECREDENTIALS/);assert.equal(f.calls.length,0);
});
test("legacy: rejects malformed ASIN before calling Amazon",async t=>{
  const f=await watchFixture();t.after(f.close);for(const asin of ["../bad","bad","B000000001/extra"])await assert.rejects(f.service.run("get_item_offers",{asin},COMPANY),/EINPUT/);assert.equal(f.calls.length,0);
});
test("legacy: refuses another company including change history",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();await assert.rejects(f.service.run("list_listings",{},OTHER),/ECOMPANY/);await assert.rejects(f.watch.listChanges({since:"2026-01-01T00:00:00Z"},OTHER,f.deps.now()+50000),/ECOMPANY/);
});
test("legacy: saves baseline then only actual field changes",async t=>{
  const f=await watchFixture();t.after(f.close);assert.equal((await f.check()).changes,0);f.set({status:[],price:11,ours:false});const second=await f.check();const rows=await f.changes();
  for(const name of ["status","issues","ourPrice","buyBoxHolder","buyBoxPrice","offerCount","otherSellers"])assert.ok(rows.some(r=>r.field===name),name);assert.equal(second.changes,14);
  assert.equal((await f.check()).changes,0);assert.equal((await f.changes()).length,14);
});
test("legacy: records added and removed listings after the baseline",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({skus:["SKU-1","SKU-3"]});await f.check();assert.deepEqual((await f.changes()).map(r=>`${r.sku}:${r.field}:${r.after}`),["SKU-2:listing:removed","SKU-3:listing:added"]);
});
test("legacy: failed offers preserve previous Buy Box values",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({offersFail:true});const out=await f.check();assert.equal(out.degraded,true);assert.deepEqual(await f.changes(),[]);
});
test("legacy: detects submitted versus live title differences",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check("content");f.set({title:"Example changed live title"});await f.check("content");assert.deepEqual((await f.changes()).map(r=>r.field),["liveTitle","titleOverridden","liveTitle","titleOverridden"]);
});
test("legacy: missing A+ preserves previous A+ values",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check("content");f.set({aplusFail:true});assert.equal((await f.check("content")).degraded,true);assert.deepEqual(await f.changes(),[]);
});
test("legacy: scheduled checks leave disabled accounts off",async t=>{
  const f=await watchFixture();t.after(f.close);f.setConfig({accounts:[{...account(),listingWatch:false}]});await f.watch.scheduled("status");assert.equal(f.calls.length,0);await assert.rejects(f.check(),/ECOMPANY/);
});
test("legacy: sign-in failure fails check without leaking secrets",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({signFail:true});await assert.rejects(f.check(),/EAUTH/);assert.deepEqual(await f.changes(),[]);assert.ok(!JSON.stringify(f.logs).includes(CREDS.clientSecret));
});
test("legacy: reads changes and recent checks with current authorization",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({price:12});await f.check();const out=await f.watch.listChanges({since:"2026-01-01T00:00:00Z",marketplaceId:MARKET},COMPANY,f.deps.now()+50000) as any;assert.equal(out.changes.length,2);assert.equal(out.recentChecks.length,1);assert.equal(out.health.length,2);assert.equal(out.health.find((r:any)=>r.kind==="content").latest,null);
});
test("legacy: field diffs ignore the order of other sellers",()=>{
  const listing={sku:"SKU-1",status:["DISCOVERABLE","BUYABLE"]};const a=statusSnapshot(listing,{offers:[{sellerId:"EXAMPLEA"},{sellerId:"EXAMPLEB"}]});const b=statusSnapshot(listing,{offers:[{sellerId:"EXAMPLEB"},{sellerId:"EXAMPLEA"}]});assert.deepEqual(diffSnapshots(a,b),[]);
});
test("legacy: title override requires two known different titles",()=>{
  assert.equal(contentSnapshot({title:"Submitted"},{title:"Live"},[]).titleOverridden,true);assert.equal(contentSnapshot({title:"Submitted"},{},[]).titleOverridden,false);
});
