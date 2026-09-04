/**
 * Which review locations a company is allowed to see.
 *
 * This closes a real leak. The dashboard's `review-summary` handler looped
 * over every configured location and returned all of them, ignoring the
 * company the page was opened in. Each location already carries a
 * `targetCompanyId` — the company whose review issues it creates — and that
 * field was simply never consulted for reading. So an operator in company A
 * saw company B's locations, their review counts, their unreplied backlog and
 * their average rating.
 *
 * The rule, in the owner's words: a company sees its own; the portfolio root
 * (HQ) is the one place a roll-up across companies is legitimate.
 *
 * Fails closed. No company means no locations, rather than everything, which
 * is what the old behaviour amounted to.
 */

export interface ScopedLocation {
  key: string;
  displayName?: string;
  /** The Paperclip company this location belongs to. */
  targetCompanyId?: string;
}

export interface LocationScopeInput<T extends ScopedLocation> {
  companyId: string | null | undefined;
  /**
   * Whether the viewing company is the portfolio root. Only the host knows
   * this, so it is passed in rather than guessed from the id.
   */
  isPortfolioRoot: boolean;
  locations: T[] | null | undefined;
}

export interface LocationScopeResult<T extends ScopedLocation> {
  locations: T[];
  /** True when this is the cross-company roll-up rather than one company's own. */
  isRollup: boolean;
}

export function scopeLocationsForCompany<T extends ScopedLocation>(
  input: LocationScopeInput<T>,
): LocationScopeResult<T> {
  const { companyId, isPortfolioRoot, locations } = input;
  if (!locations || locations.length === 0) return { locations: [], isRollup: false };

  // No company in context is not a licence to show everything. The page is
  // always opened inside one; its absence means something is wrong, and the
  // safe answer to "whose data is this" is none.
  if (!companyId) return { locations: [], isRollup: false };

  if (isPortfolioRoot) {
    return { locations: [...locations], isRollup: true };
  }

  return {
    // A location with no target company belongs to nobody in particular, so it
    // is not shown to a specific company. It still appears in the HQ roll-up,
    // where someone can see it needs configuring.
    locations: locations.filter((location) => location.targetCompanyId === companyId),
    isRollup: false,
  };
}
