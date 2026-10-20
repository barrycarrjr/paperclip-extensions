import test from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { AmazonService } from "./amazon.js";
import { ListingWatch } from "./watch.js";
import { NS, watchFixture } from "./watchFixtures.js";
import { COMPANY, OTHER, MARKET, CREDS, account, json } from "./fixtures.js";
import { AmazonError } from "./safety.js";

const refs=["aaaaaaaa-0000-4000-8000-000000000001","aaaaaaaa-0000-4000-8000-000000000002","aaaaaaaa-0000-4000-8000-000000000003"];
const legacy=()=>({key:"seller",region:"na",sellerId:CREDS.sellerId,lwaClientIdRef:refs[0],lwaClientSecretRef:refs[1],refreshTokenRef:refs[2],marketplaceIds:[MARKET],allowedCompanies:[COMPANY],listingWatch:true});
async function monitored() {
  const f=await watchFixture();f.setConfig({accounts:[legacy()]});let total=0,max=0,trips=0;let window:number[]=[];
  f.ctx.secrets.resolve=async(ref,company)=>{assert.equal(company,COMPANY);assert.ok(refs.includes(ref));window=window.filter(t=>t>f.deps.now()-60000);window.push(f.deps.now());total++;max=Math.max(max,window.length);if(window.length>1200){trips++;throw Error("Rate limit exceeded for secret resolution");}return [CREDS.clientId,CREDS.clientSecret,CREDS.refreshToken][refs.indexOf(ref)];};
  const service=new AmazonService(f.ctx,f.deps),watch=new ListingWatch(f.ctx,service,f.deps.now);
  return {...f,service,watch,stats:()=>({total,max,trips}),check:(kind:"status"|"content"="status")=>watch.check(COMPANY,"seller",kind,MARKET)};
}
async function snapshots(f:Awaited<ReturnType<typeof watchFixture>>) {return (await f.pg.query<any>(`SELECT kind,revision,complete,snapshots FROM ${NS}.watch_state_v2 ORDER BY kind`)).rows;}
async function latest(f:Awaited<ReturnType<typeof watchFixture>>,kind="status") {return (await f.watch.listChanges({},COMPANY,f.deps.now()+50000) as any).health.find((r:any)=>r.kind===kind).latest;}

for(const size of [120,140])test(`${size} distinct-ASIN status checks never claim full coverage when the stable tail is unread`,async t=>{
  const f=await monitored();t.after(f.close);f.set({distinctAsins:true,skus:Array.from({length:size},(_,i)=>`SKU-${i}`),paged:true,latency:150});
  // Seed a genuine prior complete baseline with a caller-owned high-rate
  // synthetic provider plan, then restore Amazon's ordinary default plan.
  const fast=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const r=await f.deps.send(...args);return {...r,headers:{...r.headers,"x-amzn-ratelimit-limit":"1000"}};}});
  await new ListingWatch(f.ctx,fast,f.deps.now).check(COMPANY,"seller","status",MARKET);const before=await snapshots(f);f.advance(61000);
  const results=[];
  for(let run=0;run<2;run++){
    if(run)f.set({ours:false});const start=f.deps.now(),callStart=f.calls.length;
    await assert.rejects(f.check(),/ERATE|EDEADLINE/);
    assert.deepEqual(await snapshots(f),before);const health=await latest(f);assert.equal(health.ok,false);assert.equal(health.complete,false);assert.equal(health.enumerationComplete,true);
    const offers=health.coverage.offers,calls=f.calls.slice(callStart).filter(c=>c.url.pathname.endsWith("/offers"));
    assert.equal(offers.required,size);assert.equal(offers.read,calls.length);assert.equal(offers.providerFailures,0);assert.equal(offers.notAttemptedBudget,size-calls.length);assert.equal(offers.unavailableListings,offers.notAttemptedBudget);assert.ok(offers.notAttemptedBudget>0);
    assert.ok(!calls.some(c=>c.url.pathname.includes(`B${String(size-1).padStart(9,"0")}`)));assert.ok(f.deps.now()-start<240000);results.push({run,coverage:health.coverage,elapsed:f.deps.now()-start});f.advance(61000);
  }
  await assert.rejects(f.watch.scheduled("status"),/EINCOMPLETE/);assert.deepEqual(await snapshots(f),before);assert.deepEqual(await f.changes(),[]);assert.ok(f.stats().max<=900);assert.equal(f.stats().trips,0);
  if(process.env.AMAZON_SQL_RECEIPT)await appendFile(process.env.AMAZON_SQL_RECEIPT+".capacity",JSON.stringify({size,kind:"status",results,...f.stats()})+"\n");
});

