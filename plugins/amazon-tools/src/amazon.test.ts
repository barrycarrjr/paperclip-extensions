import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { AmazonService, accounts, pageRows, parseTsv } from "./amazon.js";
import { decode, downloadUrl, publicIPv4, Projector, AmazonError, redact, transport } from "./safety.js";
import { projectRecord, projectWith } from "./paging.js";
import manifest, { REPORT_TYPES, TOOLS, NOTIFICATIONS } from "./manifest.js";
import { extractAplus } from "./aplus.js";
import * as shapes from "./shapes.js";
import { COMPANY,OTHER,MARKET,CREDS,ACCESS,account,fixture,json,type Call } from "./fixtures.js";

const dates={postedAfter:"2026-01-01T00:00:00Z",postedBefore:"2026-01-02T00:00:00Z"};
const code = (name:string) => (e:unknown) => e instanceof AmazonError && e.code===name;

test("R3-L1: complete selected secrets are scrubbed before character/byte cuts and Unicode normalization", async () => {
  const emoji = String.fromCodePoint(0x1f600);
  for (const secret of [...Object.values(CREDS), ACCESS, "unicode-" + emoji + "-example"]) {
    const scrub = (v: unknown) => redact(v, [secret]);
    for (const prefix of ["a".repeat(1490), "a".repeat(1488) + emoji]) {
      const rec = projectRecord({ value: prefix + secret }, { value: true }, scrub);
      const out = JSON.parse(rec.json).value;
      assert.equal(out, prefix + "[redacted]"); assert.ok(!rec.json.includes(secret.slice(0, 7)));
      assert.equal(Buffer.from(out).toString("utf8"), out);
    }
    // 21 strings consume 31,542 bytes, leaving a cut inside the secret.
    const room = 32 * 1024 - 21 * 1502 - 2;
    const raw = [...Array(21).fill("a".repeat(1500)), "b".repeat(room - 7) + secret];
    const rec = projectRecord(raw, [true], scrub);
    assert.ok(!rec.json.includes(secret.slice(0, 7))); assert.ok(rec.truncated);
    assert.equal(Buffer.from(rec.json).toString("utf8"), rec.json);
    const module = { contentModuleType: "STANDARD_TEXT", standardText: { body: { textList: raw.map(value => ({ value })) } } };
    const ap = projectWith(p => extractAplus({ contentModuleList: [module] }, p), scrub);
    assert.ok(!ap.json.includes(secret.slice(0, 7)), "custom A+ projector uses the same string hook");
  }
  let visited = 0;
  const ignored = Object.defineProperty({}, "deep", { enumerable: true, get() { throw Error("unselected provider object must not be visited"); } });
  const rec = projectRecord({ chosen: "safe", unselected: ignored }, { chosen: true }, v => { if (typeof v === "string") visited++; return v; });
  assert.deepEqual(JSON.parse(rec.json), { chosen: "safe" }); assert.equal(visited, 2);
  // Normalization itself must not hide a full credential before redaction.
  const normalized = projectRecord({ value: "a\u0000" + CREDS.clientSecret }, { value: true }, v => redact(v, [CREDS.clientSecret]));
  assert.equal(JSON.parse(normalized.json).value, "a[redacted]");
  const hidden = CREDS.clientSecret.slice(0, 5) + "\u0000" + CREDS.clientSecret.slice(5);
  const afterNormalization = projectRecord({ value: "a".repeat(1490) + hidden }, { value: true }, v => redact(v, [CREDS.clientSecret]));
  assert.equal(JSON.parse(afterNormalization.json).value, "a".repeat(1490) + "[redacted]");
});

