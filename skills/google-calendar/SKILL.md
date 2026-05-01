---
name: google-calendar
description: Read and modify Google Calendar via the google-workspace paperclip plugin. Use when an agent needs to list events, look up free/busy windows, or create/update/delete calendar entries on behalf of an authenticated Google account configured in the plugin.
---

# Google Calendar

Wraps the `gcal_*` tools registered by the `google-workspace` paperclip
plugin. The plugin handles OAuth and per-company isolation; this skill
documents how heartbeats invoke the tools.

## When to invoke

- A heartbeat needs today's or this week's events ("brief me on what's on
  Barry's calendar today" → `gcal_list_events`).
- A task says "schedule a 30-min sync with X" → `gcal_freebusy` to find a
  slot, then `gcal_create_event` to book it.
- A confirmation requests an event move/cancel → `gcal_update_event` or
  `gcal_delete_event`.

## Pre-conditions

- The `google-workspace` plugin is installed and at least one account
  is configured for the calling company (operator did this in
  `/instance/settings/plugins/google-workspace`).
- For mutation tools (`gcal_create_event`, `gcal_update_event`,
  `gcal_delete_event`) the plugin's master switch
  **"Allow create/update/delete tools"** is on.
- For external-tier actions (events with non-operator attendees, or
  deletions of events others rely on), draft first and request board
  confirmation before invoking.

## How to invoke

Plugin tools are NOT exposed as Claude Code MCP tools. They live in
paperclip's plugin tool registry and are invoked via a paperclip API call.
**Do not search ToolSearch / MCP** for `gcal_*` — they won't be there.

The body shape is `{ tool, parameters, runContext }`. The runContext comes
from env vars auto-injected into your heartbeat:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" --arg company "$PAPERCLIP_COMPANY_ID" '{
    tool: "google-workspace:gcal_list_events",
    parameters: {
      account: "barry-personal",
      timeMin: "2026-04-30T00:00:00-05:00",
      timeMax: "2026-05-01T00:00:00-05:00"
    },
    runContext: {
      agentId: $agent,
      runId: $run,
      companyId: $company
    }
  }')"
```

Tool names use the `<pluginId>:<toolName>` format —
`google-workspace:gcal_list_events`, etc.

## Available tools

| Tool | Purpose | Mutation? |
|---|---|---|
| `gcal_list_calendars` | List calendars (own + subscribed). | no |
| `gcal_list_events` | List events in a window (default: today through 7 days). | no |
| `gcal_get_event` | Fetch one event by ID. | no |
| `gcal_freebusy` | Busy intervals on named calendars (use for conflict checks). | no |
| `gcal_create_event` | Create a new event. | yes |
| `gcal_update_event` | `events.patch` — partial update. | yes |
| `gcal_delete_event` | Delete an event. | yes |

The `account` parameter is optional if the plugin has a `defaultAccount`
configured. To discover valid account keys, read the plugin config
(`GET /api/plugins/google-workspace/config`).

## Examples

### List events for the next 24 hours

```json
{
  "tool": "google-workspace:gcal_list_events",
  "parameters": {
    "account": "barry-personal",
    "timeMin": "2026-04-30T00:00:00-05:00",
    "timeMax": "2026-05-01T00:00:00-05:00"
  }
}
```

Returns `{ events: [...], nextPageToken }`. Each event has `summary`, `start`, `end`, `location`, `attendees`, `htmlLink`.

### Find a free 30-min slot, then book it

```json
{
  "tool": "google-workspace:gcal_freebusy",
  "parameters": {
    "account": "barry-personal",
    "timeMin": "2026-05-01T13:00:00-05:00",
    "timeMax": "2026-05-01T18:00:00-05:00",
    "calendarIds": ["primary"]
  }
}
```

Then, after picking a window:

```json
{
  "tool": "google-workspace:gcal_create_event",
  "parameters": {
    "account": "barry-personal",
    "summary": "Sync with Tony",
    "start": { "dateTime": "2026-05-01T14:00:00-05:00" },
    "end":   { "dateTime": "2026-05-01T14:30:00-05:00" },
    "attendees": [{ "email": "tony@example.com" }],
    "sendUpdates": "all"
  }
}
```

`sendUpdates` — `"all"` to email attendees, `"none"` (default) to silently
add. Use `"all"` for external attendees.

### Update / cancel

```json
{
  "tool": "google-workspace:gcal_update_event",
  "parameters": {
    "account": "barry-personal",
    "eventId": "...",
    "patch": { "location": "Cafe Y" }
  }
}
```

```json
{
  "tool": "google-workspace:gcal_delete_event",
  "parameters": { "account": "barry-personal", "eventId": "...", "sendUpdates": "all" }
}
```

## Response shape

Success (HTTP 200):

```json
{
  "pluginId": "google-workspace",
  "toolName": "gcal_list_events",
  "result": {
    "content": "Found 3 event(s).",
    "data": { "events": [...], "nextPageToken": null }
  }
}
```

In-band failure (still HTTP 200):

```json
{
  "pluginId": "google-workspace",
  "toolName": "gcal_create_event",
  "result": { "error": "[EMUTATIONS_DISABLED] gcal_create_event is a mutation tool. Set ..." }
}
```

## Common error codes

- `[ECOMPANY_NOT_ALLOWED]` — your company isn't in the account's
  `allowedCompanies`. Stop and ask the operator to fix on the plugin
  settings page.
- `[EMUTATIONS_DISABLED]` — you tried a mutation tool but the master switch
  is off. Stop; do not retry. Ask the operator (or surface in your
  reply that the action requires enabling it).
- `[EACCOUNT_REQUIRED]` / `[EACCOUNT_NOT_FOUND]` — `account` parameter
  missing or unknown.
- `[EGOOGLE_INVALID_GRANT]` — refresh token was revoked. Operator must
  re-run `pnpm grant <account-key>` and update the secret.
- `[EGOOGLE_FORBIDDEN]` — the granted scope doesn't include the API call,
  or the API isn't enabled for the OAuth client's project.
- `[EGOOGLE_NOT_FOUND]` — the event ID doesn't exist or the account can't
  see it.
- `[EGOOGLE_RATE_LIMIT]` — back off and retry later.

## Voice rules

When creating events on someone's behalf, the `summary` should match how
they'd write it themselves — short, lowercase if that's their style, no
clinical phrasing. Use the calendar owner's existing entries for tone.
