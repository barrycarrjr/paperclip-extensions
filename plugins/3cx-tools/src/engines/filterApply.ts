/**
 * Pure helpers used by manual-mode engines to filter result lists
 * client-side after the API call.
 *
 * In `single` mode these helpers are skipped (no scoping needed).
 * In `native` mode the engine sets a tenantId header so the API filters
 * server-side; these helpers are also skipped.
 *
 * Only `manual` mode invokes these — when a single PBX is shared across
 * multiple Paperclip companies and we have to slice up results by the
 * by-convention partitioning the operator declared.
 */
import type {
  NormalizedActiveCall,
  NormalizedAgent,
  NormalizedCallRecord,
  NormalizedDid,
  NormalizedExtension,
  NormalizedParkedCall,
  NormalizedQueue,
  ScopeFilter,
} from "./types.js";
import { didInScope, extensionInScope, queueInScope } from "../scopeFilter.js";

export function filterQueues(
  scope: ScopeFilter,
  queues: NormalizedQueue[],
): NormalizedQueue[] {
  if (scope.mode !== "manual") return queues;
  return queues.filter(
    (q) => queueInScope(scope, q.id) || queueInScope(scope, q.extension),
  );
}

export function filterParkedCalls(
  scope: ScopeFilter,
  parked: NormalizedParkedCall[],
): NormalizedParkedCall[] {
  if (scope.mode !== "manual") return parked;
  // A parked slot is in scope if the extension that parked it (or the
  // pickup target) is in the company's extension range. Some 3CX configs
  // don't expose `originalExtension` — when missing we fall back to
  // including the slot if it's in any of the company's ranges, which
  // happens implicitly in the API since manual-mode park slots are
  // tied to extension groups.
  return parked.filter((p) => extensionInScope(scope, p.originalExtension));
}

export function filterActiveCalls(
  scope: ScopeFilter,
  calls: NormalizedActiveCall[],
): NormalizedActiveCall[] {
  if (scope.mode !== "manual") return calls;
  return calls.filter(
    (c) =>
      extensionInScope(scope, c.extension) ||
      queueInScope(scope, c.queue) ||
      didInScope(scope, c.toNumber) ||
      didInScope(scope, c.fromNumber),
  );
}

export function filterAgents(
  scope: ScopeFilter,
  agents: NormalizedAgent[],
): NormalizedAgent[] {
  if (scope.mode !== "manual") return agents;
  return agents.filter((a) => extensionInScope(scope, a.extension));
}

export function filterCallHistory(
  scope: ScopeFilter,
  calls: NormalizedCallRecord[],
): NormalizedCallRecord[] {
  if (scope.mode !== "manual") return calls;
  return calls.filter(
    (c) =>
      extensionInScope(scope, c.extension) ||
      queueInScope(scope, c.queue) ||
      didInScope(scope, c.toNumber) ||
      didInScope(scope, c.fromNumber),
  );
}

export function filterDids(
  scope: ScopeFilter,
  dids: NormalizedDid[],
): NormalizedDid[] {
  if (scope.mode !== "manual") return dids;
  return dids.filter((d) => didInScope(scope, d.e164));
}

export function filterExtensions(
  scope: ScopeFilter,
  exts: NormalizedExtension[],
): NormalizedExtension[] {
  if (scope.mode !== "manual") return exts;
  return exts.filter((e) => extensionInScope(scope, e.number));
}
