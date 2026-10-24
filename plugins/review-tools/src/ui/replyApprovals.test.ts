/**
 * Finding a review's drafted reply among the company's approvals.
 *
 * The dangerous direction is an Approve button on something that is not a
 * pending reply to this review: another tool's draft, an approval already
 * decided, or a row whose parameters are missing. Each is left out.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  REJECT_NOTES,
  REPLY_TOOL,
  approvalsForReview,
  pendingReplyApprovals,
  reviewsAwaitingApproval,
} from "./replyApprovals.js";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

const REVIEW = "accounts/111/locations/222/reviews/abc";
const OTHER = "accounts/111/locations/222/reviews/xyz";

function approval(over: Record<string, unknown> = {}, payloadOver: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  return {
    id: "appr-1",
    type: "outbound_tool_draft",
    status: "pending",
    requestedByAgentId: "agent-1",
    createdAt: "2026-10-01T09:00:00.000Z",
    ...over,
    payload: {
      toolName: REPLY_TOOL,
      agentId: "agent-1",
      draftedAt: "2026-10-01T09:00:00.000Z",
      ...payloadOver,
      parameters: { reviewName: REVIEW, locationKey: "main-st", replyText: "Thank you for the kind words.", ...params },
    },
  };
}

test("a pending drafted reply is found with its review, words and agent", () => {
  assert.deepEqual(pendingReplyApprovals([approval()]), [
    {
      approvalId: "appr-1",
      reviewName: REVIEW,
      replyText: "Thank you for the kind words.",
      agentId: "agent-1",
      createdAt: "2026-10-01T09:00:00.000Z",
    },
  ]);
});

test("anything that is not a pending drafted reply with a review and words is left out", () => {
  const rows = [
    approval({ status: "approved" }),
    approval({ status: "rejected" }),
    approval({ type: "hire_agent" }),
    approval({}, { toolName: "email-tools:email_send" }),
    approval({}, {}, { reviewName: undefined }),
    approval({}, {}, { replyText: "   " }),
    approval({ id: undefined }),
    { id: "x", type: "outbound_tool_draft", status: "pending", payload: null },
    null,
    "nonsense",
  ];
  assert.deepEqual(pendingReplyApprovals(rows), []);
  assert.deepEqual(pendingReplyApprovals({ error: "Unauthorized" }), [], "an error body is not a list");
});

test("approvals are matched to their own review, newest first", () => {
  const all = pendingReplyApprovals([
    approval({ id: "old", createdAt: "2026-10-01T09:00:00.000Z" }),
    approval({ id: "new", createdAt: "2026-10-02T09:00:00.000Z" }),
    approval({ id: "elsewhere" }, {}, { reviewName: OTHER }),
  ]);
  assert.deepEqual(approvalsForReview(all, REVIEW).map((a) => a.approvalId), ["new", "old"]);
  assert.deepEqual(approvalsForReview(all, "accounts/1/locations/2/reviews/none"), []);
  assert.deepEqual([...reviewsAwaitingApproval(all)].sort(), [REVIEW, OTHER].sort());
});

test("the notes left on a turned-down approval are plain sentences", () => {
  for (const note of Object.values(REJECT_NOTES)) {
    assert.match(note, /^[A-Z].*\.$/);
    assert.doesNotMatch(note, LONG_DASHES);
  }
});
