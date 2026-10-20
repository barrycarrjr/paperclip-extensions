import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { AmazonService } from "./amazon.js";
import { watchModuleFingerprint } from "./aplus.js";
import { redactor } from "./safety.js";
import { ListingWatch } from "./watch.js";
import { NS, watchFixture } from "./watchFixtures.js";
import { COMPANY, OTHER, CREDS, MARKET, account, json, fixture } from "./fixtures.js";
import { compatibleParams } from "./compatibility.js";
import { validateParams } from "./worker.js";
import manifest, { TOOLS } from "./manifest.js";

// Declared A+ 2020-11-01 model shapes: standard comparison allows six
// products and ten metrics; premium scroller allows seven products and twelve
// rows. These ordinary examples exceed the public fifty-text display limit.
function comparisonTable() {
  return {contentModuleType:"STANDARD_COMPARISON_TABLE",standardComparisonTable:{
    productColumns:Array.from({length:6},(_,p)=>({position:p+1,title:`Product ${p+1}`,metrics:Array.from({length:9},(_,r)=>({position:r+1,value:`Product ${p+1} metric ${r+1}`}))})),
    metricRowLabels:Array.from({length:9},(_,r)=>({position:r+1,value:`Metric ${r+1}`})),
  }};
}
function comparisonScroller() {
  return {contentModuleType:"PREMIUM_COMPARISON_SCROLLER",premiumComparisonScroller:{
    headline:{value:"Example comparison"},
    comparisonProducts:Array.from({length:7},(_,p)=>({comparisonProduct:{position:p+1,productTitle:{value:`Product ${p+1}`},productAsin:{value:`B${String(p).padStart(9,"0")}`}}})),
    comparisonRows:Array.from({length:6},(_,r)=>({comparisonRow:{position:r+1,metricName:{value:`Metric ${r+1}`},comparisonFields:Array.from({length:7},(_,p)=>({comparisonField:{position:p+1,value:`Product ${p+1} metric ${r+1}`}}))}})),
  }};
}

const refs=["aaaaaaaa-0000-4000-8000-000000000001","aaaaaaaa-0000-4000-8000-000000000002","aaaaaaaa-0000-4000-8000-000000000003"];
const legacy=(marketplaceIds=[MARKET])=>({key:"seller",region:"na",sellerId:CREDS.sellerId,lwaClientIdRef:refs[0],lwaClientSecretRef:refs[1],refreshTokenRef:refs[2],marketplaceIds,allowedCompanies:[COMPANY],listingWatch:true});
async function limitedWatch() {
  const f=await watchFixture();f.setConfig({accounts:[legacy()]});
  let window:number[]=[],max=0,total=0,trips=0,revoked=false;
  f.ctx.secrets.resolve=async(ref,company)=>{
    assert.equal(company,COMPANY);assert.ok(refs.includes(ref));
    window=window.filter(t=>t>f.deps.now()-60000);window.push(f.deps.now());max=Math.max(max,window.length);total++;
    if(window.length>1200){trips++;throw Error("Rate limit exceeded for secret resolution");}
    if(revoked)throw Error(`Secret not found: ${ref}`);
    return [CREDS.clientId,CREDS.clientSecret,CREDS.refreshToken][refs.indexOf(ref)];
  };
  const service=new AmazonService(f.ctx,f.deps),watch=new ListingWatch(f.ctx,service,f.deps.now);
  return {...f,service,watch,stats:()=>({max,total,trips}),revoke:()=>revoked=true,check:(kind:"status"|"content"="status",market=MARKET)=>watch.check(COMPANY,"seller",kind,market)};
}
for(const size of [41,80]) for(const kind of ["status","content"] as const) test(`${size}-listing legacy ${kind} baseline and later change stay within real pacing, deadline and secret window`,async t=>{
  const f=await limitedWatch();t.after(f.close);f.set({distinctAsins:true,skus:Array.from({length:size},(_,i)=>`SKU-${i}`),paged:true,description:"D".repeat(2000),moduleText:"A".repeat(3000),latency:150});
  const started=f.deps.now();const first=await f.check(kind);assert.equal(first.listings,size);assert.equal(first.changes,0);assert.ok(f.deps.now()-started<240000);
  const count=f.stats().total;assert.ok(count < size*28+50,`duplicate lookups: ${count}`);assert.ok(f.stats().max<=600);assert.equal(f.stats().trips,0);
  f.advance(61000);f.set(kind==="status"?{price:13}:{description:"D".repeat(1999)+"X",moduleText:"A".repeat(2999)+"Y"});
  const changed=await f.check(kind);assert.ok(changed.changes>=size);assert.equal((await f.check(kind)).changes,0);
  assert.ok(f.stats().max<=600);assert.equal(f.stats().trips,0);
  await f.service.run("get_listing",{sku:"SKU-0"},COMPANY);assert.ok(f.stats().max<=900);assert.equal(f.stats().trips,0);
  if(process.env.AMAZON_SQL_RECEIPT)await appendFile(process.env.AMAZON_SQL_RECEIPT+".quota",JSON.stringify({size,kind,elapsed:f.deps.now()-started,...f.stats()})+"\n");
});

