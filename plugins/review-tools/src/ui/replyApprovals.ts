/**
 * A reply an agent drafted that is waiting for a person's approval, found
 * from the review it is for.
 *
 * When the company asks before public posts, an agent's call to
 * gbp_reply_to_review does not post: Paperclip holds it as an approval and
 * runs the tool only once a person approves. Those approvals live in
 * Paperclip's own approvals list, which knew nothing about the Reviews page,
 * so a person reading a review could not see that a reply for it was already
 * written and waiting. This finds them, so the review can show the reply with
 * Approve, Edit first and Reject.
 *
 * The approvals are read and decided through Paperclip's own approvals
 * routes, from the browser, with the person's own session. Nothing here goes
 * through the plugin worker, so the host applies exactly the permission
 * checks its own Approve button does, and approving runs the drafted call
 * the same way. The plugin's own guard still runs inside that call: a review
 * somebody chose not to answer is refused even when its approval is approved.
 *
 * The parsing is pure and tested under node; the three fetch helpers are the
 * only part that needs a browser.
 */

/** The tool whose drafts are replies to reviews. */
export const REPLY_TOOL = "review-tools:gbp_reply_to_review";

export interface PendingReplyApproval {
  approvalId: string;
  reviewName: string;
  replyText: string;
  /** The agent that drafted it, when the approval says. */
  agentId: string | null;
  /** When it was drafted, as an ISO string, when known. */
  createdAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The pending reply approvals in an approvals list, newest first. Anything
 * that is not a pending drafted reply with a review name and some text is
 * left out rather than guessed at: a malformed row must never become an
 * Approve button.
 */
export function pendingReplyApprovals(rows: unknown): PendingReplyApproval[] {
  if (!Array.isArray(rows)) return [];
  const out: PendingReplyApproval[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!row || row.type !== "outbound_tool_draft" || row.status !== "pending") continue;
    const payload = asRecord(row.payload);
    if (!payload || payload.toolName !== REPLY_TOOL) continue;
    const params = asRecord(payload.parameters);
    const approvalId = asString(row.id);
    const reviewName = asString(params?.reviewName);
    const replyText = typeof params?.replyText === "string" ? params.replyText.trim() : "";
    if (!approvalId || !reviewName || !replyText) continue;
    out.push({
      approvalId,
      reviewName,
      replyText,
      agentId: asString(row.requestedByAgentId) ?? asString(payload.agentId),
      createdAt: asString(row.createdAt) ?? asString(payload.draftedAt),
    });
  }
  return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** The ones for one review, newest first. */
export function approvalsForReview(all: PendingReplyApproval[], reviewName: string): PendingReplyApproval[] {
  return all.filter((a) => a.reviewName === reviewName);
}

/** The reviews that have at least one reply waiting for approval, for the list. */
export function reviewsAwaitingApproval(all: PendingReplyApproval[]): Set<string> {
  return new Set(all.map((a) => a.reviewName));
}

/** The note left on an approval the Reviews page turned down, so the approvals list says why. */
export const REJECT_NOTES = {
  rejected: "Rejected from the Reviews page.",
  replaced: "Replaced by a reply posted from the Reviews page.",
  skipped: "The review was set to not reply on the Reviews page.",
} as const;

// ---------------------------------------------------------------------------
// The browser side
// ---------------------------------------------------------------------------

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    const text = asString(body?.error) ?? asString(body?.message);
    if (text) return text;
  } catch {
    // Not JSON; the status line below is all there is.
  }
  return `Paperclip answered ${response.status}.`;
}

/** Every pending approval in the company, filtered to drafted review replies. */
export async function fetchPendingReplyApprovals(companyId: string): Promise<PendingReplyApproval[]> {
  const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/approvals?status=pending`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(await readError(response));
  return pendingReplyApprovals(await response.json());
}

/** Approve or reject through Paperclip's own route, as the signed-in person. */
export async function decideApproval(
  approvalId: string,
  decision: "approve" | "reject",
  decisionNote?: string,
): Promise<{ status: string | null }> {
  const response = await fetch(`/api/approvals/${encodeURIComponent(approvalId)}/${decision}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(decisionNote ? { decisionNote } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = asRecord(await response.json().catch(() => null));
  return { status: asString(body?.status) };
}