for(const size of [40,80,100,140])test(`legacy content capacity at ${size} distinct ASINs measures actual guarded lookups`,async t=>{
  const f=await monitored();t.after(f.close);f.set({distinctAsins:true,skus:Array.from({length:size},(_,i)=>`SKU-${i}`),paged:true,latency:150,description:"D".repeat(2000),moduleText:"A".repeat(3000)});
  const start=f.deps.now();const result=await f.check("content");assert.equal(result.complete,true);assert.equal(result.degraded,false);assert.equal(result.listings,size);assert.equal(result.changes,0);assert.equal(result.coverage.catalog.read,size);assert.equal(result.coverage.aplus.read,size);assert.ok(f.stats().total<size*13+50);assert.ok(f.stats().max<=600);assert.equal(f.stats().trips,0);assert.ok(f.deps.now()-start<240000);
  if(process.env.AMAZON_SQL_RECEIPT)await appendFile(process.env.AMAZON_SQL_RECEIPT+".capacity",JSON.stringify({size,kind:"content",elapsed:f.deps.now()-start,...f.stats()})+"\n");
});

test("ordinary absent optional values are known null or empty, with no degraded baseline or later false alert",async t=>{
  const f=await watchFixture();t.after(f.close);const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const r=await f.deps.send(...args);const body=JSON.parse(r.body.toString());if(args[0].pathname.endsWith("/SELLEREXAMPLE"))for(const row of body.items){delete row.summaries[0].mainImage;delete row.offers;row.attributes={};}if(args[0].pathname.includes("/catalog/"))body.attributes={};if(args[0].pathname.includes("/items/SELLEREXAMPLE/"))body.attributes={};return json(body,r.status,r.headers);}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  for(let run=0;run<2;run++)for(const kind of ["status","content"] as const){const out=await watch.check(COMPANY,"seller",kind,MARKET);assert.equal(out.degraded,false);assert.equal(out.complete,true);assert.equal(out.changes,0);}
  const states=await snapshots(f);assert.equal(states[1].snapshots[0].data.mainImage,null);assert.equal(states[1].snapshots[0].data.ourPrice,null);assert.deepEqual(states[0].snapshots[0].data.searchTerms,[]);assert.equal(states[0].snapshots[0].data.liveDescription,null);assert.deepEqual(await f.changes(),[]);
});

test("absent attribute keys record removals and later additions, without needing explicit empty arrays",async t=>{
  const f=await watchFixture();t.after(f.close);let empty=false;
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const r=await f.deps.send(...args),body=JSON.parse(r.body.toString());if(args[0].pathname.includes("/catalog/")||args[0].pathname.includes("/items/SELLEREXAMPLE/")){if(empty)body.attributes={};else body.attributes.generic_keyword=[{value:"Example search term"}];}return json(body,r.status,r.headers);}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  await watch.check(COMPANY,"seller","content",MARKET);empty=true;const removed=await watch.check(COMPANY,"seller","content",MARKET);assert.equal(removed.complete,true);
  const changes=await f.changes();for(const field of ["submittedDescription","submittedBullets","searchTerms","liveBullets","liveDescription"])assert.ok(changes.some(c=>c.field===field&&(c.after===null||Array.isArray(c.after)&&c.after.length===0)),field);
  assert.equal((await watch.check(COMPANY,"seller","content",MARKET)).changes,0);empty=false;await watch.check(COMPANY,"seller","content",MARKET);
  const added=await f.changes();for(const field of ["searchTerms","liveBullets","submittedDescription"])assert.ok(added.some(c=>c.field===field&&(c.before===null||Array.isArray(c.before)&&c.before.length===0)&&c.after!==null),field);
});

test("a successful summary observes removed main image and price while losing BUYABLE",async t=>{
  const f=await watchFixture();t.after(f.close);let removed=false;
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const r=await f.deps.send(...args),body=JSON.parse(r.body.toString());if(removed&&body.items)for(const row of body.items){delete row.summaries[0].mainImage;row.summaries[0].status=[];delete row.offers;}return json(body,r.status,r.headers);}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  await watch.check(COMPANY,"seller","status",MARKET);removed=true;const out=await watch.check(COMPANY,"seller","status",MARKET);assert.equal(out.complete,true);assert.equal(out.degraded,false);const rows=await f.changes();for(const field of ["mainImage","ourPrice"])assert.ok(rows.some(c=>c.field===field&&c.after===null));assert.ok(rows.some(c=>c.field==="status"&&c.after.length===0));
});