test("two marketplaces share the secret budget without tripping the host backstop",async t=>{
  const f=await limitedWatch();t.after(f.close);f.setConfig({accounts:[legacy([MARKET,"EXAMPLEMARKET"])]});f.set({distinctAsins:true,skus:Array.from({length:40},(_,i)=>`SKU-${i}`),paged:true,latency:150,description:"D".repeat(2000)});
  await f.watch.scheduled("content");assert.ok(f.stats().max<=600);assert.equal(f.stats().trips,0);
  const health=await f.watch.listChanges({},COMPANY,f.deps.now()+50000) as any;assert.equal(health.health.length,4);assert.equal(health.health.filter((r:any)=>r.kind==="content"&&r.latest?.ok).length,2);assert.ok(health.health.filter((r:any)=>r.kind==="status").every((r:any)=>r.latest===null));
});

test("two companies cannot use each other's credentials and rejected initial auth still emits fixed health",async t=>{
  const f=await limitedWatch();t.after(f.close);f.setConfig({accounts:[{...legacy(),allowedCompanies:[COMPANY,OTHER]}]});await assert.rejects(f.watch.scheduled("status"),/EINCOMPLETE/);
  assert.ok(f.logs.some((v:any)=>v.companyId===OTHER&&v.metadata?.outcome==="failed"));
  const before=f.calls.length;await assert.rejects(f.watch.listChanges({},OTHER,f.deps.now()+50000));assert.equal(f.calls.length,before);
});

for(const length of [1501,2000,3000])test(`watch compares full ${length}-character text while public reads keep their bounds`,async t=>{
  const f=await watchFixture();t.after(f.close);f.set({description:"D".repeat(length),moduleText:"A".repeat(length)});assert.equal((await f.check("content")).changes,0);
  const tool=await f.service.run("get_listing",{sku:"SKU-1"},COMPANY) as any;assert.equal(tool.truncated,true);assert.equal(tool.listing.attributes.product_description[0].value.length,1500);
  f.set({description:"D".repeat(length-1)+"X",moduleText:"A".repeat(length-1)+"Y"});await f.check("content");const changes=await f.changes();assert.ok(changes.some((r:any)=>r.field==="submittedDescription"));assert.ok(changes.some((r:any)=>r.field==="liveDescription"));assert.ok(changes.some((r:any)=>r.field==="aplus"));assert.equal((await f.check("content")).changes,0);
});

