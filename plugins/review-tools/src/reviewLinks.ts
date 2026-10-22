/**
 * The two links a person wants from a review task: the review inside
 * Paperclip, and the listing on Google.
 *
 * The task used to say "open Reviews inside this company, pick the location
 * and choose this review", which is three manual steps from a page that
 * already knows exactly which review it means.
 *
 * Google has no public address for one individual review. It does publish
 * one for the listing, and hands it to us as `mapsUri` on the location, so
 * that is what is linked and that is what the wording promises. Pretending
 * to deep-link a single review would send people to a dead address.
 */

/** What Google tells us about a listing, kept so the links survive between syncs. */
export interface LocationLinks {
  placeId?: string;
  /** Google's own link to the listing, e.g. https://maps.google.com/maps?cid=... */
  mapsUri?: string;
  /** Where a customer would leave a new review. Not used for replying. */
  newReviewUri?: string;
  /** When this was last read from Google, so a stale copy is recognisable. */
  fetchedAt?: string;
}

/** Where a location's Google links live: one instance-wide key per location. */
export function locationLinksStateKey(locationKey: string) {
  return { scopeKind: "instance" as const, stateKey: `location-links:${locationKey}` };
}

/** Narrow whatever came back from plugin state into links we can use. */
export function readLocationLinks(value: unknown): LocationLinks | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const str = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined);
  const links: LocationLinks = {};
  const placeId = str("placeId");
  const mapsUri = str("mapsUri");
  const newReviewUri = str("newReviewUri");
  const fetchedAt = str("fetchedAt");
  if (placeId) links.placeId = placeId;
  if (mapsUri) links.mapsUri = mapsUri;
  if (newReviewUri) links.newReviewUri = newReviewUri;
  if (fetchedAt) links.fetchedAt = fetchedAt;
  return links.mapsUri || links.placeId ? links : null;
}

/**
 * The link to open the listing on Google.
 *
 * Google's own `mapsUri` is preferred. A place id alone still makes a
 * working address, which covers a listing read before this plugin started
 * recording the maps link. Nothing is invented from a business name,
 * because a search for a name can land on somebody else's listing.
 */
export function googleListingUrl(links: LocationLinks | null | undefined): string | null {
  if (!links) return null;
  if (links.mapsUri) return links.mapsUri;
  if (links.placeId) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(links.placeId)}`;
  return null;
}

/**
 * The link that opens this exact review in the Reviews page, with its reply
 * box already on screen.
 *
 * The prefix is the company's own, because every page in Paperclip lives
 * under it. Without one there is no address to give, and a link to the
 * wrong company's page would be worse than none.
 */
export function reviewPageUrl(
  companyPrefix: string | null | undefined,
  locationKey: string,
  reviewName: string,
): string | null {
  if (!companyPrefix) return null;
  const params = new URLSearchParams({ location: locationKey, review: reviewName });
  return `/${companyPrefix}/reviews?${params.toString()}`;
}

export interface ReviewLinkLines {
  /** Markdown for the review task body, or an empty array when no link can be made. */
  lines: string[];
}

/**
 * The markdown put at the top of a review task.
 *
 * The in-app link comes first because it is the one that does the work; the
 * Google link is second and says plainly that it opens the listing rather
 * than the single review.
 */
export function reviewTaskLinkLines(input: {
  companyPrefix: string | null | undefined;
  locationKey: string;
  reviewName: string;
  locationName: string;
  links: LocationLinks | null | undefined;
}): string[] {
  const out: string[] = [];
  const inApp = reviewPageUrl(input.companyPrefix, input.locationKey, input.reviewName);
  if (inApp) out.push(`**[Open this review and reply](${inApp})**`);
  const google = googleListingUrl(input.links);
  if (google) {
    out.push(
      `[Open ${input.locationName} on Google Maps](${google}) then choose its Reviews tab. Google publishes no address that opens one review on its own.`,
    );
  }
  return out;
}
