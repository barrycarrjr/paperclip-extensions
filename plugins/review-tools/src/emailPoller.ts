/**
 * Gmail API poller for Google Business Profile review notification emails.
 *
 * GBP sends emails from review-noreply@google.com with subjects like
 * "New review for <Business Name>". This module searches the configured inbox
 * for unseen emails matching that pattern and parses them into structured
 * review data for Phase 1 issue creation.
 *
 * Uses the Gmail REST API directly with the GBP OAuth2 client (requires
 * gmail.readonly scope to be included in the account's refresh token).
 */

import type { OAuth2Client } from "google-auth-library";
import { getAccessToken } from "./gbpAuth.js";
import { describeGoogleApiError } from "./googleError.js";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const GBP_SENDER = "review-noreply@google.com";
const GBP_SUBJECT_PREFIX = "New review for";

export interface ParsedReviewEmail {
  messageId: string;
  businessName: string;
  reviewerName: string;
  starRating: string;
  reviewText: string;
  receivedAt: string;
}

async function gmailFetch(
  oauth2Client: OAuth2Client,
  path: string,
): Promise<unknown> {
  const token = await getAccessToken(oauth2Client);
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // A token granted without gmail.readonly fails here with a 403 whose
    // text is about "scopes" and names no product. The mapped message says
    // which permission is missing and that reconnecting is the fix.
    throw new Error(describeGoogleApiError("gmail", res.status, await res.text()));
  }
  return res.json();
}

/**
 * How far back to look when the plugin has never polled before.
 *
 * Without a bound, a first run searches the whole mailbox and can open an
 * issue for every review notification the account has ever received. Seven
 * days is enough to catch anything recent without a flood on the day
 * somebody switches polling on.
 */
export const FIRST_RUN_WINDOW_DAYS = 7;

