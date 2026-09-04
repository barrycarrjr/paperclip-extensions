/**
 * Which PBX account is behind the page you are looking at, and who else it
 * serves.
 *
 * The reason this exists, from the host project's scope document
 * (docs/plans/2026-09-02-ux-control-center-scope.md, "A stable scope layer"):
 * a shared service is its own kind of scope, and the rule for it is "show the
 * real account/location scope alongside the current company filter".
 *
 * Everything else in Paperclip is company-bound: what you see in company A is
 * company A's. A PBX account is not. One account can be allow-listed to every
 * company at once (`allowedCompanies: ["*"]`), and then a call list read under
 * one company is really the shared account's call list. Nothing on screen said
 * so, which is the problem — an operator reasonably reads a page inside a
 * company as being about that company.
 *
 * This only describes; it does not restrict. `assertCompanyAccess` remains
 * the thing that decides what a caller may touch, and it is unchanged.
 */

export interface ScopedAccount {
  /** The account key operators see in configuration. */
  key?: string;
  name?: string;
  allowedCompanies?: string[];
}

export type AccountReach =
  /** Allow-listed to every company via the "*" wildcard. */
  | "all-companies"
  /** Named on more than one company's allow list. */
  | "several-companies"
  /** Only this company can reach it. */
  | "this-company-only";

export interface AccountScopeEntry {
  key: string;
  name: string | null;
  reach: AccountReach;
  /** How many companies are named, when they are named individually. */
  namedCompanyCount: number;
}

export interface AccountScopeSummary {
  /** Accounts this company can actually use. */
  accounts: AccountScopeEntry[];
  /**
   * True when at least one usable account reaches beyond this company, so a
   * surface can decide whether it needs to say anything at all.
   */
  anyShared: boolean;
}

function reachOf(allow: string[], companyId: string): AccountReach {
  if (allow.includes("*")) return "all-companies";
  const named = allow.filter((entry) => entry !== companyId);
  return named.length > 0 ? "several-companies" : "this-company-only";
}

/**
 * Summarise the accounts a company can reach.
 *
 * Accounts the company cannot use are left out entirely rather than listed as
 * unavailable: this is a disclosure about the data on screen, and an account
 * that cannot produce any of it is not part of that story. Deciding access is
 * `assertCompanyAccess`'s job, not this function's.
 */
export function describeAccountScope(
  companyId: string | null | undefined,
  accounts: ScopedAccount[] | null | undefined,
): AccountScopeSummary {
  if (!companyId || !accounts || accounts.length === 0) {
    return { accounts: [], anyShared: false };
  }

  const entries: AccountScopeEntry[] = [];
  for (const account of accounts) {
    const allow = account.allowedCompanies ?? [];
    const usable = allow.includes("*") || allow.includes(companyId);
    if (!usable) continue;

    const reach = reachOf(allow, companyId);
    entries.push({
      key: account.key ?? account.name ?? "(default)",
      name: account.name ?? null,
      reach,
      // The wildcard names nobody, so a count would be a guess. Zero is
      // honest; the reach already says "every company".
      namedCompanyCount: reach === "all-companies" ? 0 : allow.length,
    });
  }

  return {
    accounts: entries,
    anyShared: entries.some((entry) => entry.reach !== "this-company-only"),
  };
}

/**
 * One plain sentence for an account, in the words an operator would use.
 *
 * Deliberately says "shared", not "wildcard" or "allow-listed": the reader
 * needs to know that what they are looking at is not private to the company
 * they are in, which is a fact about their data, not about configuration
 * syntax.
 */
export function describeAccountReach(entry: AccountScopeEntry): string {
  switch (entry.reach) {
    case "all-companies":
      return "Shared with every company on this instance.";
    case "several-companies":
      return `Shared with ${entry.namedCompanyCount} companies, including this one.`;
    case "this-company-only":
      return "Used only by this company.";
    default: {
      const unhandled: never = entry.reach;
      void unhandled;
      return "";
    }
  }
}
