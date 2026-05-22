import type { GbpListReviewsResponse, GbpReview } from "./types.js";
import type { OAuth2Client } from "google-auth-library";
import { getAccessToken } from "./gbpAuth.js";

const GBP_BASE = "https://mybusiness.googleapis.com/v4";

async function gbpFetch(
  oauth2Client: OAuth2Client,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const token = await getAccessToken(oauth2Client);
  const url = `${GBP_BASE}${path}`;
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
    let errMsg = text;
    try {
      const json = JSON.parse(text) as { error?: { message?: string; status?: string } };
      errMsg = json?.error?.message ?? text;
    } catch { /* use raw text */ }
    throw new Error(`[EGBP_HTTP_${res.status}] ${errMsg.slice(0, 300)}`);
  }

  if (!text) return {};
  return JSON.parse(text);
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
  reviewName: string,
): Promise<GbpReview> {
  return gbpFetch(oauth2Client, `/${reviewName}`) as Promise<GbpReview>;
}

export async function postReply(
  oauth2Client: OAuth2Client,
  reviewName: string,
  comment: string,
): Promise<{ comment: string; updateTime: string }> {
  return gbpFetch(oauth2Client, `/${reviewName}/reply`, {
    method: "PUT",
    body: { comment },
  }) as Promise<{ comment: string; updateTime: string }>;
}

export async function deleteReply(
  oauth2Client: OAuth2Client,
  reviewName: string,
): Promise<void> {
  await gbpFetch(oauth2Client, `/${reviewName}/reply`, { method: "DELETE" });
}

export async function getGbpAccounts(
  oauth2Client: OAuth2Client,
): Promise<Array<{ name: string; accountName: string; type: string }>> {
  const res = await gbpFetch(oauth2Client, "/accounts") as { accounts?: Array<{ name: string; accountName: string; type: string }> };
  return res.accounts ?? [];
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
