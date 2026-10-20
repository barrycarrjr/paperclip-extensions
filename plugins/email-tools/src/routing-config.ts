import type { ConfigMailbox, InstanceConfig, RoutingDestination } from "./types.js";
import { isCompanyAllowed } from "./companyAccess.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const validMessageId = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 998 && /^<[^<>@\s\x00-\x1f\x7f]+@[^<>@\s\x00-\x1f\x7f]+>$/.test(v);
export const validUid = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 0xffff_ffff;

function fail(message: string): never { throw new Error(`[EROUTING_CONFIG] ${message}`); }
function known(o: object, keys: string[]) {
  if (Object.keys(o).some(k => !keys.includes(k))) fail("Unknown routing field. Review the mailbox configuration.");
}
function text(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
}

/** Reject malformed disabled destinations too: toggling a checkbox must not hide bad configuration. */
export function routingConfig(m: ConfigMailbox) {
  const r = m.routing;
  if (r === undefined) return { mode: "off" as const, destinations: [] as RoutingDestination[] };
  if (!r || typeof r !== "object" || Array.isArray(r)) fail("Routing must be an object.");
  known(r, ["mode", "routerAgentId", "sendingApprovalConfirmed", "destinations"]);
  const mode = r.mode ?? "off";
  if (!["off", "review", "auto"].includes(mode)) fail("Unknown routing mode.");
  if (r.sendingApprovalConfirmed !== undefined && typeof r.sendingApprovalConfirmed !== "boolean") fail("Invalid acknowledgment.");
  if (r.routerAgentId !== undefined && (typeof r.routerAgentId !== "string" || !UUID.test(r.routerAgentId))) fail("Invalid router agent.");
  if (r.destinations !== undefined && (!Array.isArray(r.destinations) || r.destinations.length > 50)) fail("At most 50 destinations are allowed.");
  const seen = new Set<string>();
  for (const d of r.destinations ?? []) {
    if (!d || typeof d !== "object" || Array.isArray(d)) fail("Invalid destination.");
    known(d, ["key", "label", "description", "companyId", "projectId", "assigneeAgentId", "priority", "enabled"]);
    if (typeof d.key !== "string" || !KEY.test(d.key) || seen.has(d.key)) fail("Destination keys must be valid and unique.");
    seen.add(d.key);
    if (!text(d.label, 100) || !text(d.description, 600)) fail("Each destination needs a bounded label and description.");
    if (![d.companyId, d.projectId, d.assigneeAgentId].every(v => typeof v === "string" && UUID.test(v))) fail("Each destination needs a company, project and agent UUID.");
    if (d.enabled !== undefined && typeof d.enabled !== "boolean") fail("Invalid destination enabled flag.");
    if (d.priority !== undefined && !["low", "medium", "high", "critical"].includes(d.priority)) fail("Invalid priority.");
  }
  if (mode !== "off") {
    if (!r.routerAgentId || !UUID.test(m.ingestCompanyId ?? "")) fail("Choose the ingest company and its router agent.");
    if (!r.sendingApprovalConfirmed) fail("Confirm the operator sending-approval prerequisite before enabling routing.");
    if (m.onReceive?.mode === "issue") fail("Disable on-receive issue mode before routing.");
    if (!(r.destinations ?? []).some(d => d.enabled !== false)) fail("Enable at least one destination.");
  }
  return { mode, destinations: (r.destinations ?? []).filter(d => d.enabled !== false) };
}

export function routingMailbox(config: InstanceConfig, key: unknown): ConfigMailbox {
  if (typeof key !== "string" || key.length < 1 || key.length > 200 || /[\s\x00-\x1f\x7f]/.test(key)) fail("Invalid mailbox identifier.");
  const matches = (config.mailboxes ?? []).filter(m => m.key?.toLowerCase() === key.toLowerCase());
  if (matches.length !== 1) fail("Mailbox must exist with a unique identifier.");
  return matches[0];
}

export function assertRouter(m: ConfigMailbox, companyId: unknown, agentId: unknown) {
  if (typeof companyId !== "string" || !isCompanyAllowed(m.allowedCompanies, companyId)
    || m.ingestCompanyId !== companyId || !agentId || m.routing?.routerAgentId !== agentId) {
    throw new Error("[EROUTE_NOT_ALLOWED] Only the configured router in the mailbox's ingest company may route or list destinations.");
  }
}

export interface RoutingBoardScope { companyId: string; userId: string; isInstanceAdmin: true }
export function boardScope(params: Record<string, unknown>): RoutingBoardScope {
  const s = params.hostScope as RoutingBoardScope | undefined;
  if (!s || s.isInstanceAdmin !== true || !UUID.test(s.companyId ?? "") || typeof s.userId !== "string" || !s.userId.trim()) {
    throw new Error("[EROUTE_ADMIN_REQUIRED] Mail routing requires an authenticated instance admin and company scope.");
  }
  return s;
}

export function assertBoardMailbox(m: ConfigMailbox, scope: RoutingBoardScope) {
  if (m.ingestCompanyId !== scope.companyId || !isCompanyAllowed(m.allowedCompanies, scope.companyId)) {
    throw new Error("[EROUTE_NOT_ALLOWED] The board scope must have access to the mailbox's source company.");
  }
}
