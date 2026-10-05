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

/**
 * Which configured location a review EMAIL belongs to.
 *
 * Google's notification emails name the business, not the location id, so
 * the match is by display name. The old code fell back to the first
 * configured location whenever the name did not match, regardless of how
 * many locations there were, which filed company B's review as an issue in
 * company A. That is the write-side twin of the read-side leak fixed in
 * v0.1.8.
 *
 * The fallback survives only where it cannot be wrong: exactly one location
 * configured, so there is nothing else it could be. With several, a name
 * that matches nothing returns null and the caller skips the email and logs
 * it, so somebody can fix the display name. Guessing is not an option when
 * the guess decides which company sees a customer's words.
 */
export function resolveEmailLocation<T extends { displayName?: string }>(
  locations: readonly T[] | null | undefined,
  businessName: string | null | undefined,
): T | null {
  if (!locations || locations.length === 0) return null;
  const wanted = businessName?.trim().toLowerCase();
  if (wanted) {
    const match = locations.find((l) => l.displayName?.trim().toLowerCase() === wanted);
    if (match) return match;
  }
  return locations.length === 1 ? locations[0]! : null;
}
