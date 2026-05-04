---
name: pbx-queue-watchdog
description: Every N minutes, check each queue on the 3CX PBX. If depth or longest-wait crosses a threshold, raise an issue on the company's board so the operator can intervene. Anchor poll-style use case for the 3cx-tools plugin in the absence of (or alongside) realtime WebSocket events.
---

# PBX Queue Watchdog

A heartbeat that polls `pbx_queue_list` and `pbx_queue_status` and
files an issue when a queue is in trouble.

## When to invoke

- A scheduled routine fires this skill every 5–10 minutes during
  business hours.
- When the realtime WebSocket layer (Phase 3) is also enabled, this
  skill can run on a longer cadence (every 30 min) as a backstop —
  realtime events fire much faster but a poll is still useful for
  recovering from missed events.

## Pre-conditions

- `3cx-tools` plugin installed + `ready`.
- Calling company in `allowedCompanies` and routing populated for
  manual mode.

## How to invoke

```bash
QUEUES=$(curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" --arg company "$PAPERCLIP_COMPANY_ID" '{
    tool: "3cx-tools:pbx_queue_list",
    parameters: {},
    runContext: { agentId: $agent, runId: $run, companyId: $company }
  }')")
```

For each queue with `depth >= DEPTH_THRESHOLD` or
`longestWaitSec >= WAIT_THRESHOLD`, file an issue on the company's
board with title "Queue \"$NAME\" is backed up" and body summarizing
the current snapshot. Use idempotency: if an open issue already exists
with this title (and the queue is still backed up), append a comment
instead of creating a duplicate.

```bash
echo "$QUEUES" | jq -r '.data.queues[] | select(.depth >= 5 or .longestWaitSec >= 90) | @json' | while read -r row; do
  NAME=$(echo "$row" | jq -r '.name')
  DEPTH=$(echo "$row" | jq -r '.depth')
  WAIT=$(echo "$row" | jq -r '.longestWaitSec')
  AGENTS=$(echo "$row" | jq -r '.agentsOn')
  TITLE="Queue \"$NAME\" is backed up"
  BODY="$DEPTH waiting, longest wait ${WAIT}s, $AGENTS agent(s) on. Snapshot at $(date -Iseconds)."
  # Look for an open issue with this exact title; comment if found, otherwise create:
  EXISTING=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
    "$PAPERCLIP_API_URL/api/issues?companyId=$PAPERCLIP_COMPANY_ID&status=open&q=$(jq -rn --arg t "$TITLE" '$t|@uri')" \
    | jq -r '.[0].id // empty')
  if [ -n "$EXISTING" ]; then
    curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
      "$PAPERCLIP_API_URL/api/issues/$EXISTING/comments" \
      -d "$(jq -n --arg body "$BODY" '{ body: $body }')"
  else
    curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
      "$PAPERCLIP_API_URL/api/issues" \
      -d "$(jq -n --arg t "$TITLE" --arg b "$BODY" --arg c "$PAPERCLIP_COMPANY_ID" '{ title: $t, description: $b, companyId: $c, priority: "high" }')"
  fi
done
```

## Configuration

- `DEPTH_THRESHOLD` — default 5 calls waiting.
- `WAIT_THRESHOLD` — default 90 seconds longest wait.
- Routine cadence: cron `*/10 9-18 * * 1-5` (every 10 min during
  weekday business hours).

## Notes

- This skill is a pure read; no `allowMutations` required.
- For richer alerting (debounced threshold crossings, per-queue
  custom thresholds), enable the WebSocket layer and subscribe to
  `plugin.3cx-tools.queue.depth` events instead of polling.
