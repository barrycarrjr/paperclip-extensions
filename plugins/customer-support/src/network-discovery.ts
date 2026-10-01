import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { setMaxListeners } from "node:events";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { ns, person } from "./interactive-support.js";
import { resolveRemoteAccess } from "./remote-access.js";
import { discoveryRange } from "./discovery-scope.js";
import { resolveDiscoveryNames, type DiscoveryName } from "./discovery-dns.js";

export const discoveryPorts = [
  { port: 22, service: "SSH" }, { port: 80, service: "HTTP" }, { port: 135, service: "RPC" },
  { port: 443, service: "HTTPS" }, { port: 445, service: "SMB" }, { port: 515, service: "LPD printing" },
  { port: 631, service: "IPP printing" }, { port: 3389, service: "RDP" },
  { port: 5985, service: "WinRM HTTP" }, { port: 5986, service: "WinRM HTTPS" }, { port: 9100, service: "Raw printing" },
];
type Dependencies = {
  tcp: (address: string, port: number, signal: AbortSignal) => Promise<boolean>;
  ping: (address: string, signal: AbortSignal) => Promise<boolean>;
  reverse: (address: string, signal: AbortSignal) => Promise<string[]>;
  lookup: (hostname: string, signal: AbortSignal) => Promise<string[]>;
  prepareDns?: (addresses: string[], signal: AbortSignal, knownNames: string[]) => Promise<void>;
};
function tcp(address: string, port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    const socket = createConnection({ host: address, port });
    const done = (value: boolean) => { signal.removeEventListener("abort", abort); socket.destroy(); resolve(value); };
    const abort = () => done(false);
    signal.addEventListener("abort", abort, { once: true });
    socket.setTimeout(700); socket.once("connect", () => done(true));
    socket.once("error", () => done(false)); socket.once("timeout", () => done(false));
  });
}
function ping(address: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    const args = process.platform === "win32" ? ["-n", "1", "-w", "700", address] : ["-c", "1", "-W", "1", address];
    // Validated numeric IP, no shell, no elevation and no password.
    execFile("ping", args, { timeout: 1500, windowsHide: true, maxBuffer: 8192, signal }, error => resolve(!error));
  });
}
function defaults(): Dependencies {
  let records: DiscoveryName[] = [];
  return { tcp, ping,
    prepareDns: async (addresses, signal, knownNames) => { records = await resolveDiscoveryNames(addresses, signal, knownNames); },
    reverse: async address => records.filter(row => row.address === address).map(row => row.hostname),
    lookup: async name => records.filter(row => row.hostname === name).flatMap(row => row.forwardAddresses),
  };
}

export async function knownDiscoveryTargets(ctx: PluginContext, cfg: Config, companyId: string) {
  const rows = await ctx.db.query<{ target_address: string }>(
    `SELECT target_address FROM ${ns(ctx)}.support_devices WHERE company_id=$1 ORDER BY last_seen_at DESC LIMIT 50`, [companyId]);
  const targets = [...rows.map(row => row.target_address), ...(cfg.remoteAccessProfiles ?? []).filter(profile => profile.companyId === companyId).flatMap(profile => (profile.targets ?? []).map(target => target.address))];
  return [...new Set(targets)].filter(target => {
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(target) || /^\d+(?:\.\d+){3}$/.test(target)) return false;
    try { resolveRemoteAccess(cfg, companyId, target); return true; } catch { return false; }
  }).slice(0, 50);
}

