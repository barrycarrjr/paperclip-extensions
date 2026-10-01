import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { postSupportIntake } from "./support-intake-http.js";

const caseId="11111111-1111-4111-8111-111111111111";
test("native intake reaches an actual loopback API without the private-address-blocking worker bridge",async()=>{
  let requests=0;
  const server=createServer(async(req,res)=>{requests++;assert.equal(req.method,"POST");assert.equal(req.url,"/api/plugins/customer-support/api/messages");assert.equal(req.headers.authorization,"Bearer synthetic-test-key");let text="";for await(const chunk of req)text+=chunk;assert.deepEqual(JSON.parse(text),{externalMessageId:"example-revision-1"});res.writeHead(201,{"Content-Type":"application/json"});res.end(JSON.stringify({caseId,created:true}));});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  try {const port=(server.address() as AddressInfo).port;const result=await postSupportIntake(`http://127.0.0.1:${port}/api/plugins/customer-support/api/messages`,"synthetic-test-key",{externalMessageId:"example-revision-1"},Date.now()+1000);assert.deepEqual(result,{caseId,created:true});assert.equal(requests,1);}
  finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
test("a real native request deadline aborts a stalled local acknowledgement",async()=>{
  const server=createServer(()=>{});await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  try {const port=(server.address() as AddressInfo).port;const start=Date.now();await assert.rejects(postSupportIntake(`http://127.0.0.1:${port}/api/plugins/customer-support/api/messages`,"synthetic-test-key",{},Date.now()+60));assert.ok(Date.now()-start<1500);}
  finally {server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
});
test("intake refuses redirects, excessive or invalid acknowledgements and arbitrary endpoint paths",async()=>{
  const endpoint="https://paperclip.example.com/api/plugins/customer-support/api/messages";let calls=0;
  for(const response of [new Response(null,{status:302,headers:{Location:"https://example.com"}}),Response.json({caseId,created:true,unexpected:"x".repeat(2001)}),Response.json({caseId:"not-a-case",created:true})]){
    await assert.rejects(postSupportIntake(endpoint,"synthetic-test-key",{},Date.now()+1000,async(_url,init)=>{calls++;assert.equal(init?.redirect,"manual");assert.ok(init?.signal);return response;}));
  }
  const send=async()=>{calls++;return Response.json({caseId,created:true});};
  await assert.rejects(postSupportIntake("http://example.com/api/plugins/customer-support/api/messages","synthetic-test-key",{},Date.now()+1000,send));
  await assert.rejects(postSupportIntake("https://paperclip.example.com/other-path","synthetic-test-key",{},Date.now()+1000,send));
  await assert.rejects(postSupportIntake(endpoint,"synthetic-test-key",{},Date.now()-1,send));assert.equal(calls,3);
});
