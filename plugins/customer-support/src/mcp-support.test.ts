import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import type { Config } from "./routing.js";
import { checkMcpConnection,mcpProfile } from "./mcp-support.js";
const companyId="11111111-1111-4111-8111-111111111111";
const run={companyId,userId:"operator",chatSessionId:"chat",userPermission:"support:diagnose"} as ToolRunContext;
const tool={name:"example_lookup",description:"PRIVATE SERVER INSTRUCTIONS",inputSchema:{type:"object"}};
function fixture(){
  const cfg:Config={mcpConnections:[{id:"example",allowedCompanies:[companyId],endpoint:"https://mcp.example.com/mcp",enabled:true,protocol:"Auto",tokenRef:"22222222-2222-4222-8222-222222222222"}]};let secrets=0;const audit:any[]=[];
  const ctx={secrets:{resolve:async()=>{secrets++;return"synthetic-mcp-test-value";}},activity:{log:async(value:any)=>audit.push(value)}} as unknown as PluginContext;
  return{cfg,ctx,audit,secrets:()=>secrets};
}
function json(id:string,result:unknown,headers?:Record<string,string>){return Response.json({jsonrpc:"2.0",id,result},{headers});}
test("modern MCP metadata succeeds on an actual loopback server, with no external tool calls or content disclosure",async()=>{
  const f=fixture();const methods:string[]=[];
  const server=createServer(async(req,res)=>{let text="";for await(const chunk of req)text+=chunk;const message=JSON.parse(text);methods.push(message.method);assert.equal(req.headers.authorization,"Bearer synthetic-mcp-test-value");assert.equal(req.headers["mcp-protocol-version"],"2026-07-28");assert.equal(req.headers["mcp-method"],"tools/list");assert.equal(message.params._meta["io.modelcontextprotocol/protocolVersion"],"2026-07-28");res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({jsonrpc:"2.0",id:message.id,result:{tools:[tool]}}));});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  try{f.cfg.mcpConnections![0]!.endpoint=`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;const result=await checkMcpConnection(f.ctx,async()=>f.cfg,run,{connectionId:"example"});assert.equal(result.status,"catalog_observed");assert.equal(result.toolCount,1);assert.deepEqual(methods,["tools/list"]);assert.doesNotMatch(JSON.stringify([result,f.audit]),/PRIVATE|example_lookup|synthetic-mcp-test-value|127\.0\.0\.1/);}
  finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
test("auto fallback initializes a legacy session, counts a bounded SSE catalog and terminates only its own session",async()=>{
  const f=fixture(),methods:string[]=[];
  const result=await checkMcpConnection(f.ctx,async()=>f.cfg,run,{connectionId:"example"},async(_url,init)=>{
    assert.equal(init!.redirect,"manual");assert.ok(init!.signal);const headers=new Headers(init!.headers);
    if(init!.method==="DELETE"){methods.push("DELETE");assert.equal(headers.get("MCP-Session-Id"),"synthetic-session");return new Response(null,{status:204});}
    const body=JSON.parse(init!.body as string);methods.push(body.method);
    if(headers.get("MCP-Protocol-Version")==="2026-07-28")return new Response(null,{status:400});
    if(body.method==="initialize")return json(body.id,{protocolVersion:"2025-06-18",capabilities:{tools:{}},instructions:"PRIVATE SERVER INSTRUCTIONS"},{"MCP-Session-Id":"synthetic-session"});
    assert.equal(headers.get("MCP-Protocol-Version"),"2025-06-18");assert.equal(headers.get("MCP-Session-Id"),"synthetic-session");
    if(body.method==="notifications/initialized")return new Response(null,{status:202});
    const stream=`: heartbeat\r\n\r\ndata: ${JSON.stringify({jsonrpc:"2.0",method:"notifications/progress",params:{message:"PRIVATE PROGRESS"}})}\r\n\r\ndata: ${JSON.stringify({jsonrpc:"2.0",id:body.id,result:{tools:[tool]}})}\r\n\r\n`;
    return new Response(stream,{headers:{"Content-Type":"text/event-stream"}});
  });
  assert.equal(result.protocol,"2025-06-18");assert.equal(result.toolCount,1);assert.equal(result.sessionCleanup,"terminated");assert.deepEqual(methods,["tools/list","initialize","notifications/initialized","tools/list","DELETE"]);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|synthetic-session|example_lookup/);
});
test("company, human permission, opt-in and exact safe endpoints precede Secrets; revocation blocks follow-up",async()=>{
  const f=fixture();let calls=0;const send=async()=>{calls++;return new Response(null,{status:401});};
  await assert.rejects(checkMcpConnection(f.ctx,async()=>f.cfg,{...run,companyId:"33333333-3333-4333-8333-333333333333"},{connectionId:"example"},send));
  await assert.rejects(checkMcpConnection(f.ctx,async()=>f.cfg,{...run,userId:undefined},{connectionId:"example"},send));
  await assert.rejects(checkMcpConnection(f.ctx,async()=>f.cfg,{...run,userPermission:"support:respond"},{connectionId:"example"},send));
  f.cfg.mcpConnections![0]!.endpoint="https://mcp.example.com/mcp?access_token=synthetic-value";assert.throws(()=>mcpProfile(f.cfg,companyId,"example"));assert.equal(f.secrets(),0);assert.equal(calls,0);
  f.cfg.mcpConnections![0]!.endpoint="https://mcp.example.com/mcp";
  await assert.rejects(checkMcpConnection(f.ctx,async()=>f.cfg,run,{connectionId:"example"},async(_url,init)=>{calls++;f.cfg.mcpConnections![0]!.enabled=false;return json(JSON.parse(init!.body as string).id,{tools:[tool],nextCursor:"another"});}));assert.equal(calls,1);
});
test("redirects, rejected authentication, mismatched IDs, oversized responses and server requests never become a catalog",async()=>{
  const f=fixture();
  for(const send of [async()=>new Response(null,{status:302,headers:{Location:"https://example.com"}}),async()=>new Response(null,{status:401}),async()=>json("wrong-id",{tools:[tool]}),async(_url:string,init?:RequestInit)=>json(JSON.parse(init!.body as string).id,{tools:[],unexpected:"x".repeat(128001)}),async()=>new Response('data: {"jsonrpc":"2.0","id":"server-request","method":"sampling/createMessage"}\n\n',{headers:{"Content-Type":"text/event-stream"}})]){
    await assert.rejects(checkMcpConnection(f.ctx,async()=>f.cfg,run,{connectionId:"example"},send));
  }
  assert.equal(f.audit.length,0);
});
test("paged tool catalogs are bounded and duplicate names or cursor loops are rejected",async()=>{
  const f=fixture();let page=0;
  const result=await checkMcpConnection(f.ctx,async()=>f.cfg,run,{connectionId:"example"},async(_url,init)=>{page++;return json(JSON.parse(init!.body as string).id,{tools:[{...tool,name:`example_${page}`}],nextCursor:`cursor_${page}`});});
  assert.equal(result.status,"partial_catalog_observed");assert.equal(result.pages,5);assert.equal(result.toolCount,5);
  await assert.rejects(checkMcpConnection(f.ctx,async()=>f.cfg,run,{connectionId:"example"},async(_url,init)=>json(JSON.parse(init!.body as string).id,{tools:[tool,tool]})));
  page=0;await assert.rejects(checkMcpConnection(f.ctx,async()=>f.cfg,run,{connectionId:"example"},async(_url,init)=>json(JSON.parse(init!.body as string).id,{tools:[{...tool,name:`example_${++page}`}],nextCursor:"same-cursor"})));
});
