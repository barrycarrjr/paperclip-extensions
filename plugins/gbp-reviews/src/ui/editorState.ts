/**
 * The decisions behind the reply editor, kept out of React so they can be
 * tested under node --test with no browser and no DOM.
 *
 * Three questions live here:
 *
 * - May the page show a Post button at all, and if not, which one sentence
 *   takes its place? (canShowPostButton, whyNoPostButton). The button is not
 *   rendered when the answer is no; a disabled button would promise
 *   something the page cannot do.
 * - What state is the editor in, and what happens on each event? (reduce).
 *   The confirm panel mints one idempotency key when it opens and keeps it
 *   across a retry, so a double click, a lost response and a second attempt
 *   all carry the same key and the worker can tell they are one post. Only a
 *   change to the text earns a new key.
 * - Is the confirm panel ready to post? (confirmReady): the public box is
 *   ticked, the replace box too when a reply is already on Google, and the
 *   text is within Google's limit.
 *
 * Nothing here talks to the host or the worker; the components do that.
 */

/** Google's own limit on a reply. The worker refuses anything longer. */
export const MAX_REPLY_LENGTH = 4096;

export interface EditorReview {
  reviewName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  replyText: string | null;
  replyTime: string | null;
  replySource: string | null;
  reviewTime: string;
  issueId: string | null;
}

/** What review-detail returns. Mirrors the worker's handler, field for field. */
export interface ReviewDetail {
  review: EditorReview;
  /** The reply Google holds right now, or null; only meaningful when liveChecked. */
  liveReply: { text: string; updateTime: string } | null;
  liveChecked: boolean;
  liveError: string | null;
  suggestedReply: string;
  /** "Posts as: <location>, using the Google account <account>", from settings. */
  postsAs: string;
  posting: {
    enabled: boolean;
    /** False when the location names an account the settings do not hold. */
    accountFound: boolean;
    accountAllowed: boolean;
    /**
     * The account key the location names, when the worker sent it. Only used
     * to name the missing account in the sentence below, and left out of the
     * sentence when it is not known rather than guessed at.
     */
    accountKey?: string | null;
  };
  canPostFromHere: boolean;
  isRollup: boolean;
  pendingAttempt: { createdAt: string; status: "posting" | "unknown" } | null;
  issueId: string | null;
}

/** What review-post-reply returns on success. Mirrors PostReplyReceipt in replyGuard.ts. */
export interface PostReceipt {
  postedAt: string;
  location: { key: string; displayName: string };
  account: string;
  replyText: string;
  replaced: boolean;
  previousReplyText: string | null;
  issueId: string | null;
  recordedLocally: boolean;
  alreadyPosted: boolean;
}

/**
 * A time for a person to read. Falls back to the raw value rather than
 * "Invalid Date" when the worker sent something unexpected.
 */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "an unknown time";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

// ---------------------------------------------------------------------------
// May the Post button be shown?
// ---------------------------------------------------------------------------

export function canShowPostButton(detail: ReviewDetail): boolean {
  return (
    detail.posting.enabled &&
    detail.posting.accountFound &&
    detail.posting.accountAllowed &&
    detail.canPostFromHere &&
    detail.liveChecked &&
    detail.pendingAttempt === null
  );
}

/**
 * The one sentence shown where the Post button would be. Null when the
 * button may be shown. The order matters: the master switch comes first
 * because turning it on is the fix for everything below it too, and the
 * roll-up comes before the account check because from HQ the account is
 * never the reason.
 */
