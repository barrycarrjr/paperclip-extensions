import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { AmazonService, accounts, selectAccount } from "./amazon.js";
import { compatibleParams } from "./compatibility.js";
import { watchFixture, NS } from "./watchFixtures.js";
import { account, COMPANY, OTHER, REF, CREDS, MARKET, json, TOKEN } from "./fixtures.js";
import { ListingWatch } from "./watch.js";

const refs=["aaaaaaaa-0000-4000-8000-000000000001","aaaaaaaa-0000-4000-8000-000000000002","aaaaaaaa-0000-4000-8000-000000000003"];
const legacy=()=>({key:"seller",name:"Example seller",region:"na",sellerId:CREDS.sellerId,marketplaceIds:[MARKET],lwaClientIdRef:refs[0],lwaClientSecretRef:refs[1],refreshTokenRef:refs[2],allowedCompanies:[COMPANY],listingWatch:false});
test("config upgrade: serialized legacy and combined inputs survive without mutation",()=>{
  for(const config of [{defaultAccount:"seller",accounts:[legacy()]},{accounts:[account()]}]){const before=JSON.stringify(config);const loaded=JSON.parse(before);assert.equal(selectAccount(loaded,COMPANY).region,"NA");assert.equal(JSON.stringify(loaded),before);assert.equal(loaded.accounts[0].listingWatch??false,false);}
});
test("config upgrade: conflicting modes, wildcards, malformed allowlists and duplicate keys fail closed",()=>{
  for(const a of [{...legacy(),credentialsRef:REF},{...account(),allowedCompanies:["*"]},{...account(),allowedCompanies:[COMPANY,COMPANY]},{...legacy(),sellerId:undefined}])assert.throws(()=>accounts({accounts:[a]}),/ECONFIG/);
  assert.throws(()=>accounts({accounts:[legacy(),legacy()]}),/ECONFIG/);assert.throws(()=>selectAccount({accounts:[{...account(),allowedCompanies:[]}]},COMPANY),/ECOMPANY/);
});
test("legacy auth checks current company ownership for all three references including cached reads",async()=>{
  let allowed=true;const resolutions:string[]=[];const cfg={defaultAccount:"seller",accounts:[legacy()]};
  const ctx={config:{get:async()=>cfg},secrets:{resolve:async(ref:string,company?:string)=>{resolutions.push(ref);assert.equal(company,COMPANY);if(!allowed)throw Object.assign(new Error(`Secret not found: ${ref}`),{code:-32603});return [CREDS.clientId,CREDS.clientSecret,CREDS.refreshToken][refs.indexOf(ref)];}}};
  let calls=0;const service=new AmazonService(ctx as any,{send:async(url)=>{calls++;return url.hostname==="api.amazon.com"?TOKEN():json({items:[]});}});
  await service.run("test_connection",{},COMPANY);for(const ref of refs)assert.ok(resolutions.filter(r=>r===ref).length>=3);
  allowed=false;const before=calls;await assert.rejects(service.run("test_connection",{},COMPANY),/ECREDENTIALS/);assert.equal(calls,before);
});
test("list_accounts never returns credential references or raw values",async()=>{
  const f=await watchFixture();try{const out=await f.service.run("list_accounts",{},COMPANY);const text=JSON.stringify(out);assert.ok(text.includes('"key":"seller"'));for(const secret of [REF,CREDS.clientSecret,CREDS.refreshToken])assert.ok(!text.includes(secret));assert.equal(f.calls.length,0);}finally{await f.close();}
});
test("compatibility maps matching aliases and refuses unbound tokens and financial group IDs",()=>{
  assert.deepEqual(compatibleParams("list_orders",{maxResults:5,marketplaceIds:[MARKET]}),{limit:5,marketplaceId:MARKET});
  assert.deepEqual(compatibleParams("list_reports",{reportTypes:["GET_SALES_AND_TRAFFIC_REPORT"]}),{reportType:"GET_SALES_AND_TRAFFIC_REPORT"});
  for(const p of [{nextToken:"raw-example"},{settlementId:"event-group-example"},{maxResults:2,limit:2},{marketplaceIds:[MARKET,"EXAMPLE"]},{reportOptions:{}}])assert.throws(()=>compatibleParams("get_settlement",p),/ECOMPAT/);
  assert.throws(()=>compatibleParams("get_aplus_content",{asin:"B000000001",contentReferenceKey:"K-1"}),/ECOMPAT/);
});
test("historical migration bytes remain exact and forward migration preserves old snapshots and history",async()=>{
  const old=await readFile(new URL("../migrations/0001_listing_watch.sql",import.meta.url));
  assert.equal(createHash("sha256").update(old).digest("hex"),"17feca661a335401932fb49fd84c816b0e98aa2d1617661525e46223f4169237");
  const pg=new PGlite();try{await pg.exec(`CREATE SCHEMA ${NS}`);await pg.exec(old.toString());await pg.query(`INSERT INTO ${NS}.listing_snapshots (account_key,marketplace_id,sku,kind,data) VALUES ($1,$2,$3,$4,$5::jsonb)`,["seller",MARKET,"SKU-1","status",JSON.stringify({title:"Example retained baseline"})]);await pg.query(`INSERT INTO ${NS}.listing_changes (account_key,marketplace_id,sku,kind,field,before,after) VALUES ('seller',$1,'SKU-1','status','title',$2::jsonb,$3::jsonb)`,[MARKET,'"Old example"','"New example"']);const before=(await pg.query(`SELECT * FROM ${NS}.listing_snapshots`)).rows;await pg.exec(await readFile(new URL("../migrations/0002_company_watch.sql",import.meta.url),"utf8"));assert.deepEqual((await pg.query(`SELECT * FROM ${NS}.listing_snapshots`)).rows,before);assert.equal((await pg.query(`SELECT * FROM ${NS}.listing_changes`)).rows.length,1);assert.equal((await pg.query(`SELECT * FROM ${NS}.watch_changes_v2`)).rows.length,0);}finally{await pg.close();}
});
test("unowned legacy history is never returned under a matching account key",async t=>{
  const f=await watchFixture();t.after(f.close);await f.pg.exec(`INSERT INTO ${NS}.listing_changes (account_key,marketplace_id,sku,kind,field,after) VALUES ('seller','EXAMPLE','OLD-SKU','status','title','"Private historical example"'::jsonb)`);const out=await f.watch.listChanges({since:"2026-01-01T00:00:00Z"},COMPANY,f.deps.now()+50000) as any;assert.deepEqual(out.changes,[]);assert.ok(!JSON.stringify(out).includes("Private historical example"));await f.check();assert.equal((await f.pg.query(`SELECT * FROM ${NS}.listing_changes`)).rows.length,1);
});
test("reassigning an account key to a different seller cannot inherit history",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({price:12});await f.check();f.setSecret(JSON.stringify({...CREDS,sellerId:"OTHEREXAMPLESELLER"}));const out=await f.watch.listChanges({since:"2026-01-01T00:00:00Z"},COMPANY,f.deps.now()+50000) as any;assert.deepEqual(out.changes,[]);assert.deepEqual(out.recentChecks,[]);
});
test("revocation prevents jobs and history including already-issued history cursors",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({price:12});await f.check();const p={since:"2026-01-01T00:00:00Z",limit:1};const out=await f.watch.listChanges(p,COMPANY,f.deps.now()+50000) as any;assert.ok(out.nextCursor);f.setConfig({accounts:[{...account(),listingWatch:true,allowedCompanies:[OTHER]}]});const n=f.calls.length;await assert.rejects(f.watch.listChanges({...p,cursor:out.nextCursor},COMPANY,f.deps.now()+50000),/ECOMPANY/);await assert.rejects(f.check(),/ECOMPANY/);assert.equal(f.calls.length,n);
});
test("history continuation stays bound to filters and preserves whole rows",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({price:12});await f.check();const p={since:"2026-01-01T00:00:00Z",limit:1};const one=await f.watch.listChanges(p,COMPANY,f.deps.now()+50000) as any;const two=await f.watch.listChanges({...p,cursor:one.nextCursor},COMPANY,f.deps.now()+50000) as any;assert.equal(one.changes.length,1);assert.equal(two.changes.length,1);assert.notEqual(one.changes[0].id,two.changes[0].id);assert.equal(two.nextCursor,null);await assert.rejects(f.watch.listChanges({...p,sku:"SKU-1",cursor:one.nextCursor},COMPANY,f.deps.now()+50000),/ECURSOR/);
});
test("incomplete listing pages never remove unseen listings or complete a baseline",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();const before=(await f.pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows;f.set({skus:["SKU-1"],next:true,pageFails:true});await assert.rejects(f.check());assert.deepEqual((await f.pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows,before);assert.deepEqual(await f.changes(),[]);
});
test("catalog enumeration beyond its bounded capacity retains all prior snapshots",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();const before=(await f.pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows;f.set({skus:Array.from({length:2001},(_,i)=>`SKU-${i}`)});await assert.rejects(f.check(),/EINCOMPLETE/);assert.deepEqual((await f.pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows,before);
});
test("failed commit loses neither baseline nor changes; retry records each change once",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({price:12,failCommit:true});await assert.rejects(f.check());assert.deepEqual(await f.changes(),[]);f.set({failCommit:false});assert.equal((await f.check()).changes,2);assert.equal((await f.check()).changes,0);assert.equal((await f.changes()).length,2);
});
test("lost commit reply followed by retry does not duplicate history",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({price:12,lostReply:true});await assert.rejects(f.check());assert.equal((await f.changes()).length,2);assert.equal((await f.check()).changes,0);assert.equal((await f.changes()).length,2);
});
test("concurrent stale checks cannot duplicate changes or overwrite a newer snapshot",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();f.set({price:12});let count=0;let release!:()=>void;const barrier=new Promise<void>(r=>release=r);const query=f.ctx.db.query.bind(f.ctx.db);
  f.ctx.db.query=async<T>(sql:string,p?:unknown[])=>{const rows=await query<T>(sql,p);if(sql.startsWith("SELECT revision")){if(++count===2)release();await barrier;}return rows;};
  const outcomes=await Promise.allSettled([f.check(),f.check()]);assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);assert.equal((await f.changes()).length,2);assert.match(String((outcomes.find(r=>r.status==="rejected") as PromiseRejectedResult).reason),/ECONCURRENT/);
});
test("watch clock deadline is bounded without changing globals",async t=>{
  const f=await watchFixture();t.after(f.close);const before=f.calls.length;await assert.rejects(f.watch.check(COMPANY,"seller","status",MARKET,f.deps.now()-1),/EDEADLINE/);assert.equal(f.calls.length,before);
});
test("one synthetic job deadline covers authentication, pages and offers without saving partial work",async t=>{
  const f=await watchFixture();t.after(f.close);const start=f.deps.now();
  f.set({distinctAsins:true,skus:Array.from({length:20},(_,i)=>`SKU-${i}`)});
  const slow=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const result=await f.deps.send(...args);f.advance(20000);return result;}});
  const watch=new ListingWatch(f.ctx,slow,f.deps.now);
  await assert.rejects(watch.scheduled("status"),/EINCOMPLETE/);
  assert.equal(f.deps.now()-start,240000);assert.equal(f.calls.length,12);
  const rows=(await f.pg.query<any>(`SELECT complete,snapshots FROM ${NS}.watch_state_v2`)).rows;
  assert.equal(rows[0].complete,false);assert.deepEqual(rows[0].snapshots,[]);assert.deepEqual(await f.changes(),[]);
});
test("compatible legacy inventory and listing aliases preserve explicit scope",()=>{
  assert.deepEqual(compatibleParams("get_inventory_summary",{channel:"merchant",skus:["SKU-1"]}),{fulfillment:"MERCHANT",sku:"SKU-1"});
  assert.deepEqual(compatibleParams("list_listings",{pageSize:20}),{limit:20});
  for(const p of [{channel:"fba",fulfillment:"FBA"},{skus:["SKU-1","SKU-2"]}])assert.throws(()=>compatibleParams("get_inventory_summary",p),/ECOMPAT/);
});
test("redaction before cuts prevents credential text becoming snapshot data",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({secretEcho:true});await assert.rejects(f.check("content"),/EINCOMPLETE/);assert.equal((await f.changes()).length,0);assert.ok(!JSON.stringify((await f.pg.query(`SELECT * FROM ${NS}.watch_state_v2`)).rows).includes(CREDS.clientSecret));
});
test("scheduled jobs use explicit owner companies and fail honestly on denied credentials",async t=>{
  const f=await watchFixture();t.after(f.close);f.setConfig({accounts:[{...account(),listingWatch:true,allowedCompanies:[OTHER]}]});await assert.rejects(f.watch.scheduled("status"),/EINCOMPLETE/);assert.equal(f.calls.length,0);
});
