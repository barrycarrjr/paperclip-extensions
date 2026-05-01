---
name: google-tasks
description: Read and modify Google Tasks via the google-workspace paperclip plugin. Use when an agent needs to fetch a task list, append a new task, mark a task complete, or otherwise manage tasks in one of the operator's Google Tasks lists ("Mission Control", a project's todo list, etc.).
---

# Google Tasks

Wraps the `gtasks_*` tools registered by the `google-workspace` paperclip
plugin. Google Tasks is the operator's lightweight todo store (one list
per workstream). This skill documents how heartbeats invoke the tools.

## When to invoke

- A task says "add to Mission Control: review Acme's Q2 invoice" →
  `gtasks_create_task` against the Mission Control list.
- A morning briefing needs to surface what's open today →
  `gtasks_list_tasks` with `dueMax` set to end-of-day.
- A confirmation closes out a task → `gtasks_complete_task`.

## Pre-conditions

- The `google-workspace` plugin is installed and at least one account is
  configured for the calling company.
- For mutation tools (`gtasks_create_task`, `gtasks_update_task`,
  `gtasks_complete_task`, `gtasks_delete_task`) the master switch
  **"Allow create/update/delete tools"** is on.
- You know the target `listId`. If you don't, call `gtasks_list_lists`
  first (cheap; the response is small).

## How to invoke

Plugin tools are NOT exposed as Claude Code MCP tools. Use the paperclip
plugin-tool execute endpoint:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" --arg company "$PAPERCLIP_COMPANY_ID" '{
    tool: "google-workspace:gtasks_create_task",
    parameters: {
      account: "personal",
      listId: "MTAyMzQ1Njc4OQ",
      title: "Review Acme Q2 invoice",
      due: "2026-05-08T00:00:00Z"
    },
    runContext: {
      agentId: $agent,
      runId: $run,
      companyId: $company
    }
  }')"
```

Tool names use `<pluginId>:<toolName>` — `google-workspace:gtasks_create_task`, etc.

## Available tools

| Tool | Purpose | Mutation? |
|---|---|---|
| `gtasks_list_lists` | List all task lists for the account. | no |
| `gtasks_list_tasks` | List tasks in a list (filter by due / completion). | no |
| `gtasks_create_task` | Add a task. | yes |
| `gtasks_update_task` | Partial update. | yes |
| `gtasks_complete_task` | Mark a task complete (convenience for update). | yes |
| `gtasks_delete_task` | Delete a task. | yes |

## Examples

### Find a list ID by name (one-time)

```json
{
  "tool": "google-workspace:gtasks_list_lists",
  "parameters": { "account": "personal" }
}
```

Pick the matching `id` from the returned `lists` array and cache it in
your skill's working notes — Tasks list IDs are stable.

### List today's open tasks

```json
{
  "tool": "google-workspace:gtasks_list_tasks",
  "parameters": {
    "account": "personal",
    "listId": "MTAyMzQ1Njc4OQ",
    "showCompleted": false,
    "dueMax": "2026-05-01T00:00:00Z"
  }
}
```

### Append a new task

```json
{
  "tool": "google-workspace:gtasks_create_task",
  "parameters": {
    "account": "personal",
    "listId": "MTAyMzQ1Njc4OQ",
    "title": "Pay invoice 1234",
    "notes": "Acme Corp · due 2026-05-08",
    "due": "2026-05-08T00:00:00Z"
  }
}
```

### Mark complete

```json
{
  "tool": "google-workspace:gtasks_complete_task",
  "parameters": {
    "account": "personal",
    "listId": "MTAyMzQ1Njc4OQ",
    "taskId": "..."
  }
}
```

## Response shape

Success (HTTP 200):

```json
{
  "pluginId": "google-workspace",
  "toolName": "gtasks_create_task",
  "result": {
    "content": "Task created: Pay invoice 1234 (id ...).",
    "data": { "task": { "id": "...", "title": "...", "due": "...", "status": "needsAction" } }
  }
}
```

In-band failure looks the same as for the calendar skill — `result.error`
contains a `[E…]` code.

## Notes / quirks

- **Completed tasks lose their `due` field** in API responses. If you need
  to compute "what's overdue and was completed late," cache the `due` value
  before completion.
- The Tasks API ignores time-of-day on `due` — only the date part is
  recorded. If your intent is "by 5pm today" you'll need to enforce that
  in skill logic, not via the API.
- `gtasks_create_task` accepts `parent` (for subtasks) and `previous`
  (for ordering). Both are task IDs from the same list.

## Common error codes

Same shape as `google-calendar`:

- `[ECOMPANY_NOT_ALLOWED]`, `[EMUTATIONS_DISABLED]`, `[EACCOUNT_REQUIRED]`,
  `[EACCOUNT_NOT_FOUND]`, `[EINVALID_INPUT]`, `[ECONFIG_SECRET_MISSING]`,
  `[EGOOGLE_INVALID_GRANT]`, `[EGOOGLE_FORBIDDEN]`, `[EGOOGLE_NOT_FOUND]`,
  `[EGOOGLE_RATE_LIMIT]`, `[EGOOGLE_UNKNOWN]`.

See the `google-workspace` plugin README for the full table.

## Voice rules

When creating tasks on the operator's behalf, mirror their existing
phrasing — terse, lowercase if that's their style, action-first
("pay invoice 1234", not "I should remember to pay invoice 1234"). Don't
add boilerplate notes ("Created by AI assistant on ...") — the timestamp
and metadata are already there.
