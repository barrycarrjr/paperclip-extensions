---
name: listing-watch
displayName: Listing Watch pack
description: One-click setup for watching a seller's own Amazon listings. Imports the listing-watch agent, the listing-watch skill, the 6-hourly review routine and the weekly digest routine. Requires amazon-tools (with Listing Watch on) and slack-tools.
icon: eye
category: commerce
requiresPlugins:
  - amazon-tools
  - slack-tools
includes:
  agents:
    - listing-watch
  routines:
    - listing-watch-review
    - listing-watch-digest
  skills:
    - listing-watch
---

# Listing Watch pack

amazon-tools records every change on every listing; this pack adds the agent
that reads those changes, decides which ones matter, and tells a person.

## After installing

1. In amazon-tools, set the account's Seller ID and turn on **Listing Watch**.
2. Add the operator's Slack member ID to Paperclip's "messages to yourself"
   setting, and set it as `slackUserId` on both routines.
3. Run **Review listing changes** once by hand to check the setup.