export function whyNoPostButton(detail: ReviewDetail): string | null {
  if (!detail.posting.enabled) {
    return "Posting replies is switched off in the plugin settings (Allow posting replies to GBP). You can still copy the words below into Google's console yourself.";
  }
  if (!detail.canPostFromHere) {
    return "Open this location's own company to reply.";
  }
  // Two different problems, and telling them apart matters: an account that
  // is missing from the settings cannot be added to an allow-list, so
  // sending the reader to look for one wastes their time.
  if (!detail.posting.accountFound) {
    const key = detail.posting.accountKey;
    return key
      ? `This location's Google account (${key}) is not in the plugin settings, so nothing can be posted from here.`
      : "This location's Google account is not in the plugin settings, so nothing can be posted from here.";
  }
  if (!detail.posting.accountAllowed) {
    return "This location's Google account is not allowed for this company in the plugin settings, so nothing can be posted from here.";
  }
  if (!detail.liveChecked) {
    return "Google could not be checked for an existing reply, so posting is off for now. Try again in a moment, or reply in Google's console.";
  }
  if (detail.pendingAttempt) {
    return `A post was attempted at ${formatTime(detail.pendingAttempt.createdAt)} and did not finish. Check the review on Google before trying again.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reply status in the list
// ---------------------------------------------------------------------------

/** "Not replied yet", or "Replied" with where the reply came from in plain words. */
export function replyStatusLabel(replyText: string | null, replySource: string | null): string {
  if (replyText === null || replyText.length === 0) return "Not replied yet";
  switch (replySource) {
    case "human":
      return "Replied from Paperclip";
    case "agent":
      return "Replied by an agent";
    case "google":
      return "Replied in Google";
    default:
      return "Replied";
  }
}

// ---------------------------------------------------------------------------
// The location cards on the dashboard
// ---------------------------------------------------------------------------

/**
 * The rating line on a location card. With no rating there is no number to
 * put between the stars and the "/5 avg", so the whole phrase is dropped
 * rather than left with a gap in the middle of it.
 */
export function locationRatingLabel(avgRating: number | null): string {
  if (avgRating == null) return "No rating yet";
  return `${"⭐".repeat(Math.round(avgRating))} ${avgRating.toFixed(1)}/5 avg`;
}

/** How loudly a location card's badge should read. */
export type BadgeTone = "neutral" | "good" | "warn" | "bad";

/**
 * The badge on a location card. A location with no reviews has not replied
 * to everything, it has nothing to reply to, so the green tick would be a
 * claim about work that never existed.
 */
export function locationReplyBadge(unreplied: number, totalReviews: number): { label: string; tone: BadgeTone } {
  if (totalReviews === 0) return { label: "No reviews yet", tone: "neutral" };
  if (unreplied === 0) return { label: "All replied ✓", tone: "good" };
  return { label: `${unreplied} unreplied`, tone: unreplied >= 3 ? "bad" : "warn" };
}

// ---------------------------------------------------------------------------
// Editor state machine
// ---------------------------------------------------------------------------

export type EditorStage = "reading" | "editing" | "confirming" | "posting" | "posted" | "failed";

export interface EditorState {
  stage: EditorStage;
  text: string;
  /** Minted when the confirm panel opens; reused until the text changes. */
  idempotencyKey: string | null;
  /** The trimmed text the current key was minted for. */
  keyedText: string | null;
  publicAcknowledged: boolean;
  replaceAcknowledged: boolean;
  /** The sentence shown under the button after a failed post. */
  error: string | null;
  receipt: PostReceipt | null;
}

export type EditorEvent =
  | { type: "textChanged"; text: string }
  | { type: "enterConfirm" }
  | { type: "backToEditing" }
  | { type: "setPublicAcknowledged"; value: boolean }
  | { type: "setReplaceAcknowledged"; value: boolean }
  | { type: "postStarted" }
  | { type: "postSucceeded"; receipt: PostReceipt }
  | { type: "postFailed"; error: string };

export function initialEditorState(text: string = ""): EditorState {
  return {
    stage: text.length > 0 ? "editing" : "reading",
    text,
    idempotencyKey: null,
    keyedText: null,
    publicAcknowledged: false,
    replaceAcknowledged: false,
    error: null,
    receipt: null,
  };
}

/** The key minter is injected so tests can see which key a state carries. */
export type MintKey = () => string;

export function defaultMintKey(): string {
  return crypto.randomUUID();
}

export function reduceEditor(state: EditorState, event: EditorEvent, mintKey: MintKey = defaultMintKey): EditorState {
  switch (event.type) {
    case "textChanged": {
      // Typing after a failed post goes back to editing; the key is kept
      // until the confirm panel reopens, where it is compared to the text.
      // A receipt is final: once posted, the editor does not reopen on this
      // panel, so the text is ignored.
      if (state.stage === "posted" || state.stage === "posting") return state;
      return {
        ...state,
        stage: event.text.length > 0 ? "editing" : "reading",
        text: event.text,
        error: null,
        publicAcknowledged: false,
        replaceAcknowledged: false,
      };
    }
    case "enterConfirm": {
      if (state.stage === "posting" || state.stage === "posted") return state;
      const trimmed = state.text.trim();
      if (trimmed.length === 0) return state;
      // Same text, same key: a retry after a failure or a cancelled panel
      // must reach the worker as the same attempt, so a post that did land
      // is returned as a receipt rather than sent twice. Different text is a
      // different attempt and the worker would refuse the old key anyway.
      const keep = state.idempotencyKey !== null && state.keyedText === trimmed;
      return {
        ...state,
        stage: "confirming",
        idempotencyKey: keep ? state.idempotencyKey : mintKey(),
        keyedText: trimmed,
        error: null,
        // The ticks are per panel open, never remembered across edits.
        publicAcknowledged: keep ? state.publicAcknowledged : false,
        replaceAcknowledged: keep ? state.replaceAcknowledged : false,
      };
    }
    case "backToEditing": {
      if (state.stage !== "confirming" && state.stage !== "failed") return state;
      return { ...state, stage: state.text.length > 0 ? "editing" : "reading", error: null };
    }
    case "setPublicAcknowledged": {
      if (state.stage !== "confirming" && state.stage !== "failed") return state;
      return { ...state, publicAcknowledged: event.value };
    }
    case "setReplaceAcknowledged": {
      if (state.stage !== "confirming" && state.stage !== "failed") return state;
      return { ...state, replaceAcknowledged: event.value };
    }
    case "postStarted": {
      if (state.stage !== "confirming" && state.stage !== "failed") return state;
      return { ...state, stage: "posting", error: null };
    }
    case "postSucceeded": {
      return { ...state, stage: "posted", error: null, receipt: event.receipt };
    }
    case "postFailed": {
      // The panel stays open with the same key so the person can try again.
      return { ...state, stage: "failed", error: event.error };
    }
    default:
      return state;
  }
}

/**
 * Whether "Yes, post it" may be pressed. The replace tick is demanded only
 * when Google holds a reply, because that is the one case where posting
 * destroys something.
 */
export function confirmReady(state: EditorState, detail: Pick<ReviewDetail, "liveReply">): boolean {
  if (state.stage !== "confirming" && state.stage !== "failed") return false;
  const trimmed = state.text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REPLY_LENGTH) return false;
  if (!state.publicAcknowledged) return false;
  if (detail.liveReply !== null && !state.replaceAcknowledged) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Unsent drafts, kept in the person's own browser only
// ---------------------------------------------------------------------------

/** The subset of window.localStorage the draft helpers use. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function draftStorageKey(companyId: string, reviewName: string): string {
  return `gbp-reviews:draft:${companyId}:${reviewName}`;
}

/**
 * Every call is wrapped: a browser that blocks storage throws on the
 * accessor itself, and a draft is a convenience, never something the page
 * may fail over.
 */
export function readDraft(storage: DraftStorage | null | undefined, key: string): string {
  try {
    return storage?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(storage: DraftStorage | null | undefined, key: string, text: string): void {
  try {
    if (text.length === 0) storage?.removeItem(key);
    else storage?.setItem(key, text);
  } catch {
    // Nothing to do: the draft lives on in React state for this page view.
  }
}

export function clearDraft(storage: DraftStorage | null | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Same as above.
  }
}

// ---------------------------------------------------------------------------
// The receipt as a step list
// ---------------------------------------------------------------------------

export interface ReceiptStep {
  label: string;
  /** "done" for a step that happened; "note" for one the person still owns. */
  status: "done" | "note";
  detail: string;
  /** A host route (relative to the app root) the step can link to. */
  href?: string;
}

/**
 * The little pop-up shown beside the receipt. It has to say the same thing
 * the receipt says: on a retry the worker finds the attempt already landed
 * and sends nothing, so "Reply posted" there would contradict the panel.
 */
export function postToast(receipt: Pick<PostReceipt, "alreadyPosted" | "location">): { title: string; body: string } {
  if (receipt.alreadyPosted) {
    return { title: "Already posted", body: "Google already had this reply; nothing was sent twice." };
  }
  return { title: "Reply posted", body: `Posted as ${receipt.location.displayName}.` };
}

/**
 * The same shape as the starter activation receipt: each step a label, a
 * status and a detail. A public post is never reported as failed because of
 * something after it (the local write, the task), so those steps are notes.
 */
export function receiptSteps(receipt: PostReceipt, companyPrefix: string | null): ReceiptStep[] {
  const steps: ReceiptStep[] = [
    {
      label: "Checked Google for an existing reply",
      status: "done",
      detail: receipt.alreadyPosted
        ? "This attempt had already reached Google, so nothing was sent twice."
        : receipt.replaced
          ? "There was one, and you chose to replace it."
          : "There was none.",
    },
    {
      label: "Posted to Google",
      status: "done",
      detail: `At ${formatTime(receipt.postedAt)} as ${receipt.location.displayName} using ${receipt.account}.`,
    },
    {
      label: "Recorded in Paperclip",
      status: receipt.recordedLocally ? "done" : "note",
      detail: receipt.recordedLocally
        ? "The review now shows as replied."
        : "Not yet; the dashboard will catch up at the next sync.",
    },
  ];
  if (receipt.issueId) {
    steps.push({
      label: "Task",
      status: "note",
      detail: "Still open. Close it yourself when you are done with this review.",
      href: companyPrefix ? `/${companyPrefix}/issues/${receipt.issueId}` : undefined,
    });
  } else {
    steps.push({ label: "Task", status: "note", detail: "No task is linked to this review." });
  }
  return steps;
}