export function firstRunAfterSeconds(now: Date): number {
  return Math.floor((now.getTime() - FIRST_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000);
}

export async function searchReviewEmails(
  oauth2Client: OAuth2Client,
  afterEpochSeconds?: number,
): Promise<Array<{ id: string; threadId: string }>> {
  // Always bounded: the caller's recorded checkpoint, or the first-run
  // window when there is none.
  const after = afterEpochSeconds ?? firstRunAfterSeconds(new Date());
  // `is:unread` used to be part of this. It was doing the job of an
  // idempotency check, badly: the plugin cannot mark anything read on a
  // read-only scope, so every matching email stayed unread and was fetched
  // again on every poll for ever. Which messages have been handled is held
  // in plugin state by message id, which works whatever the mailbox says.
  const query = encodeURIComponent(`from:${GBP_SENDER} subject:"${GBP_SUBJECT_PREFIX}" after:${after}`);
  const res = await gmailFetch(oauth2Client, `/users/me/messages?q=${query}&maxResults=50`) as {
    messages?: Array<{ id: string; threadId: string }>;
  };
  return res.messages ?? [];
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function extractHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseStarRating(text: string): string {
  const fiveStarPatterns = [/5\s*(?:out of)?\s*5/i, /5 stars?/i, /five stars?/i];
  const fourStarPatterns = [/4\s*(?:out of)?\s*5/i, /4 stars?/i, /four stars?/i];
  const threeStarPatterns = [/3\s*(?:out of)?\s*5/i, /3 stars?/i, /three stars?/i];
  const twoStarPatterns = [/2\s*(?:out of)?\s*5/i, /2 stars?/i, /two stars?/i];
  const oneStarPatterns = [/1\s*(?:out of)?\s*5/i, /1 star/i, /one star/i];

  if (fiveStarPatterns.some((p) => p.test(text))) return "FIVE";
  if (fourStarPatterns.some((p) => p.test(text))) return "FOUR";
  if (threeStarPatterns.some((p) => p.test(text))) return "THREE";
  if (twoStarPatterns.some((p) => p.test(text))) return "TWO";
  if (oneStarPatterns.some((p) => p.test(text))) return "ONE";

  // Count star emojis as fallback
  const starCount = (text.match(/⭐/g) ?? []).length;
  const ratingMap: Record<number, string> = { 1: "ONE", 2: "TWO", 3: "THREE", 4: "FOUR", 5: "FIVE" };
  return ratingMap[starCount] ?? "FIVE";
}

function parseReviewerName(body: string, subject: string): string {
  // GBP emails typically include "X left a review" or "X gave a X-star rating"
  const patterns = [
    /^([A-Z][a-zA-Z\s'-]+?) (?:left a review|gave|reviewed|wrote)/m,
    /^([A-Z][a-zA-Z\s'-]+?) (?:\d|rated)/m,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  // Try subject line: "New review for <Business> from <Reviewer>"
  const subjectMatch = subject.match(/from\s+([A-Z][a-zA-Z\s'-]+)/i);
  if (subjectMatch?.[1]) return subjectMatch[1].trim();
  return "A Google reviewer";
}

function parseReviewText(body: string): string {
  // Look for the review content between common delimiters in GBP emails
  const patterns = [
    /(?:wrote|says?|left a review):\s*["“]?(.+?)["”]?(?:\n|$)/is,
    /Review:\s*(.+?)(?:\n\n|$)/is,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  // No structured text found — extract meaningful paragraphs
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 20 && !/^https?:/.test(l));
  return lines.slice(0, 3).join(" ") || "(no review text)";
}

function extractBusinessName(subject: string): string {
  const match = subject.match(/New review for (.+)/i);
  return match?.[1]?.trim() ?? "your business";
}

export async function fetchAndParseEmail(
  oauth2Client: OAuth2Client,
  messageId: string,
): Promise<ParsedReviewEmail | null> {
  const msg = await gmailFetch(
    oauth2Client,
    `/users/me/messages/${messageId}?format=full`,
  ) as {
    id: string;
    internalDate?: string;
    payload?: {
      headers?: Array<{ name: string; value: string }>;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    };
  };

  const headers = msg.payload?.headers ?? [];
  const subject = extractHeader(headers, "Subject");

  if (!subject.toLowerCase().startsWith("new review for")) return null;

  let body = "";
  if (msg.payload?.body?.data) {
    body = decodeBase64Url(msg.payload.body.data);
  } else {
    const textPart = (msg.payload?.parts ?? []).find(
      (p) => p.mimeType === "text/plain" && p.body?.data,
    );
    if (textPart?.body?.data) body = decodeBase64Url(textPart.body.data);
  }

  const receivedAt = msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10)).toISOString()
    : new Date().toISOString();

  return {
    messageId,
    businessName: extractBusinessName(subject),
    reviewerName: parseReviewerName(body, subject),
    starRating: parseStarRating(body),
    reviewText: parseReviewText(body),
    receivedAt,
  };
}

/**
 * Try to clear the UNREAD label, and say whether Google allowed it.
 *
 * This can never succeed on the scope this plugin asks for: marking a
 * message read is a write, so it needs `gmail.modify`, while the plugin
 * requests `gmail.readonly` and should keep doing so, because a plugin that
 * reads notification emails has no business being able to change a mailbox.
 *
 * The call used to ignore its own response, so the failure was invisible and
 * the message stayed unread for ever. Nothing depends on it now: which
 * emails have been handled is recorded in plugin state by message id, and
 * the search no longer filters on unread. It is still attempted because a
 * token that happens to carry `gmail.modify` makes the mailbox tidier, and
 * the caller logs the refusal once rather than silently retrying for ever.
 */
export async function markEmailRead(
  oauth2Client: OAuth2Client,
  messageId: string,
): Promise<boolean> {
  const token = await getAccessToken(oauth2Client);
  const res = await fetch(`${GMAIL_BASE}/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
  return res.ok;
}