test("ASIN-less and summary-less listings preserve unknown live/status evidence without false removals",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();await f.check("content");const before=(await f.pg.query<any>(`SELECT kind,snapshots FROM ${NS}.watch_state_v2 ORDER BY kind`)).rows;
  f.set({noAsin:true,noSummary:true});assert.equal((await f.check()).degraded,true);assert.equal((await f.check("content")).degraded,true);
  const after=(await f.pg.query<any>(`SELECT kind,snapshots FROM ${NS}.watch_state_v2 ORDER BY kind`)).rows;
  for(let i=0;i<before.length;i++)assert.deepEqual(after[i].snapshots.map((r:any)=>r.data),before[i].snapshots.map((r:any)=>r.data));assert.deepEqual(await f.changes(),[]);
  const fresh=await watchFixture();t.after(fresh.close);fresh.set({noAsin:true,noSummary:true});await fresh.check("content");const row=(await fresh.pg.query<any>(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows[0].snapshots[0].data;assert.ok(!Object.hasOwn(row,"liveTitle"));assert.ok(!Object.hasOwn(row,"aplus"));
});

test("revocation or rotation while awaiting pacing prevents the next outbound request",async t=>{
  for(const mode of ["revoke","rotate"]){const f=await watchFixture();t.after(f.close);f.set({distinctAsins:true});let waited=false;const deps={...f.deps,sleep:async(ms:number)=>{f.advance(ms);waited=true;if(mode==="revoke")f.setConfig({accounts:[{...account(),allowedCompanies:[OTHER],listingWatch:true}]});else f.setSecret(JSON.stringify({...CREDS,refreshToken:"rotated-example-not-real"}));}};
    const service=new AmazonService(f.ctx,deps),watch=new ListingWatch(f.ctx,service,f.deps.now);await assert.rejects(watch.check(COMPANY,"seller","status",MARKET),mode==="revoke"?/ECOMPANY/:/ECREDENTIALS/);assert.equal(waited,true);assert.equal(f.calls.filter(c=>c.url.pathname.endsWith("/offers")).length,1);const runs=(await f.pg.query<any>(`SELECT ok,note FROM ${NS}.watch_runs_v2`)).rows;assert.equal(runs.length,1);assert.equal(runs[0].ok,false);}
});

test("failed secret resolution after authorization writes a sanitized failure receipt without another privileged read",async t=>{
  const f=await limitedWatch();t.after(f.close);let n=0;const original=f.ctx.secrets.resolve;f.ctx.secrets.resolve=async(...args)=>{if(++n>6)throw Error("Rate limit exceeded for secret resolution");return original(...args);};
  await assert.rejects(f.check(),/EHOST/);const runs=(await f.pg.query<any>(`SELECT ok,note FROM ${NS}.watch_runs_v2`)).rows;assert.equal(runs[0].ok,false);assert.equal(JSON.parse(runs[0].note).error,"EHOST");assert.equal((await f.pg.query(`SELECT * FROM ${NS}.watch_changes_v2`)).rows.length,0);
});

test("revocation immediately before commit and before history return refuses results",async t=>{
  const f=await watchFixture();t.after(f.close);const authorize=f.service.authorize.bind(f.service);f.service.authorize=async(...args)=>{const auth=await authorize(...args),ensure=auth.ensureCurrent;auth.ensureCurrent=async(until?:number)=>{if(until===undefined)f.setConfig({accounts:[{...account(),listingWatch:true,allowedCompanies:[OTHER]}]});await ensure(until);};return auth;};
  await assert.rejects(f.check(),/ECOMPANY/);assert.deepEqual(await f.changes(),[]);assert.equal((await f.pg.query<any>(`SELECT complete FROM ${NS}.watch_state_v2`)).rows[0].complete,false);
  f.setConfig({accounts:[{...account(),listingWatch:true}]});await assert.rejects(f.watch.listChanges({},COMPANY,f.deps.now()+50000),/ECOMPANY/);
});

test("forged or different-company authorized handles cannot enter the internal watch path",async t=>{
  const f=await watchFixture();t.after(f.close);await assert.rejects(f.service.read("get_listing",{sku:"SKU-1",account:"seller"},COMPANY,f.deps.now()+50000,{} as any),/ECOMPANY/);
  const auth=await f.service.authorize(COMPANY,"seller");await assert.rejects(f.service.read("get_listing",{sku:"SKU-1",account:"seller"},OTHER,f.deps.now()+50000,auth),/ECOMPANY/);await assert.rejects(f.service.read("request_report",{},COMPANY,f.deps.now()+50000,auth),/EWRITE_BLOCKED/);assert.equal(f.calls.length,0);
});

test("safe legacy aliases normalize before strict validation and conflicts fail closed",()=>{
  const validate=(op:string,p:any)=>validateParams(compatibleParams(op,p),TOOLS.find(t=>t.name===`amazon_${op}`)!);
  assert.deepEqual(validate("get_order",{orderId:"111-1234567-1234567",includeItems:true}),{orderId:"111-1234567-1234567"});assert.throws(()=>validate("get_order",{orderId:"111-1234567-1234567",includeItems:false}),/ECOMPAT/);
  assert.deepEqual(validate("list_reports",{reportType:"GET_SALES_AND_TRAFFIC_REPORT",pageSize:10}),{reportType:"GET_SALES_AND_TRAFFIC_REPORT",limit:10});assert.throws(()=>validate("list_reports",{pageSize:10,limit:10}),/ECOMPAT/);
  for(const limit of [101,500])assert.equal(validate("get_report",{reportId:"REPORTEXAMPLE",limit}).limit,100);assert.throws(()=>validate("get_report",{reportId:"REPORTEXAMPLE",limit:501}),/EINPUT/);
});

test("an overlapping history reread recovers a row committed after the earlier watermark read",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();const first=await f.watch.listChanges({},COMPANY,f.deps.now()+50000) as any;
  const auth=await f.service.authorize(COMPANY,"seller");await f.pg.query(`INSERT INTO ${NS}.watch_changes_v2 (scope_id,company_id,marketplace_id,kind,sku,field,before,after,detected_at) VALUES ($1,$2,$3,'status','LATE-SKU','ourPrice','10'::jsonb,'12'::jsonb,$4::timestamptz)`,[auth.scope,COMPANY,MARKET,new Date(Date.parse(first.through)-1000).toISOString()]);f.advance(2000);
  const normal=await f.watch.listChanges({since:first.through},COMPANY,f.deps.now()+50000) as any;assert.equal(normal.changes.length,0);
  const replay=await f.watch.listChanges({since:new Date(Date.parse(first.through)-600000).toISOString()},COMPANY,f.deps.now()+50000) as any;assert.equal(replay.changes[0].sku,"LATE-SKU");assert.equal(new Set([...replay.changes,...replay.changes].map((c:any)=>c.id)).size,1);
});