test("R3-L1: provider projection, A+ modules, cached cursor records and cached TSV cells retain no secret prefixes", async () => {
  const secrets = [...Object.values(CREDS), ACCESS];
  for (const secret of secrets) {
    const reflected = "a".repeat(1490) + secret;
    const f = fixture(() => json({ sku: "example", summaries: [{ itemName: reflected }] }));
    const listing: any = await f.service.run("get_listing", { sku: "example" }, COMPANY);
    assert.equal(listing.listing.summaries[0].itemName, "a".repeat(1490) + "[redacted]");
    const ap = fixture(() => json({ contentRecord: { contentReferenceKey: "k1", contentDocument: { contentModuleList: [{ contentModuleType: "STANDARD_TEXT", standardText: { body: { textList: [{ value: reflected }] } } }] } } }));
    const a: any = await ap.service.run("get_aplus_content", { contentReferenceKey: "k1" }, COMPANY);
    assert.equal(a.content.modules[0].texts[0], "a".repeat(1490) + "[redacted]");
  }
  const f = fixture(() => json({ items: secrets.map((secret, i) => ({ sku: `SKU-${i}`, summaries: [{ itemName: "a".repeat(1490) + secret }] })) }));
  let cursor: unknown, i = 0;
  do {
    const page: any = await f.service.run("get_inventory_summary", { fulfillment: "MERCHANT", limit: 1, ...(cursor ? { cursor } : {}) }, COMPANY);
    assert.equal(page.inventory[0].summaries[0].itemName, "a".repeat(1490) + "[redacted]");
    cursor = page.nextCursor; i++;
  } while (cursor && i < 10);
  assert.equal(i, secrets.length); assert.equal(f.calls.length, 2, "all later cursor pages came from projected cache");
  const tsv = fixture(c => c.url.pathname.endsWith("/reports/r1") ? json({ reportType: REPORT_TYPES[1], marketplaceIds: [MARKET], processingStatus: "DONE", reportDocumentId: "d1" })
    : c.url.pathname.endsWith("/documents/d1") ? json({ url: "https://d34o8swod1owfl.cloudfront.net/r" })
    : { status: 200, headers: {}, body: Buffer.from("sku\tprice\n" + secrets.map(secret => secret + "\u0000\t1.00").join("\n")) });
  for (let offset = 0; offset < secrets.length; offset++) {
    const out: any = await tsv.service.run("get_report", { reportId: "r1", limit: 1, offset }, COMPANY);
    assert.equal(out.rows[0].sku, "[redacted]"); assert.equal(out.truncated, true);
  }
  assert.equal(tsv.calls.length, 4, "TSV text is scrubbed and normalized before caching");
});
test("company allowlists deny empty, absent, malformed, wildcard and duplicate configuration before secrets or networking",async()=>{
  for(const companies of [[],undefined,null,"*",["*"],[OTHER],[COMPANY,"bad"],[COMPANY,COMPANY]]){
    const f=fixture();f.setConfig({accounts:[{...account(),allowedCompanies:companies}]});
    await assert.rejects(f.service.run("test_connection",{},COMPANY));assert.equal(f.resolves,0);assert.equal(f.calls.length,0);
  }
  for(const config of [{},null,{accounts:"bad"},{accounts:[account(),account()]},{accounts:[{...account(),region:"constructor"}]}]){
    const f=fixture();f.setConfig(config);await assert.rejects(f.service.run("test_connection",{},COMPANY));assert.equal(f.calls.length,0);assert.equal(f.resolves,0);
  }
  const f=fixture();await assert.rejects(f.service.run("test_connection",{},OTHER),code("ECOMPANY"));assert.equal(f.resolves,0);
});
test("credentials must be a company-owned current JSON secret, not raw config",async()=>{
  for(const bad of ["not json","null","[]",JSON.stringify({...CREDS,extra:"bad"}),JSON.stringify({...CREDS,clientSecret:""})]){
    const f=fixture();f.setSecret(bad);await assert.rejects(f.service.run("test_connection",{},COMPANY),code("ECREDENTIALS"));assert.equal(f.calls.length,0);
  }
  const f=fixture();f.setConfig({accounts:[{...account(),credentialsRef:CREDS.clientSecret}]});await assert.rejects(f.service.run("test_connection",{},COMPANY));assert.equal(f.calls.length,0);
});
test("all tools have concrete supported GET mappings; the only provider business POST is allowlisted report generation",async()=>{
  const cases: [string,Record<string,unknown>,string,unknown][] = [
    ["test_connection",{},"/listings/2021-08-01/items/SELLEREXAMPLE",{items:[]}],
    ["list_settlements",{},"/reports/2021-06-30/reports",{reports:[]}],
    ["get_settlement",{reportId:"r1"},"/reports/2021-06-30/reports/r1",{reportId:"r1",reportType:REPORT_TYPES[0],marketplaceIds:[],processingStatus:"IN_QUEUE"}],
    ["list_financial_events",dates,"/finances/2024-06-19/transactions",{payload:{transactions:[]}}],
    ["get_balances",{},"/finances/2024-06-19/balances",{balances:[]}],
    ["get_inventory_summary",{fulfillment:"FBA"},"/fba/inventory/v1/summaries",{payload:{inventorySummaries:[]}}],
    ["get_inventory_summary",{fulfillment:"MERCHANT"},"/listings/2021-08-01/items/SELLEREXAMPLE",{items:[]}],
    ["list_orders",{createdAfter:dates.postedAfter,createdBefore:dates.postedBefore},"/orders/2026-01-01/orders",{orders:[]}],
    ["get_order",{orderId:"123-1234567-1234567"},"/orders/2026-01-01/orders/123-1234567-1234567",{order:{salesChannel:{marketplaceId:MARKET}}}],
    ["list_reports",{reportType:REPORT_TYPES[1]},"/reports/2021-06-30/reports",{reports:[]}],
    ["get_report",{reportId:"r1"},"/reports/2021-06-30/reports/r1",{reportType:REPORT_TYPES[1],marketplaceIds:[MARKET],processingStatus:"IN_QUEUE"}],
    ["request_report",{reportType:REPORT_TYPES[1]},"/reports/2021-06-30/reports",{reportId:"new-report"}],
    ["get_catalog_item",{asin:"B012345678"},"/catalog/2022-04-01/items/B012345678",{asin:"B012345678"}],
    ["get_listing",{sku:"demo/SKU"},"/listings/2021-08-01/items/SELLEREXAMPLE/demo%2FSKU",{sku:"demo/SKU"}],
    ["list_aplus_content",{},"/aplus/2020-11-01/contentDocuments",{contentMetadataRecords:[]}],
    ["get_aplus_content",{contentReferenceKey:"content-1"},"/aplus/2020-11-01/contentDocuments/content-1",{contentRecord:{contentReferenceKey:"content-1",contentDocument:{contentModuleList:[]}}}],
    ["list_aplus_publish_records",{asin:"B012345678"},"/aplus/2020-11-01/contentPublishRecords",{publishRecordList:[]}],
    ["get_notification_subscription",{notificationType:NOTIFICATIONS[0]},"/notifications/v1/subscriptions/ANY_OFFER_CHANGED",{payload:{subscriptionId:"sub",destinationId:"dest",payloadVersion:"1.0"}}],
    ["list_notification_destinations",{},"/notifications/v1/destinations",{payload:[]}],
  ];
  assert.equal(TOOLS.length,18);
  for(const [operation,p,path,response] of cases){
    const f=fixture(()=>json(response));const out=await f.service.run(operation,p,COMPANY);
    const call=f.calls[1];assert.equal(call.url.pathname,path,operation);assert.equal(call.method,operation==="request_report"?"POST":"GET");
    assert.equal(call.headers["x-amz-access-token"],ACCESS);assert.equal(call.url.origin,"https://sellingpartnerapi-na.amazon.com");
    assert.ok(out.provenance);assert.equal(f.calls[0].url.origin,"https://api.amazon.com");
    assert.ok(!f.calls.some(c=>/tokens\/|buyerInfo|address|feeds|shipment/.test(c.url.pathname)));
  }
  assert.ok(!JSON.stringify(manifest).includes("allowMutations"));
});
test("fresh config, credential rotation, and revocation cannot reuse cached authorization or cursors",async()=>{
  const f=fixture(()=>json({items:[]}));await f.service.run("test_connection",{},COMPANY);
  f.advance(1000);await f.service.run("test_connection",{},COMPANY);assert.equal(f.calls.filter(c=>c.url.hostname==="api.amazon.com").length,1);
  f.setSecret(JSON.stringify({...CREDS,refreshToken:"rotated-example-not-real"}));f.advance(1000);await f.service.run("test_connection",{},COMPANY);
  assert.equal(f.calls.filter(c=>c.url.hostname==="api.amazon.com").length,2);
  const before=f.resolves;f.setConfig({accounts:[{...account(),allowedCompanies:[]}]});await assert.rejects(f.service.run("test_connection",{},COMPANY),code("ECOMPANY"));assert.equal(f.resolves,before);
  const r=fixture(()=>{r.setConfig({accounts:[{...account(),allowedCompanies:[]}]});return json({items:[{secret:"not returned"}]});});
  await assert.rejects(r.service.run("test_connection",{},COMPANY),code("ECOMPANY"));
});
test("order outputs use a nested allowlist and never include buyer, tax, gift, address or customization",async()=>{
  const privateValue="example-buyer-should-never-return";
  const row={orderId:"123-1234567-1234567",buyer:{buyerName:privateValue},recipient:{deliveryAddress:privateValue},tax:{taxId:privateValue},salesChannel:{marketplaceId:MARKET},proceeds:{grandTotal:{amount:"10",currencyCode:"USD",privateValue}},orderItems:[{quantityOrdered:2,product:{asin:"B012345678",customization:privateValue,title:"Example"},fulfillment:{quantityFulfilled:1,shipping:{giftOption:privateValue}}}]};
  const f=fixture(()=>json({order:row}));const out=await f.service.run("get_order",{orderId:row.orderId},COMPANY);
  assert.ok(!JSON.stringify(out).includes(privateValue));assert.equal((out.order as any).orderItems[0].quantityOrdered,2);
  assert.equal(f.calls[1].url.searchParams.get("includedData"),"PROCEEDS,FULFILLMENT");
  const x=fixture(()=>json({order:{...row,salesChannel:{marketplaceId:"OTHER"}}}));await assert.rejects(x.service.run("get_order",{orderId:row.orderId},COMPANY),code("ECOMPANY"));
});
test("secrets reflected into allowlisted fields are redacted and untrusted error bodies are discarded",async()=>{
  const f=fixture(()=>json({sku:"example",summaries:[{itemName:CREDS.clientSecret}],attributes:{item_name:[{value:ACCESS}]}}));const out=await f.service.run("get_listing",{sku:"example"},COMPANY);
  assert.ok(!JSON.stringify(out).includes(CREDS.clientSecret));assert.ok(!JSON.stringify(out).includes(ACCESS));assert.match(JSON.stringify(out),/redacted/);
  const e=fixture(()=>json({errors:[{message:JSON.stringify(CREDS)}]},403));await assert.rejects(e.service.run("get_listing",{sku:"example"},COMPANY),error=>{assert.ok(!JSON.stringify(error).includes(CREDS.clientSecret));assert.match((error as Error).message,/403/);return true;});
  const n=fixture(()=>{throw Error(CREDS.refreshToken);});await assert.rejects(n.service.run("get_listing",{sku:"example"},COMPANY),code("ENETWORK"));
});
test("finance uses supported transactions API, permits only real identifier filters and defaults to account-wide for US MFN",async()=>{
  const f=fixture(()=>json({payload:{transactions:[{transactionId:"t1",transactionType:"Disbursement",totalAmount:{currencyCode:"USD",currencyAmount:42},contexts:[{bankAccount:CREDS.clientSecret}],relatedIdentifiers:[{relatedIdentifierName:"DISBURSEMENT_ID",relatedIdentifierValue:"pay1"}]}]}}));
  const out=await f.service.run("list_financial_events",dates,COMPANY);assert.ok(!f.calls[1].url.searchParams.has("marketplaceId"));assert.equal((out.transactions as any)[0].totalAmount.currencyAmount,42);assert.ok(!JSON.stringify(out).includes("bankAccount"));
  const x=fixture();await assert.rejects(x.service.run("list_financial_events",{...dates,relatedIdentifierName:"SETTLEMENT_ID",relatedIdentifierValue:"s1"},COMPANY),code("EINPUT"));assert.equal(x.calls.length,0);
});
test("merchant inventory reads DEFAULT live quantities and never invents an unavailable quantity",async()=>{
  const f=fixture(()=>json({items:[{sku:"one",fulfillmentAvailability:[{fulfillmentChannelCode:"DEFAULT",quantity:3},{fulfillmentChannelCode:"AMAZON_NA",quantity:99}]},{sku:"missing"}]}));
  const out=await f.service.run("get_inventory_summary",{fulfillment:"MERCHANT"},COMPANY);assert.deepEqual((out.inventory as any)[0].fulfillmentAvailability,[{fulfillmentChannelCode:"DEFAULT",quantity:3}]);assert.deepEqual((out.inventory as any)[1].fulfillmentAvailability,[]);
});
test("pagination binds company, connection, secret and exact query; reports use nextToken as their sole query parameter",async()=>{
  const f=fixture(()=>json({reports:[],nextToken:"provider-token-should-stay-private"}));
  const p={reportType:REPORT_TYPES[1],limit:1};const first=await f.service.run("list_reports",p,COMPANY);assert.ok(first.nextCursor);assert.ok(!JSON.stringify(first).includes("provider-token"));
  f.advance(100000);await f.service.run("list_reports",{...p,cursor:first.nextCursor},COMPANY);const q=f.calls.at(-1)!.url.searchParams;assert.equal(q.size,1);assert.equal(q.get("nextToken"),"provider-token-should-stay-private");
  await assert.rejects(f.service.run("list_reports",{...p,limit:2,cursor:first.nextCursor},COMPANY),code("ECURSOR"));
  f.setSecret(JSON.stringify({...CREDS,clientSecret:"new-example-not-real"}));await assert.rejects(f.service.run("list_reports",{...p,cursor:first.nextCursor},COMPANY),code("ECURSOR"));
  const s=fixture(()=>json({orders:[],pagination:{nextToken:"page2"}}));const o={createdAfter:new Date(Date.now()-86400_000).toISOString()};const a=await s.service.run("list_orders",o,COMPANY);const before=s.calls[1].url.searchParams.get("createdBefore");s.advance(200000);await s.service.run("list_orders",{...o,cursor:a.nextCursor},COMPANY);assert.equal(s.calls.at(-1)!.url.searchParams.get("createdBefore"),before);
  s.advance(900001);await assert.rejects(s.service.run("list_orders",{...o,cursor:a.nextCursor},COMPANY),code("ECURSOR"));
});
test("GET backoff is bounded, respects rate headers and Retry-After; POST is never repeated blindly",async()=>{
  let tries=0;const f=fixture(()=>++tries<3?json({},429,{"retry-after":"2","x-amzn-ratelimit-limit":"10"}):json({items:[]}));await f.service.run("test_connection",{},COMPANY);assert.equal(tries,3);assert.deepEqual(f.waits,[2000,2000]);
  const slow=fixture(()=>json({},429,{"retry-after":"600"}));await assert.rejects(slow.service.run("test_connection",{},COMPANY),code("ERATE"));assert.equal(slow.calls.length,2);assert.deepEqual(slow.waits,[]);
  let posts=0;const post=fixture(()=>{posts++;throw Error("timeout after request sent");});await assert.rejects(post.service.run("request_report",{reportType:REPORT_TYPES[1]},COMPANY),code("EREPORT_UNKNOWN"));assert.equal(posts,1);
  const error=fixture(()=>json({},503));await assert.rejects(error.service.run("request_report",{reportType:REPORT_TYPES[1]},COMPANY),code("EREPORT_UNKNOWN"));assert.equal(error.calls.length,2);
  // Concurrent calls share one bucket: Amazon's burst of 5 runs at once, the sixth waits for a refill.
  let ongoing=0,max=0;const concurrent=fixture(async()=>{ongoing++;max=Math.max(max,ongoing);await Promise.resolve();ongoing--;return json({items:[]});});await Promise.all(Array.from({length:5},()=>concurrent.service.run("test_connection",{},COMPANY)));assert.deepEqual(concurrent.waits,[]);assert.ok(max<=5);
  await Promise.all([concurrent.service.run("test_connection",{},COMPANY),concurrent.service.run("test_connection",{},COMPANY)]);assert.equal(concurrent.waits.length,2);assert.ok(concurrent.waits.every(w=>w>0&&w<=400),String(concurrent.waits));
});
test("no report type or metadata can bypass the PII allowlist and settlement reports cannot be requested",async()=>{
  for(const reportType of [REPORT_TYPES[0],"GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL","GET_FLAT_FILE_ORDERS_DATA","http://127.0.0.1"]){const f=fixture();await assert.rejects(f.service.run("request_report",{reportType},COMPANY),code("EREPORT"));assert.equal(f.calls.length,0);}
  for(const report of [{reportType:"GET_FLAT_FILE_ORDERS_DATA",marketplaceIds:[MARKET]},{reportType:REPORT_TYPES[1],marketplaceIds:["OTHER"]},{reportType:REPORT_TYPES[1],marketplaceIds:[]},{reportType:REPORT_TYPES[1],marketplaceIds:"bad"}]){const f=fixture(()=>json({...report,processingStatus:"DONE",reportDocumentId:"d1"}));await assert.rejects(f.service.run("get_report",{reportId:"r1"},COMPANY),code("EREPORT"));assert.equal(f.calls.length,2);}
});
test("download allowlist blocks URL credentials, local and non-HTTPS targets, foreign services and lookalikes",()=>{
  for(const u of ["http://tortuga-prod-na.s3.amazonaws.com/file","https://127.0.0.1/file","https://localhost/file","https://s3.amazonaws.com/file","https://sts.amazonaws.com/file","https://example.com/file","https://d12345678.cloudfront.net.evil.example/file","https://x:y@d12345678.cloudfront.net/file","https://d12345678.cloudfront.net:444/file","https://d12345678.cloudfront.net/file#fragment"]){assert.throws(()=>downloadUrl(u),code("EDOWNLOAD"),u);}
  for(const u of ["https://tortuga-prod-na.s3-external-1.amazonaws.com/file?sig=example","https://tortuga-prod-eu.s3.eu-west-1.amazonaws.com/file","https://d34o8swod1owfl.cloudfront.net/file"])assert.ok(downloadUrl(u));
  for(const ip of ["127.0.0.1","10.1.1.1","169.254.169.254","172.16.1.1","192.168.1.1","100.64.0.1","::1","::ffff:127.0.0.1","224.0.0.1"])assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4("8.8.8.8"),true);
});
test("report download sends no access token, parses bounded gzip TSV, strips unknown buyer columns, and never returns the URL",async()=>{
  const f=fixture(c=>{
    if(c.url.pathname.endsWith("/reports/r1"))return json({reportId:"r1",reportType:REPORT_TYPES[0],marketplaceIds:[],processingStatus:"DONE",reportDocumentId:"d1"});
    if(c.url.pathname.endsWith("/documents/d1"))return json({url:"https://tortuga-prod-na.s3.amazonaws.com/file?sig=secret-url",compressionAlgorithm:"GZIP"});
    return {status:200,headers:{"content-encoding":"gzip"},body:gzipSync("settlement-id\tdeposit-date\ttotal-amount\tamount\tbuyer-name\nsettle1\t2026-01-02\t95,00\t95,00\tDO-NOT-RETURN\n")};
  });
  const out=await f.service.run("get_settlement",{reportId:"r1"},COMPANY);const last=f.calls.at(-1)!;assert.equal(last.headers["x-amz-access-token"],undefined);assert.equal(last.method,"GET");assert.equal((out.rows as any)[0].amount,"95,00");assert.ok(!JSON.stringify(out).includes("DO-NOT-RETURN"));assert.ok(!JSON.stringify(out).includes("secret-url"));
  assert.equal(f.calls.length,4);
});
test("report URL redirects never result in another request and gzip bombs fail closed",async()=>{
  const f=fixture(c=>c.url.pathname.endsWith("/reports/r1")?json({reportType:REPORT_TYPES[1],marketplaceIds:[MARKET],processingStatus:"DONE",reportDocumentId:"d1"}):c.url.pathname.endsWith("/documents/d1")?json({url:"https://d34o8swod1owfl.cloudfront.net/file"}):{status:302,headers:{location:"http://169.254.169.254/"},body:Buffer.from("")});
  await assert.rejects(f.service.run("get_report",{reportId:"r1"},COMPANY),code("EHTTP"));assert.equal(f.calls.length,4);
  assert.throws(()=>decode({status:200,headers:{},body:gzipSync(Buffer.alloc(9*1024*1024))},true),code("ERESPONSE"));
  assert.throws(()=>decode({status:200,headers:{},body:Buffer.from([0xff,0xfe])}),code("ERESPONSE"));
});
test("TSV handles pagination and decimal commas, rejects column shifts and duplicate headers",()=>{
  const parsed=parseTsv("sku\tquantity\tbuyer\r\na\t3\tPRIVATE\r\nb\t4\tPRIVATE\r\n",["sku","quantity"]);assert.deepEqual(parsed,{columns:["sku","quantity"],rows:["a\t3","b\t4"]});
  assert.deepEqual(pageRows(parsed.columns,parsed.rows,0,1),{rows:[{sku:"a",quantity:"3"}],rowCount:2,nextOffset:1});
  for(const s of ["sku\tsku\na\tb","sku\tquantity\na\t3\textra","sku\tquantity\n\"a\nprivate\"\t3"])assert.throws(()=>parseTsv(s,["sku","quantity"]),code("ERESPONSE"));
});
test("A+ follows official module field paths, omits unknown objects and bounds text",()=>{
  const p=new Projector();const data=extractAplus({name:"Example",locale:"en-US",contentModuleList:[{contentModuleType:"STANDARD_TEXT",standardText:{headline:{value:"Title"},body:{textList:[{value:"Description"}]}},buyer:{value:"PRIVATE"}}]},p);
  assert.deepEqual(data.modules[0].texts,["Title","Description"]);assert.ok(!JSON.stringify(data).includes("PRIVATE"));
  const large=new Projector();large.pick(Array.from({length:101},()=>({value:"x".repeat(2000)})),[{value:true}]);assert.equal(large.truncated,true);
});
test("Notifications use seller authorization for subscriptions and distinct grantless token for destinations",async()=>{
  const f=fixture(c=>c.url.pathname.includes("destinations")?json({payload:[{destinationId:"dest1",name:"PRIVATE-NAME",resource:{sqs:{arn:"PRIVATE-ARN"}}}]}):json({payload:{subscriptionId:"sub1",destinationId:"dest1",payloadVersion:"1.0",processingDirective:{private:"PRIVATE"}}}));
  await f.service.run("get_notification_subscription",{notificationType:NOTIFICATIONS[0]},COMPANY);
  const d=await f.service.run("list_notification_destinations",{},COMPANY);assert.ok(!JSON.stringify(d).includes("PRIVATE"));assert.equal(d.eventIngestion,false);
  const tokenCalls=f.calls.filter(c=>c.url.hostname==="api.amazon.com");assert.equal(tokenCalls.length,2);const body=new URLSearchParams(tokenCalls[1].body);assert.equal(body.get("grant_type"),"client_credentials");assert.equal(body.get("scope"),"sellingpartnerapi::notifications");assert.equal(body.has("refresh_token"),false);
});
test("input paths, date ranges, marketplace and filters cannot become unrestricted API access",async()=>{
  for(const [op,p] of [["get_listing",{sku:".."}],["get_report",{reportId:".."}],["get_catalog_item",{asin:"../tokens"}],["list_orders",{}],["list_orders",{createdAfter:dates.postedAfter,lastUpdatedAfter:dates.postedAfter}],["list_financial_events",{postedAfter:"not a date"}],["get_inventory_summary",{fulfillment:"FBA",marketplaceId:"OTHER"}],["get_notification_subscription",{notificationType:"ORDER_CHANGE"}]] as [string,any][]){const f=fixture();await assert.rejects(f.service.run(op,p,COMPANY));assert.equal(f.calls.length,0);}
});
test("the native HTTPS transport rejects private DNS answers before connecting",async()=>{
  const original=dns.lookup;
  try {
    dns.lookup=((_host:unknown,_options:unknown,callback:any)=>callback(null,[{address:"169.254.169.254",family:4}])) as typeof dns.lookup;
    syncBuiltinESMExports();
    // Refused before any connection: provably never sent, so a report request can be retried.
    await assert.rejects(transport(new URL("https://d34o8swod1owfl.cloudfront.net/file"),"GET",{}),e=>code("ENETWORK")(e)&&(e as AmazonError).notSent===true);
  } finally { dns.lookup=original;syncBuiltinESMExports(); }
});
test("settlements with omitted optional marketplace IDs remain discoverable and downloads never use a caller document URL",async()=>{
  const f=fixture(()=>json({reports:[{reportId:"settlement-report",reportType:REPORT_TYPES[0],processingStatus:"DONE"}]}));
  const out=await f.service.run("list_settlements",{},COMPANY);
  assert.equal((out.reports as any).length,1);assert.equal(f.calls[1].url.searchParams.has("marketplaceIds"),false);
});
test("sales report creation fixes safe options and JSON download projects both paginated datasets",async()=>{
  const create=fixture(()=>json({reportId:"sales1"}));await create.service.run("request_report",{reportType:REPORT_TYPES[3],dataStartTime:dates.postedAfter,dataEndTime:dates.postedBefore},COMPANY);
  assert.deepEqual(JSON.parse(create.calls[1].body!).reportOptions,{dateGranularity:"DAY",asinGranularity:"SKU"});
  const f=fixture(c=>c.url.pathname.endsWith("/reports/sales1")?json({reportType:REPORT_TYPES[3],marketplaceIds:[MARKET],processingStatus:"DONE",reportDocumentId:"d1"}):c.url.pathname.endsWith("/documents/d1")?json({url:"https://d34o8swod1owfl.cloudfront.net/report"}):json({salesAndTrafficByDate:[{date:"2026-01-01",salesByDate:{unitsOrdered:3,buyerName:"PRIVATE"}},{date:"2026-01-02"}],salesAndTrafficByAsin:[{sku:"one",salesByAsin:{orderedProductSales:{amount:10,currencyCode:"USD"}}}],buyerName:"PRIVATE"}));
  const out=await f.service.run("get_report",{reportId:"sales1",limit:1},COMPANY);assert.equal(out.nextDateOffset,1);assert.equal(out.nextAsinOffset,null);assert.equal(out.nextOffset,undefined);assert.equal((out.salesAndTrafficByDate as any)[0].salesByDate.unitsOrdered,3);assert.ok(!JSON.stringify(out).includes("PRIVATE"));
});
test("access tokens refresh on expiry and malformed token grants never become authorization headers",async()=>{
  const f=fixture(()=>json({items:[]}));await f.service.run("test_connection",{},COMPANY);f.advance(3600_000);await f.service.run("test_connection",{},COMPANY);assert.equal(f.calls.filter(c=>c.url.hostname==="api.amazon.com").length,2);
  for(const response of [{access_token:ACCESS,expires_in:3600,token_type:{}},{access_token:"bad\r\ntoken",expires_in:3600,token_type:"bearer"},{access_token:ACCESS,expires_in:0,token_type:"bearer"}]){
    const x=fixture();const service=new AmazonService(x.ctx,{send:async()=>json(response)});await assert.rejects(service.run("test_connection",{},COMPANY),code("EAUTH"));
  }
});
test("invalid calendar dates and mislabeled gzip fail closed",async()=>{
  const f=fixture();await assert.rejects(f.service.run("get_balances",{asOfDate:"2026-02-31"},COMPANY),code("EINPUT"));assert.equal(f.calls.length,0);
  assert.throws(()=>decode({status:200,headers:{},body:Buffer.from("sku\nexample")},true),code("ERESPONSE"));
});
test("an allowed storage hostname cannot receive credentials reflected into its download URL",async()=>{
  const f=fixture(c=>c.url.pathname.endsWith("/reports/r1")?json({reportType:REPORT_TYPES[1],marketplaceIds:[MARKET],processingStatus:"DONE",reportDocumentId:"d1"}):json({url:`https://d34o8swod1owfl.cloudfront.net/report?credential=${encodeURIComponent(ACCESS)}`}));
  await assert.rejects(f.service.run("get_report",{reportId:"r1"},COMPANY),code("EDOWNLOAD"));assert.equal(f.calls.length,3);
});
test("F2: merchant inventory never asks Amazon for more than 20 listings per page",async()=>{
  for(const [limit,expected] of [[undefined,"20"],[5,"5"],[20,"20"],[100,"20"]] as const){
    const f=fixture(()=>json({items:[]}));await f.service.run("get_inventory_summary",{fulfillment:"MERCHANT",...(limit?{limit}:{})},COMPANY);
    assert.equal(f.calls[1].url.searchParams.get("pageSize"),expected,String(limit));
  }
});
test("F3: A+ continuations send pageToken as their only parameter",async()=>{
  for(const [operation,params,rows] of [["list_aplus_content",{},"contentMetadataRecords"],["list_aplus_publish_records",{asin:"B012345678"},"publishRecordList"]] as const){
    let n=0;const f=fixture(()=>json({[rows]:[],...(++n===1?{nextPageToken:"tok2"}:{})}));
    const first=await f.service.run(operation,params,COMPANY);assert.ok(first.nextCursor);
    await f.service.run(operation,{...params,cursor:first.nextCursor},COMPANY);
    assert.deepEqual(Object.fromEntries(f.calls.at(-1)!.url.searchParams),{pageToken:"tok2"},operation);
    assert.equal(f.calls[1].url.searchParams.get("marketplaceId"),MARKET);
  }
});
test("F5: quote characters in unquoted TSV cells are data, while column counts stay strict",()=>{
  const header=["sku","fnsku","asin","product-name","condition","your-price","afn-fulfillable-quantity"].join("\t");
  const row=["SKU-1","X001","B012345678","Example 12\" skillet","New","19.99","9"].join("\t");
  const parsed=parseTsv(`${header}\n${row}\n`,shapes.inventoryColumns);
  assert.deepEqual(pageRows(parsed.columns,parsed.rows,0,25).rows,[{sku:"SKU-1",fnsku:"X001",asin:"B012345678",condition:"New","your-price":"19.99","afn-fulfillable-quantity":"9"}]);
  assert.deepEqual(parseTsv("sku\tquantity\n12\" \"pan\"\t3\n",["sku","quantity"]).rows,["12\" \"pan\"\t3"]);
  for(const s of [`${header}\n${row}\textra\n`,`${header}\nSKU-1\t"multi\nline"\tB012345678\n`,`"sku"\tquantity\na\t1`])assert.throws(()=>parseTsv(s,shapes.inventoryColumns),code("ERESPONSE"),s);
});
test("F7: A+ comparison tables return product titles, metric values and row labels from the official model shapes",async()=>{
  const module={contentModuleType:"STANDARD_COMPARISON_TABLE",standardComparisonTable:{productColumns:[{position:1,title:"Model A",asin:"B012345678",highlight:true,image:{altText:"PRIVATE-ALT",uploadDestinationId:"PRIVATE-UPLOAD",imageCropSpecification:{size:{width:{value:1,units:"pixels"},height:{value:1,units:"pixels"}}}},metrics:[{position:1,value:"5 lbs"},{position:2,value:"Blue"}]}],metricRowLabels:[{position:1,value:"Weight"},{position:2,value:"Color"}]}};
  const data=extractAplus({name:"Doc",contentType:"EBC",locale:"en-US",contentModuleList:[module]},new Projector());
  assert.deepEqual(data.modules[0].texts,["Model A","5 lbs","Blue","Weight","Color"]);assert.ok(!JSON.stringify(data).includes("PRIVATE"));
  const f=fixture(()=>json({contentRecord:{contentReferenceKey:"k1",contentDocument:{name:"Doc",contentType:"EBC",locale:"en-US",contentModuleList:[module]}}}));
  const out:any=await f.service.run("get_aplus_content",{contentReferenceKey:"k1"},COMPANY);
  assert.deepEqual(out.content.modules,[{moduleType:"STANDARD_COMPARISON_TABLE",texts:["Model A","5 lbs","Blue","Weight","Color"]}]);assert.equal(out.nextModuleOffset,null);assert.ok(!JSON.stringify(out).includes("PRIVATE"));
});
test("L2: catalog summaries keep the 2022-04-01 brand field",async()=>{
  const f=fixture(()=>json({asin:"B012345678",summaries:[{marketplaceId:MARKET,brand:"ExampleBrand",itemName:"Example",websiteDisplayGroupName:"Kitchen"}]}));
  const out:any=await f.service.run("get_catalog_item",{asin:"B012345678"},COMPANY);
  assert.deepEqual(out.item.summaries,[{marketplaceId:MARKET,itemName:"Example",brand:"ExampleBrand"}]);
});

