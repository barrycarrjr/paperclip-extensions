import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp,mkdir,cp,readFile,writeFile,rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT=fileURLToPath(new URL("../",import.meta.url));
const COMPANY="11111111-1111-4111-8111-111111111111",OTHER="22222222-2222-4222-8222-222222222222",REF="33333333-3333-4333-8333-333333333333";
const credentials={clientId:"synthetic-client-not-real",clientSecret:"synthetic-secret-not-real",refreshToken:"synthetic-refresh-not-real",sellerId:"SELLEREXAMPLE"};
const config={accounts:[{key:"seller",credentialsRef:REF,region:"NA",marketplaceIds:["ATVPDKIKX0DER"],allowedCompanies:[COMPANY]}]};
const tx=i=>({transactionType:"Shipment",transactionId:`t${i}`,transactionStatus:"RELEASED",postedDate:"2026-09-01T00:00:00Z",totalAmount:{currencyCode:"USD",currencyAmount:9},
  relatedIdentifiers:[{relatedIdentifierName:"ORDER_ID",relatedIdentifierValue:"123-1234567-1234567"}],breakdowns:[{breakdownType:"Sales",breakdownAmount:{currencyCode:"USD",currencyAmount:10},breakdowns:[{breakdownType:"ProductCharges",breakdownAmount:{currencyCode:"USD",currencyAmount:10}}]}]});

