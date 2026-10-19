import test from "node:test";
import assert from "node:assert/strict";
import type { PluginContext, ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { createPlugin } from "./worker.js";
import { REPORT_TYPES, TOOLS } from "./manifest.js";
import { fixture,account,COMPANY,OTHER,CREDS,LWA_FAILURES,HOST_FAILURES,json } from "./fixtures.js";

async function setup(handler: Parameters<typeof fixture>[0] = ()=>json({items:[]}), tokenReply?: typeof LWA_FAILURES[number]["reply"]) {
  const f=fixture(handler);
  if (tokenReply) {
    const send = f.deps.send;
    f.deps.send = async (...args) => args[0].hostname === "api.amazon.com" ? tokenReply() : send(...args);
  }
  const handlers=new Map<string,(p:unknown,c:ToolRunContext)=>Promise<ToolResult>>();
  const logs:unknown[]=[],warnings:string[]=[];
  let auditFails=false,completionFails=false;
  const ctx={...f.ctx,tools:{register:(name:string,_declaration:unknown,handler:any)=>handlers.set(name,handler)},activity:{log:async(entry:any)=>{if(auditFails||(completionFails&&/completed/.test(entry.message)))throw Error(CREDS.clientSecret);logs.push(entry);}},logger:{warn:(message:string)=>warnings.push(message)}} as unknown as PluginContext;
  const plugin=createPlugin(f.deps);await plugin.definition.setup(ctx);
  const run={companyId:COMPANY,agentId:"example-agent",runId:"example-run"};
  return {f,handlers,logs,warnings,plugin,run,failAudit:()=>auditFails=true,failCompletion:()=>completionFails=true};
}
test("registered tools exactly match the manifest and log fixed metadata per successful and denied call",async()=>{
  const s=await setup();assert.deepEqual([...s.handlers.keys()],TOOLS.map(t=>t.name));
  const ok=await s.handlers.get("amazon_test_connection")!({},s.run);assert.equal(ok.error,undefined);assert.equal(s.logs.length,2);
  const denied=await s.handlers.get("amazon_test_connection")!({}, {...s.run,companyId:OTHER});assert.match(denied.error!,/ECOMPANY/);assert.equal(s.logs.length,4);
  assert.ok(!JSON.stringify(s.logs).includes(CREDS.clientSecret));assert.ok(!JSON.stringify(s.logs).includes("seller"));
});

test("R3-L3: worker host lookup failures have sanitized retry codes and pre-report errors release the claim", async () => {
  for (const c of HOST_FAILURES) {
    const s = await setup();
    const reject = async () => { throw Object.assign(new Error(c.message), { code: c.rpc }); };
    if (c.lookup === "secret") s.f.ctx.secrets.resolve = reject; else s.f.ctx.config.get = reject;
    const out = await s.handlers.get("amazon_test_connection")!({}, s.run);
    assert.match(out.error!, new RegExp(c.code)); assert.equal(out.failure?.code, c.host);
    await assert.rejects(s.handlers.get("amazon_request_report")!({ reportType: REPORT_TYPES[1] }, s.run), new RegExp(c.code));
    assert.equal(s.f.calls.length, 0); assert.ok(!JSON.stringify([out, s.logs]).includes(c.message));
  }
});

test("R3-L4/L5: malformed upstream IDs settle failure and advertised argument rules match validation", async () => {
  for (const reportId of ["r1\ud83d", "r1\n", CREDS.clientSecret, "prefix-" + CREDS.sellerId]) {
    const s = await setup(() => json({ reportId }, 202));
    const out = await s.handlers.get("amazon_request_report")!({ reportType: REPORT_TYPES[1] }, s.run);
    assert.match(out.error!, /EREPORT_UNKNOWN/); assert.equal(out.failure?.code, "failed");
    assert.ok(!JSON.stringify(out).includes(reportId));
  }
  const s = await setup(() => json({ reportType: REPORT_TYPES[0], processingStatus: "DONE" }));
  const missing = await s.handlers.get("amazon_get_report")!({ reportId: "r1" }, s.run);
  assert.match(missing.error!, /ERESPONSE/); assert.equal(missing.failure?.code, "failed");
  const report = TOOLS.find(t => t.name === "amazon_request_report")!;
  const props = (report.parametersSchema as any).properties;
  assert.match(report.description!, /requires dataStartTime.*30-day.*inventory types refuse dates/);
  assert.match(props.dataStartTime.description, /Required.*Forbidden/);
  assert.match(props.dataEndTime.description, /earlier of now minus three minutes and start plus 30 days.*Forbidden/);
  const orders = TOOLS.find(t => t.name === "amazon_list_orders")!;
  assert.match(orders.description!, /exactly one start.*730 days/);
  assert.match((orders.parametersSchema as any).properties.createdAfter.description, /730-day/);
  assert.ok(TOOLS.every(t => !("oneOf" in t.parametersSchema!) && !("anyOf" in t.parametersSchema!)));
  const denied = await setup();
  const bad = await denied.handlers.get("amazon_list_orders")!({ createdAfter: 9 }, denied.run);
  assert.equal(bad.failure?.code, "invalid_input"); assert.equal(denied.f.resolves, 0);
});
test("unknown params, URLs, company spoofing, bad types and unbounded values fail before secrets and network",async()=>{
  for(const params of [{companyId:COMPANY},{url:"http://127.0.0.1"},{method:"DELETE"},{account:22},{account:"x".repeat(41)},null,[],{limit:0},{allowedCompanies:[COMPANY]}]){
    const s=await setup();const result=await s.handlers.get("amazon_test_connection")!(params,s.run);assert.match(result.error!,/EINPUT/);assert.equal(result.failure?.code,"invalid_input");assert.equal(s.f.resolves,0);assert.equal(s.f.calls.length,0);
  }
});
test("audit failure prevents reads and never echoes host exception text",async()=>{
  const s=await setup();s.failAudit();const result=await s.handlers.get("amazon_test_connection")!({},s.run);assert.match(result.error!,/EAUDIT/);assert.ok(!result.error!.includes(CREDS.clientSecret));assert.equal(s.f.calls.length,0);
});
test("local config validation and health do not resolve credentials or claim live connectivity",async()=>{
  const s=await setup();const result=await s.plugin.definition.onValidateConfig!({accounts:[]});assert.equal(result.ok,true);assert.match(result.warnings!.join(),/No seller/);
  const invalid=await s.plugin.definition.onValidateConfig!({accounts:"wrong"});assert.equal(invalid.ok,false);
  const health=await s.plugin.definition.onHealth!();assert.match(health.message!,/test_connection/);assert.equal(s.f.resolves,0);assert.equal(s.f.calls.length,0);
});
test("F4: every read declares writes:false and only report generation declares writes:true, with no invented action type",()=>{
  assert.deepEqual(TOOLS.filter(t=>t.writes!==false).map(t=>t.name),["amazon_request_report"]);
  assert.equal(TOOLS.find(t=>t.name==="amazon_request_report")!.writes,true);
  assert.ok(TOOLS.every(t=>typeof t.writes==="boolean"&&t.actionType===undefined&&Number.isInteger(t.executionTimeoutMs)));
  assert.ok(TOOLS.find(t=>t.name==="amazon_list_aplus_publish_records")!.writes===false,"a read named publish is declared a read");
});
test("failures carry the host's failure codes and retry hints",async()=>{
  const s=await setup(()=>json({},429,{"retry-after":"600"}));
  const rated=await s.handlers.get("amazon_test_connection")!({},s.run);
  assert.match(rated.error!,/ERATE/);assert.equal(rated.failure?.code,"unavailable");assert.equal(rated.failure?.retryAfterMs,600_000);
  const denied=await s.handlers.get("amazon_test_connection")!({},{...s.run,companyId:OTHER});assert.equal(denied.failure?.code,"not_authorized");
  const missing=await setup(()=>json({},404));const notFound=await missing.handlers.get("amazon_get_order")!({orderId:"123-1234567-1234567"},missing.run);assert.equal(notFound.failure?.code,"not_found");
  const expired=await setup(()=>json({payload:{transactions:[]},nextToken:"x"}));
  const cursor=await expired.handlers.get("amazon_list_financial_events")!({postedAfter:"2026-09-01T00:00:00Z",cursor:"11111111-1111-4111-8111-999999999999"},expired.run);assert.match(cursor.error!,/ECURSOR/);assert.equal(cursor.failure?.code,"invalid_input");
});

test("R2-2: worker LWA failures carry host retry/reconnect codes, and pre-report failures raise", async () => {
  for (const c of LWA_FAILURES) {
    const s = await setup(undefined, c.reply);
    const out = await s.handlers.get("amazon_test_connection")!({}, s.run);
    assert.match(out.error!, new RegExp(c.code), c.name); assert.equal(out.failure?.code, c.host, c.name);
    assert.equal(out.failure?.retryAfterMs, "retry" in c ? c.retry * 1000 : undefined);
    await assert.rejects(s.handlers.get("amazon_request_report")!({ reportType: REPORT_TYPES[1] }, s.run), new RegExp(c.code));
    assert.equal(s.f.calls.length, 0, "the business API was never reached");
    assert.ok(!JSON.stringify([out, s.logs]).includes(CREDS.clientSecret));
  }
});
test("a completed call stays completed when its outcome log fails",async()=>{
  const s=await setup();s.failCompletion();
  const ok=await s.handlers.get("amazon_test_connection")!({},s.run);assert.equal(ok.error,undefined);assert.equal((ok.data as any).connected,true);assert.deepEqual(s.warnings,["Amazon activity log unavailable."]);
});
test("F4/L6: report generation keeps the host's repeat claim only when Amazon may have received the request",async()=>{
  // Nothing reached Amazon: the handler raises, so the host releases its claim and an identical retry may run.
  const denied=await setup(()=>json({reportId:"created-report"},202));
  await assert.rejects(denied.handlers.get("amazon_request_report")!({reportType:REPORT_TYPES[1]},{...denied.run,companyId:OTHER}),(e:unknown)=>/ECOMPANY/.test((e as Error).message)&&!(e as Error).message.includes(CREDS.clientSecret));
  assert.equal(denied.f.calls.length,0);assert.ok(denied.logs.some((l:any)=>l.metadata.code==="ECOMPANY"));
  const throttled=await setup(c=>c.method==="POST"?json({},429,{"retry-after":"30"}):json({}));
  await assert.rejects(throttled.handlers.get("amazon_request_report")!({reportType:REPORT_TYPES[1]},throttled.run),/ERATE.*30 seconds/);
  const invalid=await setup();await assert.rejects(invalid.handlers.get("amazon_request_report")!({reportType:"GET_FLAT_FILE_ORDERS_DATA"},invalid.run),/EINPUT/);
  const audit=await setup();audit.failAudit();await assert.rejects(audit.handlers.get("amazon_request_report")!({reportType:REPORT_TYPES[1]},audit.run),/EAUDIT/);assert.equal(audit.f.calls.length,0);
  // Possibly received or accepted: a settled failure result, which the host replays instead of running again.
  const unknown=await setup(c=>{if(c.method==="POST")throw Error("connection reset after request");return json({});});
  const u=await unknown.handlers.get("amazon_request_report")!({reportType:REPORT_TYPES[1]},unknown.run);
  assert.match(u.error!,/EREPORT_UNKNOWN/);assert.equal(u.failure?.code,"failed");assert.ok(unknown.logs.some((l:any)=>l.metadata.code==="EREPORT_UNKNOWN"));
  const holder:{f?:ReturnType<typeof fixture>}={};
  const revoked=await setup(c=>{if(c.method==="POST"){holder.f!.setConfig({accounts:[{...account(),allowedCompanies:[]}]});return json({reportId:"created-report-9"},202);}return json({});});holder.f=revoked.f;
  const d=await revoked.handlers.get("amazon_request_report")!({reportType:REPORT_TYPES[1]},revoked.run);
  assert.match(d.error!,/EREPORT_DISPATCHED/);assert.ok(!JSON.stringify(d).includes("created-report-9"));assert.equal(d.failure?.code,"failed");
  const ok=await setup(()=>json({reportId:"created-report"},202));const result=await ok.handlers.get("amazon_request_report")!({reportType:REPORT_TYPES[1]},ok.run);
  assert.equal(result.content,"Amazon report requested.");assert.equal((result.data as any).reportId,"created-report");
});