test("R2-L1: text normalization and both projection cuts preserve valid Unicode, numeric values and secret scrubbing", async () => {
  const emoji = String.fromCodePoint(0x1f600);
  for (const [value, expected] of [
    ["a".repeat(1499) + emoji + "b", "a".repeat(1499)],
    ["a".repeat(1498) + emoji + "b", "a".repeat(1498) + emoji],
    ["Pan\u0000 12in", "Pan 12in"],
    ["x\ud83dy\ude00z", "x\ufffdy\ufffdz"],
    [emoji + "\ud83d" + emoji + "\ude00", emoji + "\ufffd" + emoji + "\ufffd"],
  ]) {
    const p = new Projector(); const result = p.pick(value, true);
    assert.equal(result, expected); assert.equal(p.truncated, true);
    assert.equal(Buffer.from(result).toString("utf8"), result);
    assert.ok(!result.includes("\u0000"));
  }
  for (let budget = 0; budget < 32; budget++) {
    const p = new Projector(1400, budget); const result = p.pick("abc" + emoji.repeat(10), true);
    if (result !== undefined) {
      assert.equal(Buffer.from(result).toString("utf8"), result, `budget ${budget}`);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget);
    }
  }
  const p = new Projector();
  const values = p.pick([...Array.from({ length: 21 }, () => "a".repeat(1500)), "x".repeat(1223) + emoji.repeat(200)], [true]);
  assert.equal(p.truncated, true); assert.equal(values.length, 22);
  assert.ok(values.reduce((n: number, v: string) => n + Buffer.byteLength(JSON.stringify(v)), 0) <= 32 * 1024);
  assert.ok(values.every((v: string) => Buffer.from(v).toString("utf8") === v));
  const raw = { title: "Pan" + emoji + CREDS.clientSecret, id: "000123", amount: "1,00", count: 7, enabled: true };
  const clean = JSON.parse(projectRecord(raw, { title: true, id: true, amount: true, count: true, enabled: true }, v => redact(v, [CREDS.clientSecret])).json);
  assert.deepEqual(clean, { ...raw, title: "Pan" + emoji + "[redacted]" });
  const f = fixture(() => json({ asin: "B012345678", summaries: [{ marketplaceId: MARKET, itemName: "Pan\u0000" + emoji + "\ud83d" }] }));
  const out: any = await f.service.run("get_catalog_item", { asin: "B012345678" }, COMPANY);
  assert.equal(out.item.summaries[0].itemName, "Pan" + emoji + "\ufffd"); assert.equal(out.truncated, true);
});