test("dist-only isolated installation validates manifest and speaks real worker RPC over synthetic HTTP",{timeout:60000},async t=>{
  const scratchRoot=path.resolve(ROOT,"../../.smoke-tests");
  await mkdir(scratchRoot,{recursive:true});
  const scratch=await mkdtemp(path.join(scratchRoot,"issue-43-install-"));
  t.after(async()=>{assert.equal(path.dirname(scratch),scratchRoot);await rm(scratch,{recursive:true,force:true});});
  await cp(path.join(ROOT,"dist"),path.join(scratch,"dist"),{recursive:true});
  const pkg=JSON.parse(await readFile(path.join(ROOT,"package.json"),"utf8"));
  await writeFile(path.join(scratch,"package.json"),JSON.stringify({name:pkg.name,version:pkg.version,type:"module",paperclipPlugin:pkg.paperclipPlugin}));
  const manifest=(await import(pathToFileURL(path.join(scratch,"dist/manifest.js")).href)).default;
  const sdkUrl=import.meta.resolve("@paperclipai/plugin-sdk");
  const shared=await import(new URL("../../shared/dist/index.js",sdkUrl).href);
  const schemas=Object.keys(shared).filter(k=>/plugin.*manifest.*schema/i.test(k));
  assert.ok(schemas.length,"host manifest validator is available in vendored shared");
  const validated=shared[schemas[0]].parse(manifest);
  assert.equal(manifest.version,pkg.version);assert.equal(manifest.tools.length,18);
  assert.ok(manifest.capabilities.includes("activity.log.write"));
  // The host reads these declarations: every read is writes:false, only report
  // generation is a write, and each tool carries its own execution timeout.
  for(const tool of [manifest.tools,validated.tools]){
    assert.deepEqual(tool.filter(x=>x.writes===true).map(x=>x.name),["amazon_request_report"]);
    assert.ok(tool.every(x=>typeof x.writes==="boolean"&&x.actionType===undefined&&Number.isInteger(x.executionTimeoutMs)&&x.executionTimeoutMs>=70000));
  }
  const calls=[],audit=[];let resolves=0,hostConfig=config,lwaMode="ok",bodyMode="plain",hostFailure,reportMode="503";
  const big=Buffer.alloc(9*1024*1024,120),compressed=gzipSync(big);
  const server=createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;
    calls.push({path:req.url,method:req.method,headers:req.headers,body});
    res.setHeader("content-type","application/json");
    if(req.url==="/auth/o2/token"){
      assert.equal(req.headers["x-test-original-host"],"api.amazon.com");
      const form=new URLSearchParams(body);assert.equal(form.get("grant_type"),"refresh_token");assert.equal(form.get("client_secret"),credentials.clientSecret);
      if(lwaMode==="network"){req.socket.destroy();return;}
      if(lwaMode!=="ok"){
        res.statusCode=Number(lwaMode)||200;res.setHeader("retry-after","7");
        res.end(JSON.stringify({error:credentials.clientSecret}));return;
      }
      res.end(JSON.stringify({access_token:"synthetic-access-not-real",token_type:"bearer",expires_in:3600}));return;
    }
    if(req.headers["x-test-original-host"]==="d34o8swod1owfl.cloudfront.net"){
      assert.equal(req.headers["x-amz-access-token"],undefined);
      res.setHeader("content-type","text/plain;charset=UTF-8");
      if(bodyMode==="network"){req.socket.destroy();return;}
      if(bodyMode==="gzip")res.setHeader("content-encoding","gzip");
      res.end(bodyMode==="gzip"?compressed:big);return;
    }
    assert.equal(req.headers["x-test-original-host"],"sellingpartnerapi-na.amazon.com");
    assert.equal(req.headers["x-amz-access-token"],"synthetic-access-not-real");
    const url=new URL(req.url,"http://loopback");
    if(url.pathname==="/catalog/2022-04-01/items/B012345678"){
      res.end(JSON.stringify({asin:"B012345678",summaries:[{marketplaceId:"ATVPDKIKX0DER",itemName:"Pan\u0000"+String.fromCodePoint(0x1f600)+"\ud83d"}],attributes:{product_description:[{value:"a".repeat(1499)+String.fromCodePoint(0x1f600)+"b"}],bullet_point:[{value:"b".repeat(1490)+credentials.refreshToken}]}}));return;
    }
    if(url.pathname==="/finances/2024-06-19/transactions"){
      res.end(JSON.stringify(url.searchParams.get("nextToken")==="page2"?{payload:{transactions:[tx(120)]}}:{payload:{transactions:Array.from({length:120},(_,i)=>tx(i)),nextToken:"page2"}}));return;
    }
    if(url.pathname==="/reports/2021-06-30/reports"&&req.method==="POST"){
      if(reportMode==="503"){res.statusCode=503;res.end(JSON.stringify({errors:[{message:credentials.clientSecret}]}));}
      else {res.statusCode=202;res.end(JSON.stringify({reportId:reportMode}));}return;
    }
    if(url.pathname==="/reports/2021-06-30/reports"){res.end(big);return;}
    if(url.pathname==="/reports/2021-06-30/reports/r1"){res.end(JSON.stringify({reportType:"GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",processingStatus:"DONE",reportDocumentId:"d1"}));return;}
    if(url.pathname==="/reports/2021-06-30/documents/d1"){res.end(JSON.stringify({url:"https://d34o8swod1owfl.cloudfront.net/r"}));return;}
    assert.match(req.url,/^\/listings\/2021-08-01\/items\/SELLEREXAMPLE\?/);
    res.setHeader("x-amzn-RateLimit-Limit","1000");res.end(JSON.stringify({items:[]}));
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>{server.closeAllConnections();server.close();});
  const child=spawn(process.execPath,["--import",pathToFileURL(path.join(ROOT,"test/loopback-loader.mjs")).href,path.join(scratch,"dist/worker.js")],{cwd:scratch,env:{...process.env,AMAZON_TEST_PORT:String(server.address().port)},stdio:["pipe","pipe","pipe"]});
  t.after(()=>child.kill());
  const pending=new Map();let seq=0,stderr="";child.stderr.on("data",v=>stderr+=v);
  const send=v=>child.stdin.write(JSON.stringify(v)+"\n");
  createInterface({input:child.stdout}).on("line",line=>{
    const m=JSON.parse(line);
    if(m.method){
      if(hostFailure?.method===m.method){send({jsonrpc:"2.0",id:m.id,error:{code:hostFailure.code,message:hostFailure.message}});return;}
      let result;
      if(m.method==="secrets.resolve"){assert.equal(m.params.companyId,COMPANY);assert.equal(m.params.secretRef,REF);resolves++;result=JSON.stringify(credentials);}
      else if(m.method==="activity.log"){audit.push(m.params);result=null;}
      else if(m.method==="config.get"){result=hostConfig;}
      else if(m.id===undefined)return;
      else throw Error("Unexpected host RPC "+m.method);
      send({jsonrpc:"2.0",id:m.id,result});
    }else{const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}
  });
  child.on("exit",code=>{for(const p of pending.values())p.reject(Error("worker exited "+code+" "+stderr));pending.clear();});
  function rpc(method,params){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});send({jsonrpc:"2.0",id,method,params});});}
  const init=await rpc("initialize",{manifest,config});assert.equal(init.ok,true);
  const validation=await rpc("validateConfig",{config});assert.equal(validation.ok,true);assert.equal(calls.length,0);assert.equal(resolves,0);
  const runContext={companyId:COMPANY,agentId:"synthetic-agent",runId:"synthetic-run"};
  const connected=await rpc("executeTool",{toolName:"amazon_test_connection",parameters:{},runContext});assert.equal(connected.data.connected,true);assert.equal(calls.length,2);assert.equal(audit.length,2);
  const before=resolves;
  const denied=await rpc("executeTool",{toolName:"amazon_test_connection",parameters:{},runContext:{...runContext,companyId:OTHER}});assert.match(denied.error,/ECOMPANY/);assert.equal(denied.failure.code,"not_authorized");assert.equal(resolves,before);assert.equal(calls.length,2);
  // LWA failures cross the actual RPC boundary as retry/reconnect results for
  // reads, but throw before a report POST so the host can release its claim.
  for(const [mode,code,host] of [["network","ENETWORK","unavailable"],["503","EHTTP","unavailable"],["429","ERATE","unavailable"],["400","EAUTH","needs_reconnect"],["401","EAUTH","needs_reconnect"],["malformed","EAUTH","needs_reconnect"]]){
    lwaMode=mode;await rpc("configChanged",{config});const before=calls.length;
    const out=await rpc("executeTool",{toolName:"amazon_test_connection",parameters:{},runContext});
    assert.match(out.error,new RegExp(code));assert.equal(out.failure.code,host);
    assert.equal(out.failure.retryAfterMs,mode==="429"?7000:undefined);
    await assert.rejects(rpc("executeTool",{toolName:"amazon_request_report",parameters:{reportType:"GET_FLAT_FILE_OPEN_LISTINGS_DATA"},runContext}),new RegExp(code));
    assert.equal(calls.length-before,2,"one LWA request per call and no business POST");
    assert.ok(!JSON.stringify([out,audit]).includes(credentials.clientSecret));
  }
  lwaMode="ok";await rpc("configChanged",{config});
  // Real SDK RPC flattens host errors. Only exact missing-secret messages
  // require reconnection; temporary and unknown lookup failures stay retryable.
  for(const [method,message,code,expected,host] of [
    ["secrets.resolve","Rate limit exceeded for secret resolution",-32603,"EHOST","unavailable"],
    ["secrets.resolve","Host lookup timed out",-32003,"EHOST","unavailable"],
    ["config.get",credentials.clientSecret,-32603,"EHOST","unavailable"],
    ["secrets.resolve",`Secret not found: ${REF}`,-32603,"ECREDENTIALS","needs_reconnect"],
  ]){
    hostFailure={method,message,code};const before=calls.length;
    const out=await rpc("executeTool",{toolName:"amazon_test_connection",parameters:{},runContext});
    assert.match(out.error,new RegExp(expected));assert.equal(out.failure.code,host);
    await assert.rejects(rpc("executeTool",{toolName:"amazon_request_report",parameters:{reportType:"GET_FLAT_FILE_OPEN_LISTINGS_DATA"},runContext}),new RegExp(expected));
    assert.equal(calls.length,before);assert.ok(!JSON.stringify([out,audit]).includes(message));
  }
  hostFailure=undefined;
  // Continuation contract: a page too large for one response is returned in
  // whole records across cursors, from memory, before Amazon's next page.
  const window={postedAfter:new Date(Date.now()-2*86400_000).toISOString(),postedBefore:new Date(Date.now()-86400_000).toISOString()};
  const ids=[];let cursor,pages=0;
  do{
    const page=await rpc("executeTool",{toolName:"amazon_list_financial_events",parameters:cursor?{...window,cursor}:window,runContext});
    assert.equal(page.error,undefined);ids.push(...page.data.transactions.map(x=>x.transactionId));cursor=page.data.nextCursor;pages++;
  }while(cursor&&pages<20);
  assert.ok(pages>2);assert.deepEqual(ids,Array.from({length:121},(_,i)=>`t${i}`));
  assert.equal(calls.filter(c=>c.path.startsWith("/finances/")).length,2,"one provider call per Amazon page");
  // Deterministic size failures must stay nonretryable through real transport,
  // service, worker and host structured codes for plain/API/gzip bodies alike.
  for(const [tool,parameters,mode] of [["amazon_get_settlement",{reportId:"r1"},"plain"],["amazon_get_settlement",{reportId:"r1"},"gzip"],["amazon_list_settlements",{},"plain"]]){
    bodyMode=mode;const before=calls.length;
    const out=await rpc("executeTool",{toolName:tool,parameters,runContext});
    assert.match(out.error,/ERESPONSE/);assert.equal(out.failure.code,"failed");
    assert.equal(shared.isRetryableOperationError(out.failure.code),false);
    assert.equal(calls.length-before,tool==="amazon_list_settlements"?1:3,"no retry of a size failure");
  }
  bodyMode="network";
  const reset=await rpc("executeTool",{toolName:"amazon_get_settlement",parameters:{reportId:"r1"},runContext});
  assert.match(reset.error,/ENETWORK/);assert.equal(reset.failure.code,"unavailable");
  const catalog=await rpc("executeTool",{toolName:"amazon_get_catalog_item",parameters:{asin:"B012345678"},runContext});
  assert.equal(catalog.error,undefined);assert.equal(catalog.data.truncated,true);
  assert.equal(catalog.data.item.summaries[0].itemName,"Pan"+String.fromCodePoint(0x1f600)+"\ufffd");
  assert.equal(catalog.data.item.attributes.product_description[0].value,"a".repeat(1499));
  assert.equal(catalog.data.item.attributes.bullet_point[0].value,"b".repeat(1490)+"[redacted]");
  // Optional test-only module path reuses an already installed PGlite. No new
  // plugin dependency or persistent database is needed for the jsonb contract.
  await t.test("projected worker output roundtrips through isolated PostgreSQL jsonb",{skip:!process.env.AMAZON_TEST_PGLITE_MODULE},async()=>{
    const {PGlite}=await import(pathToFileURL(process.env.AMAZON_TEST_PGLITE_MODULE).href);
    const db=new PGlite();
    try{
      await assert.rejects(db.query("SELECT $1::jsonb AS value",[JSON.stringify({text:"bad\u0000"})]));
      await assert.rejects(db.query("SELECT $1::jsonb AS value",[JSON.stringify({text:"bad\ud83d"})]));
      const {rows}=await db.query("SELECT $1::jsonb AS value",[JSON.stringify(catalog)]);
      assert.deepEqual(rows[0].value,catalog);
    }finally{await db.close();}
  });
  // Report generation: nothing sent becomes an RPC error, so the host releases
  // its repeat claim; a possibly received request is a settled failure result.
  const sentBefore=calls.length;
  await assert.rejects(rpc("executeTool",{toolName:"amazon_request_report",parameters:{reportType:"GET_FLAT_FILE_OPEN_LISTINGS_DATA"},runContext:{...runContext,companyId:OTHER}}),/ECOMPANY/);
  assert.equal(calls.length,sentBefore);
  const unknown=await rpc("executeTool",{toolName:"amazon_request_report",parameters:{reportType:"GET_FLAT_FILE_OPEN_LISTINGS_DATA"},runContext});
  assert.match(unknown.error,/EREPORT_UNKNOWN/);assert.equal(unknown.failure.code,"failed");
  assert.equal(calls.filter(c=>c.method==="POST"&&c.path.startsWith("/reports/")).length,1,"a report POST is never retried");
  for(const id of ["r1\ud83d","r1\u0000",credentials.clientSecret,"r1/extra"]){
    reportMode=id;const before=calls.length;
    const out=await rpc("executeTool",{toolName:"amazon_request_report",parameters:{reportType:"GET_FLAT_FILE_OPEN_LISTINGS_DATA"},runContext});
    assert.match(out.error,/EREPORT_UNKNOWN/);assert.equal(out.failure.code,"failed");
    assert.equal(calls.length-before,1,"invalid accepted IDs settle after one POST");assert.ok(!JSON.stringify(out).includes(id));
  }
  reportMode="123456789012";
  for(const hours of [1,8]){
    const dataStartTime=new Date(Date.now()-30*86400_000-hours*3600_000).toISOString();
    const before=calls.length;
    const out=await rpc("executeTool",{toolName:"amazon_request_report",parameters:{reportType:"GET_SALES_AND_TRAFFIC_REPORT",dataStartTime},runContext});
    assert.equal(out.error,undefined);assert.equal(out.data.reportId,reportMode);assert.equal(calls.length-before,1);
    const body=JSON.parse(calls.at(-1).body);assert.equal(Date.parse(body.dataEndTime),Date.parse(dataStartTime)+30*86400_000);
  }
  const sent=calls.length;
  hostConfig={accounts:[]};await rpc("configChanged",{config:hostConfig});
  const revoked=await rpc("executeTool",{toolName:"amazon_test_connection",parameters:{},runContext});assert.match(revoked.error,/ECOMPANY/);assert.equal(calls.length,sent);
  assert.ok(!JSON.stringify([connected,denied,unknown,revoked,audit,stderr]).includes(credentials.clientSecret));
  assert.ok(!JSON.stringify(audit).includes("page2")&&!JSON.stringify(ids).includes("page2"));
  assert.equal(stderr,"");
  await rpc("shutdown",{});const [exitCode]=await once(child,"exit");assert.equal(exitCode,0);
});
