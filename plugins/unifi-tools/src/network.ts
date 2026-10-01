import type { PluginContext } from "@paperclipai/plugin-sdk";
export interface NetworkAccount { key: string; baseUrl: string; apiKeyRef: string; allowedCompanies: string[]; sites: { companyId: string; siteIds: string[] }[]; supportReadEnabled?: boolean }
export interface NetworkConfig { accounts?: NetworkAccount[]; allowDeviceRestarts?: boolean }
export const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function resolveNetworkAccount(cfg: NetworkConfig, companyId: string, key: unknown, siteId: unknown) {
  if (!uuid.test(companyId) || typeof key !== "string" || typeof siteId !== "string" || !uuid.test(siteId)) throw new Error("Choose this company's saved controller account and exact site UUID");
  const matches = (cfg.accounts ?? []).filter(account => account.key === key);
  const account = matches[0];
  if (matches.length !== 1 || !account || !account.allowedCompanies.includes(companyId)) throw new Error("Controller account is not uniquely allowed for this company");
  const ownership = account.sites.filter(site => site.siteIds.includes(siteId));
  if (ownership.length !== 1 || ownership[0]!.companyId !== companyId) throw new Error("Site is not uniquely owned by this company");
  const base = new URL(account.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !["/integration", "/proxy/network/integration"].includes(base.pathname.replace(/\/$/, "")) || !uuid.test(account.apiKeyRef)) throw new Error("Save an HTTPS local Integration API base and a Paperclip Secret reference. TLS verification is required.");
  return account;
}
export async function networkRequest(ctx: PluginContext, account: NetworkAccount, path: string) {
  // Callers construct only validated UUID paths below; no arbitrary URLs or redirects.
  const key = await ctx.secrets.resolve(account.apiKeyRef);
  const response = await ctx.http.fetch(`${account.baseUrl.replace(/\/$/, "")}/v1/${path}`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "X-API-Key": key, Accept: "application/json" } });
  if (!response.ok || !/json/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw new Error("Controller read unavailable; check API version, key/site permission and TLS trust. Redirects are not followed."); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Controller returned no data");
  let bytes = 0, body = ""; const decoder = new TextDecoder();
  try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1000000) throw new Error("Controller data exceeded bound"); body += decoder.decode(part.value, { stream: true }); } body += decoder.decode(); } finally { await reader.cancel(); }
  return JSON.parse(body) as Record<string, unknown>;
}
function selected(item: Record<string, unknown>, fields: string[]) { return Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]])); }
export async function observeNetwork(ctx: PluginContext, companyId: string, input: Record<string, unknown>, api = networkRequest) {
  const cfg = await ctx.config.get() as NetworkConfig;
  const account = resolveNetworkAccount(cfg, companyId, input.account, input.siteId), site = `sites/${input.siteId}`;
  if (input.supportBridge === true && !account.supportReadEnabled) throw new Error("Support Desk observations disabled");
  let result: unknown;
  if (input.operation === "device") {
    if (typeof input.deviceId !== "string" || !uuid.test(input.deviceId)) throw new Error("Use an exact device UUID");
    const path = `${site}/devices/${input.deviceId}`;
    const details = await api(ctx, account, path);
    if (details.id !== input.deviceId) throw new Error("Device identity mismatch");
    let statistics: unknown;
    try {
      const raw = await api(ctx, account, `${path}/statistics/latest`);
      statistics = { status: "available", data: selected(raw, ["uptimeSec", "lastHeartbeatAt", "cpuUtilizationPct", "memoryUtilizationPct", "loadAverage1Min"]), uplink: raw.uplink && typeof raw.uplink === "object" ? selected(raw.uplink as Record<string, unknown>, ["txRateBps", "rxRateBps"]) : null };
    }
    catch { statistics = { status: "unavailable" }; }
    const interfaces = details.interfaces as { ports?: Record<string, unknown>[]; radios?: Record<string, unknown>[] } | undefined;
    result = { device: selected(details, ["id", "name", "model", "state", "firmwareVersion", "firmwareUpdatable", "supported"]), ports: Array.isArray(interfaces?.ports) ? interfaces.ports.slice(0, 50).map(item => selected(item, ["idx", "state", "speedMbps", "maxSpeedMbps"])) : [], radios: Array.isArray(interfaces?.radios) ? interfaces.radios.slice(0, 10).map(item => selected(item, ["wlanStandard", "frequencyGHz", "channel", "channelWidthMHz"])) : [], portsTruncated: (interfaces?.ports?.length ?? 0) > 50, statistics };
  } else if (input.operation === "site") {
    const sections: Record<string, unknown> = {};
    for (const resource of ["devices", "clients"]) {
      try {
        const page = await api(ctx, account, `${site}/${resource}?offset=0&limit=50`);
        if (!Array.isArray(page.data)) throw new Error("Invalid controller page");
        sections[resource] = { status: "available", samples: page.data.slice(0, 50).map(item => selected(item as Record<string, unknown>, resource === "devices" ? ["id", "name", "model", "state", "features"] : ["id", "name", "type", "connectedAt", "uplinkDeviceId"])), totalCount: typeof page.totalCount === "number" ? page.totalCount : null, truncated: typeof page.totalCount !== "number" || page.totalCount > 50 || page.data.length > 50 };
      } catch { sections[resource] = { status: "unavailable" }; }
    }
    result = sections;
  } else throw new Error("Choose site or device observation");
  const latest = resolveNetworkAccount(await ctx.config.get() as NetworkConfig, companyId, input.account, input.siteId);
  if (JSON.stringify(account) !== JSON.stringify(latest)) throw new Error("Controller access changed during the observation");
  return { siteId: input.siteId, observedAtUtc: new Date().toISOString(), findings: result, limitations: "Official UniFi Network Integration API observations, bounded to 50 devices/connected clients. Offline state is evidence, not a root cause. Connected-client lists omit offline clients. Rates describe the selected device uplink, not per-application bandwidth attribution. Firmware availability does not authorize updates. This is not a configuration backup or proof of internet/DNS health. No configuration changes, resets or uploads run." };
}
