/**
 * The one path by which a reply reaches Google, for people and agents alike.
 *
 * A reply is public and Paperclip cannot take it back, so every rule about
 * posting one lives here and nowhere else: who may post (the host-checked
 * company, the allowReplies switch, the location's own company), what may
 * be overwritten (nothing, unless a person explicitly asked to replace a
 * reply they were shown), and which of several attempts wins (one row per
 * idempotency key, one in-flight attempt per review). The Reviews page and
 * the agent tool are two callers of the same function; two copies of this
 * rule would drift.
 *
 * Everything the chain needs is injected (config, store, OAuth, the two
 * Google calls, a clock) so each refusal and the single success path run
 * under node --test with no network and no database.
 *
 * Refusals are thrown as Error('[ECODE] sentence'). The sentence is what a
 * person reads, so it is plain and carries no long dashes.
 */
import type { OAuth2Client } from "google-auth-library";
import { ESCOPE_MESSAGE } from "./hostScope.js";
import { canonicalReviewName, parseReviewName, reviewBelongsToLocation, type ParsedReviewName } from "./reviewName.js";
import { accountLabel } from "./draftReply.js";
import type { BeginPostInput, ReplyPostRow, ReplyStore } from "./replyStore.js";
import type { GbpReview, InstanceConfig, LocationConfig } from "./types.js";

export const MAX_REPLY_LENGTH = 4096;

/** A 'posting' row older than this is treated as abandoned and reconciled. */
export const STALE_IN_FLIGHT_MS = 2 * 60 * 1000;

export interface ReplyGuardLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface ReplyGuardDeps {
  config: InstanceConfig;
  store: ReplyStore;
  /**
   * Resolves the Google client for an account on behalf of a company. The
   * real one is getOAuthClient with ctx and config already bound; it fails
   * closed on the account's allowed-companies list.
   */
  getOAuthClient(accountKey: string, companyId: string): Promise<OAuth2Client>;
  google: {
    getReview(oauth: OAuth2Client, review: ParsedReviewName): Promise<GbpReview>;
    postReply(oauth: OAuth2Client, review: ParsedReviewName, comment: string): Promise<{ comment: string; updateTime: string }>;
  };
  logger: ReplyGuardLogger;
  now(): Date;
}

export interface PostReplyInput {
  source: "human" | "agent";
  /** From the host stamp (a person) or the tool run context (an agent). */
  scope: { companyId: string | null; userId: string | null };
  agent?: { agentId: string | null; runId: string | null };
  reviewName: unknown;
  replyText: unknown;
  /** Minted by the caller and reused on retry; a new text needs a new key. */
  idempotencyKey: string;
  /**
   * The updateTime of the reply the caller was shown, or null when they were
   * shown none. Compared against Google immediately before the write.
   */
  expectedReplyUpdateTime: string | null;
  /** A person's explicit choice to replace the reply they were shown. */
  replaceExisting: boolean;
}

export interface PostReplyReceipt {
  /** Google's update time for the reply. */
  postedAt: string;
  location: { key: string; displayName: string };
  /** The Google account label, as shown in the "Posts as" line. */
  account: string;
  replyText: string;
  replaced: boolean;
  previousReplyText: string | null;
  issueId: string | null;
  /** False when Google has the reply but the local reviews row could not be written. */
  recordedLocally: boolean;
  /** True when this key had already posted and the stored receipt is being returned. */
  alreadyPosted: boolean;
}

