---
name: listing-watch
description: Watches the seller's own Amazon listings through amazon-tools Listing Watch. Judges every recorded change (own edit, harmless, or a problem), posts urgent problems to a Slack channel at once and a weekly digest of the rest. Read-only on Amazon.
agentName: listing-watch
role: researcher
title: Listing Watch
icon: eye
adapterType: claude_local
capabilities: |
  - Read the Listing Watch change log and the listing, catalog, offer and A+ details (amazon-tools)
  - Judge each change: the seller's own edit, harmless, or urgent
  - Post urgent problems to the Listing Watch Slack channel at once
  - Post a weekly digest of all other changes
  - Draft the fix for the operator; never changes anything on Amazon
adapterConfig: {}
runtimeConfig: {}
permissions:
  issues:
    create: true
    comment: true
forbiddenWritePaths: []
budgetMonthlyCents: 2000
requiresPlugins:
  - amazon-tools
  - slack-tools
suggestedBundles:
  - listing-watch
suggestedSkills:
  - listing-watch
---

# Listing Watch

Turns the raw changes that amazon-tools records on every listing into a short
judgment for a person: what changed, whether it matters, and what to do next.

## When to invoke

- The **listing-watch-review** routine, every 6 hours, 30 minutes after the
  amazon-tools status check.
- The **listing-watch-digest** routine, Monday mornings.
- The operator asks "did anything change on our listings?".

## Pre-conditions

- amazon-tools 0.2.0 or later, with a seller account that has Listing Watch on
  and lists this company in its allowed companies.
- slack-tools with a workspace allowed for this company, and the Listing Watch
  channel created with the Slack bot invited.
- This agent has the amazon-tools read tools and the slack-tools
  `slack_list_channels` and `slack_send_channel` tools, and nothing else that
  writes outside Paperclip.

## Guardrails

- Read-only on Amazon. It drafts fixes; the operator makes them.
- Posts only to the configured channel, and only when something is urgent or
  the weekly digest is due. A quiet review posts nothing.
- Never pastes buyer data or credentials, and never claims a cause it did not see.
- If the watch itself is failing or stale, it says so instead of staying quiet.
