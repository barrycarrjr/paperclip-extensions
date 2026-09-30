import { createHash } from "node:crypto";
import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { resolveRemoteAccess } from "./remote-access.js";

export const setupPermissions = ["diagnose", "repair", "respond"] as const;
export function probeSetupPermission(input: PluginApiRequestInput): PluginApiResponse {
  const action = input.routeKey.slice("setup.permission.".length);
  if (!setupPermissions.some(value => value === action)) throw new IntakeError(404, "Unknown permission check");
  const permission = `support:${action}`;
  if (input.actor.actorType !== "user" || !input.actor.userId || input.actor.grantedPermission !== permission) {
    throw new IntakeError(403, "Paperclip must verify this person's support permission");
  }
  return { status: 200, body: { allowed: true, permission } };
}

interface IdentityObservation {
  companyId: string; profileId: string; target: string; checkedAt: string;
  status: "succeeded" | "failed"; fingerprint: string; transport: string | null;
}
function stateKey(companyId: string, profileId: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "windows_setup", stateKey: profileId };
}
function fingerprint(cfg: Config, companyId: string, target: string) {
  return createHash("sha256").update(JSON.stringify(resolveRemoteAccess(cfg, companyId, target.toLowerCase()))).digest("hex");
}
export async function rememberSetupIdentity(ctx: PluginContext, cfg: Config, companyId: string, target: string, result: Record<string, unknown> | null) {
  const access = resolveRemoteAccess(cfg, companyId, target.toLowerCase());
  const observation: IdentityObservation = {
    companyId, profileId: access.profileId, target: access.target, checkedAt: new Date().toISOString(),
    status: result?.status === "succeeded" ? "succeeded" : "failed",
    fingerprint: fingerprint(cfg, companyId, access.target),
    transport: typeof result?.transport === "string" && ["winrm_https", "winrm_http", "wmi_dcom_smb"].includes(result.transport) ? result.transport : null,
  };
  // No password, account value, raw command output or failure text is stored.
  await ctx.state.set(stateKey(companyId, access.profileId), observation);
}
export async function getSupportSetup(ctx: PluginContext, cfg: Config, companyId: unknown) {
  if (typeof companyId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(companyId)) throw new IntakeError(422, "Company ID must be a UUID");
  const connections = (cfg.connections ?? []).filter(connection => connection.allowedCompanies?.includes(companyId) && connection.routes?.some(route => route.companyId === companyId));
  const profiles = (cfg.remoteAccessProfiles ?? []).filter(profile => profile.companyId.toLowerCase() === companyId.toLowerCase());
  const windows = await Promise.all(profiles.map(async profile => {
    let issue: string | null = null;
    const samples = [...(profile.targets ?? []).map(target => target.address), ...(profile.scopes ?? []).map(rule => rule.kind === "dns_suffix" ? `setup-check.${rule.value}` : rule.value.split("/")[0]!)];
    try {
      if (!samples.length || profiles.filter(item => item.id === profile.id).length !== 1) throw new Error();
      for (const sample of samples) resolveRemoteAccess(cfg, companyId, sample);
    } catch { issue = "Check this group's account, password secret, domain/range and overlapping access rules."; }
    const saved = typeof profile.id === "string" && profile.id.trim() ? await ctx.state.get(stateKey(companyId, profile.id)) as Partial<IdentityObservation> | null : null;
    let identityTest = null;
    if (saved?.companyId === companyId && saved.profileId === profile.id && typeof saved.target === "string" &&
      typeof saved.checkedAt === "string" && Number.isFinite(Date.parse(saved.checkedAt)) && ["succeeded", "failed"].includes(saved.status ?? "")) {
      let settingsMatch = false;
      try { settingsMatch = fingerprint(cfg, companyId, saved.target) === saved.fingerprint; } catch { /* Removed/changed device scope. */ }
      identityTest = { target: saved.target, checkedAt: saved.checkedAt, status: saved.status, transport: saved.transport, settingsMatch };
    }
    return { id: profile.id, configured: !issue, issue, passwordRef: profile.passwordRef, bindingCount: samples.length, identityTest };
  }));
  return {
    configured: connections.length > 0,
    windows,
    connections: connections.map(connection => ({ id: connection.id, source: connection.source,
      deliveryPluginId: connection.deliveryPluginId ?? null, outboundAccount: connection.outboundAccount ?? null,
      routeCount: connection.routes.filter(route => route.companyId === companyId).length,
      delivery: connection.source === "slack" && connection.pollingEnabled && connection.botTokenRef ? "built-in Slack polling"
        : connection.deliveryPluginId ? `plugin: ${connection.deliveryPluginId}` : "integration agent API",
    })),
    vendorRoutes: (cfg.softwareRoutes ?? []).filter(route => route.reportingCompanyId === companyId).map(route => ({
      id: route.id, productName: route.productName, destinationKind: route.destinationKind, outboundAccount: route.outboundAccount ?? null,
    })),
  };
}
export type SupportSetup = Awaited<ReturnType<typeof getSupportSetup>>;
