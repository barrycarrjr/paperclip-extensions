import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp,mkdir,cp,readFile,writeFile } from "node:fs/promises";
import { fileURLToPath,pathToFileURL } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const ROOT=fileURLToPath(new URL("../",import.meta.url)),NS="plugin_amazon_d696b53491";
const COMPANY="11111111-1111-4111-8111-111111111111",OTHER="22222222-2222-4222-8222-222222222222",REF="33333333-3333-4333-8333-333333333333",MARKET="ATVPDKIKX0DER";
const CREDS={clientId:"synthetic-client-not-real",clientSecret:"synthetic-secret-not-real",refreshToken:"synthetic-refresh-not-real",sellerId:"SELLEREXAMPLE"};
const REFS=["aaaaaaaa-0000-4000-8000-000000000001","aaaaaaaa-0000-4000-8000-000000000002","aaaaaaaa-0000-4000-8000-000000000003"];
test("built worker upgrades legacy configuration and runs both jobs through host-like migrated SQL bridge",{timeout:280000},async t=>{
  const scratchRoot=path.resolve(ROOT,"../../.smoke-tests");await mkdir(scratchRoot,{recursive:true});const scratch=await mkdtemp(path.join(scratchRoot,"watch-union-"));
  await cp(path.join(ROOT,"dist"),path.join(scratch,"dist"),{recursive:true});await writeFile(path.join(scratch,"package.json"),JSON.stringify({type:"module"}));
  const manifest=(await import(pathToFileURL(path.join(scratch,"dist/manifest.js")).href)).default;
  assert.equal(manifest.version,"0.3.0");assert.deepEqual(manifest.jobs.map(j=>[j.jobKey,j.schedule]),[["listing_watch_status","17 */6 * * *"],["listing_watch_content","43 7 * * *"]]);
  const validators=process.env.AMAZON_HOST_SQL_VALIDATORS?await import(pathToFileURL(process.env.AMAZON_HOST_SQL_VALIDATORS).href):undefined;
  const pg=new PGlite();t.after(()=>pg.close());await pg.exec(`CREATE SCHEMA ${NS}`);
  for(const migration of ["0001_listing_watch.sql","0002_company_watch.sql"]){const sql=await readFile(path.join(ROOT,"migrations",migration),"utf8");for(const statement of sql.split(";").filter(s=>s.trim()))validators?.validatePluginMigrationStatement(statement,NS);await pg.exec(sql);}
  let aplusModules,catalogChildren=0,unusedAttributeItems=0;
  const selected=(value,url,identity)=>Object.fromEntries(Object.entries(value).filter(([key])=>key===identity||!url.searchParams.has("includedData")||url.searchParams.get("includedData").split(",").includes(key)));
  let aplusName="Example content",aplusStatus="APPROVED",aplusText="Example module",imageUpload="example-upload-1";
  let price=10,partial=false,revoked=false,count=1,description="Example description",emptyValues=false,offersFail=false,distinct=false;
  let config={defaultAccount:"seller",accounts:[{key:"seller",name:"Example account",region:"na",sellerId:CREDS.sellerId,lwaClientIdRef:REFS[0],lwaClientSecretRef:REFS[1],refreshTokenRef:REFS[2],marketplaceIds:[MARKET],allowedCompanies:[COMPANY],listingWatch:true}]};
  const serialized=JSON.stringify(config),calls=[],audits=[],sqlCalls=[];let secretWindow=[],maxLookups=0,quotaTrips=0;
  const server=createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;calls.push({method:req.method,path:req.url,body});res.setHeader("content-type","application/json");res.setHeader("x-amzn-ratelimit-limit","1000");
    const url=new URL(req.url,"http://fixture");
    if(url.pathname==="/auth/o2/token"){assert.equal(req.headers["x-test-original-host"],"api.amazon.com");assert.equal(new URLSearchParams(body).get("client_secret"),CREDS.clientSecret);res.end(JSON.stringify({access_token:"synthetic-access-not-real",token_type:"bearer",expires_in:3600}));return;}
    assert.equal(req.headers["x-test-original-host"],"sellingpartnerapi-na.amazon.com");assert.equal(req.method,"GET");
    if(url.pathname.endsWith("/offers")){if(offersFail){res.statusCode=503;res.end('{}');return;}res.end(JSON.stringify({payload:{ASIN:url.pathname.split('/').at(-2),Summary:{TotalOfferCount:1},Offers:[{MyOffer:true,IsBuyBoxWinner:true,SellerId:CREDS.sellerId,ListingPrice:{Amount:price,CurrencyCode:"USD"},ShipsFrom:{Address:"Excluded fake address"}}]}}));return;}
    if(url.pathname.includes("/catalog/")){res.end(JSON.stringify(selected({asin:url.pathname.split('/').at(-1),summaries:[{marketplaceId:MARKET,itemName:"Example live title"}],attributes:emptyValues?{}:{bullet_point:[{value:"Example live bullet"}],color:Array.from({length:unusedAttributeItems},()=>({value:"Example color"}))},relationships:[{marketplaceId:MARKET,relationships:[{type:"VARIATION",childAsins:Array.from({length:catalogChildren},(_,i)=>`B${String(i).padStart(9,"0")}`)}]}]},url,"asin")));return;}
    if(url.pathname.endsWith("/contentPublishRecords")){res.end(JSON.stringify({publishRecordList:[{contentReferenceKey:"K-1"}]}));return;}
    if(url.pathname.endsWith("/contentDocuments/K-1")){res.end(JSON.stringify({contentRecord:{contentReferenceKey:"K-1",contentMetadata:{name:aplusName,status:aplusStatus},contentDocument:{name:"Example document",contentModuleList:aplusModules??[{contentModuleType:"STANDARD_HEADER_IMAGE_TEXT",standardHeaderImageText:{headline:{value:aplusText},block:{image:{uploadDestinationId:imageUpload,altText:"Example image",imageCropSpecification:{size:{width:{value:100,units:"pixels"},height:{value:100,units:"pixels"}}}}}}}]}}}));return;}
    if(partial&&url.searchParams.has("pageToken")){res.statusCode=503;res.end('{}');return;}
    const sku=decodeURIComponent(url.pathname.split("/").at(-1));const listing={sku:sku.startsWith("SKU-")?sku:"SKU-1",summaries:[{marketplaceId:MARKET,asin:"B000000001",itemName:"Example title",status:emptyValues?[]:["BUYABLE"],...(emptyValues?{}:{mainImage:{link:"https://example.com/product.jpg"}})}],issues:[],...(emptyValues?{}:{offers:[{marketplaceId:MARKET,price:{amount:price,currencyCode:"USD"}}]}),attributes:emptyValues?{}:{color:Array.from({length:unusedAttributeItems},()=>({value:"Example color"})),item_name:[{value:"Example submitted title",marketplace_id:MARKET}],product_description:[{value:description,marketplace_id:MARKET}],generic_keyword:[{value:"Example search term"}]}};
    if(url.pathname.endsWith("/SELLEREXAMPLE"))res.end(JSON.stringify({items:Array.from({length:Math.min(20,count-Number(url.searchParams.get("pageToken")??0))},(_,i)=>{const n=Number(url.searchParams.get("pageToken")??0)+i+1;return selected({...listing,sku:`SKU-${n}`,summaries:listing.summaries.map(s=>({...s,asin:distinct?`B${String(n).padStart(9,'0')}`:s.asin}))},url,"sku");}),...(count>Number(url.searchParams.get("pageToken")??0)+20?{pagination:{nextToken:String(Number(url.searchParams.get("pageToken")??0)+20)}}:partial?{pagination:{nextToken:"private-provider-page"}}:{})}));else if(url.pathname.split("/").at(-1).startsWith("SKU-"))res.end(JSON.stringify(selected(listing,url,"sku")));else{res.statusCode=404;res.end('{}');}
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");assert.ok(![3100,54329].includes(server.address().port));t.after(()=>{server.closeAllConnections();server.close();});
  const child=spawn(process.execPath,["--import",pathToFileURL(path.join(ROOT,"test/loopback-loader.mjs")).href,path.join(scratch,"dist/worker.js")],{cwd:scratch,env:{...process.env,AMAZON_TEST_PORT:String(server.address().port)},stdio:["pipe","pipe","pipe"]});t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,"exit");}await writeFile(path.join(scratch,"cleanup-receipt.json"),JSON.stringify({pid:child.pid,exit:child.exitCode,signal:child.signalCode,retained:true}));});
  let stderr="",seq=0;child.stderr.on("data",b=>stderr+=b);const pending=new Map();const send=v=>child.stdin.write(JSON.stringify(v)+"\n");
  createInterface({input:child.stdout}).on("line",async line=>{
    const m=JSON.parse(line);
    if(m.method){if(m.id===undefined)return;try{let result;
      if(m.method==="config.get")result=config;
      else if(m.method==="secrets.resolve"){secretWindow=secretWindow.filter(t=>t>Date.now()-60000);secretWindow.push(Date.now());maxLookups=Math.max(maxLookups,secretWindow.length);if(secretWindow.length>1200){quotaTrips++;throw Error("Rate limit exceeded for secret resolution");}assert.equal(m.params.companyId,COMPANY);if(revoked)throw Error(`Secret not found: ${m.params.secretRef}`);const i=REFS.indexOf(m.params.secretRef);if(i>=0)result=[CREDS.clientId,CREDS.clientSecret,CREDS.refreshToken][i];else{assert.equal(m.params.secretRef,REF);result=JSON.stringify(CREDS);}}
      else if(m.method==="activity.log"){audits.push(m.params);result=null;}
      else if(m.method==="db.query"){validators?.validatePluginRuntimeQuery(m.params.sql,NS);sqlCalls.push(m.params.sql);result=(await pg.query(m.params.sql,m.params.params)).rows;}
      else if(m.method==="db.execute"){validators?.validatePluginRuntimeExecute(m.params.sql,NS);sqlCalls.push(m.params.sql);result={rowCount:(await pg.query(m.params.sql,m.params.params)).affectedRows??0};}
      else throw Error("Unexpected host method "+m.method);
      send({jsonrpc:"2.0",id:m.id,result});
    }catch(e){send({jsonrpc:"2.0",id:m.id,error:{code:-32603,message:e.message}});}}
    else{const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}
  });
  child.on("exit",code=>{for(const p of pending.values())p.reject(Error("worker exited "+code+stderr));pending.clear();});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});send({jsonrpc:"2.0",id,method,params});});
  const run={companyId:COMPANY,agentId:"synthetic-agent",runId:"synthetic-run"};const tool=(name,parameters={})=>rpc("executeTool",{toolName:`amazon_${name}`,parameters,runContext:run});
  assert.equal((await rpc("initialize",{manifest,config,databaseNamespace:NS})).ok,true);assert.equal((await rpc("validateConfig",{config})).ok,true);assert.equal(JSON.stringify(config),serialized);
  assert.equal((await tool("test_connection")).data.connected,true);
  const listed=await tool("list_accounts");assert.equal(listed.data.accounts[0].key,"seller");assert.ok(!JSON.stringify(listed).includes(REFS[0]));
  const job=kind=>rpc("runJob",{job:{jobKey:`listing_watch_${kind}`,runId:`synthetic-${kind}`,trigger:"manual",scheduledAt:new Date().toISOString()}});
  await job("status");await job("content");assert.equal((await pg.query(`SELECT * FROM ${NS}.watch_changes_v2`)).rows.length,0);const baselineHealth=(await tool("list_listing_changes")).data.health;assert.ok(baselineHealth.every(r=>r.latest?.complete===true&&r.latest?.degraded===false));
  const aplusSnapshot=async()=>(await pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2 WHERE kind='content'`)).rows[0].snapshots[0].data.aplus;
  let aplusBefore=await aplusSnapshot();assert.match(aplusBefore[0],/^Example content \[APPROVED\] [a-f0-9]+$/);
  const aplusEvidence=[];
  for(const step of ["status","rename","text","image"]){
    if(step==="status")aplusStatus="REJECTED";else if(step==="rename")aplusName="Renamed example";else if(step==="text")aplusText="Edited example";else imageUpload="example-upload-2";
    const n=(await pg.query(`SELECT count(*)::int AS n FROM ${NS}.watch_changes_v2`)).rows[0].n;
    await job("content");const after=await aplusSnapshot();
    const rows=(await pg.query(`SELECT field,before,after FROM ${NS}.watch_changes_v2 WHERE field='aplus'`)).rows;
    assert.equal(rows.length,aplusEvidence.length+1);assert.equal((await pg.query(`SELECT count(*)::int AS n FROM ${NS}.watch_changes_v2`)).rows[0].n,n+1);
    assert.ok(rows.some(r=>JSON.stringify(r.before)===JSON.stringify(aplusBefore)&&JSON.stringify(r.after)===JSON.stringify(after)));
    const exposed=(await tool("list_listing_changes",{field:"aplus",limit:100})).data;
    assert.ok(exposed.changes.some(r=>JSON.stringify(r.before)===JSON.stringify(aplusBefore)&&JSON.stringify(r.after)===JSON.stringify(after)));
    if(step==="status")assert.match(after[0],/\[REJECTED\]/);if(step==="rename")assert.match(after[0],/^Renamed example /);
    assert.ok(!JSON.stringify([rows,exposed]).includes("example-upload-"));
    aplusEvidence.push({step,before:aplusBefore,after});aplusBefore=after;
    await job("content");assert.equal((await pg.query(`SELECT count(*)::int AS n FROM ${NS}.watch_changes_v2`)).rows[0].n,n+1);
  }
  const publicAplus=(await tool("get_aplus_content",{contentReferenceKey:"K-1"})).data;
  assert.ok(!JSON.stringify(publicAplus).includes("example-upload-")&&!JSON.stringify(publicAplus).includes('"fingerprint"'));
  const displayCutEvidence=[];
  for(const kind of ["table","scroller","paragraphs"]){
    const module=kind==="table"?{contentModuleType:"STANDARD_COMPARISON_TABLE",standardComparisonTable:{productColumns:Array.from({length:6},(_,p)=>({position:p+1,title:`Product ${p+1}`,metrics:Array.from({length:9},(_,r)=>({position:r+1,value:`Product ${p+1} metric ${r+1}`}))})),metricRowLabels:Array.from({length:9},(_,r)=>({position:r+1,value:`Metric ${r+1}`}))}}:kind==="scroller"?{contentModuleType:"PREMIUM_COMPARISON_SCROLLER",premiumComparisonScroller:{headline:{value:"Example comparison"},comparisonProducts:Array.from({length:7},(_,p)=>({comparisonProduct:{position:p+1,productTitle:{value:`Product ${p+1}`},productAsin:{value:`B${String(p).padStart(9,'0')}`}}})),comparisonRows:Array.from({length:6},(_,r)=>({comparisonRow:{position:r+1,metricName:{value:`Metric ${r+1}`},comparisonFields:Array.from({length:7},(_,p)=>({comparisonField:{position:p+1,value:`Product ${p+1} metric ${r+1}`}}))}}))}}:{contentModuleType:"STANDARD_TEXT",standardText:{body:{textList:Array.from({length:34},(_,i)=>({value:`${i}:`+"T".repeat(1100)}))}}};
    const key=`display-${kind}`;config={defaultAccount:key,accounts:[{...JSON.parse(serialized).accounts[0],key}]};await rpc("configChanged",{config});count=2;catalogChildren=150;unusedAttributeItems=101;aplusModules=[module];
    const state=async()=>(await pg.query(`SELECT scope_id,revision,snapshots FROM ${NS}.watch_state_v2 WHERE kind='content' AND account_key=$1`,[key])).rows;
    const publicBefore=(await tool("get_aplus_content",{contentReferenceKey:"K-1"})).data;assert.equal(publicBefore.truncated,true);assert.equal(publicBefore.content.modules[0].texts.length,kind==="paragraphs"?30:50);
    const catalogTool=await tool("get_catalog_item",{asin:"B000000001"});assert.equal(catalogTool.data.truncated,true);assert.equal(catalogTool.data.item.relationships[0].relationships[0].childAsins.length,100);
    assert.equal(new URL(calls.at(-1).path,"http://fixture").searchParams.get("includedData"),"attributes,images,identifiers,productTypes,relationships,summaries");
    const publicListing=await tool("get_listing",{sku:"SKU-1"});assert.equal(publicListing.data.truncated,true);assert.equal(publicListing.data.listing.attributes.color.length,100);
    assert.equal(new URL(calls.at(-1).path,"http://fixture").searchParams.get("includedData"),"attributes,summaries,issues,offers,fulfillmentAvailability,productTypes");
    const callStart=calls.length;await job("content");const before=await state();assert.equal(before[0].snapshots.length,2);const scope=before[0].scope_id;
    const evidenceCalls=calls.slice(callStart);assert.equal(evidenceCalls.filter(c=>c.path.includes('/catalog/')).length,1);assert.ok(evidenceCalls.filter(c=>c.path.includes('/catalog/')).every(c=>new URL(c.path,'http://fixture').searchParams.get('includedData')==='attributes,images,productTypes,summaries'));
    assert.ok(evidenceCalls.filter(c=>/\/SKU-/.test(c.path)).every(c=>new URL(c.path,'http://fixture').searchParams.get('includedData')==='attributes'));
    const rows=async()=>(await pg.query(`SELECT sku,field,before,after FROM ${NS}.watch_changes_v2 WHERE scope_id=$1 ORDER BY sku`,[scope])).rows;
    assert.deepEqual(await rows(),[]);const health=(await tool("list_listing_changes")).data.health.find(r=>r.kind==='content').latest;assert.equal(health.complete,true);assert.equal(health.degraded,false);
    if(kind==="table")module.standardComparisonTable.productColumns[5].metrics[8].value="Edited text sixty";
    else if(kind==="scroller")module.premiumComparisonScroller.comparisonRows[5].comparisonRow.comparisonFields[6].comparisonField.value="Edited text sixty-three";
    else module.standardText.body.textList[33].value+="Edited suffix";
    await job("content");const changed=await rows(),after=await state();assert.equal(changed.length,2);assert.deepEqual(changed.map(r=>r.sku),["SKU-1","SKU-2"]);
    for(let i=0;i<2;i++){assert.equal(changed[i].field,'aplus');assert.deepEqual(changed[i].before,before[0].snapshots[i].data.aplus);assert.deepEqual(changed[i].after,after[0].snapshots[i].data.aplus);assert.notDeepEqual(changed[i].before,changed[i].after);}
    assert.equal((await tool("list_listing_changes",{field:'aplus'})).data.changes.length,2);await job("content");assert.equal((await rows()).length,2);
    const publicAfter=(await tool("get_aplus_content",{contentReferenceKey:"K-1"})).data;delete publicBefore.provenance;delete publicAfter.provenance;assert.deepEqual(publicAfter,publicBefore);
    if(kind==="table"){
      const saved=await state();module.standardComparisonTable.productColumns[5].metrics[8].value=CREDS.clientSecret;
      await assert.rejects(job("content"),/EINCOMPLETE/);assert.deepEqual(await state(),saved);assert.equal((await rows()).length,2);
      assert.ok(!JSON.stringify([(await pg.query(`SELECT * FROM ${NS}.watch_runs_v2 WHERE scope_id=$1`,[scope])).rows,audits]).includes(CREDS.clientSecret));
      const exposed=await tool("get_aplus_content",{contentReferenceKey:"K-1"});assert.equal(exposed.data.truncated,true);assert.equal(exposed.data.content.modules[0].texts.length,50);assert.ok(!JSON.stringify(exposed).includes(CREDS.clientSecret));
    }
    displayCutEvidence.push({kind,baselineChanges:0,changedRows:2,repeatRows:2,publicTruncated:true,parentChildren:150,selectedCatalogFields:true,selectedListingFields:true,secretRejected:kind==='table'});
  }
  config=JSON.parse(serialized);count=1;catalogChildren=0;unusedAttributeItems=0;aplusModules=undefined;await rpc("configChanged",{config});
  price=12;await job("status");const changed=await tool("list_listing_changes",{since:"2026-01-01T00:00:00Z"});assert.equal(changed.error,undefined);assert.ok(changed.data.changes.some(c=>c.field==="ourPrice"));assert.equal(changed.data.recentChecks.length,2);assert.equal(changed.data.health.length,2);
  const snap=(await pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2 ORDER BY kind`)).rows;partial=true;await assert.rejects(job("status"),/EINCOMPLETE/);assert.deepEqual((await pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2 ORDER BY kind`)).rows,snap);partial=false;
  const before=calls.length;const incompatible=await tool("get_settlement",{settlementId:"event-group-example"});assert.match(incompatible.error,/ECOMPAT/);assert.equal(calls.length,before);
  const legacy=config.accounts[0];config={accounts:[{key:legacy.key,credentialsRef:REF,region:"NA",marketplaceIds:[MARKET],allowedCompanies:[COMPANY],listingWatch:false}]};const combined=JSON.stringify(config);await rpc("configChanged",{config});assert.equal((await tool("test_connection")).data.connected,true);assert.equal(JSON.stringify(config),combined);
  // Changing credential identity starts an isolated history; old rows remain.
  assert.deepEqual((await tool("list_listing_changes",{since:"2026-01-01T00:00:00Z"})).data.changes,[]);assert.ok((await pg.query(`SELECT * FROM ${NS}.watch_changes_v2`)).rows.length>0);
  // Exercise the rebuilt worker with 80 paginated listings and benign long text.
  config.accounts[0].listingWatch=true;await rpc("configChanged",{config});count=80;distinct=true;description="D".repeat(2000);
  await job("status");await job("content");
  assert.ok((await pg.query(`SELECT snapshots FROM ${NS}.watch_state_v2 WHERE kind='content'`)).rows.some(r=>r.snapshots.length===80));
  description="D".repeat(1999)+"X";await job("content");const large=await tool("list_listing_changes",{since:"2026-01-01T00:00:00Z",limit:100});assert.equal(large.error,undefined);const allChanges=[...large.data.changes];let cursor=large.data.nextCursor;while(cursor){const page=await tool("list_listing_changes",{since:"2026-01-01T00:00:00Z",limit:100,cursor});assert.equal(page.error,undefined);allChanges.push(...page.data.changes);cursor=page.data.nextCursor;}assert.equal(allChanges.filter(c=>c.field==="submittedDescription").length,80);assert.equal(new Set(allChanges.map(c=>c.id)).size,allChanges.length);assert.ok(maxLookups<=900);assert.equal(quotaTrips,0);
  // Four SKUs sharing an ASIN exercise actual bundled deduplication and
  // source-level empty values through serialized SQL, not direct test helpers.
  count=4;distinct=false;let callStart=calls.length;await job("status");await job("content");let evidenceCalls=calls.slice(callStart);assert.equal(evidenceCalls.filter(c=>new URL(c.path,'http://fixture').pathname.endsWith('/offers')).length,1);assert.equal(evidenceCalls.filter(c=>c.path.includes('/catalog/')).length,1);assert.equal(evidenceCalls.filter(c=>c.path.includes('/contentPublishRecords')).length,1);assert.equal(evidenceCalls.filter(c=>new URL(c.path,'http://fixture').pathname.startsWith('/listings/')&&/SKU-/.test(c.path)).length,4);
  emptyValues=true;await job("status");await job("content");const removed=(await tool("list_listing_changes",{limit:100})).data;const removedChanges=[...removed.changes];let removedCursor=removed.nextCursor;while(removedCursor){const page=(await tool("list_listing_changes",{limit:100,cursor:removedCursor})).data;removedChanges.push(...page.changes);removedCursor=page.nextCursor;}for(const field of ['mainImage','ourPrice','submittedDescription','searchTerms','liveBullets'])assert.ok(removedChanges.some(c=>c.field===field&&(c.after===null||Array.isArray(c.after)&&c.after.length===0)),field);assert.ok(removed.health.every(r=>r.latest.complete===true&&r.latest.degraded===false));
  offersFail=true;await assert.rejects(job("status"),/EINCOMPLETE/);const failedCoverage=(await tool("list_listing_changes",{limit:100})).data.health.find(r=>r.kind==='status').latest;assert.equal(failedCoverage.complete,false);assert.equal(failedCoverage.ok,false);assert.equal(failedCoverage.enumerationComplete,true);assert.equal(failedCoverage.coverage.offers.providerFailures,1);assert.equal(failedCoverage.coverage.offers.unavailableListings,4);assert.equal(failedCoverage.coverage.offers.notAttemptedBudget,0);offersFail=false;
  const foreign=await rpc("executeTool",{toolName:"amazon_list_listing_changes",parameters:{},runContext:{...run,companyId:OTHER}});assert.match(foreign.error,/ECOMPANY/);
  assert.match((await tool("get_order",{orderId:"111-1234567-1234567",includeItems:false})).error,/includeItems/);
  revoked=true;const n=calls.length;assert.match((await tool("list_listing_changes",{since:"2026-01-01T00:00:00Z"})).error,/ECREDENTIALS/);assert.equal(calls.length,n);
  assert.ok(!JSON.stringify([changed,audits]).includes(CREDS.clientSecret));assert.ok(calls.every(c=>c.method==="GET"||c.path==="/auth/o2/token"));assert.ok(sqlCalls.some(s=>s.startsWith("WITH saved")));assert.equal(stderr,"");
  await rpc("shutdown",{});const [exit]=await once(child,"exit");assert.equal(exit,0);
  await writeFile(path.join(scratch,"receipt.json"),JSON.stringify({pid:child.pid,exit,port:server.address().port,sqlCalls:sqlCalls.length,apiCalls:calls.length,maxLookups,quotaTrips,largeCatalog:80,distinctAsins:80,longTextChangeDetected:true,displayCutEvidence,aplusEvidence,deduplicatedEvidence:true,absentKeyRemovals:true,failedCoverage,legacyConfigUnchanged:true,combinedConfigUnchanged:true,validatorsUsed:!!validators}));
});
