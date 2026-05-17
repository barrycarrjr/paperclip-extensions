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
  NormalizedRecording,
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
  _scope: ScopeFilter,
  parked: NormalizedParkedCall[],
): NormalizedParkedCall[] {
  // Park slots on 3CX are shared infrastructure (the configured slots are
  // literally called "Shared parking") — they don't belong to any one
  // company in a manual-mode setup. The XAPI's ActiveCalls view of a
  // parked call also doesn't carry the original-leg extension or DID, so
  // there's no reliable field to scope on anyway. Surface all parked
  // calls regardless of mode; the BLF UI works the same way.
  return parked;
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

export function filterRecordings(
  scope: ScopeFilter,
  recordings: NormalizedRecording[],
): NormalizedRecording[] {
  if (scope.mode !== "manual") return recordings;
  return recordings.filter(
    (r) =>
      extensionInScope(scope, r.extension) ||
      didMatchesScope(scope, r.fromDidNumber) ||
      didMatchesScope(scope, r.toDidNumber),
  );
}

/**
 * Authorize the audio-fetch route. A recording is in scope if the
 * internal extension matches OR (when extension matching fails) one of
 * the DIDs matches — same OR-of-attributes logic as `filterRecordings`.
 * The audio handler passes the already-resolved scope plus the recording
 * metadata; callers should pre-load metadata to take advantage of DID
 * matching.
 */
export function recordingInScope(
  scope: ScopeFilter,
  args: { extension?: string; fromDidNumber?: string; toDidNumber?: string },
): boolean {
  if (scope.mode !== "manual") return true;
  return (
    extensionInScope(scope, args.extension) ||
    didMatchesScope(scope, args.fromDidNumber) ||
    didMatchesScope(scope, args.toDidNumber)
  );
}

/**
 * 3CX returns DIDs on Recording entries as bare digits ("12154636348"),
 * while the operator types them with a `+` prefix ("+12154636348") in
 * the configured `dids` list. Match in either direction by comparing
 * the bare-digits form.
 */
function didMatchesScope(scope: ScopeFilter, did: string | undefined): boolean {
  if (!did || scope.mode !== "manual") return false;
  const bare = did.replace(/^\+/, "");
  for (const configured of scope.dids) {
    if (configured.replace(/^\+/, "") === bare) return true;
  }
  return false;
}