test("R2-L1: projected TSV text and cached rows cannot carry NUL, while decimal and identifier strings stay exact", async () => {
  const f = fixture(c => c.url.pathname.endsWith("/reports/r1") ? json({ reportType: REPORT_TYPES[1], marketplaceIds: [MARKET], processingStatus: "DONE", reportDocumentId: "d1" }) : c.url.pathname.endsWith("/documents/d1") ? json({ url: "https://d34o8swod1owfl.cloudfront.net/r" }) : { status: 200, headers: {}, body: Buffer.from("sku\tprice\nSKU-\u0000example\t001,00\n000123\t2.00\n") });
  for (const offset of [0, 1]) {
    const out: any = await f.service.run("get_report", { reportId: "r1", offset, limit: 1 }, COMPANY);
    assert.equal(out.truncated, true); assert.ok(!JSON.stringify(out).includes("\\u0000"));
    assert.deepEqual(out.rows, [offset ? { sku: "000123", price: "2.00" } : { sku: "SKU-example", price: "001,00" }]);
  }
  assert.equal(f.calls.filter(c => c.url.hostname.endsWith("cloudfront.net")).length, 1);
});
test("L6: a report Amazon accepted is reported as dispatched, without its ID, when access changes before the result returns",async()=>{
  const revoked=fixture(c=>{if(c.method==="POST"){revoked.setConfig({accounts:[{...account(),allowedCompanies:[]}]});return json({reportId:"created-report-1"},202);}return json({});});
  await assert.rejects(revoked.service.run("request_report",{reportType:REPORT_TYPES[1]},COMPANY),e=>code("EREPORT_DISPATCHED")(e)&&(e as AmazonError).dispatch==="accepted"&&!(e as Error).message.includes("created-report-1")&&/Do not request it again/.test((e as Error).message));
  assert.equal(revoked.calls.filter(c=>c.method==="POST"&&c.url.hostname!=="api.amazon.com").length,1);
  const rotated=fixture(c=>{if(c.method==="POST"){rotated.setSecret(JSON.stringify({...CREDS,clientSecret:"rotated-example-not-real"}));return json({reportId:"created-report-2"},202);}return json({});});
  await assert.rejects(rotated.service.run("request_report",{reportType:REPORT_TYPES[1]},COMPANY),e=>code("EREPORT_DISPATCHED")(e)&&!(e as Error).message.includes("created-report-2"));
  const ok=fixture(()=>json({reportId:"created-report-3"},202));const out=await ok.service.run("request_report",{reportType:REPORT_TYPES[1]},COMPANY);assert.equal(out.reportId,"created-report-3");
});
test("L7: report downloads honour an allowlisted Content-Type charset and fail closed otherwise",async()=>{
  const reply=(body:Buffer,type?:string)=>({status:200,headers:(type?{"content-type":type}:{}) as Record<string,string>,body});
  // Expected text is built from code points so this source stays ASCII.
  const u=(...codes:number[])=>String.fromCharCode(...codes);
  const cp1252=Buffer.from([0x63,0x61,0x66,0xe9,0x20,0x93,0x71,0x94]),cafe=`caf${u(0xe9)} ${u(0x201c)}q${u(0x201d)}`;
  for(const type of ["text/plain;charset=Cp1252","text/plain; charset=\"windows-1252\""])assert.equal(decode(reply(cp1252,type),false,true),cafe,type);
  // The whole 0x80 to 0x9F range follows the WHATWG index, not Latin-1 control characters.
  assert.equal(decode(reply(Buffer.from([0x80,0x8a,0x99,0x9f,0xff]),"text/plain;charset=cp1252"),false,true),u(0x20ac,0x160,0x2122,0x178,0xff));
  assert.equal(decode(reply(Buffer.from([0x83,0x65,0x83,0x58,0x83,0x67]),"text/plain; charset=Shift_JIS"),false,true),u(0x30c6,0x30b9,0x30c8));
  assert.equal(decode(reply(Buffer.from(`caf${u(0xe9)}`),"text/plain; charset=UTF-8"),false,true),`caf${u(0xe9)}`);
  assert.equal(decode(reply(Buffer.from("plain ascii"),"application/json"),false,true),"plain ascii");
  assert.equal(decode({status:200,headers:{"content-type":"text/plain;charset=Cp1252"},body:gzipSync(cp1252)},true,true),cafe);
  assert.throws(()=>decode(reply(cp1252,"text/plain"),false,true),code("ERESPONSE"),"an undeclared non-UTF-8 document is never guessed");
  assert.throws(()=>decode(reply(Buffer.from([0x83]),"text/plain; charset=Shift_JIS"),false,true),code("ERESPONSE"));
  for(const type of ["text/plain; charset=iso-8859-2","text/plain; charset=utf-16","text/plain; charset=utf-8; charset=cp1252","text/plain; charset="])assert.throws(()=>decode(reply(Buffer.from("x"),type),false,true),code("EDOWNLOAD"),type);
  const f=fixture(c=>c.url.pathname.endsWith("/reports/r1")?json({reportType:REPORT_TYPES[1],marketplaceIds:[MARKET],processingStatus:"DONE",reportDocumentId:"d1"}):c.url.pathname.endsWith("/documents/d1")?json({url:"https://d34o8swod1owfl.cloudfront.net/r"}):reply(Buffer.concat([Buffer.from("sku\tprice\nSKU-"),cp1252,Buffer.from("\t9,99\n")]),"text/plain;charset=Cp1252"));
  const out:any=await f.service.run("get_report",{reportId:"r1"},COMPANY);assert.deepEqual(out.rows,[{sku:`SKU-${cafe}`,price:"9,99"}]);
});
