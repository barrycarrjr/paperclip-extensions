---
name: email-sweep
description: Twice-daily sweep of a support mailbox's unreplied customer email. Wakes an agent to work the queue via the email-reply skill — drafting send-ready replies to clear, low-risk questions and holding refunds, complaints, billing, and anything ambiguous for board approval. One routine per mailbox; pass the mailbox key.
routineTitle: Work the support inbox
routineDescription: |
  Twice-daily. Process unreplied customer email in the {{mailbox}} mailbox using
  the email-reply skill: draft send-ready replies to clear, low-risk questions,
  and hold refunds, cancellations, complaints, billing disputes, and anything
  ambiguous for the board. Never auto-send a negative or high-stakes reply.
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
defaultAssigneeRole: support
triggers:
  - kind: schedule
    label: Weekdays 8am & 1pm Eastern
    cronExpression: "0 8,13 * * 1-5"
    timezone: America/New_York
variables:
  - name: mailbox
    label: Mailbox key (from email-tools config)
    type: text
    required: true
requiresSkills:
  - email-reply
requiresPlugins:
  - email-tools
---

# Work the support inbox

The customer-service half of the "respond to inbound" loop — the email analog of
the reviews-sweep routine. A predictable, twice-a-day pass that brings the
support inbox's reply queue to zero: send-ready drafts for the easy stuff,
board-held drafts for anything risky.

Pairs the `email-tools` plugin with the `email-reply` skill.

## After importing

1. Confirm the `email-tools` plugin is installed and the mailbox is configured
   (SMTP/IMAP creds in the encrypted secret store).
2. Set `mailbox` to the mailbox key you want worked. **One routine per mailbox**
   — clone this for each support address, in the company that owns it.
3. Attach the `email-reply` skill to the assignee (a `support` agent by default,
   or the CEO if the company has no dedicated support role).
4. Trust posture: keep the outbound draft gate **on** to start — every reply
   queues for your approval. Once the drafts read right, allow-list Handle-tier
   replies so routine answers send hands-free while risky ones still wait.
5. Adjust the cron timezone to the operator's local timezone.

## Note on the variable

Per the mailbox convention: the `{{mailbox}}` placeholder lives in the
description (which registers the variable); the title stays hardcoded so the
routines list reads cleanly. The agent reads `mailbox` from the trigger payload
at run time.