test("missing attributes objects preserve prior evidence and expose real source unavailability",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check("content");const before=await snapshots(f);
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const r=await f.deps.send(...args),body=JSON.parse(r.body.toString());delete body.attributes;return json(body,r.status,r.headers);}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  const out=await watch.check(COMPANY,"seller","content",MARKET);assert.equal(out.complete,false);assert.equal(out.degraded,true);assert.equal(out.coverage.sources.missingSubmittedAttributes,2);assert.equal(out.coverage.sources.missingCatalogAttributes,2);assert.deepEqual((await snapshots(f))[0].snapshots,before[0].snapshots);assert.deepEqual(await f.changes(),[]);
  const health=(await watch.listChanges({},COMPANY,f.deps.now()+50000) as any).health[1].latest;assert.equal(health.complete,false);assert.deepEqual(health.coverage,out.coverage);
});

for(const status of [429,503])test(`optional offers HTTP ${status} is visibly unavailable once per ASIN, without a new write retry policy`,async t=>{
  const f=await watchFixture();t.after(f.close);f.set({skus:["SKU-1","SKU-2","SKU-3","SKU-4"]});await f.check();const before=await snapshots(f);let calls=0;
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{if(args[0].pathname.endsWith("/offers")){calls++;return json({},status,status===429?{"retry-after":"60"}:{});}return f.deps.send(...args);}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  const out=await watch.check(COMPANY,"seller","status",MARKET);assert.equal(out.ok,false);assert.equal(out.complete,false);assert.equal(out.enumerationComplete,true);assert.equal(out.coverage.offers.required,1);assert.equal(out.coverage.offers.providerFailures,1);assert.equal(out.coverage.offers.notAttemptedBudget,0);assert.equal(out.coverage.offers.unavailableListings,4);assert.equal(calls,1);assert.deepEqual((await snapshots(f))[0].snapshots,before[0].snapshots);assert.deepEqual(await f.changes(),[]);
  await assert.rejects(watch.scheduled("status"),/EINCOMPLETE/);const health=(await watch.listChanges({},COMPANY,f.deps.now()+50000) as any).health[0].latest;assert.equal(health.complete,false);assert.ok(health.coverage.offers.providerFailures||health.coverage.offers.notAttemptedBudget);
});

test("four SKUs share one offers/catalog/A+ read but keep their submitted reads and field changes",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({skus:["SKU-1","SKU-2","SKU-3","SKU-4"]});
  for(let run=0;run<2;run++){
    const start=f.calls.length;if(run)f.set({ours:false,description:"Example changed description",price:12});
    await f.check();await f.check("content");const calls=f.calls.slice(start);assert.equal(calls.filter(c=>c.url.pathname.endsWith("/offers")).length,1);assert.equal(calls.filter(c=>c.url.pathname.includes("/catalog/")).length,1);assert.equal(calls.filter(c=>c.url.pathname.endsWith("/contentPublishRecords")).length,1);assert.equal(calls.filter(c=>c.url.pathname.endsWith("/contentDocuments/K-1")).length,1);assert.equal(calls.filter(c=>c.url.pathname.includes("/items/SELLEREXAMPLE/")).length,4);
  }
  const rows=await f.changes();for(const field of ["buyBoxHolder","ourPrice","submittedDescription","liveDescription"])assert.equal(rows.filter(c=>c.field===field).length,4);
});

for(const mode of ["revoke","rotate"] as const)test(`cached ASIN evidence rechecks ${mode} before another SKU can consume it`,async t=>{
  const f=await watchFixture();t.after(f.close);f.set({skus:["SKU-1","SKU-2","SKU-3","SKU-4"]});let counts=0;const get=f.ctx.config.get.bind(f.ctx.config);
  // Revoke/rotate only after the first offer was read, at the cached-evidence
  // ownership check, rather than relying on another network request.
  f.ctx.config.get=async()=>{if(f.calls.some(c=>c.url.pathname.endsWith("/offers"))&&++counts===1){if(mode==="revoke")f.setConfig({accounts:[{...account(),listingWatch:true,allowedCompanies:[OTHER]}]});else f.setSecret(JSON.stringify({...CREDS,refreshToken:"rotated-example-not-real"}));}return get();};
  await assert.rejects(f.check(),mode==="revoke"?/ECOMPANY/:/ECREDENTIALS/);assert.equal(f.calls.filter(c=>c.url.pathname.endsWith("/offers")).length,1);assert.deepEqual(await f.changes(),[]);assert.equal((await snapshots(f))[0].complete,false);
});

