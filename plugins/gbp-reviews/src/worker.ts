import { randomUUID } from "node:crypto";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { resolveEmailLocation, scopeLocationsForCompany } from "./locationScope.js";
import { canonicalReviewName, parseReviewName, reviewBelongsToLocation } from "./reviewName.js";
import { accountLabel, buildDraftReply, postsAs } from "./draftReply.js";
import { nextReplySource, type ReplySource } from "./replySource.js";
import { postReplyGuarded, settlePendingAttempts, STALE_IN_FLIGHT_MS } from "./replyGuard.js";
import { createDbReplyStore } from "./replyStore.js";
import { requireCompanyScope, type CompanyScope } from "./hostScope.js";
import { isCompanyAllowedForAccount } from "./companyAccess.js";
import {
  findPendingAttempt,
  findReviewForLocation,
  listReviewsForLocation,
  resolveScopedLocation,
  resolveScopedLocationForReview,
  summaryForLocation,
} from "./reviewQueries.js";

/**
 * A tool result that the host will treat as a failure.
 *
 * Every error path here used to return `{ content: "[E...] ..." }`, which is
 * success-shaped: the host saw a completed call with some text in it and
 * never marked the reply as failed. ToolResult has an `error` field for
 * exactly this. Using it means a refused or failed public post shows up as
 * refused or failed, rather than as a run that went fine.
 */
function fail(message: string) {
  return { content: message, error: message };
}
/**
 * A refusal for a page handler. Thrown rather than returned so the bridge
 * reports it as a failure and the route's own log captures the reason. The
 * sentence is what the person reads; the code is what the page maps on.
 */
function refuse(code: string, sentence: string): never {
  throw new Error(`[${code}] ${sentence}`);
}
import { findAccount, getOAuthClient, wrapGbpError } from "./gbpAuth.js";
import {
  getAllReviews,
  getReview,
  listReviews,
  postReply,
  reviewPriority,
  starRatingToEmoji,
  starRatingToNumber,
} from "./gbpClient.js";
import {
  fetchAndParseEmail,
  markEmailRead,
  searchReviewEmails,
} from "./emailPoller.js";
import type { GbpReview, InstanceConfig, LocationConfig } from "./types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function buildReviewIssueBody(
  reviewerName: string,
  starRating: string,
  reviewText: string | undefined,
  locationName: string,
  draftReply: string,
): string {
  const stars = starRatingToEmoji(starRating);
  const text = reviewText?.trim() || "_(no written review)_";
  // The old instruction told people to comment "@CEO Agent reply approved",
  // which nothing ever read. The Reviews page is the real path now; a review
  // that arrived by email has no Google name yet, so it says how to get one.
  return [
    `## ${stars} Review: ${locationName}`,
    "",
    `**Reviewer:** ${reviewerName}`,
    `**Rating:** ${stars} (${starRatingToNumber(starRating)}/5)`,
    "",
    "### Review",
    text,
    "",
    "---",
    "",
    "### Suggested reply",
    "",
    "> " + draftReply.split("\n").join("\n> "),
    "",
    "---",
    "",
    "**To reply:** open Reviews inside this company, pick the location and choose this review. If it is not listed yet, press Sync now.",
    "",
  ].join("\n");
}

// buildDraftReply lives in draftReply.ts now, where the Reviews page can share
// it. It takes the numeric rating the table stores, so callers here convert.

/** The plugin context, spelled out once instead of at every call site. */
type PluginCtx = Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0];

/**
 * Where a location's last sync time is kept: one instance-wide key per
 * location.
 *
 * "Last synced" used to be MAX(updated_at) over that location's rows, which
 * is the time of the last row change, not the last sync: posting a reply
 * bumped it, and a location whose Google listing holds no reviews had no rows
 * at all and so read as never synced however often it was pulled. The sync
 * now records itself, so the time on the page is the time Google was read.
 */
function lastSyncStateKey(locationKey: string) {
  return { scopeKind: "instance" as const, stateKey: `last-sync:${locationKey}` };
}

