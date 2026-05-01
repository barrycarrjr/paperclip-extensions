---
name: ceo-morning-briefing
description: Compile a morning briefing for the operator and deliver it as a Slack DM. Runs on a daily routine. Pulls open-issue counts, overdue tasks, and any metric snapshots already configured for the company, formats as Slack Block Kit, and sends via the slack-tools plugin. Use whenever a heartbeat fires the daily briefing routine, or on-demand when the operator asks "give me the daily."
---

# CEO Morning Briefing

Daily briefing delivered to the operator's Slack DM. Pulls activity that
matters (open issues, overdue tasks, optional metrics) and ships a
single Block Kit message that's quick to scan from a phone.

## When to invoke

- A scheduled routine fires `ceo-morning-briefing` (typical cadence:
  weekday mornings at 07:30 in the operator's local timezone).
- The operator types "give me the daily" / "morning brief" in chat.
- A skill that just finished overnight work wants to surface its results
  in the next briefing — set a comment on the open briefing issue rather
  than calling this skill mid-day.

## Pre-conditions

- The `slack-tools` paperclip plugin is installed and `ready` (check via
  `/instance/settings/plugins`).
- A workspace is configured with a valid bot token and the operator's
  Slack user ID set as `defaultDmTarget`.
- The calling company is in the workspace's `allowedCompanies`. For
  cross-company briefings (e.g., one CEO covering multiple LLCs),
  configure separate workspaces per company OR use `allowedCompanies:
  ["*"]` on a single shared workspace.
- The `allowMutations` switch is irrelevant — DMs use the send tools, not
  the gated edit/delete tools.

## What to include

A briefing is a one-screen message. Default sections:

1. **Header** — date in the operator's locale (e.g. `📊 Briefing — Mon
   May 1`).
2. **Counts** — open issues, overdue tasks, pending approvals, agents
   active. Pull from the paperclip API:
   - `GET /api/issues?status=open&limit=200` for open count
   - `GET /api/issues?dueBefore=<today-iso>&status[]=open&status[]=in_progress`
     for overdue
   - `GET /api/issues?status=pending_approval` for approvals
3. **Top-priority items** — list up to 5 critical/high-priority open
   issues. Just `title (project • priority)`. Don't paste long bodies.
4. **What's on the calendar** — only if the `google-workspace` plugin is
   installed. Call `gcal_list_events` for today. Title + start time only.
5. **Optional metric callout** — if a metrics snapshot was generated
   overnight (e.g. by `metrics-collector`), reference its summary line
   here. Don't try to compute metrics inside this skill.

If a section has no content (e.g., zero overdue), omit the section
rather than printing "0 overdue" — keeps the message tight.

## How to invoke

Plugin tools live in paperclip's plugin tool registry, not as Claude
Code MCP tools. Call them via the paperclip plugin-tool execute endpoint:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n \
    --arg agent "$PAPERCLIP_AGENT_ID" \
    --arg run "$PAPERCLIP_RUN_ID" \
    --arg company "$PAPERCLIP_COMPANY_ID" \
    --argjson blocks "$BLOCKS_JSON" \
    --arg text "$FALLBACK_TEXT" \
    '{
      tool: "slack-tools:slack_send_dm",
      parameters: {
        text: $text,
        blocks: $blocks
      },
      runContext: {
        agentId: $agent,
        runId: $run,
        companyId: $company
      }
    }')"
```

The tool name uses the `<pluginId>:<toolName>` format —
`slack-tools:slack_send_dm`. Omitting `workspace` falls back to the
plugin's `defaultWorkspace`. Omitting `userId` falls back to the
workspace's `defaultDmTarget`.

`text` is REQUIRED even when blocks are used — Slack uses it as the
notification fallback (push/notification body, screen reader text).
Make it a short single line that summarizes the brief.

## Block Kit shape

Build the blocks array in your heartbeat. Recommended layout:

```jsonc
[
  // 1. Header
  {
    "type": "header",
    "text": { "type": "plain_text", "text": "📊 Briefing — Mon May 1" }
  },
  // 2. Counts as a 2-column or 4-column section.fields
  {
    "type": "section",
    "fields": [
      { "type": "mrkdwn", "text": "*Open issues*\n12" },
      { "type": "mrkdwn", "text": "*Overdue*\n3" },
      { "type": "mrkdwn", "text": "*Approvals*\n1" },
      { "type": "mrkdwn", "text": "*Agents active*\n4" }
    ]
  },
  // 3. Top-priority items as a bulleted mrkdwn block
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "*Top priorities*\n• Customer escalation: refund window expired (Acme Print • critical)\n• Calendar: lunch with vendor at 12:30 (Personal • medium)"
    }
  },
  // 4. Calendar (only if google-workspace returned events)
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "*Today*\n• 09:30 — design review\n• 12:30 — lunch w/ vendor"
    }
  },
  // 5. Footer context line
  {
    "type": "context",
    "elements": [
      { "type": "mrkdwn", "text": "Generated by `ceo-morning-briefing` · run abc123" }
    ]
  }
]
```

Use the [Block Kit Builder](https://app.slack.com/block-kit-builder/) to
preview before sending. The slack-tools plugin doesn't validate Block Kit
structure client-side — Slack does, and a malformed payload returns
`[ESLACK_INVALID_ARGUMENTS]`.

## Threading (optional)

If the operator wants every day's briefing collapsed into one Slack
thread instead of separate messages:

1. On the very first briefing, send normally and store the returned `ts`
   somewhere stable (e.g. a paperclip key-value or the company's
   `last_briefing_ts` config).
2. On every subsequent briefing, pass that `ts` as `threadTs` so the new
   message threads under the original.

This is purely an operator preference. Default: send fresh DMs daily.

## Response

On success the API returns (HTTP 200):

```json
{
  "pluginId": "slack-tools",
  "toolName": "slack_send_dm",
  "result": {
    "content": "DM sent to U01ABCDEFGH on team-main.",
    "data": {
      "ts": "1714579312.000200",
      "channel": "D01XYZ1234"
    }
  }
}
```

Stash the `ts` if you're threading. Otherwise just confirm and move on.

On in-band failure (HTTP 200 with error in result):

```json
{
  "pluginId": "slack-tools",
  "toolName": "slack_send_dm",
  "result": { "error": "[ESLACK_AUTH] invalid_auth" }
}
```

Common failure modes:

| Error | Meaning | Fix |
|---|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | This company isn't on the workspace's allow-list. | Operator adds the company UUID under Allowed companies on `/instance/settings/plugins/slack-tools`. |
| `[EWORKSPACE_REQUIRED]` | No workspace param and no defaultWorkspace. | Set `defaultWorkspace` on the plugin settings page or pass `workspace` in the call. |
| `[EINVALID_INPUT] No userId provided and workspace has no defaultDmTarget` | Need to know who to DM. | Set `defaultDmTarget` to your Slack user ID, OR pass `userId` explicitly. |
| `[ESLACK_AUTH]` | Bot token invalid/revoked/expired. | Reissue token in Slack App admin, update the secret in paperclip. |
| `[ESLACK_SCOPE]` | Bot is missing `chat:write` or `im:write`. | Add the scope, reinstall the Slack App, update token. |

## After sending

Append a comment to the parent briefing issue (or open one if there
isn't a recurring issue) with:

```
Briefing sent.
- Workspace: <workspace-key>
- Recipient: <userId>
- Slack ts: <ts>
- Sections included: <list>
```

This is the audit trail — handy when the operator says "did today's
briefing actually go out?" and you need to answer in one query.

## Pre-requisites for this skill to work

- `slack-tools` plugin installed + `ready` and at least one workspace
  configured.
- Operator's Slack user ID set as `defaultDmTarget` (one-time setup —
  see the slack-tools plugin README).
- The bot is invited to / can DM the operator. For DMs the bot opens an
  IM channel automatically; no invite needed.
- The calling agent's company is in the workspace's `allowedCompanies`.

## Out of scope for this skill

- Computing metrics (delegate to `metrics-collector` which writes its own
  summary; reference it here, don't recompute).
- Cross-company aggregation (briefing is per-company; if the operator
  wants a portfolio-wide brief, run this skill in a portfolio-wide
  company context with `allowedCompanies: ["*"]`).
- Posting to a channel instead of a DM (use `slack-tools:slack_send_channel`
  directly; that's a different cadence skill, not this one).
