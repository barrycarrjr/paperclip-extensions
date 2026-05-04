import type { ConfigAccount, ScopeFilter } from "./engines/types.js";

/**
 * Build a per-call ScopeFilter for an authorized (account, companyId) pair.
 *
 * Modes:
 * - `single`   — no filter at all; account.allowedCompanies is the whole story.
 * - `manual`   — filter against the company's extensionRanges/queueIds/DIDs.
 *                Throws ECOMPANY_NOT_ROUTED if no entry exists.
 * - `native`   — filter via the company's 3CX tenantId header.
 *                Throws ECOMPANY_NOT_ROUTED if no entry exists.
 */
export function buildScopeFilter(
  account: ConfigAccount,
  companyId: string,
): ScopeFilter {
  const mode = account.mode;
  if (mode === "single") {
    return { mode: "single" };
  }
  if (mode === "manual") {
    const entry = (account.companyRouting ?? []).find(
      (r) => r.companyId === companyId,
    );
    if (!entry) {
      throw new Error(
        `[ECOMPANY_NOT_ROUTED] No companyRouting entry for company ${companyId} on account ${account.key}. Add the company's extension ranges, queues, and DIDs in the plugin settings.`,
      );
    }
    return {
      mode: "manual",
      extensions: collectIndividualExtensions(entry.extensionRanges ?? []),
      extensionRanges: entry.extensionRanges ?? [],
      queueIds: entry.queueIds ?? [],
      dids: entry.dids ?? [],
    };
  }
  if (mode === "native") {
    const entry = (account.companyTenants ?? []).find(
      (t) => t.companyId === companyId,
    );
    if (!entry) {
      throw new Error(
        `[ECOMPANY_NOT_ROUTED] No companyTenants entry for company ${companyId} on account ${account.key}. Add the 3CX tenantId for this company in the plugin settings.`,
      );
    }
    return { mode: "native", tenantId: entry.tenantId };
  }
  throw new Error(`[E3CX_CONFIG] Unknown mode "${mode}" on account ${account.key}.`);
}

/**
 * Expand "100-119" + "201" + "300-309" into ["100","101",...,"119","201","300",...].
 *
 * Returns deduped, lexicographic-stable list. Used in scope filters for
 * O(1) "is this extension allowed" lookups.
 */
function collectIndividualExtensions(ranges: string[]): string[] {
  const out = new Set<string>();
  for (const raw of ranges) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi && hi - lo < 10000) {
        // pad to width of the start to preserve "0100-0119" style
        const width = m[1].length;
        for (let i = lo; i <= hi; i++) {
          out.add(String(i).padStart(width, "0"));
        }
      }
      continue;
    }
    out.add(trimmed);
  }
  return Array.from(out);
}

/**
 * Manual-mode helper exposed for engines that need to match a single
 * extension against a company's ranges (for active-call / agent filtering).
 */
export function extensionInScope(
  filter: ScopeFilter,
  extension: string | undefined,
): boolean {
  if (!extension) return false;
  if (filter.mode !== "manual") return true;
  return filter.extensions.includes(extension);
}

export function queueInScope(
  filter: ScopeFilter,
  queueId: string | undefined,
): boolean {
  if (!queueId) return false;
  if (filter.mode !== "manual") return true;
  return filter.queueIds.includes(queueId);
}

export function didInScope(
  filter: ScopeFilter,
  did: string | undefined,
): boolean {
  if (!did) return false;
  if (filter.mode !== "manual") return true;
  return filter.dids.includes(did);
}
