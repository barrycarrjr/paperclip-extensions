import { createHash } from "node:crypto";
import { IntakeError, type Config, type TicketPolicy } from "./routing.js";
import { diagnosticIds } from "./diagnostic-catalog.js";

export function ticketPolicy(cfg: Config, companyId: string): TicketPolicy {
  const matches = (cfg.ticketPolicies ?? []).filter(item => item.companyId === companyId);
  const policy = matches[0];
  if (matches.length !== 1 || !policy || policy.enabled !== true ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(policy.agentId ?? "") ||
      !Array.isArray(policy.diagnostics) || policy.diagnostics.some(id => !diagnosticIds.includes(id as never) || ["repair_rehearsal", "connectivity"].includes(id)) ||
      new Set(policy.diagnostics).size !== policy.diagnostics.length || typeof policy.allowThreadUpdates !== "boolean" ||
      (policy.sources !== undefined && (!Array.isArray(policy.sources) || !policy.sources.length || new Set(policy.sources).size !== policy.sources.length || policy.sources.some(source=>!["slack","helpscout"].includes(source))))) {
    throw new IntakeError(403, "A unique enabled company ticket policy is required");
  }
  return policy;
}
export function ticketPolicyHash(policy: TicketPolicy) {
  const original=[policy.companyId,policy.agentId,policy.enabled,[...policy.diagnostics].sort(),policy.allowThreadUpdates];
  // Existing Slack-only configurations keep their original proof hash.
  return createHash("sha256").update(JSON.stringify(policy.sources===undefined?original:[...original,[...policy.sources].sort()])).digest("hex");
}
