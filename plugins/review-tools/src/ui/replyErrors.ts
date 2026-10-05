/**
 * One place that turns whatever the bridge rejected with into a sentence a
 * person can act on.
 *
 * usePluginAction rejects with a plain object { code, message, details }, not
 * an Error, and usePluginData reports the same shape in its error field.
 * Rendering that object directly prints "[object Object]", which is the bug
 * this file exists to prevent. The worker's handlers throw
 * Error('[ECODE] sentence'), and the host's own refusals arrive as prose
 * ("Viewer access is read-only"), so both are recognised here.
 *
 * Every sentence below is checked by a test for long dashes.
 */

const NOT_RUNNING = "The Reviews plugin is not running right now. Try again in a moment.";
// Every read on this page is a POST the host checks as a write, so a viewer
// sees nothing at all here, not a read-only view of it. Saying their role
// "can read reviews" on a screen that has just shown them none was untrue.
const ROLE_VIEW_ONLY =
  "Your role in this company is view-only, and this page needs a role that can create work. Ask an admin to change your role to see or reply to reviews.";
// A different person entirely: not a member of this company, or a member
// whose access has been suspended. Nothing about their role would help.
const NO_COMPANY_ACCESS = "You do not have access to this company's reviews.";
const NO_REASON = "Something went wrong and no reason was given.";

/** The codes the worker throws, each with the one sentence the page shows. */
const CODE_SENTENCES: Record<string, string> = {
  ESCOPE: "This page must be opened inside a company.",
  EREPLIES_DISABLED: "Posting replies is switched off in the plugin settings (Allow posting replies to GBP).",
  EROLLUP_READ_ONLY: "Open this location's own company to reply.",
  ELOCATION_NOT_FOUND: "This location is not one this company can post to. Check the plugin settings.",
  EREVIEW_NOT_FOUND: "That review is not in Paperclip yet. Press Sync now on its location, then open it again.",
  EDUPLICATE_IN_PROGRESS: "A reply to this review is already being posted. Wait a moment, then open the review again to see what is on Google.",
  EREPLY_EXISTS: "A reply is already on Google for this review. Open the review again to see it and choose whether to replace it.",
  EREPLY_CHANGED: "The reply on Google changed since you opened this review. Open it again to see the current reply.",
  // "Open the review again" was the one route that could not recover: a
  // reopened editor mints a fresh key, and only the panel still on screen
  // holds the key that lets the worker settle this attempt.
  EPOST_UNCONFIRMED: "The connection dropped while posting, so it is not known whether the reply reached Google. Press Yes, post it again: it checks Google first and will not post twice.",
  ECOMPANY_NOT_ALLOWED: "This location's Google account is not allowed for this company in the plugin settings.",
  EACCOUNT_NOT_FOUND: "This location's Google account is not in the plugin settings.",
  EAUTH: "Google refused the plugin's sign-in. The refresh token may need to be granted again.",
  ECONFIG: "The plugin's Google credentials are not fully configured. Check the secrets in the plugin settings.",
  ECONFIG_SECRET_MISSING: "One of the plugin's Google secrets is missing. Check the secrets in the plugin settings.",
};

const CODE_PREFIX = /^\[(E[A-Z0-9_]*)\]\s*(.*)$/s;

function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && !(err instanceof Error)) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

/** True when the host, not the worker, refused the call over who the person is. */
export function isAccessRefusal(err: unknown): boolean {
  return accessRefusalSentence(err) !== null;
}

/**
 * Which host refusal this is, told apart rather than lumped together. A
 * viewer is a member whose role is too small; the two "does not have
 * access" refusals are a non-member and a suspended member, and neither of
 * those is about a role at all.
 */
function accessRefusalSentence(err: unknown): string | null {
  const message = messageOf(err);
  if (message.includes("Viewer access is read-only")) return ROLE_VIEW_ONLY;
  if (message.includes("does not have access") || message.includes("does not have active company access")) {
    return NO_COMPANY_ACCESS;
  }
  return null;
}

/**
 * The sentence to show for a failed data read or action. Never returns an
 * empty string and never "[object Object]".
 */
export function describeReplyError(err: unknown): string {
  const code = codeOf(err);
  if (code === "WORKER_UNAVAILABLE" || code === "TIMEOUT") return NOT_RUNNING;

  const message = messageOf(err).trim();
  const refusal = accessRefusalSentence(err);
  if (refusal) return refusal;

  const match = CODE_PREFIX.exec(message);
  if (match) {
    const [, errorCode, rest] = match;
    const mapped = CODE_SENTENCES[errorCode];
    if (mapped) return mapped;
    // Google's own HTTP errors carry the useful part after the code.
    if (errorCode.startsWith("EGBP_HTTP_")) {
      return rest.length > 0 ? `Google returned an error: ${rest}` : "Google returned an error.";
    }
    // EINVALID_INPUT and anything new: the worker's sentence is already
    // written for a person, so it is shown without the code.
    return rest.length > 0 ? rest : NO_REASON;
  }

  return message.length > 0 ? message : NO_REASON;
}
