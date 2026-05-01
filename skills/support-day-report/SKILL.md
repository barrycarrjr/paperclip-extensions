---
name: support-day-report
description: Pull yesterday's Help Scout support metrics and post them to Slack as a daily DM. Anchor use case for the help-scout + slack-tools plugin pair. Use when a routine fires it on a daily cadence (typical: weekday mornings around 08:00 local time) or when the operator asks for "yesterday's support numbers."
---

# Support Day Report

Composes a one-line summary of yesterday's Help Scout activity and
delivers it as a Slack DM. Round-trip: `help-scout` for the data,
`slack-tools` for the delivery.

## When to invoke

- A scheduled routine fires `support-day-report` (cadence usually:
  weekday mornings 08:00 local time after the support team's TZ has
  ticked over).
- Operator asks "what did support look like yesterday?" — call this
  ad-hoc.

## Pre-conditions

- `help-scout` plugin installed + `ready`, with at least one account
  configured.
- `slack-tools` plugin installed + `ready`, with a workspace +
  `defaultDmTarget` configured.
- The calling company is in both plugins' `allowedCompanies`.
- A Help Scout `defaultMailbox` is set on the account (or you'll pass
  `mailboxId` to the day-report call).

## How to invoke

Two plugin calls in sequence. First, pull the report:

```bash
REPORT=$(curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" --arg company "$PAPERCLIP_COMPANY_ID" '{
    tool: "help-scout:helpscout_get_day_report",
    parameters: {},
    runContext: { agentId: $agent, runId: $run, companyId: $company }
  }')")
```

Inspect `REPORT` — it contains the date, conversation counts, response-time stats. The exact shape depends on Help Scout's report API; the plugin returns it as `data` verbatim.

Format a brief, then send the DM:

```bash
TEXT="Support yesterday: <new> new, <closed> closed, median first response <FRT>m"
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" --arg company "$PAPERCLIP_COMPANY_ID" --arg text "$TEXT" '{
    tool: "slack-tools:slack_send_dm",
    parameters: { text: $text },
    runContext: { agentId: $agent, runId: $run, companyId: $company }
  }')"
```

For richer formatting, build a Block Kit `blocks` array (see the
`ceo-morning-briefing` skill for an example) and pass it alongside
`text`. `text` stays mandatory — Slack uses it for notifications.

## Response

Both calls return the standard plugin envelope:

```json
{
  "pluginId": "...",
  "toolName": "...",
  "result": { "content": "...", "data": {...} }
}
```

Stash the day-report `data` if you also want to persist a metric.

## After sending

Append a comment on the parent paperclip routine issue:

```
Support day report sent for <date>.
- Workspace: <slack workspace key>
- Mailbox: <help-scout mailbox key>
- New: <n> · Closed: <n> · Median FRT: <m>m
- Slack ts: <ts>
```

## Errors

- `[ECOMPANY_NOT_ALLOWED]` on either plugin — operator hasn't added
  this company to the allow-list yet. Surface, don't retry.
- `[EHELP_SCOUT_AUTH]` — PAT expired. Operator rotates the secret.
- `[EHELP_SCOUT_RATE_LIMIT]` — back off and retry next day; don't
  loop. The day report is cached 60s server-side anyway.
- `[ESLACK_AUTH]` / `[ESLACK_SCOPE]` — Slack token issue. Surface.
- `[EINVALID_INPUT] No userId provided …` — operator hasn't set
  `defaultDmTarget` yet. Surface.

## Pre-requisites

- Help Scout PAT issued and stored as a paperclip secret.
- Slack bot token issued and stored as a paperclip secret.
- `defaultMailbox` (Help Scout) and `defaultDmTarget` (Slack) set on
  the respective plugin configs.
- At least one read of the day report worked once during setup, so you
  know the mailbox + token are correct.

## Out of scope

- Multi-mailbox aggregation — call this skill once per mailbox if you
  have multiple support brands.
- Historical comparison ("vs. last week") — pull `helpscout_get_week_report`
  separately and let the calling agent diff.
- Auto-replying or auto-tagging — different skills.
