import { createHash } from "node:crypto";
import { IntakeError, type Config, type TicketPolicy } from "./routing.js";
import { diagnosticIds } from "./diagnostic-catalog.js";

export function ticketPolicy(cfg: Config, companyId: string): TicketPolicy {
  const matches = (cfg.ticketPolicies ?? []).filter(item => item.companyId === companyId);
  const policy = matches[0];
  if (matches.length !== 1 || !policy || policy.enabled !== true ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(policy.agentId ?? "") ||
      !Array.isArray(policy.diagnostics) || policy.diagnostics.some(id => !diagnosticIds.includes(id as never) || ["repair_rehearsal", "connectivity"].includes(id)) ||
      new Set(policy.diagnostics).size !== policy.diagnostics.length || typeof policy.allowThreadUpdates !== "boolean") {
    throw new IntakeError(403, "A unique enabled company ticket policy is required");
  }
  return policy;
}
export function ticketPolicyHash(policy: TicketPolicy) {
  return createHash("sha256").update(JSON.stringify([policy.companyId,policy.agentId,policy.enabled,
    [...policy.diagnostics].sort(),policy.allowThreadUpdates])).digest("hex");
}
