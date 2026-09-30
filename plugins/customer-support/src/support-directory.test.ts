import assert from "node:assert/strict";
import test, { before, beforeEach, after } from "node:test";
import { readFile,readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginApiRequestInput,PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import { directoryHistory,listDirectory,resolveDirectoryRoute,saveDirectory,saveDirectoryRequest,validateDirectory } from "./support-directory.js";
import { directoryTools,registerDirectoryTools } from "./directory-tools.js";
import { specialistStatus } from "./directory-schema.js";
import type { Config } from "./routing.js";

const namespace = "plugin_customer_support_0c69412611";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "77777777-7777-4777-8777-777777777777";
const cfg: Config = { discoveryNetworks: [{ id: "office",companyId,cidr: "192.0.2.0/24" },{ id: "other",companyId: otherCompanyId,cidr: "198.51.100.0/24" }] };
let db: PGlite;let ctx: PluginContext; const activity: unknown[] = [];
before(async () => {
  db = new PGlite();await db.exec(`CREATE SCHEMA ${namespace}`);
  for (const file of (await readdir(new URL("../migrations/",import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),"utf8"));
  ctx = { db: { namespace,query: async (sql: string,params: unknown[]) => { assert.match(sql.trim(),/^SELECT\b/i);return (await db.query(sql,params)).rows; },execute: async (sql: string,params: unknown[]) => { assert.match(sql.trim(),/^(INSERT|UPDATE|DELETE)\b/i);return { rowCount: (await db.query(sql,params)).affectedRows }; } },
    agents: { get: async (id: string,company: string) => id === agentId && company === companyId ? { id,companyId,status: "idle" } : null },activity: { log: async (value: unknown) => activity.push(value) } } as unknown as PluginContext;
});
beforeEach(async () => { await db.exec(`TRUNCATE ${namespace}.support_directory`);activity.length=0; });
after(async () => { await db.close(); });
const save = (kind: string,name: string,details: Record<string,string> = {},company = companyId) => saveDirectory(ctx,cfg,company,"operator",{ kind,name,details });

test("reviewed contacts survive updates with atomic revisions; stale and simultaneous edits cannot overwrite",async () => {
  const vendor = await save("vendor","Example service",{ email: "service@example.com",phone: "+1 202 555 0100" });
  assert.equal((await listDirectory(ctx,cfg,companyId,{ query: "service@example.com" })).records[0]!.id,vendor.id);
  const edit = { id: vendor.id,expectedVersion: 1,kind: "vendor",name: "Example service updated",details: { email: "repairs@example.com" } };
  const results = await Promise.allSettled([saveDirectory(ctx,cfg,companyId,"operator",edit),saveDirectory(ctx,cfg,companyId,"operator",{ ...edit,name: "Concurrent edit" })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length,1);
  const history = await directoryHistory(ctx,cfg,companyId,vendor.id) as { revisions: { version: number;details: Record<string,string>;actorUserId: string }[] };
  assert.deepEqual(history.revisions.map(revision => revision.version),[1,2]);assert.equal(history.revisions[0]!.details.email,"service@example.com");assert.equal(history.revisions[1]!.actorUserId,"operator");
  await assert.rejects(saveDirectory(ctx,cfg,companyId,"operator",edit),/refresh/);
  await assert.rejects(saveDirectory(ctx,cfg,companyId,"operator",{ ...edit,expectedVersion: 2,kind: "brand",details: {} }),/another type/);
  assert.equal(activity.length,2);assert.ok(!JSON.stringify(activity).includes("service@example.com"));
});

test("company boundaries apply to searches, history, edits, links and agents",async () => {
  const other = await save("vendor","Other company's vendor",{ email: "other@example.com" },otherCompanyId);
  assert.equal((await listDirectory(ctx,cfg,companyId)).records.length,0);
  await assert.rejects(directoryHistory(ctx,cfg,companyId,other.id),/not found/);
  await assert.rejects(saveDirectory(ctx,cfg,companyId,"operator",{ id: other.id,expectedVersion: 1,kind: "vendor",name: "Stolen",details: {} }),/refresh/);
  await assert.rejects(save("equipment","Machine",{ vendorId: other.id }),/this company/);
  await assert.rejects(save("owner","Wrong agent",{ contactName: "Team",agentId },otherCompanyId),/this company/);
  await assert.rejects(listDirectory(ctx,{},companyId),/not configured/);
  const owner = await save("owner","Production team",{ contactName: "Team",agentId });
  await assert.rejects(save("equipment","Wrong vendor",{ vendorId: owner.id }),/correct record type/);
  // Even bypassing application validation cannot attach another company's record.
  await assert.rejects(db.query(`INSERT INTO ${namespace}.support_directory(company_id,id,kind,name,details,history,updated_by_user_id,vendor_id) VALUES($1,gen_random_uuid(),'equipment','bad','{}','[]','operator',$2)`,[companyId,other.id]),/foreign key/);
});

test("specific equipment/brand routes win, ties need clarification and unspecified devices never guess",async () => {
  const owner = await save("owner","Facilities",{ contactName: "Facilities manager" });
  const vendor = await save("vendor","Equipment service");const equipment = await save("equipment","Example press",{ ownerId: owner.id,vendorId: vendor.id,warrantyEndsOn: "2027-02-28" });
  const brand = await save("brand","Example brand",{ domain: "example.com",fromEmail: "support@example.com",signature: "Example support team" });
  const generic = await save("route","General facilities",{ area: "facilities",ownerId: owner.id });
  const specific = await save("route","Press facilities",{ area: "facilities",ownerId: owner.id,equipmentId: equipment.id,brandId: brand.id,vendorId: vendor.id });
  const all = await resolveDirectoryRoute(ctx,cfg,companyId,{ area: "facilities" });assert.equal(all.routes[0]!.id,generic.id);
  const match = await resolveDirectoryRoute(ctx,cfg,companyId,{ area: "facilities",equipmentId: equipment.id,brandId: brand.id });
  assert.equal(match.status,"matched");assert.equal(match.routes[0]!.id,specific.id);assert.equal(match.related.length,4);
  await save("route","Another press route",{ area: "facilities",ownerId: owner.id,equipmentId: equipment.id,brandId: brand.id });
  assert.equal((await resolveDirectoryRoute(ctx,cfg,companyId,{ area: "facilities",equipmentId: equipment.id,brandId: brand.id })).status,"needs_clarification");
  assert.equal((await resolveDirectoryRoute(ctx,cfg,companyId,{ area: "phones" })).status,"not_configured");
  await assert.rejects(resolveDirectoryRoute(ctx,cfg,companyId,{ area: "phones",equipmentId: vendor.id }),/equipment/);
});

test("credentials, bad fields, unsafe links and invalid dates are rejected before persistence",async () => {
  for (const input of [
    { kind: "vendor",name: "Example",details: { notes: "password: synthetic-forbidden-value" } },
    { kind: "vendor",name: "Example",details: { website: "https://example.com/?token=synthetic-value" } },
    { kind: "vendor",name: "Example",details: { notes: "https://user:synthetic-value@example.com/" } },
    { kind: "vendor",name: "Example",details: { website: "javascript:alert(1)" } },
    { kind: "vendor",name: "Example",details: { email: "first@example.com,second@example.com" } },
    { kind: "equipment",name: "Example",details: { warrantyEndsOn: "2027-02-30" } },
    { kind: "owner",name: "Example",details: {} },
    { kind: "brand",name: "Example",details: { domain: "https://example.com/" } },
    { kind: "equipment",name: "Example",details: { execute: "untrusted command" } },
  ]) assert.throws(() => validateDirectory(input));
  assert.equal((await listDirectory(ctx,cfg,companyId)).records.length,0);
});

test("HTTP saves require a host-verified operator, matching company and explicit review",async () => {
  const input = { companyId,body: { companyId,kind: "vendor",name: "Reviewed service",details: {},confirmed: true },actor: { actorType: "user",userId: "operator",grantedPermission: "support:repair" } } as PluginApiRequestInput;
  for (const changed of [ { ...input,actor: { ...input.actor,grantedPermission: "support:diagnose" } },{ ...input,actor: { actorType: "agent",userId: "operator",grantedPermission: "support:repair" } },{ ...input,body: { ...input.body as object,companyId: otherCompanyId } },{ ...input,body: { ...input.body as object,confirmed: false } } ]) await assert.rejects(saveDirectoryRequest(ctx,cfg,changed as PluginApiRequestInput));
  assert.equal((await listDirectory(ctx,cfg,companyId)).records.length,0);
  assert.equal((await saveDirectoryRequest(ctx,cfg,input)).saved,true);
});

test("Clippy tools enforce exact consent and ticket lookup does not accept a human or unassigned agent",async () => {
  const handlers = new Map<string,(params: unknown,run: ToolRunContext) => Promise<any>>();
  const toolCtx = { ...ctx,tools: { register: (name: string,_tool: unknown,handler: any) => handlers.set(name,handler) } } as unknown as PluginContext;
  registerDirectoryTools(toolCtx,async () => cfg);
  assert.equal(handlers.size,directoryTools.length);
  const run = { companyId,userId: "operator",chatSessionId: "chat",userPermission: "support:repair",userConfirmed: true } as ToolRunContext;
  const input = { kind: "vendor",name: "Clippy service",details: {} };
  assert.ok((await handlers.get("support_save_directory")!(input,{ ...run,userConfirmed: false })).error);
  assert.ok((await handlers.get("support_save_directory")!(input,{ ...run,userPermission: "support:diagnose" })).error);
  assert.ok((await handlers.get("support_save_directory")!(input,run)).data.saved);
  assert.ok((await handlers.get("support_lookup_ticket_directory")!({ caseId: companyId },run)).error);
  assert.ok((await handlers.get("support_lookup_ticket_directory")!({ caseId: companyId },{ companyId,agentId,runId: otherCompanyId })).error);
});

test("specialist readiness distinguishes metadata, installation and untested access",() => {
  assert.equal(specialistStatus("3cx-tools",null),"not_checked");assert.equal(specialistStatus("3cx-tools",[]),"not_installed");
  assert.equal(specialistStatus("3cx-tools",[{ pluginKey: "3cx-tools",status: "ready" }]),"running_untested");
  assert.equal(specialistStatus("3cx-tools",[{ pluginKey: "3cx-tools",status: "disabled" }]),"inactive");
});

test("literal search characters stay literal and tool result limits report truncation",async () => {
  await save("vendor","100% service");await save("vendor","Other service");
  assert.equal((await listDirectory(ctx,cfg,companyId,{ query: "%" })).records.length,1);
  const limited = await listDirectory(ctx,cfg,companyId,{},1);assert.equal(limited.records.length,1);assert.equal(limited.truncated,true);
});
