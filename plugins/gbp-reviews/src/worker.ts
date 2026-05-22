import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { getOAuthClient, wrapGbpError } from "./gbpAuth.js";
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
import type { InstanceConfig, LocationConfig } from "./types.js";

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
  return [
    `## ${stars} Review — ${locationName}`,
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
    "**To post this reply:** Edit the reply above if needed, then comment `@CEO Agent reply approved` or use the `gbp_reply_to_review` tool with the `reviewName` shown below.",
    "",
  ].join("\n");
}

function buildDraftReply(
  businessName: string,
  reviewerName: string,
  starRating: string,
  reviewText: string | undefined,
): string {
  const n = starRatingToNumber(starRating);
  if (n >= 4) {
    return `Thank you so much for the kind words, ${reviewerName}! We're thrilled you had a great experience at ${businessName}. We look forward to serving you again!`;
  }
  if (n === 3) {
    return `Thank you for your feedback, ${reviewerName}. We're glad you chose ${businessName} and appreciate you sharing your thoughts. We're always working to improve, and your input helps us do that. We'd love the chance to exceed your expectations next time.`;
  }
  // Low rating — more empathetic
  const issueMention = reviewText?.trim()
    ? `We take your concerns about ${reviewText.slice(0, 60)}… seriously.`
    : "We take all feedback seriously.";
  return `Thank you for letting us know about your experience, ${reviewerName}. ${issueMention} We'd like to make this right — please reach out to us directly so we can address your concerns. We value your business and hope to restore your confidence in ${businessName}.`;
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

  const draftReply = buildDraftReply(businessName, reviewerName, starRating, reviewText);
  const title = `${stars} ${n}-star Review — ${reviewerName} (${businessName})`;
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
): Promise<void> {
  const ns = ctx.db.namespace;
  const oauth2 = await getOAuthClient(ctx, config, location.accountKey, location.targetCompanyId);
  const reviews = await getAllReviews(oauth2, location.googleAccountId, location.locationId);

  let newCount = 0;
  for (const review of reviews) {
    const existing = await ctx.db.query<{ review_name: string }>(
      `SELECT review_name FROM ${ns}.reviews WHERE review_name = $1`,
      [review.name],
    );

    if (existing.length > 0) {
      // Update reply status if it changed
      await ctx.db.execute(
        `UPDATE ${ns}.reviews SET reply_text = $1, reply_time = $2, updated_at = now() WHERE review_name = $3`,
        [review.reviewReply?.comment ?? null, review.reviewReply?.updateTime ?? null, review.name],
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

    await ctx.db.execute(
      `INSERT INTO ${ns}.reviews (review_name, location_key, company_id, reviewer_name, star_rating, review_text, reply_text, review_time, reply_time, paperclip_issue_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        issueId,
      ],
    );
    newCount++;
  }

  ctx.logger.info("Synced location reviews", {
    locationKey: location.key,
    total: reviews.length,
    new: newCount,
  });
}

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

          // Match to a configured location by business name
          const location = locations.find(
            (l) => l.displayName.toLowerCase() === parsed.businessName.toLowerCase(),
          ) ?? locations[0]; // Fall back to first location if only one configured

          if (!location) {
            ctx.logger.warn("poll-review-emails: no location match", { businessName: parsed.businessName });
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
          `SELECT reviewer_name, star_rating, review_text, reply_text, review_time FROM ${ns}.reviews WHERE location_key = $1 AND review_time > $2 ORDER BY review_time DESC`,
          [location.key, sevenDaysAgo],
        );

        if (newReviews.length === 0) continue;

        const unreplied = newReviews.filter((r) => !r.reply_text);
        const avgRating = newReviews.reduce((s, r) => s + r.star_rating, 0) / newReviews.length;

        const lines: string[] = [
          `## Weekly GBP Review Digest — ${location.displayName}`,
          "",
          `**Period:** Last 7 days  **Total new reviews:** ${newReviews.length}  **Avg rating:** ${"⭐".repeat(Math.round(avgRating))} (${avgRating.toFixed(1)}/5)  **Unreplied:** ${unreplied.length}`,
          "",
        ];

        if (unreplied.length > 0) {
          lines.push("### Unreplied reviews needing attention");
          for (const r of unreplied) {
            lines.push(`- **${r.reviewer_name}** — ${"⭐".repeat(r.star_rating)} — "${(r.review_text ?? "").slice(0, 100)}${(r.review_text ?? "").length > 100 ? "…" : ""}"`);
          }
          lines.push("");
        }

        const digestTitle = `Weekly GBP Digest — ${location.displayName} (week of ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;

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
            const text = r.comment ? `"${r.comment.slice(0, 120)}${r.comment.length > 120 ? "…" : ""}"` : "(no text)";
            const replied = r.reviewReply ? " ✅ replied" : " ❌ unreplied";
            return `- **${reviewer}** ${stars}${replied}\n  ${text}\n  _review name: ${r.name}_`;
          });

          return {
            content: `**${location.displayName} — ${reviews.length} review(s)**\n\n${lines.join("\n\n")}`,
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
          const oauth2 = await getOAuthClient(ctx, config, location.accountKey, runCtx.companyId);
          const review = await getReview(oauth2, reviewName);
          const stars = starRatingToEmoji(review.starRating);
          const reviewer = review.reviewer.isAnonymous ? "Anonymous" : review.reviewer.displayName;

          return {
            content: `**${reviewer}** — ${stars}\n\n${review.comment ?? "(no text)"}\n\nPosted: ${review.createTime}\nReply: ${review.reviewReply?.comment ?? "none"}`,
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

        if (!config.allowReplies) {
          return { content: "[EREPLIES_DISABLED] allowReplies is not enabled in plugin settings. Enable it to post replies." };
        }

        const location = (config.locations ?? []).find((l) => l.key === locationKey);
        if (!location) return { content: `[ELOCATION_NOT_FOUND] Location "${locationKey}" not configured.` };

        if (!replyText?.trim()) return { content: "[EINVALID_INPUT] replyText cannot be empty." };
        if (replyText.length > 4096) return { content: "[EINVALID_INPUT] replyText exceeds 4096 character limit." };

        try {
          const oauth2 = await getOAuthClient(ctx, config, location.accountKey, runCtx.companyId);
          const result = await postReply(oauth2, reviewName, replyText.trim());

          // Update local DB
          const ns = ctx.db.namespace;
          await ctx.db.execute(
            `UPDATE ${ns}.reviews SET reply_text = $1, reply_time = $2, updated_at = now() WHERE review_name = $3`,
            [replyText.trim(), result.updateTime, reviewName],
          ).catch(() => { /* non-fatal if review not in DB yet */ });

          return {
            content: `✅ Reply posted successfully to ${location.displayName}.\n\nPosted at: ${result.updateTime}`,
            data: result,
          };
        } catch (err) {
          return { content: wrapGbpError(err) };
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

        try {
          await syncLocationReviews(ctx, config, location);
          return { content: `✅ Synced reviews for ${location.displayName}.` };
        } catch (err) {
          return { content: wrapGbpError(err) };
        }
      },
    );

    // ── Data: dashboard summary ───────────────────────────────────────────────
    ctx.data.register("review-summary", async () => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const locations = config.locations ?? [];
      const summaries: Array<{ locationKey: string; locationName: string; unreplied: number; avgRating: number | null; totalReviews: number }> = [];

      const ns = ctx.db.namespace;
      for (const location of locations) {
        const stats = await ctx.db.query<{ unreplied: number; avg_rating: number | null; total: number }>(
          `SELECT COUNT(CASE WHEN reply_text IS NULL THEN 1 END) as unreplied, AVG(star_rating) as avg_rating, COUNT(*) as total FROM ${ns}.reviews WHERE location_key = $1`,
          [location.key],
        );
        const s = stats[0];
        summaries.push({
          locationKey: location.key,
          locationName: location.displayName,
          unreplied: s?.unreplied ?? 0,
          avgRating: s?.avg_rating ?? null,
          totalReviews: s?.total ?? 0,
        });
      }

      return { locations: summaries, updatedAt: new Date().toISOString() };
    });

    ctx.logger.info("GBP Reviews plugin started.");
  },

  async onHealth() {
    return { status: "ok", message: "GBP Reviews worker is running." };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