test("empty fresh configuration is a no-op, while malformed nonempty configuration stays denied",async t=>{
  const f=await watchFixture();t.after(f.close);for(const config of [{},{accounts:[]}]){f.setConfig(config);await f.watch.scheduled("status");await f.watch.scheduled("content");}assert.equal(f.calls.length,0);assert.equal(f.resolves,0);
  for(const config of [{accounts:null},{unexpected:true},{accounts:[{...account(),allowedCompanies:["*"]}]}]){f.setConfig(config);await assert.rejects(f.watch.scheduled("status"),/ECONFIG/);}assert.equal(f.calls.length,0);
});

test("a request that actually started before its deadline is counted separately from reads never attempted",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({distinctAsins:true,skus:["SKU-1","SKU-2","SKU-3"]});
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{if(args[0].pathname.endsWith("/offers")){f.advance(240000);throw new AmazonError("ENETWORK");}return f.deps.send(...args);}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  await assert.rejects(watch.check(COMPANY,"seller","status",MARKET),/EDEADLINE/);const health=(await watch.listChanges({},COMPANY,f.deps.now()+50000) as any).health[0].latest;
  assert.equal(health.complete,false);assert.equal(health.coverage.offers.budgetFailures,1);assert.equal(health.coverage.offers.notAttemptedBudget,2);assert.equal(health.coverage.offers.providerFailures,0);assert.equal(health.coverage.offers.unavailableListings,3);assert.equal((await snapshots(f))[0].complete,false);
});

test("shared ASINs are never reused across companies, marketplaces or successive checks",async t=>{
  const f=await watchFixture();t.after(f.close);const otherRef="44444444-4444-4444-8444-444444444444";
  f.setConfig({accounts:[{...account(),listingWatch:true},{...account(),key:"other",credentialsRef:otherRef,allowedCompanies:[OTHER],marketplaceIds:[MARKET,"EXAMPLEMARKET"],listingWatch:true}]});
  f.ctx.secrets.resolve=async(ref,company)=>{assert.ok(ref===account().credentialsRef&&company===COMPANY||ref===otherRef&&company===OTHER);return JSON.stringify(CREDS);};
  for(const [company,key,market] of [[COMPANY,"seller",MARKET],[OTHER,"other",MARKET],[OTHER,"other","EXAMPLEMARKET"],[COMPANY,"seller",MARKET]]){const start=f.calls.length;await f.watch.check(company,key,"content",market);const calls=f.calls.slice(start);assert.equal(calls.filter(c=>c.url.pathname.includes("/catalog/")).length,1);assert.equal(calls.filter(c=>c.url.pathname.endsWith("/contentPublishRecords")).length,1);}
  const own=(await f.watch.listChanges({},COMPANY,f.deps.now()+50000) as any),other=(await f.watch.listChanges({account:"other"},OTHER,f.deps.now()+50000) as any);assert.equal(own.health.length,2);assert.equal(other.health.length,4);assert.ok(other.health.filter((r:any)=>r.kind==="content").every((r:any)=>r.latest.complete));assert.deepEqual(own.changes,[]);assert.deepEqual(other.changes,[]);
});

test("new stored fields establish a baseline once, then compare against observed emptiness",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check("content");await f.pg.exec(`UPDATE ${NS}.watch_state_v2 SET snapshots=(SELECT jsonb_agg(jsonb_set(s,'{data}',(s->'data')-'liveDescription')) FROM jsonb_array_elements(snapshots) s)`);
  f.set({description:"Example second description"});await f.check("content");const first=await f.changes();assert.ok(first.every(c=>c.field!=="liveDescription"));f.set({description:"Example third description"});await f.check("content");assert.equal((await f.changes()).filter(c=>c.field==="liveDescription").length,2);
});

