import assert from "node:assert/strict";
import test from "node:test";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { getSupportSetup, probeSetupPermission, rememberSetupIdentity, setupPermissions } from "./support-setup.js";
import { checkSetupPermission, identitySummary } from "./ui/setup-client.js";
import type { Config } from "./routing.js";
const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const cfg: Config = { remoteAccessProfiles: [{ id: "office", companyId, credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333", scopes: [{ kind: "dns_suffix", value: "office.example.local", transport: "Wmi" }] }],
  connections: [{ id: "incoming",source: "slack",externalAccountId: "T123456789",ingestAgentId: "agent",allowedCompanies: [companyId],routes: [{ externalRouteId: "C123456789:Example", companyId }] }],
  softwareRoutes: [{ id: "product",reportingCompanyId: companyId,productName: "Example",destinationKind: "email",destination: "support@example.com" }],
};
function fixture() {
  const stored = new Map<string,unknown>();
  const key = (input: { scopeId: string; stateKey: string }) => `${input.scopeId}:${input.stateKey}`;
  const ctx = { state: {
    get: async (input: { scopeId: string; stateKey: string }) => stored.get(key(input)) ?? null,
    set: async (input: { scopeId: string; stateKey: string }, value: unknown) => { stored.set(key(input),value); },
  }, secrets: { resolve: () => { throw new Error("Readiness must not read a password"); } } } as unknown as PluginContext;
  return { ctx,stored };
}
test("setup observations stay company scoped, separate saved settings from tested access and detect changes",async () => {
  const { ctx,stored } = fixture();
  const initial = await getSupportSetup(ctx,cfg,companyId);
  assert.equal(initial.windows[0]!.configured,true);
  assert.equal(initial.windows[0]!.identityTest,null);
  assert.equal(initial.connections[0]!.outboundAccount,null);
  await rememberSetupIdentity(ctx,cfg,companyId,"pc.office.example.local",{ status: "succeeded",transport: "wmi_dcom_smb",output: "password: never-store-this-output" });
  assert.ok(!JSON.stringify([...stored.values()]).includes("never-store"));
  const checked = (await getSupportSetup(ctx,cfg,companyId)).windows[0]!.identityTest!;
  assert.equal(checked.status,"succeeded");
  assert.equal(checked.settingsMatch,true);
  const changed: Config = { ...cfg,remoteAccessProfiles: [{ ...cfg.remoteAccessProfiles![0]!,credentialUser: "EXAMPLE\\different" }] };
  assert.equal((await getSupportSetup(ctx,changed,companyId)).windows[0]!.identityTest!.settingsMatch,false);
  await rememberSetupIdentity(ctx,cfg,companyId,"pc.office.example.local",null);
  assert.equal((await getSupportSetup(ctx,cfg,companyId)).windows[0]!.identityTest!.status,"failed");
  const other = await getSupportSetup(ctx,cfg,otherCompanyId);
  assert.equal(other.windows.length,0); assert.equal(other.connections.length,0); assert.equal(other.vendorRoutes.length,0);
  await assert.rejects(getSupportSetup(ctx,cfg,"bad-company"));
  await assert.rejects(rememberSetupIdentity(ctx,cfg,otherCompanyId,"pc.office.example.local",{ status: "succeeded" }));
});
test("missing, invalid and overlapping access groups never appear configured",async () => {
  const { ctx } = fixture();
  assert.equal((await getSupportSetup(ctx,{},companyId)).windows.length,0);
  for (const bad of [
    { ...cfg,remoteAccessProfiles: [{ ...cfg.remoteAccessProfiles![0]!,passwordRef: "literal-password" }] },
    { ...cfg,remoteAccessProfiles: [{ ...cfg.remoteAccessProfiles![0]!,scopes: [] }] },
    { ...cfg,remoteAccessProfiles: [...cfg.remoteAccessProfiles!,{ ...cfg.remoteAccessProfiles![0]!,id: "duplicate" }] },
  ]) assert.ok((await getSupportSetup(ctx,bad,companyId)).windows.every(group => !group.configured && group.issue));
});
test("permission probes require a real host grant for this operation and never execute a command",() => {
  for (const action of setupPermissions) {
    const request = { routeKey: `setup.permission.${action}`,actor: { actorType: "user",userId: "operator",grantedPermission: `support:${action}` } } as PluginApiRequestInput;
    assert.equal(probeSetupPermission(request).status,200);
    for (const actor of [{ actorType: "agent",userId: "operator",grantedPermission: `support:${action}` },{ actorType: "user",userId: "operator" },{ actorType: "user",userId: "operator",grantedPermission: "agents:create" }]) assert.throws(() => probeSetupPermission({ ...request,actor } as PluginApiRequestInput));
  }
});
test("UI permission errors remain unknown rather than being mistaken for a grant",async () => {
  const request = (status: number,body: unknown) => async () => new Response(JSON.stringify(body),{ status,headers: { "Content-Type": "application/json" } });
  assert.equal((await checkSetupPermission(request(200,{ allowed: true,permission: "support:diagnose" }) as typeof fetch,companyId,"diagnose")).allowed,true);
  assert.equal((await checkSetupPermission(request(403,{}) as typeof fetch,companyId,"repair")).allowed,false);
  for (const fetcher of [request(500,{}),request(200,{ allowed: true,permission: "support:repair" }),async () => { throw new Error(); }]) {
    const result = await checkSetupPermission(fetcher as typeof fetch,companyId,"diagnose"); assert.equal(result.allowed,null); assert.ok(result.error);
  }
  const summary = identitySummary({ status: "succeeded",target: "pc.example.local",transport: "wmi_dcom_smb",output: JSON.stringify({ identity: "EXAMPLE\\support" }) });
  assert.match(summary,/Connected to pc.example.local as EXAMPLE\\support/); assert.match(summary,/did not diagnose or repair/);
  assert.match(identitySummary({ status: "failed" }),/did not confirm/);
});
