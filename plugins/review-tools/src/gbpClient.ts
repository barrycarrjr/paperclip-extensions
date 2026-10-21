import { canonicalReviewName, type ParsedReviewName } from "./reviewName.js";
import type { GbpListReviewsResponse, GbpReview } from "./types.js";
import type { OAuth2Client } from "google-auth-library";
import { getAccessToken } from "./gbpAuth.js";
import { describeGoogleApiError } from "./googleError.js";

/**
 * Google serves this product from three different hosts, and which one you
 * need depends on what you are asking for. Getting this wrong is silent: the
 * wrong host answers 404 with an HTML page, which reads like a missing
 * location rather than a call to an API that was never there.
 *
 * - Reviews are ONLY on the old v4 host. They were never migrated, so v4 is
 *   current for this one job and is not deprecated out from under us.
 * - Listing the accounts a credential can see moved to Account Management v1.
 *   The v4 `/accounts` path this plugin used to call now returns 404, which
 *   is why the setup script could never find an account id.
 * - Listing the locations under an account moved to Business Information v1,
 *   which also requires an explicit readMask naming the fields you want.
 */
const REVIEWS_BASE = "https://mybusiness.googleapis.com/v4";
const ACCOUNTS_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const LOCATIONS_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";

async function googleFetch(
  oauth2Client: OAuth2Client,
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const token = await getAccessToken(oauth2Client);
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    // describeGoogleApiError tells apart the three refusals that all arrive
    // as a 403: a token missing the scope, an API not enabled on the Cloud
    // project, and no approved quota. Each needs a different person to do a
    // different thing, and they used to be reported identically.
    throw new Error(describeGoogleApiError("gbp", res.status, text));
  }

  if (!text) return {};
  return JSON.parse(text);
}

async function gbpFetch(
  oauth2Client: OAuth2Client,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  return googleFetch(oauth2Client, `${REVIEWS_BASE}${path}`, options);
}

export async function listReviews(
  oauth2Client: OAuth2Client,
  googleAccountId: string,
  locationId: string,
  pageToken?: string,
): Promise<GbpListReviewsResponse> {
  const path = `/accounts/${googleAccountId}/locations/${locationId}/reviews${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`;
  return gbpFetch(oauth2Client, path) as Promise<GbpListReviewsResponse>;
}

export async function getAllReviews(
  oauth2Client: OAuth2Client,
  googleAccountId: string,
  locationId: string,
): Promise<GbpReview[]> {
  const all: GbpReview[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listReviews(oauth2Client, googleAccountId, locationId, pageToken);
    if (page.reviews) all.push(...page.reviews);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all;
}

export async function getReview(
  oauth2Client: OAuth2Client,
  review: ParsedReviewName,
): Promise<GbpReview> {
  return gbpFetch(oauth2Client, `/${canonicalReviewName(review)}`) as Promise<GbpReview>;
}

// Takes a PARSED name on purpose: the only way to get one is through
// parseReviewName, so a raw string from a caller can no longer reach the
// URL path. See reviewName.ts.
export async function postReply(
  oauth2Client: OAuth2Client,
  review: ParsedReviewName,
  comment: string,
): Promise<{ comment: string; updateTime: string }> {
  return gbpFetch(oauth2Client, `/${canonicalReviewName(review)}/reply`, {
    method: "PUT",
    body: { comment },
  }) as Promise<{ comment: string; updateTime: string }>;
}

export async function deleteReply(
  oauth2Client: OAuth2Client,
  review: ParsedReviewName,
): Promise<void> {
  await gbpFetch(oauth2Client, `/${canonicalReviewName(review)}/reply`, { method: "DELETE" });
}

export interface GbpAccountSummary {
  /** The numeric id used in every other call, taken from `accounts/<id>`. */
  accountId: string;
  /** What the account is called in Google's own UI. */
  accountName: string;
  type: string;
}

export interface GbpLocationSummary {
  /** The numeric id used in the reviews path, taken from `locations/<id>`. */
  locationId: string;
  /** The business name Google holds for this location. */
  title: string;
  storeCode?: string;
}

/** The trailing id of a `collection/<id>` resource name. */
function resourceId(name: string | undefined): string {
  if (!name) return "";
  const last = name.split("/").pop();
  return last ?? "";
}

/**
 * Every Google Business Profile account the credential can see.
 *
 * Account Management v1, not v4: the v4 path answers 404 and always did for
 * this call, which is why the id had to be copied out of a browser URL.
 */
export async function getGbpAccounts(
  oauth2Client: OAuth2Client,
): Promise<GbpAccountSummary[]> {
  const out: GbpAccountSummary[] = [];
  let pageToken: string | undefined;
  do {
    const url = `${ACCOUNTS_BASE}/accounts?pageSize=20${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const page = await googleFetch(oauth2Client, url) as {
      accounts?: Array<{ name?: string; accountName?: string; type?: string }>;
      nextPageToken?: string;
    };
    for (const a of page.accounts ?? []) {
      out.push({
        accountId: resourceId(a.name),
        accountName: a.accountName ?? resourceId(a.name),
        type: a.type ?? "UNKNOWN",
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Every location under one account.
 *
 * Business Information v1. The readMask is required: without it the call is
 * refused, and it is the reason this cannot be folded into the v4 client.
 */
export async function getGbpLocations(
  oauth2Client: OAuth2Client,
  accountId: string,
): Promise<GbpLocationSummary[]> {
  const out: GbpLocationSummary[] = [];
  let pageToken: string | undefined;
  do {
    const url =
      `${LOCATIONS_BASE}/accounts/${encodeURIComponent(accountId)}/locations` +
      `?readMask=${encodeURIComponent("name,title,storeCode")}&pageSize=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const page = await googleFetch(oauth2Client, url) as {
      locations?: Array<{ name?: string; title?: string; storeCode?: string }>;
      nextPageToken?: string;
    };
    for (const l of page.locations ?? []) {
      out.push({
        locationId: resourceId(l.name),
        title: l.title ?? resourceId(l.name),
        ...(l.storeCode ? { storeCode: l.storeCode } : {}),
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

export function starRatingToNumber(rating: string): number {
  const map: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
  return map[rating] ?? 0;
}

export function starRatingToEmoji(rating: string): string {
  const n = starRatingToNumber(rating);
  return n > 0 ? "⭐".repeat(n) : rating;
}

export function reviewPriority(rating: string): "high" | "medium" | "low" {
  const n = starRatingToNumber(rating);
  if (n <= 2) return "high";
  if (n === 3) return "medium";
  return "low";
}
