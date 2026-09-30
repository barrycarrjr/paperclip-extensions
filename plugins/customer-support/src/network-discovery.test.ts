import assert from "node:assert/strict";
import test from "node:test";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { discoveryRange } from "./discovery-scope.js";
import { parseDiscoveryNames, resolveDiscoveryNames } from "./discovery-dns.js";
import { discoverDevices, discoveryHistory, discoveryPorts, knownDiscoveryTargets } from "./network-discovery.js";
import type { Config } from "./routing.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompany = "22222222-2222-4222-8222-222222222222";
const run: ToolRunContext = { companyId, userId: "operator", chatSessionId: "chat", runId: "turn", agentId: "", userPermission: "support:diagnose" };
const cfg: Config = { discoveryNetworks: [{ id: "office", companyId, cidr: "192.0.2.0/30" }, { id: "other", companyId: otherCompany, cidr: "198.51.100.0/30" }],
  remoteAccessProfiles: [{ id: "windows", companyId, credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333", scopes: [{ kind: "dns_suffix", value: "office.example.local", transport: "Wmi" }] }] };
function fixture() {
  const stored = new Map<string, unknown>(); const events: unknown[] = [];
  const key = (scope: { scopeId: string; stateKey: string }) => `${scope.scopeId}:${scope.stateKey}`;
  const ctx = { activity: { log: async (event: unknown) => { events.push(event); } }, state: {
    set: async (scope: { scopeId: string; stateKey: string }, value: unknown) => { stored.set(key(scope), value); },
    get: async (scope: { scopeId: string; stateKey: string }) => stored.get(key(scope)) ?? null,
  }, secrets: { resolve: () => { throw new Error("Discovery must not resolve credentials"); } } } as unknown as PluginContext;
  return { ctx, stored, events };
}
const silent = { tcp: async () => false, ping: async () => false, reverse: async () => [], lookup: async () => [] };

test("name fallback reads only company inventory and currently allowed hostnames", async () => {
  const ctx = { db: { namespace: "plugin_customer_support", query: async (_sql: string, params: unknown[]) => {
    assert.deepEqual(params, [companyId]);
    return [{ target_address: "pc.office.example.local" }, { target_address: "pc.other.example.local" }, { target_address: "192.0.2.1" }];
  } } } as unknown as PluginContext;
  assert.deepEqual(await knownDiscoveryTargets(ctx, cfg, companyId), ["pc.office.example.local"]);
});

test("discovery normalizes bounded ranges and refuses special addresses or commands", () => {
  assert.equal(discoveryRange("192.0.2.45/24").cidr, "192.0.2.0/24");
  assert.equal(discoveryRange("192.0.2.0/24").addresses.length, 254);
  assert.deepEqual(discoveryRange("192.0.2.8/31").addresses, ["192.0.2.8", "192.0.2.9"]);
  assert.deepEqual(discoveryRange("192.0.2.8/32").addresses, ["192.0.2.8"]);
  for (const value of ["192.0.2.0/23", "999.0.2.0/24", "127.0.0.0/24", "224.0.0.0/24", "169.254.0.0/24", "0.0.0.0/24", "192.0.2.0/24;whoami", "example.local", "::1/128"]) assert.throws(() => discoveryRange(value));
});
test("bounded DNS output excludes unrelated addresses, malformed names and truncated records", () => {
  const rows = [
    { address: "192.0.2.1", hostname: "PC.Office.Example.Local", forwardAddresses: ["192.0.2.1"] },
    { address: "198.51.100.1", hostname: "other.example.local", forwardAddresses: ["198.51.100.1"] },
    { address: "192.0.2.2", hostname: "name;whoami", forwardAddresses: ["192.0.2.2"] },
  ].map(row => JSON.stringify(row)).join("\n") + '\n{"address":';
  assert.deepEqual(parseDiscoveryNames(rows, ["192.0.2.1", "192.0.2.2"]), [{ address: "192.0.2.1", hostname: "pc.office.example.local", forwardAddresses: ["192.0.2.1"] }]);
});
test("isolated OS DNS helper resolves a local saved name and handles pre-cancelled work", async () => {
  const controller = new AbortController();
  const names = await resolveDiscoveryNames(["127.0.0.1"], controller.signal, ["localhost"]);
  assert.ok(names.some(row => row.address === "127.0.0.1" && row.hostname === "localhost" && row.forwardAddresses.includes("127.0.0.1") && row.source === "saved_name_forward_dns"));
  controller.abort();
  assert.deepEqual(await resolveDiscoveryNames(["127.0.0.1"], controller.signal, ["localhost"]), []);
});
test("permission, company range and exact network choice are enforced before probes", async () => {
  const { ctx } = fixture(); let calls = 0;
  const probes = { ...silent, tcp: async () => { calls++; return false; } };
  for (const invalid of [{ ...run, userPermission: undefined }, { ...run, userPermission: "support:repair" }, { ...run, userId: null }, { ...run, companyId: "not-a-company" }]) await assert.rejects(discoverDevices(ctx, cfg, invalid, {}, probes));
  await assert.rejects(discoverDevices(ctx, cfg, run, { networkId: "other" }, probes));
  const missing = await discoverDevices(ctx, {}, run, {}, probes);
  assert.ok("configured" in missing); assert.equal(missing.configured, false);
  const many = { ...cfg, discoveryNetworks: [...cfg.discoveryNetworks!, { id: "branch", companyId, cidr: "203.0.113.0/30" }] };
  const choices = await discoverDevices(ctx, many, run, {}, probes);
  assert.ok("ranges" in choices); assert.equal(choices.ranges.length, 2);
  await assert.rejects(discoverDevices(ctx, { discoveryNetworks: [cfg.discoveryNetworks![0]!, cfg.discoveryNetworks![0]!] }, run, { networkId: "office" }, probes));
  assert.equal(calls, 0);
});
test("live observations separate ping, service reachability and allowed forward-checked management targets", async () => {
  const { ctx, events, stored } = fixture(); const calls: string[] = [];
  const result = await discoverDevices(ctx, cfg, run, {}, {
    tcp: async (ip, port) => { calls.push(ip); return ip === "192.0.2.1" && port === 9100; },
    ping: async ip => ip === "192.0.2.2",
    reverse: async ip => ip === "192.0.2.1" ? ["fake.office.example.local", "printer.example.net"] : ["pc.office.example.local"],
    lookup: async name => name === "pc.office.example.local" ? ["192.0.2.2"] : ["198.51.100.1"],
  });
  assert.ok("devices" in result);
  assert.equal(result.status, "completed"); assert.equal(result.checkedAddresses, 2);
  assert.ok(calls.every(ip => ip.startsWith("192.0.2.")));
  assert.equal(calls.length, 2 * discoveryPorts.length);
  assert.equal(result.devices![0]!.remoteTarget, null); // PTR alone never authorizes a different host.
  assert.deepEqual(result.devices![0]!.openPorts, [{ port: 9100, service: "Raw printing" }]);
  assert.equal(result.devices![1]!.remoteTarget, "pc.office.example.local");
  assert.equal(result.devices![1]!.pingResponded, true);
  assert.equal(events.length, 2); assert.equal(stored.size, 1);
  assert.ok(result.instruction.includes("not health diagnoses"));
  assert.ok((await discoveryHistory(ctx, cfg, companyId))[0]!.lastScan);
  assert.equal((await discoveryHistory(ctx, cfg, otherCompany))[0]!.lastScan, null);
  assert.equal((await discoveryHistory(ctx, { discoveryNetworks: [{ id: "office", companyId, cidr: "192.0.2.8/30" }] }, companyId))[0]!.lastScan, null);
});
test("silent addresses are unobserved, not diagnosed as offline or healthy", async () => {
  const { ctx } = fixture(); const result = await discoverDevices(ctx, cfg, run, {}, silent);
  assert.ok("devices" in result);
  assert.equal(result.devices!.length, 0); assert.equal(result.notObserved, 2); assert.equal(result.status, "completed");
});
test("deadline aborts outstanding probes and concurrent scans cannot start for the same company", async () => {
  const { ctx } = fixture(); let started = false; let active = 0; let peak = 0;
  const cfgLarge = { discoveryNetworks: [{ id: "office", companyId, cidr: "192.0.2.0/24" }] };
  const pending = discoverDevices(ctx, cfgLarge, run, {}, { ...silent, ping: async (_ip, signal) => {
    started = true; active++; peak = Math.max(peak, active);
    await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); active--; return false;
  } }, 20);
  while (!started) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(discoverDevices(ctx, cfgLarge, run, {}, silent), /already running/);
  const result = await pending;
  assert.ok("devices" in result);
  assert.equal(result.status, "partial"); assert.equal(result.checkedAddresses, 0); assert.equal(active, 0); assert.equal(peak, 16);
  const retry = await discoverDevices(ctx, cfg, run, {}, silent);
  assert.ok("status" in retry); assert.equal(retry.status, "completed");
});