for(const attributes of [null,[]])test(`invalid ${JSON.stringify(attributes)} attribute source cannot masquerade as an observed empty object`,async t=>{
  const f=await watchFixture();t.after(f.close);await f.check("content");const before=await snapshots(f);
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const r=await f.deps.send(...args),body=JSON.parse(r.body.toString());if(args[0].pathname.includes("/catalog/"))body.attributes=attributes;return json(body,r.status,r.headers);}});
  await assert.rejects(new ListingWatch(f.ctx,service,f.deps.now).check(COMPANY,"seller","content",MARKET),/ERESPONSE/);assert.deepEqual(await snapshots(f),before);assert.deepEqual(await f.changes(),[]);
});

test("check-local cached evidence has a byte limit even when individual records and the final snapshot fit",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check("content");const before=await snapshots(f);f.set({distinctAsins:true,skus:Array.from({length:220},(_,i)=>`SKU-${i}`),paged:true});let catalogs=0;
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const r=await f.deps.send(...args),body=JSON.parse(r.body.toString());if(args[0].pathname.includes("/catalog/")){catalogs++;body.summaries=[body.summaries[0],...Array.from({length:99},(_,i)=>({marketplaceId:`EXAMPLE${i}`,itemName:"X".repeat(220)}))];}return json(body,r.status,{...r.headers,"x-amzn-ratelimit-limit":"1000"});}});
  await assert.rejects(new ListingWatch(f.ctx,service,f.deps.now).check(COMPANY,"seller","content",MARKET),/EINCOMPLETE/);assert.ok(catalogs>100&&catalogs<220);assert.deepEqual(await snapshots(f),before);assert.deepEqual(await f.changes(),[]);
});

test("twenty structured health rows leave bounded space for whole change rows on every history page",async t=>{
  const f=await watchFixture();t.after(f.close);const markets=[MARKET,...Array.from({length:9},(_,i)=>`EXAMPLEMARKET${i}`)];f.setConfig({accounts:[{...account(),marketplaceIds:markets,listingWatch:true}]});await f.check();
  const auth=await f.service.authorize(COMPANY,"seller");const run=(await f.pg.query<any>(`SELECT note FROM ${NS}.watch_runs_v2`)).rows[0];
  for(const market of markets)for(const kind of ["status","content"])await f.pg.query(`INSERT INTO ${NS}.watch_runs_v2(scope_id,company_id,marketplace_id,kind,started_at,finished_at,ok,listings,changes,note) VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz,true,2,0,$6)`,[auth.scope,COMPANY,market,kind,new Date(f.deps.now()).toISOString(),run.note]);
  for(let i=0;i<100;i++)await f.pg.query(`INSERT INTO ${NS}.watch_changes_v2(scope_id,company_id,marketplace_id,kind,sku,field,before,after,detected_at) VALUES($1,$2,$3,'content',$4,'submittedDescription',$5::jsonb,$6::jsonb,$7::timestamptz)`,[auth.scope,COMPANY,MARKET,`SKU-${i}`,JSON.stringify("B".repeat(1000)),JSON.stringify("A".repeat(1000)),new Date(f.deps.now()).toISOString()]);
  let cursor:string|null=null;const ids=new Set();let pages=0;
  do{const page=await f.watch.listChanges({limit:100,...(cursor?{cursor}:{})},COMPANY,f.deps.now()+50000) as any;assert.ok(Buffer.byteLength(JSON.stringify(page))<=96*1024);assert.equal(page.health.length,20);assert.equal(page.recentChecks.length,20);assert.ok(page.changes.length);for(const row of page.changes){assert.equal(row.before.length,1000);assert.equal(row.after.length,1000);assert.ok(!ids.has(row.id));ids.add(row.id);}cursor=page.nextCursor;pages++;assert.ok(pages<20);}while(cursor);assert.equal(ids.size,100);assert.ok(pages>1);
});

test("revocation during the completion activity await prevents the final check result",async t=>{
  const f=await watchFixture();t.after(f.close);const log=f.ctx.activity.log.bind(f.ctx.activity);
  f.ctx.activity.log=async value=>{await log(value);if(value.metadata?.outcome==="succeeded")f.setConfig({accounts:[{...account(),listingWatch:true,allowedCompanies:[OTHER]}]});};
  await assert.rejects(f.check(),/ECOMPANY/);const rows=(await f.pg.query<any>(`SELECT ok,note FROM ${NS}.watch_runs_v2`)).rows;assert.equal(rows.length,2);assert.ok(rows.some(r=>r.ok===false&&JSON.parse(r.note).error==="ECOMPANY"));assert.deepEqual(await f.changes(),[]);
});