export function discoveryNetworks(cfg: Config, companyId: string) {
  return (cfg.discoveryNetworks ?? []).filter(network => network.companyId === companyId).map(network => {
    if (!network.id?.trim() || network.id.length > 120) throw new IntakeError(422, "Discovery network needs a unique ID");
    try { return { id: network.id, ...discoveryRange(network.cidr) }; }
    catch (error) { throw new IntakeError(422, error instanceof Error ? error.message : "Invalid discovery range"); }
  });
}
const locks = new Set<string>();
export async function discoverDevices(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>, dependencies = defaults(), budgetMs = 30_000) {
  const actor = person(run);
  if (run.userPermission !== "support:diagnose") throw new IntakeError(403, "Paperclip must verify your investigate permission");
  const networks = discoveryNetworks(cfg, actor.companyId);
  const ranges = networks.map(({ id, cidr }) => ({ id, cidr }));
  if (!networks.length) return { configured: false, ranges, instruction: "Save the office IPv4 range under Support → Discover office devices. A Windows DNS domain alone does not identify an authorized scan range." };
  if (input.networkId === undefined && networks.length !== 1) return { configured: true, ranges, instruction: "Ask which saved network to scan, then supply its networkId." };
  const matches = input.networkId === undefined ? networks : networks.filter(network => network.id === input.networkId);
  if (matches.length !== 1) throw new IntakeError(403, "Discovery network is unavailable or ambiguous for this company");
  const network = matches[0]!;
  // One discovery at a time per company, regardless of network aliases.
  if (locks.has(actor.companyId)) throw new IntakeError(409, "This company's network discovery is already running. Wait for its result.");
  locks.add(actor.companyId);
  const controller = new AbortController(); const signal = controller.signal;
  // Each bounded socket/process observes the same deadline without triggering EventTarget warnings.
  setMaxListeners(256, signal);
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const startedAt = new Date().toISOString(); let next = 0; let checked = 0;
  const devices: { address: string; names: string[]; pingResponded: boolean; openPorts: typeof discoveryPorts; remoteTarget: string | null }[] = [];
  try {
    await ctx.activity.log({ companyId: actor.companyId, message: "Office device discovery started", entityType: "support_discovery", entityId: network.id,
      metadata: { userId: actor.userId, chatSessionId: actor.chatSessionId, cidr: network.cidr, ports: discoveryPorts.map(item => item.port) } });
    await Promise.all(Array.from({ length: Math.min(16, network.addresses.length) }, async () => {
      while (!signal.aborted && next < network.addresses.length) {
        const address = network.addresses[next++]!;
        const [pingResponded, ...ports] = await Promise.all([
          dependencies.ping(address, signal), ...discoveryPorts.map(item => dependencies.tcp(address, item.port, signal)),
        ]);
        if (signal.aborted) break;
        checked++;
        const openPorts = discoveryPorts.filter((_, index) => ports[index]);
        if (!pingResponded && !openPorts.length) continue;
        devices.push({ address, names: [], pingResponded, openPorts, remoteTarget: null });
      }
    }));
    if (dependencies.prepareDns && !signal.aborted) {
      const knownNames = await knownDiscoveryTargets(ctx, cfg, actor.companyId);
      await dependencies.prepareDns(devices.map(device => device.address), signal, knownNames);
    }
    await Promise.all(devices.map(async device => {
      const { address } = device;
      device.names = [...new Set(await dependencies.reverse(address, signal))].slice(0, 4).filter(name => /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(name));
      // PTR is untrusted evidence. Only suggest an allowed name after forward DNS maps back to this IP.
      for (const candidate of [address, ...device.names]) {
        try {
          resolveRemoteAccess(cfg, actor.companyId, candidate);
          if (candidate === address || (await dependencies.lookup(candidate, signal)).includes(address)) { device.remoteTarget = candidate; break; }
        } catch { /* Discovery does not grant remote administration. */ }
      }
    }));
    devices.sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
    const result = { networkId: network.id, cidr: network.cidr, startedAt, completedAt: new Date().toISOString(),
      status: checked === network.addresses.length && !signal.aborted ? "completed" : "partial", checkedAddresses: checked, totalAddresses: network.addresses.length,
      devices, notObserved: checked - devices.length, methods: ["ICMP echo", "TCP connection", "OS reverse DNS and forward-checked saved device names"], ports: discoveryPorts,
      instruction: "These are reachability observations, not health diagnoses, authenticated access, or a complete inventory. Firewalls, sleeping devices, UDP-only services and other networks can be missed. Device names and port labels do not prove device type. Use remoteTarget with support_open_case for a permitted deeper Windows investigation; null means no matching saved remote access was established. Do not infer issues or healthy devices from discovery alone." };
    await ctx.state.set({ scopeKind: "company", scopeId: actor.companyId, namespace: "network_discovery", stateKey: network.id }, result);
    await ctx.activity.log({ companyId: actor.companyId, message: "Office device discovery completed", entityType: "support_discovery", entityId: network.id,
      metadata: { userId: actor.userId, status: result.status, checkedAddresses: checked, observedDevices: devices.length } });
    return result;
  } finally { clearTimeout(timer); controller.abort(); locks.delete(actor.companyId); }
}

export async function discoveryHistory(ctx: PluginContext, cfg: Config, companyId: string) {
  return Promise.all(discoveryNetworks(cfg, companyId).map(async network => {
    const saved = await ctx.state.get({ scopeKind: "company", scopeId: companyId, namespace: "network_discovery", stateKey: network.id }) as { cidr?: string } | null;
    return { id: network.id, cidr: network.cidr, lastScan: saved?.cidr === network.cidr ? saved : null };
  }));
}
