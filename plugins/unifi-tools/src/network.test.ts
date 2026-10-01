import assert from "node:assert/strict";
import test from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { observeNetwork, networkRequest, resolveNetworkAccount, type NetworkConfig, type NetworkAccount } from "./network.js";
const companyId = "11111111-1111-4111-8111-111111111111", siteId = "22222222-2222-4222-8222-222222222222", deviceId = "33333333-3333-4333-8333-333333333333";
const account: NetworkAccount = { key: "example", baseUrl: "https://controller.example.com/integration", apiKeyRef: "44444444-4444-4444-8444-444444444444", allowedCompanies: [companyId], sites: [{ companyId, siteIds: [siteId] }], supportReadEnabled: true };
test("UniFi account/site ownership denies ambiguity, wildcard-only access, credential URLs and legacy endpoints", () => {
  assert.equal(resolveNetworkAccount({ accounts: [account] }, companyId, "example", siteId), account);
  for (const changed of [{ ...account, allowedCompanies: ["*"] }, { ...account, sites: [...account.sites, { companyId: deviceId, siteIds: [siteId] }] }, { ...account, baseUrl: "http://controller.example.com/integration" }, { ...account, baseUrl: "https://controller.example.com/api/s/default" }, { ...account, baseUrl: "https://controller.example.com/integration?key=synthetic-test" }]) assert.throws(() => resolveNetworkAccount({ accounts: [changed] }, companyId, "example", siteId));
});
test("actual HTTP reads send key only to the saved endpoint, refuse redirects and enforce body bounds", async () => {
  let mode = "ok";
  const ctx = { secrets: { resolve: async () => "synthetic-test-key" }, http: { fetch: async (url: string, init: RequestInit) => {
    assert.equal(url, "https://controller.example.com/integration/v1/sites/example");
    assert.equal(init.redirect, "manual"); assert.equal(init.method, "GET");
    assert.equal((init.headers as Record<string, string>)["X-API-Key"], "synthetic-test-key");
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://other.example.com/" } });
    if (mode === "large") return new Response("x".repeat(1000001), { headers: { "content-type": "application/json" } });
    return Response.json({ data: [] });
  } } } as unknown as PluginContext;
  assert.deepEqual(await networkRequest(ctx, account, "sites/example"), { data: [] });
  mode = "redirect"; await assert.rejects(networkRequest(ctx, account, "sites/example"));
  mode = "large"; await assert.rejects(networkRequest(ctx, account, "sites/example"), /bound/);
});
test("scoped observations preserve unavailable/truncated sections, omit private fields and fail revoked access", async () => {
  let cfg: NetworkConfig = { accounts: [account] };
  const ctx = { config: { get: async () => cfg } } as unknown as PluginContext;
  const api = async (_ctx: PluginContext, _account: NetworkAccount, path: string): Promise<Record<string, unknown>> => {
    if (path.includes("clients")) throw new Error("Synthetic unavailable");
    if (path.endsWith("/statistics/latest")) return { uptimeSec: 1200, uplink: { txRateBps: 1000, rxRateBps: 2000, secretField: "private" }, credentials: "private" };
    if (path.includes("?")) return { totalCount: 51, data: Array.from({ length: 50 }, () => ({ id: deviceId, name: "Example AP", model: "Example", state: "OFFLINE", macAddress: "private", ipAddress: "private" })) };
    return { id: deviceId, name: "Example AP", state: "ONLINE", firmwareVersion: "Example", privateField: "private" };
  };
  const site = await observeNetwork(ctx, companyId, { account: "example", siteId, operation: "site" }, api);
  assert.equal((site.findings as any).devices.truncated, true); assert.equal((site.findings as any).clients.status, "unavailable");
  const device = await observeNetwork(ctx, companyId, { account: "example", siteId, deviceId, operation: "device" }, api);
  assert.doesNotMatch(JSON.stringify(device.findings), /private/);
  await assert.rejects(observeNetwork(ctx, companyId, { account: "example", siteId, deviceId: "../../other", operation: "device" }, api));
  const revoke = async (...args: Parameters<typeof api>) => { const result = await api(...args); cfg = { accounts: [{ ...account, allowedCompanies: [] }] }; return result; };
  await assert.rejects(observeNetwork(ctx, companyId, { account: "example", siteId, operation: "site" }, revoke));
});