export class ReplyGuardError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, sentence: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${sentence}`);
    this.name = "ReplyGuardError";
    this.code = code;
    this.details = details;
  }
}

function refuse(code: string, sentence: string, details?: Record<string, unknown>): never {
  throw new ReplyGuardError(code, sentence, details);
}

const LOCATION_NOT_FOUND = "That review is not under a location this company owns.";

function shortText(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function isHttpError(err: unknown): boolean {
  return err instanceof Error && /^\[EGBP_HTTP_\d+\]/.test(err.message);
}

/** An error one of our own layers produced, so the request was never sent or was definitely answered. */
function isCodedError(err: unknown): boolean {
  return err instanceof Error && /^\[E[A-Z_0-9]+\]/.test(err.message);
}

function findLocationForReview(
  config: InstanceConfig,
  parsed: ParsedReviewName,
  companyId: string,
): LocationConfig | null {
  // One message for "no such location" and "another company's location":
  // telling them apart would confirm to a caller that the review exists
  // somewhere else.
  return (
    (config.locations ?? []).find(
      (l) => reviewBelongsToLocation(parsed, l) && l.targetCompanyId === companyId,
    ) ?? null
  );
}

function accountLabelFor(config: InstanceConfig, location: LocationConfig): string {
  const account = (config.accounts ?? []).find(
    (a) => a.key.toLowerCase() === location.accountKey.toLowerCase(),
  );
  return account ? accountLabel(account) : location.accountKey;
}

async function storedReceipt(
  deps: ReplyGuardDeps,
  row: ReplyPostRow,
  location: LocationConfig,
  reviewName: string,
): Promise<PostReplyReceipt> {
  const local = await deps.store.getReviewRow(reviewName, location.targetCompanyId).catch(() => null);
  return {
    postedAt: row.googleUpdateTime ?? row.updatedAt,
    location: { key: location.key, displayName: location.displayName },
    account: accountLabelFor(deps.config, location),
    replyText: row.replyText,
    replaced: row.previousReplyText !== null,
    previousReplyText: row.previousReplyText,
    issueId: local?.paperclip_issue_id ?? null,
    recordedLocally: local?.reply_text === row.replyText,
    alreadyPosted: true,
  };
}

/** What is written on an in-flight row whose worker went away before it finished. */
export const ABANDONED_ATTEMPT_MESSAGE = "Abandoned: the worker that started this attempt did not finish.";

/** Only the store and the log are needed to settle a row; not Google, not OAuth. */
type ReconcileDeps = Pick<ReplyGuardDeps, "store" | "logger">;

/** How long ago an ISO timestamp was, by the injected clock. */
function ageMs(deps: Pick<ReplyGuardDeps, "now">, iso: string): number {
  return deps.now().getTime() - new Date(iso).getTime();
}

/**
 * Settle an in-flight row against what Google actually holds. Used for a
 * row whose outcome was lost (a crash or a broken connection after the PUT
 * was sent) so that the row stops blocking the review and tells the truth.
 */
export async function reconcileAgainstLive(
  deps: ReconcileDeps,
  row: ReplyPostRow,
  live: GbpReview,
): Promise<void> {
  const liveText = live.reviewReply?.comment ?? null;
  if (liveText !== null && liveText === row.replyText) {
    await deps.store.finishPost(row.idempotencyKey, "posted", live.reviewReply!.updateTime);
    deps.logger.info("gbp-reviews: reconciled an unconfirmed reply as posted", { idempotencyKey: row.idempotencyKey });
    return;
  }
  if (liveText === null) {
    await deps.store.finishPost(row.idempotencyKey, "failed", "No reply reached Google before the attempt was abandoned.");
    return;
  }
  await deps.store.finishPost(
    row.idempotencyKey,
    "unknown",
    "Google holds a different reply from the one this attempt sent.",
  );
}

/**
 * Settle every attempt on this review whose outcome was lost, against the
 * live review the caller has just read.
 *
 * This is the page's way back. The Reviews page hides the Post button while
 * an attempt is unsettled, and an attempt whose key nobody holds any more
 * (the tab was closed, the worker was restarted) used to have no route out:
 * only a retry carrying that same key could settle it. Running this on every
 * review-detail read means a crashed or dropped attempt is settled the next
 * time somebody looks at the review, so no review can be blocked for good.
 *
 * A 'posting' row still within the stale window is left alone: its worker is
 * probably alive and about to finish.
 */
export async function settlePendingAttempts(
  deps: Pick<ReplyGuardDeps, "store" | "logger" | "now">,
  reviewName: string,
  live: GbpReview,
): Promise<void> {
  const rows = await deps.store.listUnsettledPosts(reviewName);
  for (const row of rows) {
    if (row.status === "posting" && ageMs(deps, row.updatedAt) <= STALE_IN_FLIGHT_MS) continue;
    await reconcileAgainstLive(deps, row, live);
  }
}

export async function postReplyGuarded(deps: ReplyGuardDeps, input: PostReplyInput): Promise<PostReplyReceipt> {
  // (1) Only the host-checked company counts. No company means nobody.
  const companyId = input.scope.companyId;
  if (!companyId) throw new Error(ESCOPE_MESSAGE);

  // (2) The one master switch, checked at post time for people and agents.
  if (deps.config.allowReplies !== true) {
    refuse(
      "EREPLIES_DISABLED",
      "Posting replies is switched off in the plugin settings (Allow replies). Turn it on to post from here.",
    );
  }

  // (3) A well-formed Google name, never the caller's raw string.
  const parsed = parseReviewName(input.reviewName);
  if (!parsed) refuse("EINVALID_INPUT", "That is not a Google review this plugin can reply to.");
  const reviewName = canonicalReviewName(parsed);

  // (4) The review must sit under a configured location that belongs to
  // this very company.
  const location = findLocationForReview(deps.config, parsed, companyId);
  if (!location) refuse("ELOCATION_NOT_FOUND", LOCATION_NOT_FOUND);

  // (5) The only checks on the text itself: present and within Google's limit.
  const replyText = typeof input.replyText === "string" ? input.replyText.trim() : "";
  if (replyText.length === 0) refuse("EINVALID_INPUT", "The reply is empty.");
  if (replyText.length > MAX_REPLY_LENGTH) {
    refuse("EINVALID_INPUT", `The reply is longer than ${MAX_REPLY_LENGTH} characters, which is Google's limit.`);
  }

  // (6) This key has been seen before: a retry, a double click, or a misuse.
  let own = await deps.store.findPost(input.idempotencyKey);
  if (own) {
    // A key belongs to the review it was first used for. Without this, a
    // reused key would restart the FIRST review's audit row while the write
    // went to the second one, so the table would name a post that never
    // happened and hide one that did.
    if (own.reviewName !== reviewName || own.companyId !== companyId) {
      refuse("EINVALID_INPUT", "This attempt key belongs to a different review. Start a new one.");
    }
    // A row still marked 'posting' long after it was last touched belongs to
    // a worker that is gone. Record that on the row and treat it as unknown
    // from here, which is the honest word for it: whether the reply reached
    // Google is settled against Google below.
    if (own.status === "posting" && ageMs(deps, own.updatedAt) > STALE_IN_FLIGHT_MS) {
      await deps.store.finishPost(own.idempotencyKey, "unknown", ABANDONED_ATTEMPT_MESSAGE);
      deps.logger.warn("gbp-reviews: an attempt was left in flight and is being settled", {
        idempotencyKey: own.idempotencyKey,
        reviewName,
      });
      own = { ...own, status: "unknown", error: ABANDONED_ATTEMPT_MESSAGE };
    }
    if (own.replyText !== replyText && own.status !== "failed") {
      // 'failed' is the one status where different text is safe: nothing of
      // that attempt is on Google, so an agent may correct its wording and
      // try again within the same run. For 'unknown' the old text may
      // already be live, and for 'posted' and 'posting' it certainly is or
      // may be, so those keep the refusal.
      refuse("EINVALID_INPUT", "This attempt was already started with different text. Start a new one.");
    }
    if (own.status === "posted") return storedReceipt(deps, own, location, reviewName);
    if (own.status === "posting") {
      refuse("EDUPLICATE_IN_PROGRESS", "This reply is already being posted. Wait a moment and check the review.");
    }
    // 'failed' or 'unknown': carry on. An unknown row is reconciled against
    // Google below, before any overwrite rule can refuse its own reply.
  }

  // (7) Somebody else's attempt on the same review, still unsettled.
  const inFlight = await deps.store.findInFlight(reviewName);
  let otherAttempt: ReplyPostRow | null = null;
  if (inFlight && inFlight.idempotencyKey !== input.idempotencyKey) {
    if (inFlight.status === "posting") {
      // Age is measured from updated_at, not created_at: a retry restarts the
      // row in place and keeps the first attempt's created_at, so a busy
      // retry would otherwise look abandoned the moment it started.
      if (ageMs(deps, inFlight.updatedAt) <= STALE_IN_FLIGHT_MS) {
        refuse("EDUPLICATE_IN_PROGRESS", "Someone else is posting a reply to this review right now. Wait a moment and check the review.");
      }
      // Older than that means the worker that started it is gone. Marking it
      // unknown now is what frees the one-in-flight slot for this attempt;
      // what actually happened is settled against Google a few lines below.
      await deps.store.finishPost(inFlight.idempotencyKey, "unknown", ABANDONED_ATTEMPT_MESSAGE);
      deps.logger.warn("gbp-reviews: an attempt was left in flight and is being settled", {
        idempotencyKey: inFlight.idempotencyKey,
        reviewName,
      });
      otherAttempt = { ...inFlight, status: "unknown", error: ABANDONED_ATTEMPT_MESSAGE };
    } else {
      // An 'unknown' row whose key nobody holds any more. It does not block
      // the slot, but Google may already hold its text, so it is settled
      // against the live review before this attempt decides anything.
      otherAttempt = inFlight;
    }
  }

  // (8) Claim the slot BEFORE looking at Google. The partial unique index
  // allows one 'posting' row per review, so holding it from before the read
  // to after the write is what stops two attempts both seeing no reply and
  // both posting, the second silently replacing the first. The two previous_*
  // columns cannot be filled in yet; they are written at (12), once the live
  // reply is in hand and the overwrite rules have passed.
  const claim: BeginPostInput = {
    idempotencyKey: input.idempotencyKey,
    reviewName,
    locationKey: location.key,
    companyId,
    source: input.source,
    // Whoever the caller can name, whatever the source. An agent run started
    // by a person through the tools route carries that person's id, and
    // dropping it here used to leave the audit row saying only the agent
    // posted. An agent running on its own has no person behind it and sends
    // null, so nothing is invented.
    actorUserId: input.scope.userId,
    actorAgentId: input.agent?.agentId ?? null,
    actorRunId: input.agent?.runId ?? null,
    replyText,
    previousReplyText: null,
    previousReplyTime: null,
  };
  const begun = await deps.store.beginPost(claim);
  if (begun !== "ok") {
    refuse("EDUPLICATE_IN_PROGRESS", "This reply is already being posted. Wait a moment and check the review.");
  }

  // From here the slot is held, so every way out of this function has to
  // leave the row settled. A refusal or a thrown error marks it 'failed'
  // before it is rethrown; otherwise a refusal would leave a 'posting' row
  // nobody owns and the review would be blocked by its own safety check.
  let settled = false;
  try {
    // (9) The Google client, which fails closed on the account allow-list for
    // the location's own company.
    const oauth = await deps.getOAuthClient(location.accountKey, location.targetCompanyId);

    // (10) What Google holds right now. Everything after this point compares
    // against the live reply, never the local table, because a reply written
    // in Google's console is invisible locally until the next sync.
    const live = await deps.google.getReview(oauth, parsed);
    const liveReply = live.reviewReply ?? null;

    if (otherAttempt) await reconcileAgainstLive(deps, otherAttempt, live);

    if (own && own.status === "unknown" && liveReply && liveReply.comment === replyText) {
      await deps.store.finishPost(input.idempotencyKey, "posted", liveReply.updateTime);
      settled = true;
      deps.logger.info("gbp-reviews: reconciled an unconfirmed reply as posted", { idempotencyKey: input.idempotencyKey });
      const settledRow = await deps.store.findPost(input.idempotencyKey);
      return storedReceipt(
        deps,
        settledRow ?? { ...own, status: "posted", googleUpdateTime: liveReply.updateTime },
        location,
        reviewName,
      );
    }

    // (11) The overwrite rule. Google's PUT silently replaces any reply, so a
    // reply may only be replaced by a person who was shown it and asked to.
    if (liveReply && (!input.replaceExisting || input.source === "agent")) {
      refuse(
        "EREPLY_EXISTS",
        `A reply is already on Google for this review. It says: "${shortText(liveReply.comment)}"`,
        { liveReplyText: liveReply.comment, liveReplyUpdateTime: liveReply.updateTime },
      );
    }
    if (liveReply && liveReply.updateTime !== input.expectedReplyUpdateTime) {
      refuse(
        "EREPLY_CHANGED",
        "The reply on Google changed since you opened this review. Open it again to see the current reply.",
        { liveReplyText: liveReply.comment, liveReplyUpdateTime: liveReply.updateTime },
      );
    }
    if (!liveReply && input.expectedReplyUpdateTime) {
      refuse(
        "EREPLY_CHANGED",
        "The reply you were shown has since been removed from Google. Open the review again before posting.",
      );
    }

    // (12) What the audit row is about to replace, now that it is known.
    await deps.store.recordPrevious(
      input.idempotencyKey,
      liveReply?.comment ?? null,
      liveReply?.updateTime ?? null,
    );

    // (13) The one public write.
    let result: { comment: string; updateTime: string };
    try {
      result = await deps.google.postReply(oauth, parsed, replyText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isHttpError(err) || isCodedError(err)) {
        // Google answered, or one of our own layers refused before sending.
        // Either way the reply is not on Google.
        await deps.store.finishPost(input.idempotencyKey, "failed", message);
        settled = true;
        deps.logger.error("gbp-reviews: Google refused the reply", { idempotencyKey: input.idempotencyKey, reviewName, error: message });
        throw err;
      }
      // Anything else is the connection: the request may or may not have
      // arrived. Say so, and let the retry reconcile against Google.
      await deps.store.finishPost(input.idempotencyKey, "unknown", message);
      settled = true;
      deps.logger.error("gbp-reviews: lost the connection while posting a reply", { idempotencyKey: input.idempotencyKey, reviewName, error: message });
      refuse(
        "EPOST_UNCONFIRMED",
        "The connection dropped while posting, so it is not known whether the reply reached Google. Try again; the retry checks Google first and will not post twice.",
      );
    }

    // (14) Record the outcome, then the review itself. The reply is public
    // from here on, so nothing below may report this post as failed: a
    // database that has gone away is reported as "not recorded", never as
    // "not posted".
    let recordedLocally = true;
    try {
      await deps.store.finishPost(input.idempotencyKey, "posted", result.updateTime);
    } catch (err) {
      recordedLocally = false;
      deps.logger.error("gbp-reviews: posted to Google but could not record the attempt", {
        idempotencyKey: input.idempotencyKey,
        reviewName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    settled = true;

    try {
      await deps.store.upsertReview(
        { ...live, reviewReply: { comment: replyText, updateTime: result.updateTime } },
        location,
        input.source,
      );
    } catch (err) {
      recordedLocally = false;
      deps.logger.error("gbp-reviews: posted to Google but could not record locally", {
        idempotencyKey: input.idempotencyKey,
        reviewName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const local = await deps.store.getReviewRow(reviewName, location.targetCompanyId).catch(() => null);

    // (15)
    return {
      postedAt: result.updateTime,
      location: { key: location.key, displayName: location.displayName },
      account: accountLabelFor(deps.config, location),
      replyText,
      replaced: liveReply !== null,
      previousReplyText: liveReply?.comment ?? null,
      issueId: local?.paperclip_issue_id ?? null,
      recordedLocally,
      alreadyPosted: false,
    };
  } catch (err) {
    if (!settled) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await deps.store.finishPost(input.idempotencyKey, "failed", message);
      } catch (releaseErr) {
        deps.logger.error("gbp-reviews: could not release the slot this attempt was holding", {
          idempotencyKey: input.idempotencyKey,
          reviewName,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
    }
    throw err;
  }
}