test("templates parse and their declared change-log example matches the actual tool contract",async()=>{
  const require=createRequire(import.meta.url),yaml=require('js-yaml');
  for(const file of ["skills/listing-watch/SKILL.md","agents/listing-watch/AGENT.md","bundles/listing-watch/BUNDLE.md","routines/listing-watch-review/ROUTINE.md","routines/listing-watch-digest/ROUTINE.md"]){const body=await readFile(new URL('../../../'+file,import.meta.url),'utf8');const match=/^---\r?\n([\s\S]*?)\r?\n---/.exec(body);assert.ok(match);const front=yaml.load(match[1]);assert.equal(front.name,file.includes('digest')?'listing-watch-digest':file.includes('review')?'listing-watch-review':'listing-watch');assert.ok(!body.includes('limit` 500'));assert.match(body,/health/);}
  const skill=await readFile(new URL("../../../skills/listing-watch/SKILL.md",import.meta.url),"utf8");const p=JSON.parse(/```json\n([^`]+)```/.exec(skill)![1]);validateParams(p,TOOLS.find(t=>t.name==='amazon_list_listing_changes')!);assert.equal(manifest.capabilities.length,9);
});
test("watch lookup waits leave room for an interactive call and recheck revocation after waiting",async t=>{
  for(const revoke of [false,true]){const f=await limitedWatch();t.after(f.close);f.set({distinctAsins:true,skus:Array.from({length:100},(_,i)=>`SKU-${i}`),paged:true});let interleaved=false;let service:AmazonService;
    service=new AmazonService(f.ctx,{...f.deps,sleep:async(ms:number)=>{if(ms>10000&&!interleaved){interleaved=true;const result=await service.run("get_listing",{sku:"SKU-0"},COMPANY);assert.ok(result.listing);if(revoke)f.revoke();}f.advance(ms);}});
    const watch=new ListingWatch(f.ctx,service,f.deps.now);if(revoke)await assert.rejects(watch.check(COMPANY,"seller","content",MARKET),/ECREDENTIALS/);else assert.equal((await watch.check(COMPANY,"seller","content",MARKET)).listings,100);
    assert.equal(interleaved,true);assert.ok(f.stats().max<=900);assert.equal(f.stats().trips,0);if(revoke){assert.equal((await f.pg.query<any>(`SELECT complete FROM ${NS}.watch_state_v2`)).rows[0].complete,false);assert.equal(JSON.parse((await f.pg.query<any>(`SELECT note FROM ${NS}.watch_runs_v2`)).rows.at(-1).note).error,"ECREDENTIALS");}
  }
});

test("multiple authorized companies share one lookup window and later targets make fair progress",async t=>{
  const f=await watchFixture();t.after(f.close);const otherRefs=refs.map(s=>s.replace('aaaaaaaa','bbbbbbbb'));
  f.setConfig({accounts:[legacy(),{...legacy(),key:"other",allowedCompanies:[OTHER],lwaClientIdRef:otherRefs[0],lwaClientSecretRef:otherRefs[1],refreshTokenRef:otherRefs[2]}]});
  let times:number[]=[],max=0,trips=0;
  f.ctx.secrets.resolve=async(ref,company)=>{const expected=company===COMPANY?refs:otherRefs;assert.ok(expected.includes(ref));times=times.filter(v=>v>f.deps.now()-60000);times.push(f.deps.now());max=Math.max(max,times.length);if(times.length>1200){trips++;throw Error("Rate limit exceeded for secret resolution");}return [CREDS.clientId,CREDS.clientSecret,CREDS.refreshToken][expected.indexOf(ref)];};
  f.set({distinctAsins:true,skus:Array.from({length:80},(_,i)=>`SKU-${i}`),paged:true,latency:500});const service=new AmazonService(f.ctx,f.deps),watch=new ListingWatch(f.ctx,service,f.deps.now);
  await assert.rejects(watch.scheduled("content"),/EINCOMPLETE/);assert.equal(trips,0);assert.ok(max<=600);
  await assert.rejects(watch.scheduled("content"),/EINCOMPLETE/);const states=(await f.pg.query<any>(`SELECT company_id,complete,snapshots FROM ${NS}.watch_state_v2`)).rows;assert.ok(states.some(r=>r.company_id===COMPANY&&r.complete&&r.snapshots.length===80));assert.ok(states.some(r=>r.company_id===OTHER&&r.complete&&r.snapshots.length===80));
  const own=await watch.listChanges({},COMPANY,f.deps.now()+50000) as any,other=await watch.listChanges({account:"other"},OTHER,f.deps.now()+50000) as any;assert.equal(own.health[1].latest.ok,false);assert.equal(other.health[1].latest.listings,80);assert.ok(max<=900);assert.equal(trips,0);
});

test("oversized enumeration payload and 100-page bound preserve the prior completed snapshot",async t=>{
  const f=await watchFixture();t.after(f.close);await f.check();const before=(await f.pg.query<any>(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows;
  let page=0;const dense=Array.from({length:50},(_,i)=>({code:`CODE-${i}-`+"X".repeat(600),severity:"WARNING"}));
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>args[0].hostname==="api.amazon.com"?f.deps.send(...args):json({items:Array.from({length:20},(_,i)=>({...f.listing(`BIG-${page}-${i}`),issues:dense})),pagination:{nextToken:String(++page)}})});
  const watch=new ListingWatch(f.ctx,service,f.deps.now);await assert.rejects(watch.check(COMPANY,"seller","status",MARKET),/EINCOMPLETE/);assert.deepEqual((await f.pg.query<any>(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows,before);assert.deepEqual(await f.changes(),[]);
});

test("watch fingerprints preserve surrogate pairs and reject reflected credentials beyond the prefix",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({description:"X".repeat(899)+"😀"+"Z".repeat(1100)});await f.check("content");const state=(await f.pg.query<any>(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows[0].snapshots;assert.ok(state[0].data.submittedDescription.includes('sha256:'));assert.ok(!state[0].data.submittedDescription.includes('\ufffd'));
  f.set({description:"X".repeat(1900)+CREDS.clientSecret});await assert.rejects(f.check("content"),/EINCOMPLETE/);assert.deepEqual((await f.pg.query<any>(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows[0].snapshots,state);
});

test("public report aliases retain every row across clamped offsets and report-list cursors",async()=>{
  const rows=Array.from({length:150},(_,i)=>`SKU-${i}\t${i}`);const f=fixture(c=>{
    if(c.url.pathname.endsWith('/documents/DOC'))return json({url:"https://synthetic.s3.amazonaws.com/report"});
    if(c.url.hostname.endsWith('s3.amazonaws.com'))return {status:200,headers:{},body:Buffer.from('sku\tquantity\n'+rows.join('\n'))};
    if(c.url.pathname.endsWith('/reports/REPORT'))return json({reportId:'REPORT',reportType:'GET_FLAT_FILE_OPEN_LISTINGS_DATA',marketplaceIds:[MARKET],processingStatus:'DONE',reportDocumentId:'DOC'});
    return json({reports:[{reportId:c.url.searchParams.has('nextToken')?'SECOND':'FIRST',reportType:'GET_FLAT_FILE_OPEN_LISTINGS_DATA',marketplaceIds:[MARKET]}],...(c.url.searchParams.has('nextToken')?{}:{nextToken:'private-next-example'})});
  });
  const op='get_report',p=compatibleParams(op,{reportId:'REPORT',limit:500});validateParams(p,TOOLS.find(t=>t.name==='amazon_'+op)!);const first=await f.service.run(op,p,COMPANY) as any;assert.equal(first.rows.length,100);assert.equal(first.nextOffset,100);const second=await f.service.run(op,{...p,offset:first.nextOffset},COMPANY) as any;assert.equal(second.rows.length,50);assert.equal(second.nextOffset,null);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.sku)).size,150);
  const query=compatibleParams('list_reports',{reportType:'GET_FLAT_FILE_OPEN_LISTINGS_DATA',pageSize:1});const page=await f.service.run('list_reports',query,COMPANY) as any;const next=await f.service.run('list_reports',{...query,cursor:page.nextCursor},COMPANY) as any;assert.equal(next.reports[0].reportId,'SECOND');assert.equal(f.calls.at(-1)!.url.searchParams.toString(),'nextToken=private-next-example');
});

test("large legacy ASIN A+ aggregates return actionable ECOMPAT without extending output bounds",async()=>{
  const f=fixture(c=>c.url.pathname.endsWith('/contentPublishRecords')?json({publishRecordList:[{contentReferenceKey:'K1'},{contentReferenceKey:'K2'}]}):json({contentRecord:{contentReferenceKey:c.url.pathname.split('/').at(-1),contentMetadata:{name:'Example'},contentDocument:{contentModuleList:Array.from({length:45},()=>({contentModuleType:'STANDARD_TEXT',standardText:{headline:{value:'X'.repeat(1400)}}}))}}}));
  await assert.rejects(f.service.run('get_aplus_content',{asin:'B000000001'},COMPANY),e=>/ECOMPAT/.test(String(e))&&/contentReferenceKey/.test(String(e)));
});

test("missing attribute sources retain evidence while explicit empty attribute arrays record a real change",async t=>{
  const f=await watchFixture();t.after(f.close);let mode='full';const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const result=await f.deps.send(...args);if(mode!=='full'&&(args[0].pathname.includes('/catalog/')||args[0].pathname.includes('/items/SELLEREXAMPLE/'))){const body=JSON.parse(result.body.toString());if(mode==='missing')delete body.attributes;else body.attributes={item_name:[],bullet_point:[],product_description:[],generic_keyword:[]};return json(body);}return result;}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  await watch.check(COMPANY,'seller','content',MARKET);mode='missing';assert.equal((await watch.check(COMPANY,'seller','content',MARKET)).changes,0);mode='empty';await watch.check(COMPANY,'seller','content',MARKET);const changes=await f.changes();assert.ok(changes.some((c:any)=>c.field==='submittedDescription'&&c.after===null));assert.ok(changes.some((c:any)=>c.field==='submittedBullets'&&Array.isArray(c.after)&&!c.after.length));
});
test("a slow configuration reply after a quota wait cannot spend expired reservations",async t=>{
  const f=await limitedWatch();t.after(f.close);let waited=false,delayed=false;const getConfig=f.ctx.config.get.bind(f.ctx.config);
  const service=new AmazonService(f.ctx,{...f.deps,sleep:async(ms:number)=>{f.advance(ms);waited=true;}});
  f.ctx.config.get=async()=>{const config=await getConfig();if(waited&&!delayed){delayed=true;f.advance(61000);for(let i=0;i<200;i++)await service.authorize(COMPANY,'seller',f.deps.now()+240000,true);}return config;};
  for(let i=0;i<200;i++)await service.authorize(COMPANY,'seller',f.deps.now()+240000,true);
  const start=f.deps.now();await service.authorize(COMPANY,'seller',start+240000,true);assert.equal(delayed,true);assert.ok(f.deps.now()-start>180000);assert.ok(f.stats().max<=600);assert.equal(f.stats().trips,0);assert.equal(f.calls.length,0);
});


test("A+ baseline and status, name, text and image edits retain exact before/after history",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({skus:["SKU-1"]});
  assert.equal((await f.check("content")).changes,0);
  const stored=async()=>(await f.pg.query<any>(`SELECT snapshots FROM ${NS}.watch_state_v2 WHERE kind='content'`)).rows[0].snapshots[0].data.aplus;
  let before=await stored();assert.match(before[0],/^Example content \[APPROVED\] [a-f0-9]+$/);
  const steps=[{aplusStatus:"REJECTED"},{aplusName:"Renamed example"},{moduleText:"Edited text"},{imageUpload:"example-upload-2"}];
  for(let i=0;i<steps.length;i++){
    f.advance(1000);f.set(steps[i]);const r=await f.check("content");assert.equal(r.complete,true);assert.equal(r.changes,1);
    const after=await stored(),rows=await f.changes();assert.equal(rows.length,i+1);assert.ok(rows.every((r:any)=>r.field==="aplus"));
    assert.ok(rows.some((r:any)=>JSON.stringify(r.before)===JSON.stringify(before)&&JSON.stringify(r.after)===JSON.stringify(after)));
    if(i===0)assert.match(after[0],/\[REJECTED\]/);if(i===1)assert.match(after[0],/^Renamed example /);
    const history=await f.watch.listChanges({field:"aplus"},COMPANY,f.deps.now()+50000) as any;
    assert.equal(history.changes.length,i+1);assert.ok(history.changes.some((r:any)=>JSON.stringify(r.before)===JSON.stringify(before)&&JSON.stringify(r.after)===JSON.stringify(after)));
    assert.ok(!JSON.stringify([after,history]).includes("example-upload-"));
    before=after;assert.equal((await f.check("content")).changes,0);
  }
});

test("A+ name falls back to content document name only when metadata has no name",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({skus:["SKU-1"],metadataName:false,documentName:"Fallback example"});
  await f.check("content");const rows=(await f.pg.query<any>(`SELECT snapshots FROM ${NS}.watch_state_v2`)).rows;
  assert.match(rows[0].snapshots[0].data.aplus[0],/^Fallback example \[APPROVED\]/);
});

test("A+ image fingerprint reads complete bounded selected identity and ignores URLs and unknown objects",()=>{
  const module=(id:string)=>({contentModuleType:"STANDARD_COMPANY_LOGO",standardCompanyLogo:{companyLogo:{uploadDestinationId:id,altText:"Example",imageCropSpecification:{size:{width:{value:100,units:"pixels"},height:{value:100,units:"pixels"}}}}}});
  const hash=(v:unknown)=>watchModuleFingerprint(v,v=>v);
  const a=module("I".repeat(3000)),b=module("I".repeat(2999)+"X");assert.notEqual(hash(a),hash(b));assert.match(hash(a),/^[a-f0-9]{64}$/);
  const crop=structuredClone(a);crop.standardCompanyLogo.companyLogo.imageCropSpecification.size.width.value=90;assert.notEqual(hash(a),hash(crop));
  assert.equal(hash(a),hash({...a,unknown:{password:"example-secret-not-real"},url:"https://example.com/private"}));
  assert.throws(()=>hash(module("I".repeat(256*1024+1))),/EINCOMPLETE/);
  assert.throws(()=>hash({contentModuleType:"STANDARD_TEXT",standardText:{body:{textList:Array.from({length:101},()=>({value:"Example"}))}}}),/EINCOMPLETE/);
});

test("A+ images are hashed across standard, premium, carousel and brand-story schema paths",()=>{
  const image=(id:string)=>({uploadDestinationId:id,altText:"Example"});
  const variants=[(i:unknown)=>({standardHeaderImageText:{block:{image:i}}}),(i:unknown)=>({premiumFullBackgroundImage:{desktopImage:i}}),(i:unknown)=>({premiumImageCarousel:{carouselCards:[{imagePanel:{mobileImage:i}}]}}),(i:unknown)=>({brandStoryFourAsin:{asinImages:[{asinImage:{productImage:i}}]}})];
  for(const wrap of variants)assert.notEqual(watchModuleFingerprint(wrap(image("upload-a")),v=>v),watchModuleFingerprint(wrap(image("upload-b")),v=>v));
});

test("A+ reflected credential identity and text fail safely before hashing or replacing the baseline",async t=>{
  const scrub=redactor([CREDS.clientSecret]);
  for(const value of [CREDS.clientSecret,encodeURIComponent(CREDS.clientSecret),Buffer.from(CREDS.clientSecret).toString("base64")])assert.throws(()=>watchModuleFingerprint({standardCompanyLogo:{companyLogo:{uploadDestinationId:value}}},v=>scrub(String(v))),/EINCOMPLETE/);
  const f=await watchFixture();t.after(f.close);f.set({skus:["SKU-1"]});await f.check("content");
  const snapshot=async()=>(await f.pg.query<any>(`SELECT revision,snapshots FROM ${NS}.watch_state_v2`)).rows;
  const before=await snapshot();
  for(const edit of [{imageUpload:CREDS.clientSecret},{imageUpload:"safe-upload",moduleText:"T".repeat(3000)+CREDS.clientSecret}]){
    f.set(edit);await assert.rejects(f.check("content"),/EINCOMPLETE/);assert.deepEqual(await snapshot(),before);assert.deepEqual(await f.changes(),[]);
  }
  const output=JSON.stringify((await f.pg.query<any>(`SELECT * FROM ${NS}.watch_runs_v2`)).rows);assert.ok(!output.includes(CREDS.clientSecret));
});

for(const kind of ["table","scroller","paragraphs"] as const)test(`R4 display cuts: ${kind} baseline, late text edit per SKU and repeat`,async t=>{
  const f=await watchFixture();t.after(f.close);
  const module=kind==="table"?comparisonTable():kind==="scroller"?comparisonScroller():{contentModuleType:"STANDARD_TEXT",standardText:{body:{textList:Array.from({length:34},(_,i)=>({value:`${i}:`+"T".repeat(1100)}))}}};
  f.set({aplusModules:[module]});
  const baseline=await f.check("content");assert.equal(baseline.complete,true);assert.equal(baseline.degraded,false);assert.equal(baseline.changes,0);
  const state=async()=>(await f.pg.query<any>(`SELECT revision,snapshots FROM ${NS}.watch_state_v2 WHERE kind='content'`)).rows;
  const before=await state(),publicBefore=await f.service.run("get_aplus_content",{contentReferenceKey:"K-1"},COMPANY) as any;
  assert.equal(publicBefore.truncated,true);assert.equal(publicBefore.content.modules[0].texts.length,kind==="paragraphs"?30:50);
  if(kind==="table")(module as ReturnType<typeof comparisonTable>).standardComparisonTable.productColumns[5].metrics[8].value="Edited text sixty";
  else if(kind==="scroller")(module as ReturnType<typeof comparisonScroller>).premiumComparisonScroller.comparisonRows[5].comparisonRow.comparisonFields[6].comparisonField.value="Edited text sixty-three";
  else (module as {standardText:{body:{textList:{value:string}[]}}}).standardText.body.textList[33].value+="Edited suffix";
  f.advance(1000);f.set({aplusModules:[module]});const changed=await f.check("content");assert.equal(changed.complete,true);assert.equal(changed.changes,2);
  const after=await state(),rows=await f.changes();assert.equal(rows.length,2);assert.deepEqual(rows.map((r:any)=>r.sku),["SKU-1","SKU-2"]);
  for(let i=0;i<2;i++){assert.equal(rows[i].field,"aplus");assert.deepEqual(rows[i].before,before[0].snapshots[i].data.aplus);assert.deepEqual(rows[i].after,after[0].snapshots[i].data.aplus);assert.notDeepEqual(rows[i].before,rows[i].after);}
  const history=await f.watch.listChanges({field:"aplus"},COMPANY,f.deps.now()+50000) as any;assert.equal(history.changes.length,2);
  assert.equal((await f.check("content")).changes,0);assert.equal((await f.changes()).length,2);
  const publicAfter=await f.service.run("get_aplus_content",{contentReferenceKey:"K-1"},COMPANY) as any;
  delete publicBefore.provenance;delete publicAfter.provenance;assert.deepEqual(publicAfter,publicBefore);
});

test("R4 watch requests only used catalog data sets and submitted attributes",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({catalogChildren:150});
  // The fake provider returns all requested relationships. The public tool
  // proves that this same fixture really exceeds the structural array bound.
  const publicCatalog=await f.service.run("get_catalog_item",{asin:"B000000001"},COMPANY) as any;
  assert.equal(publicCatalog.truncated,true);assert.equal(publicCatalog.item.relationships[0].relationships[0].childAsins.length,100);
  const toolCall=f.calls.findLast(c=>c.url.pathname.includes("/catalog/"))!;
  assert.equal(toolCall.url.searchParams.get("includedData"),"attributes,images,identifiers,productTypes,relationships,summaries");
  const publicListing=await f.service.run("get_listing",{sku:"SKU-1"},COMPANY);assert.equal(publicListing.truncated,false);
  assert.equal(f.calls.findLast(c=>c.url.pathname.endsWith("/SKU-1"))!.url.searchParams.get("includedData"),"attributes,summaries,issues,offers,fulfillmentAvailability,productTypes");
  const n=f.calls.length;assert.equal((await f.check("content")).complete,true);
  const calls=f.calls.slice(n);assert.equal(calls.find(c=>c.url.pathname.includes("/catalog/"))!.url.searchParams.get("includedData"),"attributes,images,productTypes,summaries");
  const listingCalls=calls.filter(c=>/\/SKU-/.test(c.url.pathname));assert.equal(listingCalls.length,2);assert.ok(listingCalls.every(c=>c.url.searchParams.get("includedData")==="attributes"));
});

test("R4 unused attribute display cuts do not block listing or catalog watch evidence",async t=>{
  const f=await watchFixture();t.after(f.close);f.set({unusedAttributeItems:101});
  const listing=await f.service.run("get_listing",{sku:"SKU-1"},COMPANY) as any,catalog=await f.service.run("get_catalog_item",{asin:"B000000001"},COMPANY) as any;
  assert.equal(listing.truncated,true);assert.equal(catalog.truncated,true);assert.equal(listing.listing.attributes.color.length,100);assert.equal(catalog.item.attributes.color.length,100);
  assert.equal((await f.check("content")).complete,true);f.set({description:"Changed selected description"});assert.equal((await f.check("content")).changes,4);assert.equal((await f.check("content")).changes,0);
});

for(const invalid of [CREDS.clientSecret,"X\u0000Y","X\ud800Y"])test(`R4 full selected text rejects ${invalid===CREDS.clientSecret?"reflected credentials":invalid.includes("\u0000")?"NUL":"unpaired surrogate"} beyond the display cut`,async t=>{
  const f=await watchFixture();t.after(f.close);const module=comparisonTable();f.set({aplusModules:[module]});await f.check("content");
  const state=async()=>(await f.pg.query<any>(`SELECT revision,snapshots FROM ${NS}.watch_state_v2`)).rows,before=await state();
  module.standardComparisonTable.productColumns[5].metrics[8].value=invalid;f.set({aplusModules:[module]});await assert.rejects(f.check("content"),/EINCOMPLETE/);
  assert.deepEqual(await state(),before);assert.deepEqual(await f.changes(),[]);
  const runs=(await f.pg.query<any>(`SELECT ok,note FROM ${NS}.watch_runs_v2`)).rows;assert.equal(runs.at(-1).ok,false);assert.equal(JSON.parse(runs.at(-1).note).error,"EINCOMPLETE");assert.ok(!JSON.stringify([runs,f.logs]).includes(CREDS.clientSecret));
  const exposed=await f.service.run("get_aplus_content",{contentReferenceKey:"K-1"},COMPANY) as any;assert.equal(exposed.truncated,true);assert.equal(exposed.content.modules[0].texts.length,50);assert.ok(!JSON.stringify(exposed).includes(CREDS.clientSecret));
});

test("R4 A+ document module and traversal bounds remain fatal after display cuts",async t=>{
  const f=await watchFixture();t.after(f.close);const module=comparisonTable();f.set({aplusModules:[module]});await f.check("content");
  const state=async()=>(await f.pg.query<any>(`SELECT revision,snapshots FROM ${NS}.watch_state_v2`)).rows,before=await state();
  for(const modules of [Array.from({length:101},()=>module),[{standardText:{body:{textList:Array.from({length:101},()=>({value:"Example"}))}}}],[{standardText:{body:{textList:Array.from({length:27},()=>({value:"T".repeat(10000)}))}}}]]){
    f.set({aplusModules:modules});await assert.rejects(f.check("content"),/EINCOMPLETE/);assert.deepEqual(await state(),before);assert.deepEqual(await f.changes(),[]);
  }
  // A+ paging is independently bounded, even if every individual module fits.
  f.set({aplusModules:[module]});const read=f.service.read.bind(f.service);f.service.read=async(...args)=>{const result=await read(...args);return args[0]==="get_aplus_content"?{...result,nextModuleOffset:Number(args[1].moduleOffset??0)+1}:result;};
  await assert.rejects(f.check("content"),/EINCOMPLETE/);assert.deepEqual(await state(),before);assert.deepEqual(await f.changes(),[]);
});

for(const operation of ["get_listing","get_catalog_item"])test(`R4 used ${operation} attribute cuts and invalid sources still fail`,async t=>{
  const f=await watchFixture();t.after(f.close);await f.check("content");const state=async()=>(await f.pg.query<any>(`SELECT revision,snapshots FROM ${NS}.watch_state_v2`)).rows,before=await state();
  const original=f.deps.send;let attributes:unknown={bullet_point:Array.from({length:101},()=>({value:"Example bullet"}))};
  const service=new AmazonService(f.ctx,{...f.deps,send:async(...args)=>{const response=await original(...args);const match=operation==="get_listing"?/\/SKU-/.test(args[0].pathname):args[0].pathname.includes("/catalog/");if(!match)return response;const value=JSON.parse(response.body.toString());value.attributes=attributes;return json(value);}}),watch=new ListingWatch(f.ctx,service,f.deps.now);
  await assert.rejects(watch.check(COMPANY,"seller","content",MARKET),/EINCOMPLETE/);assert.deepEqual(await state(),before);assert.deepEqual(await f.changes(),[]);
  attributes=null;await assert.rejects(watch.check(COMPANY,"seller","content",MARKET),/ERESPONSE/);assert.deepEqual(await state(),before);assert.deepEqual(await f.changes(),[]);
});