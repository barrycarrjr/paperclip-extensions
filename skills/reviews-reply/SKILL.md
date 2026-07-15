---
name: reviews-reply
description: Handle Google Business Profile review issues created by the gbp-reviews plugin — refine the drafted reply, then apply a risk-tiered autonomy policy: auto-post warm thank-yous to plain 5-star reviews, hold everything with written content (and every review of 3 stars or fewer) for board approval. Never auto-replies to a negative or substantive review. Designed to run on a schedule (see the reviews-sweep routine) so the review queue stays clear without the operator hand-writing every reply. Requires the gbp-reviews plugin and its `allowReplies` setting to post.
---

# Reviews Reply

The `gbp-reviews` plugin polls for new Google reviews and creates a Paperclip
issue per review with an AI-drafted reply attached. This skill is what an agent
follows to **process that issue**: refine the draft, decide whether it's safe to
send automatically, and either post it or hold it for the board.

The whole point is a clear division of risk: trivial positive reviews shouldn't
need the operator's attention, but anything with real content — especially
anything negative — always should.

## When to invoke

- The `reviews-sweep` routine fires and hands you the company's unreplied
  reviews.
- A review issue created by `gbp-reviews` is assigned to you (or delegated by
  the CEO as part of a portfolio directive like "reply to all Google reviews").
- The operator asks you to clear the review queue.

## The autonomy policy (read this before acting)

Classify every review, then act by tier:

| Tier | Review | Action |
|---|---|---|
| **Auto** | 5 stars, **no written text** (or only emoji / a one-word "Thanks!") | Refine to a short, warm, specific thank-you and **post it** via `gbp_reply_to_review`. Move the issue to `done`. |
| **Hold** | 4–5 stars **with written text** | Draft a personal reply that references what they praised. Do **not** post. Raise it for board approval (the draft may already be gated — see below) and leave the issue `in_review`. |
| **Never** | **3 stars or fewer**, or any review naming a specific problem | **Never auto-reply.** Draft a calm, non-defensive, empathetic response, hold for the board, and if it points at a real failure, create a child issue to the agent who owns that area so the underlying thing actually gets fixed. |

When in doubt about a tier, treat it as **Hold**. Err toward the operator's eyes,
never toward an unreviewed public reply.

## How to act

1. `gbp_list_reviews` for the location(s) with `includeReplied: false` to see
   what's outstanding (or work the specific review on the issue you were handed).
2. Read the review and the plugin's drafted reply. Rewrite it to match the
   company's voice: specific, human, brief; no boilerplate, no "we're sorry for
   any inconvenience" filler, never argumentative, never disclosing private
   customer details.
3. Apply the tier:
   - **Auto** → `gbp_reply_to_review` with your text, then set the issue `done`
     with a one-line comment noting it was auto-handled under the 5-star policy.
   - **Hold / Never** → comment the proposed reply on the issue and raise an
     approval for the board; leave status `in_review`.
4. If `gbp_reply_to_review` comes back as **queued for approval** rather than
   posted, that's the board's trust gate — do **not** retry. End your turn; the
   draft is now in Approvals and will post when approved.

## Requirements & guardrails

- **Plugin**: `gbp-reviews` must be installed and configured for the company,
  with `allowReplies` **on** for any reply to actually post. With it off, even
  Auto-tier replies stay as drafts — which is the correct, safe way to start.
- **Trust ramp**: run Hold/Never only (allowReplies off) until the operator
  trusts the drafts, then enable posting so the Auto tier goes hands-free.
- Never invent facts about an order, visit, or customer. If a reply needs
  details you don't have, hold it and ask.
