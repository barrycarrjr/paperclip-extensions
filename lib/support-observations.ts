import { createHash } from "node:crypto";
import type { BridgeEvent } from "./support-delivery.js";
export const observationEvent = "plugin.customer-support.observation-requested";
export const observationOperations = { "help-scout": ["mailbox", "conversation"], "3cx-tools": ["overview"], "unifi-tools": ["site", "device"], "google-workspace": ["backup_verify"], "phone-tools": ["assistant_routing"] } as const;
export type ObservationProvider = keyof typeof observationOperations;
export interface ObservationRequest {
  version: 1; requestId: string; companyId: string; provider: ObservationProvider; account: string;
  operation: string; resourceId: string; requestSha256: string; expiresAt: string;
}
export function observationHash(value: Omit<ObservationRequest, "requestSha256">) {
  return createHash("sha256").update(JSON.stringify([value.version, value.requestId, value.companyId, value.provider, value.account, value.operation, value.resourceId, value.expiresAt])).digest("hex");
}
export function parseObservation(event: BridgeEvent, provider: ObservationProvider): ObservationRequest | null {
  if (event.eventType !== observationEvent || event.actorType !== "plugin" || event.actorId !== "customer-support") return null;
  const p = event.payload as ObservationRequest | null;
  if (!p || p.version !== 1 || p.provider !== provider || p.companyId !== event.companyId || !/^[a-f0-9-]{36}$/i.test(p.companyId) || !/^[a-f0-9-]{36}$/i.test(p.requestId) || typeof p.account !== "string" || !/^[a-z0-9_-]{1,120}$/i.test(p.account) || !(observationOperations[provider] as readonly string[]).includes(p.operation) || typeof p.resourceId !== "string" || p.resourceId.length > 100 || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) < Date.now() || Date.parse(p.expiresAt) > Date.now() + 180000 || observationHash(p) !== p.requestSha256) return null;
  if (provider === "help-scout" && !/^[1-9][0-9]{0,14}$/.test(p.resourceId)) return null;
  if ((provider === "google-workspace" || provider === "phone-tools") && !/^[a-z0-9_-]{1,100}$/i.test(p.resourceId)) return null;
  if (provider === "3cx-tools" && p.resourceId !== "") return null;
  if (provider === "unifi-tools" && !(p.operation === "site" ? /^[a-f0-9-]{36}$/i : /^[a-f0-9-]{36}\/[a-f0-9-]{36}$/i).test(p.resourceId)) return null;
  return p;
}
export async function consumeObservation(port: { events: { emit(name: string, companyId: string, payload: unknown): Promise<void> } }, provider: ObservationProvider, event: BridgeEvent, read: (request: ObservationRequest) => Promise<unknown>) {
  const request = parseObservation(event, provider); if (!request) return;
  let status = "unavailable", findings: unknown = null;
  try {
    findings = await read(request);
    if (Buffer.byteLength(JSON.stringify(findings)) > 40000) throw new Error("Observation exceeds bound");
    status = "available";
  } catch { findings = { reason: "Read unavailable. Check the configured account, company scope, resource and provider permissions; no changes were attempted." }; }
  await port.events.emit("support-observation-receipt", request.companyId, { version: 1, requestId: request.requestId, companyId: request.companyId, requestSha256: request.requestSha256, status, findings, observedAtUtc: new Date().toISOString() });
}
