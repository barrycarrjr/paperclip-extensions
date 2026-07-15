---
name: email-reply
description: Draft and (when safe) send replies to inbound customer email in a mailbox served by the email-tools plugin. Applies a risk-tiered policy — draft send-ready replies to clear, low-risk questions; hold and escalate anything involving refunds, cancellations, complaints, billing, legal/safety, or missing facts. Sending goes through Paperclip's outbound approval gate by default, so replies queue for the board until the operator trusts a category. Designed to run on a schedule (see the email-sweep routine) so the support inbox gets worked without the operator hand-writing every reply. Reusable across any mailbox configured in email-tools — pass the mailbox identifier as `mailbox`.
---

# Email Reply

Works a support/customer mailbox through the `email-tools` plugin: read unreplied
threads, draft a reply in the company's voice, and either queue it to send or
hold it for a human — based on how risky the message is.

Pairs with `email-triage` (which clears noise) — this skill handles the mail
that actually needs a response. The **mailbox is a parameter**, so one routine
per mailbox is all you need.

## When to invoke

- The `email-sweep` routine fires and hands you a mailbox's unreplied customer
  mail.
- A specific email is handed off / delegated to you (e.g. as part of a "reply to
  customer email" portfolio directive).
- The operator asks you to work the support inbox.

## The policy (read this before sending anything)

Classify every message, then act by tier:

| Tier | Message | Action |
|---|---|---|
| **Handle** | Clear, low-risk, answerable from known facts — hours, location, order/shipping status you can verify, general product/how-to questions, scheduling | Draft a send-ready reply and submit it with `email_reply`. |
| **Hold** | Anything with a request you can't fully satisfy from known facts, or that needs a judgment call | Draft your best reply but **do not send** — comment it on the issue and raise an approval for the board. |
| **Never** | Refunds, cancellations, billing/pricing disputes, complaints, legal or safety matters, angry or VIP senders | **Never auto-send.** Draft a calm, non-defensive reply, hold it, escalate to the board, and if it names a real problem, create a child issue to the agent who owns that area so the underlying thing gets fixed. |

When unsure of the tier, treat it as **Hold**. Never fabricate an order, price,
policy, or promise — if a reply needs facts you don't have, hold and ask.

## How to act

1. List unreplied threads in the mailbox via the `email-tools` plugin (or work
   the specific thread you were handed).
2. Read the full thread. Draft a reply that's specific, human, and brief — no
   boilerplate, no "sorry for any inconvenience" filler, never argumentative.
3. Apply the tier:
   - **Handle** → `email_reply` with your text. See the gate note below.
   - **Hold / Never** → comment the proposed reply on the issue, raise an
     approval, leave the issue `in_review`; escalate/open a fix-it child issue
     where relevant.
4. **The gate:** `email_reply` is an outbound action, so by default Paperclip
   intercepts it and queues it as a board **approval draft** rather than sending
   immediately. That's expected — do **not** retry the tool; end your turn and
   the draft appears in Approvals. Once the operator trusts a category, they can
   allow-list it so Handle-tier replies send hands-free.

## Requirements & guardrails

- **Plugin**: `email-tools` installed and configured for the mailbox (SMTP/IMAP
  creds live in the encrypted secret store, never in this skill).
- **Trust ramp**: keep the outbound draft gate on until the drafts read the way
  you'd write them; then allow-list Handle-tier replies for hands-free sending.
- Keep the customer's data private; never quote one customer to another.