/** The recorded sync time for a location, or null when it has never been synced. */
async function readLastSyncedAt(ctx: PluginCtx, locationKey: string): Promise<string | null> {
  try {
    const value = await ctx.state.get(lastSyncStateKey(locationKey));
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (err) {
    ctx.logger.warn("gbp-reviews: could not read the last sync time", {
      locationKey,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Who wrote the reply Google is showing, for a row whose stored reply text no
 * longer matches it.
 *
 * nextReplySource answers 'google' whenever the live text differs from the
 * text we stored. That is right for a reply written in Google's own console,
 * and wrong for one Paperclip posted and then could not record locally: the
 * list would then credit Google for a reply the audit table says a person
 * wrote. So before settling for 'google', the audit table is asked whether a
 * finished attempt on this review sent exactly this text, and its source
 * wins. The extra read happens only when the text changed.
 */
async function replySourceForSyncedReply(
  ctx: PluginCtx,
  reviewName: string,
  stored: { replyText: string | null; replySource: string | null },
  liveText: string | null,
): Promise<ReplySource | null> {
  const guess = nextReplySource(
    { replyText: stored.replyText, replySource: stored.replySource },
    { replyText: liveText },
  );
  if (guess !== "google" || liveText === null || stored.replyText === liveText) return guess;
  try {
    const rows = await ctx.db.query<{ source: string }>(
      `SELECT source FROM ${ctx.db.namespace}.reply_posts
       WHERE review_name = $1 AND status = 'posted' AND reply_text = $2
       ORDER BY updated_at DESC LIMIT 1`,
      [reviewName, liveText],
    );
    const source = rows[0]?.source;
    if (source === "human" || source === "agent") return source;
  } catch (err) {
    ctx.logger.warn("gbp-reviews: could not check who posted this reply", {
      reviewName,
      error: (err as Error).message,
    });
  }
  return "google";
}

async function createReviewIssue(
  ctx: Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0],
  config: InstanceConfig,
  location: LocationConfig,
  reviewName: string,
  reviewerName: string,
  starRating: string,
  reviewText: string | undefined,
  reviewTime: string,
): Promise<string | null> {
  const stars = starRatingToEmoji(starRating);
  const n = starRatingToNumber(starRating);
  const businessName = location.displayName;

  const draftReply = buildDraftReply(businessName, reviewerName, starRatingToNumber(starRating), reviewText);
  const title = `${stars} ${n}-star Review from ${reviewerName} (${businessName})`;
  const body = buildReviewIssueBody(reviewerName, starRating, reviewText, businessName, draftReply);

  try {
    const issue = await ctx.issues.create({
      companyId: location.targetCompanyId,
      title,
      description: body,
      priority: reviewPriority(starRating),
      originKind: "plugin:gbp-reviews",
      originId: reviewName,
      ...(location.targetProjectId ? { projectId: location.targetProjectId } : {}),
    });
    ctx.logger.info("Created review issue", { reviewName, issueId: issue.id, companyId: location.targetCompanyId });
    return issue.id;
  } catch (err) {
    ctx.logger.error("Failed to create review issue", { reviewName, error: (err as Error).message });
    return null;
  }
}

async function syncLocationReviews(
  ctx: Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0],
  config: InstanceConfig,
  location: LocationConfig,
): Promise<{ total: number; new: number; syncedAt: string }> {
  const ns = ctx.db.namespace;
  const oauth2 = await getOAuthClient(ctx, config, location.accountKey, location.targetCompanyId);
  const reviews = await getAllReviews(oauth2, location.googleAccountId, location.locationId);

  let newCount = 0;
  for (const review of reviews) {
    const existing = await ctx.db.query<{ review_name: string; reply_text: string | null; reply_source: string | null }>(
      `SELECT review_name, reply_text, reply_source FROM ${ns}.reviews WHERE review_name = $1`,
      [review.name],
    );

    if (existing.length > 0) {
      // Update reply status if it changed. The source is kept only while the
      // text on Google still matches what we recorded; a reply edited or
      // written in Google's own console becomes 'google' so the list does not
      // claim Paperclip wrote it, unless the audit table shows Paperclip sent
      // exactly that text.
      const stored = existing[0]!;
      const replySource = await replySourceForSyncedReply(
        ctx,
        review.name,
        { replyText: stored.reply_text, replySource: stored.reply_source },
        review.reviewReply?.comment ?? null,
      );
      // The location key and the company are rewritten from the location this
      // sync is running for. A location repointed at another company leaves
      // its rows filed under the old one, and every read is constrained on
      // the location's current company, so without this the rows are
      // invisible everywhere and one sync cannot bring them back.
      await ctx.db.execute(
        `UPDATE ${ns}.reviews SET reply_text = $1, reply_time = $2, reply_source = $3, location_key = $4, company_id = $5, updated_at = now() WHERE review_name = $6`,
        [
          review.reviewReply?.comment ?? null,
          review.reviewReply?.updateTime ?? null,
          replySource,
          location.key,
          location.targetCompanyId,
          review.name,
        ],
      );
      continue;
    }

    const reviewerName = review.reviewer.isAnonymous ? "Anonymous" : review.reviewer.displayName;

    // Create issue for unreplied reviews
    let issueId: string | null = null;
    if (!review.reviewReply) {
      issueId = await createReviewIssue(
        ctx,
        config,
        location,
        review.name,
        reviewerName,
        review.starRating,
        review.comment,
        review.createTime,
      );
    }

    // A reply this row already carries the first time we see it was written
    // somewhere other than Paperclip, so it is recorded as 'google' rather
    // than left blank; a blank source made the list say plain "Replied" for
    // a reply the same row would call "Replied in Google" a day later.
    const firstSeenSource = nextReplySource(
      { replyText: null, replySource: null },
      { replyText: review.reviewReply?.comment ?? null },
    );

    await ctx.db.execute(
      `INSERT INTO ${ns}.reviews (review_name, location_key, company_id, reviewer_name, star_rating, review_text, reply_text, review_time, reply_time, reply_source, paperclip_issue_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        review.name,
        location.key,
        location.targetCompanyId,
        reviewerName,
        starRatingToNumber(review.starRating),
        review.comment ?? null,
        review.reviewReply?.comment ?? null,
        review.createTime,
        review.reviewReply?.updateTime ?? null,
        firstSeenSource,
        issueId,
      ],
    );
    newCount++;
  }

  // The sync records itself, so "Last synced" is the time Google was read
  // even for a location whose listing holds no reviews at all.
  const syncedAt = new Date().toISOString();
  try {
    await ctx.state.set(lastSyncStateKey(location.key), syncedAt);
  } catch (err) {
    ctx.logger.warn("gbp-reviews: could not record the sync time", {
      locationKey: location.key,
      error: (err as Error).message,
    });
  }

  ctx.logger.info("Synced location reviews", {
    locationKey: location.key,
    total: reviews.length,
    new: newCount,
  });
  return { total: reviews.length, new: newCount, syncedAt };
}

/**
 * Whether the company the host checked is the portfolio root. Only the host
 * knows, so it is asked; when it cannot answer the company is treated as an
 * ordinary one, because guessing the other way would show one company
 * another's reviews.
 */
async function isPortfolioRootCompany(
  ctx: Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0],
  companyId: string,
): Promise<boolean> {
  try {
    const company = await ctx.companies.get(companyId);
    // Read through a widened shape rather than off the SDK's Company type:
    // the installed SDK in this plugin predates isPortfolioRoot, and the
    // host sends it regardless. Same approach phone-tools uses for the agent
    // "assistant" role, and it keeps this working across SDK versions in
    // both directions.
    return (company as unknown as { isPortfolioRoot?: boolean } | null)?.isPortfolioRoot === true;
  } catch (err) {
    ctx.logger.warn("gbp-reviews: could not resolve company for scoping", {
      companyId,
      err: (err as Error).message,
    });
    return false;
  }
}

/** The host-checked scope plus whether it is HQ, which every page handler needs first. */
async function requirePageScope(
  ctx: Parameters<Parameters<typeof definePlugin>[0]["setup"]>[0],
  params: unknown,
): Promise<{ scope: CompanyScope; isPortfolioRoot: boolean }> {
  const scope = requireCompanyScope(params);
  const isPortfolioRoot = await isPortfolioRootCompany(ctx, scope.companyId);
  return { scope, isPortfolioRoot };
}

const LOCATION_NOT_VISIBLE = "That location is not one this company can see.";

// ─── plugin definition ───────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    // ── Job: poll Gmail for GBP review emails (Phase 1) ──────────────────────
    ctx.jobs.register("poll-review-emails", async () => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const gmailKey = config.gmailAccountKey;
      if (!gmailKey) {
        ctx.logger.info("poll-review-emails: no gmailAccountKey configured, skipping.");
        return;
      }

      const locations = config.locations ?? [];
      if (locations.length === 0) {
        ctx.logger.info("poll-review-emails: no locations configured, skipping.");
        return;
      }

      // Use Personal company ID (gmailAccountKey account) for Gmail access
      // The allowedCompanies on the account determines which company we use
      const account = (config.accounts ?? []).find((a) => a.key === gmailKey);
      if (!account) {
        ctx.logger.warn("poll-review-emails: gmailAccountKey not found in accounts.");
        return;
      }
      const gmailCompanyId = account.allowedCompanies?.[0];
      if (!gmailCompanyId) {
        ctx.logger.warn("poll-review-emails: gmail account has no allowedCompanies.");
        return;
      }

      const oauth2 = await getOAuthClient(ctx, config, gmailKey, gmailCompanyId);

      // Track last-checked timestamp to avoid reprocessing
      const lastCheckedState = await ctx.state.get({ scopeKind: "instance", stateKey: "last-email-check" });
      const lastCheckedSeconds = lastCheckedState ? Math.floor(new Date(lastCheckedState as string).getTime() / 1000) : undefined;

      const messages = await searchReviewEmails(oauth2, lastCheckedSeconds);
      ctx.logger.info("poll-review-emails: found messages", { count: messages.length });

      for (const msg of messages) {
        try {
          const parsed = await fetchAndParseEmail(oauth2, msg.id);
          if (!parsed) continue;

          // Match to a configured location by business name. The comment on
          // the old code said "fall back to the first location if only one is
          // configured", but the code fell back regardless of how many there
          // were, so a review email for company B's location opened an issue
          // in company A. That is the write-side twin of the read-side leak
          // fixed in v0.1.8. Now the fallback applies only when it is the
          // only possible answer; otherwise the email is skipped and logged
          // so somebody can fix the display name, rather than guessed at.
          const location = resolveEmailLocation(locations, parsed.businessName);

          if (!location) {
            ctx.logger.warn("poll-review-emails: no location match, skipped", {
              businessName: parsed.businessName,
              configuredLocations: locations.length,
            });
            continue;
          }

          // Check if we already have this email processed (idempotency via messageId in state)
          const processedKey = `email-processed-${msg.id}`;
          const alreadyDone = await ctx.state.get({ scopeKind: "instance", stateKey: processedKey });
          if (alreadyDone) continue;

          const issueId = await createReviewIssue(
            ctx,
            config,
            location,
            `email/${msg.id}`, // Synthetic review name for email-sourced reviews
            parsed.reviewerName,
            parsed.starRating,
            parsed.reviewText,
            parsed.receivedAt,
          );

          await markEmailRead(oauth2, msg.id);
          await ctx.state.set({ scopeKind: "instance", stateKey: processedKey }, true);

          if (issueId) {
            ctx.logger.info("poll-review-emails: created issue from email", { msgId: msg.id, issueId });
          }
        } catch (err) {
          ctx.logger.error("poll-review-emails: failed to process message", {
            msgId: msg.id,
            error: wrapGbpError(err),
          });
        }
      }

      await ctx.state.set({ scopeKind: "instance", stateKey: "last-email-check" }, new Date().toISOString());
    });

    // ── Job: sync all reviews from GBP API (Phase 3 base) ────────────────────
    ctx.jobs.register("sync-all-reviews", async () => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const locations = config.locations ?? [];
      if (locations.length === 0) {
        ctx.logger.info("sync-all-reviews: no locations configured.");
        return;
      }

      for (const location of locations) {
        try {
          await syncLocationReviews(ctx, config, location);
        } catch (err) {
          ctx.logger.error("sync-all-reviews: failed for location", {
            locationKey: location.key,
            error: wrapGbpError(err),
          });
        }
      }
    });

    // ── Job: weekly digest (Phase 3) ─────────────────────────────────────────
    ctx.jobs.register("send-weekly-digest", async () => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const locations = config.locations ?? [];
      if (locations.length === 0) return;

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const ns = ctx.db.namespace;
      for (const location of locations) {
        const newReviews = await ctx.db.query<{
          reviewer_name: string;
          star_rating: number;
          review_text: string;
          reply_text: string | null;
          review_time: string;
        }>(
          // Constrained on the location's own company as well, the same
          // line of defence the page reads use.
          `SELECT reviewer_name, star_rating, review_text, reply_text, review_time FROM ${ns}.reviews WHERE location_key = $1 AND company_id = $2 AND review_time > $3 ORDER BY review_time DESC`,
          [location.key, location.targetCompanyId, sevenDaysAgo],
        );

        if (newReviews.length === 0) continue;

        const unreplied = newReviews.filter((r) => !r.reply_text);
        const avgRating = newReviews.reduce((s, r) => s + Number(r.star_rating), 0) / newReviews.length;

        const lines: string[] = [
          `## Weekly GBP Review Digest: ${location.displayName}`,
          "",
          `**Period:** Last 7 days  **Total new reviews:** ${newReviews.length}  **Avg rating:** ${"⭐".repeat(Math.round(avgRating))} (${avgRating.toFixed(1)}/5)  **Unreplied:** ${unreplied.length}`,
          "",
        ];

        if (unreplied.length > 0) {
          lines.push("### Unreplied reviews needing attention");
          for (const r of unreplied) {
            lines.push(`- **${r.reviewer_name}** ${"⭐".repeat(Number(r.star_rating))} "${(r.review_text ?? "").slice(0, 100)}${(r.review_text ?? "").length > 100 ? "..." : ""}"`);
          }
          lines.push("");
        }

        const digestTitle = `Weekly GBP Digest: ${location.displayName} (week of ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;

        try {
          await ctx.issues.create({
            companyId: location.targetCompanyId,
            title: digestTitle,
            description: lines.join("\n"),
            priority: unreplied.some((r) => r.star_rating <= 2) ? "high" : "low",
            ...(location.targetProjectId ? { projectId: location.targetProjectId } : {}),
          });
        } catch (err) {
          ctx.logger.error("send-weekly-digest: failed to create digest issue", {
            locationKey: location.key,
            error: (err as Error).message,
          });
        }
      }
    });

    // ── Tool: list reviews ────────────────────────────────────────────────────
    ctx.tools.register(
      "gbp_list_reviews",
      { displayName: "List GBP Reviews", description: "List reviews for a GBP location.", parametersSchema: { type: "object", properties: { locationKey: { type: "string" }, includeReplied: { type: "boolean" } }, required: ["locationKey"] } },
      async (params, runCtx) => {
        const { locationKey, includeReplied = false } = params as { locationKey: string; includeReplied?: boolean };
        const config = (await ctx.config.get()) as InstanceConfig;
        const location = (config.locations ?? []).find((l) => l.key === locationKey);
        if (!location) return { content: `[ELOCATION_NOT_FOUND] Location "${locationKey}" not configured.` };
        // A location belongs to one company, and reading its reviews is
        // reading that company's customers. Two companies sharing one Google
        // account used to be enough for an agent in the first to list the
        // second's reviews by naming its key. The reply tool and the get tool
        // have always checked this; these two did not.
        if (location.targetCompanyId !== runCtx.companyId) {
          return fail(`[ECOMPANY_NOT_ALLOWED] Location "${locationKey}" is not this company's.`);
        }

        try {
          const oauth2 = await getOAuthClient(ctx, config, location.accountKey, runCtx.companyId);
          const response = await listReviews(oauth2, location.googleAccountId, location.locationId);
          const reviews = (response.reviews ?? []).filter((r) => includeReplied || !r.reviewReply);

          if (reviews.length === 0) {
            return { content: `No ${includeReplied ? "" : "unreplied "}reviews found for ${location.displayName}.` };
          }

          const lines = reviews.map((r) => {
            const stars = starRatingToEmoji(r.starRating);
            const reviewer = r.reviewer.isAnonymous ? "Anonymous" : r.reviewer.displayName;
            const text = r.comment ? `"${r.comment.slice(0, 120)}${r.comment.length > 120 ? "..." : ""}"` : "(no text)";
            const replied = r.reviewReply ? " ✅ replied" : " ❌ unreplied";
            return `- **${reviewer}** ${stars}${replied}\n  ${text}\n  _review name: ${r.name}_`;
          });

          return {
            content: `**${location.displayName}: ${reviews.length} review(s)**\n\n${lines.join("\n\n")}`,
            data: { reviews, locationKey, totalCount: response.totalReviewCount },
          };
        } catch (err) {
          return { content: wrapGbpError(err) };
        }
      },
    );

    // ── Tool: get review ──────────────────────────────────────────────────────
    ctx.tools.register(
      "gbp_get_review",
      { displayName: "Get GBP Review", description: "Get a single GBP review.", parametersSchema: { type: "object", properties: { reviewName: { type: "string" }, locationKey: { type: "string" } }, required: ["reviewName", "locationKey"] } },
      async (params, runCtx) => {
        const { reviewName, locationKey } = params as { reviewName: string; locationKey: string };
        const config = (await ctx.config.get()) as InstanceConfig;
        const location = (config.locations ?? []).find((l) => l.key === locationKey);
        if (!location) return { content: `[ELOCATION_NOT_FOUND] Location "${locationKey}" not configured.` };

        try {
          // Same checks as the reply tool: a well-formed name, a location
          // this company owns, and a review that is actually under it. A read
          // is not a public write, but the token can reach every location on
          // the account, and reading another company's review is still a leak.
          const parsed = parseReviewName(reviewName);
          if (!parsed) return fail("[EINVALID_INPUT] reviewName is not a Google review resource name.");
          if (location.targetCompanyId !== runCtx.companyId) {
            return fail(`[ECOMPANY_NOT_ALLOWED] Location "${locationKey}" is not this company's.`);
          }
          if (!reviewBelongsToLocation(parsed, location)) {
            return fail(`[EINVALID_INPUT] That review is not under location "${locationKey}".`);
          }
          const oauth2 = await getOAuthClient(ctx, config, location.accountKey, runCtx.companyId);
          const review = await getReview(oauth2, parsed);
          const stars = starRatingToEmoji(review.starRating);
          const reviewer = review.reviewer.isAnonymous ? "Anonymous" : review.reviewer.displayName;

          return {
            content: `**${reviewer}** ${stars}\n\n${review.comment ?? "(no text)"}\n\nPosted: ${review.createTime}\nReply: ${review.reviewReply?.comment ?? "none"}`,
            data: review,
          };
        } catch (err) {
          return { content: wrapGbpError(err) };
        }
      },
    );

    // ── Tool: reply to review ─────────────────────────────────────────────────
    ctx.tools.register(
      "gbp_reply_to_review",
      { displayName: "Reply to GBP Review", description: "Post a reply to a GBP review. Requires allowReplies to be enabled.", parametersSchema: { type: "object", properties: { reviewName: { type: "string" }, locationKey: { type: "string" }, replyText: { type: "string" } }, required: ["reviewName", "locationKey", "replyText"] } },
      async (params, runCtx) => {
        const { reviewName, locationKey, replyText } = params as { reviewName: string; locationKey: string; replyText: string };
        const config = (await ctx.config.get()) as InstanceConfig;

        // Every rule about a public post (the allowReplies switch, the review
        // name's shape, the location's own company, the text limits, the
        // live overwrite check and the audit row) lives in replyGuard.ts and
        // is shared with the Reviews page. The agent side is the strict one:
        // it can never replace a reply that is already on Google, and its
        // idempotency key is the run plus the review, so a run that retries
        // the tool cannot post twice. The old checks that used to live here
        // (2026-09-06) are all inside the guard now; locationKey is kept in
        // the parameter shape for callers but the location is resolved from
        // the review name itself, which is the only thing Google needs.
        void locationKey;
        const parsed = parseReviewName(reviewName);
        const idempotencyKey = `run:${runCtx.runId || randomUUID()}:${parsed?.reviewId ?? String(reviewName)}`;

        try {
          const receipt = await postReplyGuarded(
            {
              config,
              store: createDbReplyStore(ctx.db),
              getOAuthClient: (accountKey, companyId) => getOAuthClient(ctx, config, accountKey, companyId),
              google: { getReview, postReply },
              logger: ctx.logger,
              now: () => new Date(),
            },
            {
              source: "agent",
              // The host stamps runContext.userId when a person drove this
              // tool through the tools route, and leaves it empty for an
              // agent running on its own. Passing it on means the audit row
              // names the person as well as the agent, instead of the agent
              // alone. It is read through a widened shape because the
              // installed SDK's ToolRunContext predates the field while the
              // host sends it, the same approach used for isPortfolioRoot.
              scope: {
                companyId: runCtx.companyId,
                userId: (runCtx as unknown as { userId?: string | null }).userId ?? null,
              },
              agent: { agentId: runCtx.agentId ?? null, runId: runCtx.runId ?? null },
              reviewName,
              replyText,
              idempotencyKey,
              expectedReplyUpdateTime: null,
              replaceExisting: false,
            },
          );

          if (!receipt.recordedLocally) {
            // The reply is public; the local table just does not know yet.
            // Say both, rather than reporting a failed post.
            return {
              content: `Reply posted publicly to ${receipt.location.displayName} at ${receipt.postedAt}, but it could not be recorded locally. The dashboard may show this review as unreplied until the next sync.`,
              data: { updateTime: receipt.postedAt, recordedLocally: false },
            };
          }

          return {
            content: receipt.alreadyPosted
              ? `This run already posted that reply to ${receipt.location.displayName} at ${receipt.postedAt}. Nothing was posted again.`
              : `✅ Reply posted successfully to ${receipt.location.displayName}.\n\nPosted at: ${receipt.postedAt}`,
            data: { comment: receipt.replyText, updateTime: receipt.postedAt, recordedLocally: true },
          };
        } catch (err) {
          return fail(wrapGbpError(err));
        }
      },
    );

    // ── Tool: sync location ───────────────────────────────────────────────────
    ctx.tools.register(
      "gbp_sync_location",
      { displayName: "Sync GBP Location", description: "Sync all reviews for a specific location.", parametersSchema: { type: "object", properties: { locationKey: { type: "string" } }, required: ["locationKey"] } },
      async (params, runCtx) => {
        const { locationKey } = params as { locationKey: string };
        const config = (await ctx.config.get()) as InstanceConfig;
        const location = (config.locations ?? []).find((l) => l.key === locationKey);
        if (!location) return { content: `[ELOCATION_NOT_FOUND] Location "${locationKey}" not configured.` };
        // The sync creates review issues in the location's own company and
        // reads Google with that company's allow-list, so an agent from
        // another company must not be able to start one by naming the key.
        if (location.targetCompanyId !== runCtx.companyId) {
          return fail(`[ECOMPANY_NOT_ALLOWED] Location "${locationKey}" is not this company's.`);
        }

        try {
          await syncLocationReviews(ctx, config, location);
          return { content: `✅ Synced reviews for ${location.displayName}.` };
        } catch (err) {
          return { content: wrapGbpError(err) };
        }
      },
    );

    // ── Data: dashboard summary ───────────────────────────────────────────────
    ctx.data.register("review-summary", async (params) => {
      // Scoped on the company the HOST checked (params.hostScope), never on
      // the companyId the page put in params: a member of company A could
      // send B there and used to be shown B's counts. No stamp means no
      // data. The portfolio root still gets the roll-up, which is the one
      // place a cross-company view belongs. See hostScope.ts and
      // locationScope.ts.
      const { scope, isPortfolioRoot } = await requirePageScope(ctx, params);
      const config = (await ctx.config.get()) as InstanceConfig;

      const scoped = scopeLocationsForCompany({
        companyId: scope.companyId,
        isPortfolioRoot,
        locations: config.locations ?? [],
      });
      const summaries: Array<{ locationKey: string; locationName: string; unreplied: number; avgRating: number | null; totalReviews: number }> = [];

      for (const location of scoped.locations) {
        // Read with the location's OWN company id, so a row filed under the
        // wrong company is never counted, and HQ reads each location the
        // same way its own company would.
        const s = await summaryForLocation(ctx.db, location);
        summaries.push({
          locationKey: location.key,
          locationName: location.displayName,
          unreplied: s.unreplied,
          avgRating: s.avgRating,
          totalReviews: s.total,
        });
      }

      return {
        locations: summaries,
        isRollup: scoped.isRollup,
        updatedAt: new Date().toISOString(),
      };
    });

    // ── Data: one location's reviews ─────────────────────────────────────────
    ctx.data.register("review-list", async (params) => {
      const { scope, isPortfolioRoot } = await requirePageScope(ctx, params);
      const config = (await ctx.config.get()) as InstanceConfig;

      const resolved = resolveScopedLocation(config, scope, isPortfolioRoot, params.locationKey);
      if (!resolved) refuse("ELOCATION_NOT_FOUND", LOCATION_NOT_VISIBLE);
      const { location, isRollup, canPostFromHere } = resolved;
      const account = findAccount(config, location.accountKey);

      const [lastSyncedAt, reviews] = await Promise.all([
        readLastSyncedAt(ctx, location.key),
        listReviewsForLocation(ctx.db, location),
      ]);

      return {
        location: { key: location.key, displayName: location.displayName },
        // The label a person sees: the Google address when the settings
        // carry it. A missing account still names its key so the page can
        // say which one to configure.
        account: { key: location.accountKey, label: account ? accountLabel(account) : location.accountKey },
        lastSyncedAt,
        canPostFromHere,
        isRollup,
        reviews,
      };
    });

    // ── Data: one review, with what Google holds right now ───────────────────
    ctx.data.register("review-detail", async (params) => {
      const { scope, isPortfolioRoot } = await requirePageScope(ctx, params);
      const config = (await ctx.config.get()) as InstanceConfig;

      // The name is trusted only after parsing, and the location comes from
      // the name's own ids among the locations this company may see. One
      // message whether the location is unknown or another company's.
      const parsed = parseReviewName(params.reviewName);
      if (!parsed) refuse("EINVALID_INPUT", "That is not a Google review this plugin can show.");
      const resolved = resolveScopedLocationForReview(config, scope, isPortfolioRoot, parsed);
      if (!resolved) refuse("ELOCATION_NOT_FOUND", LOCATION_NOT_VISIBLE);
      const { location, isRollup, canPostFromHere } = resolved;

      const review = await findReviewForLocation(ctx.db, canonicalReviewName(parsed), location);
      if (!review) {
        refuse("EREVIEW_NOT_FOUND", "That review is not in Paperclip yet. Press Sync now on its location, then open it again.");
      }

      // What Google holds right now. A reply written in Google's own console
      // is invisible locally until the next sync, so the page shows the live
      // one and the post action compares against it. When Google cannot be
      // read the page says so and offers no Post button; it does not fail
      // the whole screen, because the review and the suggested reply are
      // still useful for copying into Google's console by hand.
      let liveReply: { text: string; updateTime: string } | null = null;
      let liveChecked = false;
      let liveError: string | null = null;
      let liveReview: GbpReview | null = null;
      try {
        const oauth2 = await getOAuthClient(ctx, config, location.accountKey, location.targetCompanyId);
        const live = await getReview(oauth2, parsed);
        liveReview = live;
        liveReply = live.reviewReply ? { text: live.reviewReply.comment, updateTime: live.reviewReply.updateTime } : null;
        liveChecked = true;
      } catch (err) {
        liveError = wrapGbpError(err);
        ctx.logger.warn("gbp-reviews: could not read the review from Google", {
          reviewName: review.reviewName,
          error: liveError,
        });
      }

      // Opening a review is also how a lost attempt gets settled. An attempt
      // whose worker died, or whose connection dropped after the write, used
      // to sit unsettled for ever and hide the Post button with it, because
      // only a retry carrying that same key could clear it and the key lives
      // in the browser tab. Now that Google has just been read, every such
      // row on this review is compared against the live reply and told the
      // truth. It is skipped when Google could not be read, because then
      // there is nothing honest to compare against.
      if (liveReview) {
        try {
          await settlePendingAttempts(
            { store: createDbReplyStore(ctx.db), logger: ctx.logger, now: () => new Date() },
            review.reviewName,
            liveReview,
          );
        } catch (err) {
          ctx.logger.warn("gbp-reviews: could not settle an earlier attempt on this review", {
            reviewName: review.reviewName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const account = findAccount(config, location.accountKey);
      const pendingAttempt = await findPendingAttempt(ctx.db, review.reviewName, STALE_IN_FLIGHT_MS);

      return {
        review,
        liveReply,
        liveChecked,
        liveError,
        suggestedReply: buildDraftReply(location.displayName, review.reviewerName, review.starRating, review.reviewText ?? undefined),
        // Computed here from the settings and never editable on the page.
        postsAs: postsAs(location, account ?? { key: location.accountKey }),
        posting: {
          enabled: config.allowReplies === true,
          // Two different problems, told apart. A location naming an account
          // the settings do not hold is a missing account, not a refused one,
          // and saying "not allowed for this company" about an account that
          // is not there sends the reader looking for an allow-list entry
          // that cannot exist.
          accountFound: account != null,
          accountAllowed: account ? isCompanyAllowedForAccount(account.allowedCompanies, location.targetCompanyId) : false,
          // The key the location asks for, so a missing-account sentence can
          // name it. It is what the reader has to look for in the settings.
          accountKey: location.accountKey,
        },
        canPostFromHere,
        isRollup,
        pendingAttempt,
        issueId: review.issueId,
      };
    });

    // ── Action: post a reply from the Reviews page ───────────────────────────
    ctx.actions.register("review-post-reply", async (params) => {
      const { scope, isPortfolioRoot } = await requirePageScope(ctx, params);
      const config = (await ctx.config.get()) as InstanceConfig;

      // HQ can read every location but never posts: a post's company decides
      // the account allow-list and the audit trail, and from the roll-up it
      // would be the wrong one.
      if (isPortfolioRoot) refuse("EROLLUP_READ_ONLY", "Open this location's own company to reply.");

      // The confirm panel mints the key and reuses it on retry; without one
      // there is nothing to make a double click harmless.
      const idempotencyKey = typeof params.idempotencyKey === "string" ? params.idempotencyKey.trim() : "";
      if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
        refuse("EINVALID_INPUT", "This attempt has no key. Open the review again and try once more.");
      }
      const expected = params.expectedReplyUpdateTime;
      if (expected !== undefined && expected !== null && typeof expected !== "string") {
        refuse("EINVALID_INPUT", "The reply you were shown could not be identified. Open the review again.");
      }

      // Everything else (the allowReplies switch, the name, the location's
      // own company, the text, the live overwrite check, the audit row, the
      // one PUT) is the shared guard, the same one the agent tool goes
      // through. A refusal is thrown as-is so the bridge reports a failure.
      return postReplyGuarded(
        {
          config,
          store: createDbReplyStore(ctx.db),
          getOAuthClient: (accountKey, companyId) => getOAuthClient(ctx, config, accountKey, companyId),
          google: { getReview, postReply },
          logger: ctx.logger,
          now: () => new Date(),
        },
        {
          source: "human",
          scope,
          reviewName: params.reviewName,
          replyText: params.replyText,
          idempotencyKey,
          expectedReplyUpdateTime: typeof expected === "string" && expected.length > 0 ? expected : null,
          replaceExisting: params.replaceExisting === true,
        },
      );
    });

    // ── Action: pull one location's reviews in now ───────────────────────────
    ctx.actions.register("review-sync-location", async (params) => {
      const scope = requireCompanyScope(params);
      const config = (await ctx.config.get()) as InstanceConfig;

      // Only from the location's own company, never the roll-up: the sync
      // creates issues in that company and uses its account allow-list.
      const locationKey = typeof params.locationKey === "string" ? params.locationKey : "";
      const location = (config.locations ?? []).find(
        (l) => l.key === locationKey && l.targetCompanyId === scope.companyId,
      );
      if (!location) refuse("ELOCATION_NOT_FOUND", "That location is not this company's. Open the location's own company to sync it.");

      const counts = await syncLocationReviews(ctx, config, location);
      // Read back what was recorded rather than the time this handler happens
      // to be at, so the page is told the same thing the next page load will
      // be told.
      const lastSyncedAt = await readLastSyncedAt(ctx, location.key);
      return {
        location: { key: location.key, displayName: location.displayName },
        total: counts.total,
        new: counts.new,
        syncedAt: counts.syncedAt,
        lastSyncedAt,
      };
    });

    ctx.logger.info("GBP Reviews plugin started.");
  },

  async onHealth() {
    return { status: "ok", message: "GBP Reviews worker is running." };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
