/**
 * A Google review's resource name, checked before it goes anywhere.
 *
 * The reply tool used to interpolate whatever it was handed straight into the
 * Google URL path: `/${reviewName}/reply`. Nothing checked the shape, nothing
 * encoded it, and nothing checked that the review belonged to the location
 * the caller named. So a caller authorised for one location could reply to
 * any review the account's token could reach, and a crafted value could
 * address a different endpoint entirely.
 *
 * The shape Google uses is fixed:
 *   accounts/<accountId>/locations/<locationId>/reviews/<reviewId>
 * Account and location ids are numeric; the review id is an opaque token.
 * Anything else is refused, and a review is only accepted for a location
 * whose account and location ids it actually carries.
 */

export interface ParsedReviewName {
  accountId: string;
  locationId: string;
  reviewId: string;
}

const REVIEW_NAME = /^accounts\/(\d+)\/locations\/(\d+)\/reviews\/([A-Za-z0-9_\-]+)$/;

export function parseReviewName(reviewName: unknown): ParsedReviewName | null {
  if (typeof reviewName !== "string") return null;
  const m = REVIEW_NAME.exec(reviewName.trim());
  if (!m) return null;
  return { accountId: m[1]!, locationId: m[2]!, reviewId: m[3]!, };
}

/**
 * Does this review belong to this configured location?
 *
 * Both ids must match. Comparing only the location id would let a review
 * from the same location number under a different Google account through,
 * which is not a real-world coincidence anyone should rely on being absent.
 */
export function reviewBelongsToLocation(
  parsed: ParsedReviewName,
  location: { googleAccountId?: string; locationId?: string },
): boolean {
  return (
    parsed.accountId === String(location.googleAccountId ?? "") &&
    parsed.locationId === String(location.locationId ?? "")
  );
}

/**
 * The name re-assembled from its checked parts, safe to place in a URL path.
 * Never the caller's original string, so stray characters cannot survive the
 * check by hiding in what is passed on.
 */
export function canonicalReviewName(parsed: ParsedReviewName): string {
  return `accounts/${encodeURIComponent(parsed.accountId)}/locations/${encodeURIComponent(parsed.locationId)}/reviews/${encodeURIComponent(parsed.reviewId)}`;
}
