---
name: pbx-daily-call-report
description: Pull today's PBX call stats from 3CX (offered / answered / abandoned / SLA / peak depth, per queue) and post a one-line summary to the company's board as an issue comment or to a configured Slack DM. Anchor read-side use case for the 3cx-tools plugin. Use when a routine fires it on a daily cadence (typical: end-of-business-day at 18:00 local time) or when an operator asks "how did the phones do today?".
---

# PBX Daily Call Report

Round-trips through the `3cx-tools` plugin to summarize today's PBX
activity for the calling company.

## When to invoke

- A scheduled routine fires `pbx-daily-call-report` once per business
  day, typically just after the support window closes (e.g. 18:00 local
  time).
- An operator asks for today's phone numbers ad-hoc.

## Pre-conditions

- `3cx-tools` plugin installed and `status: ready`.
- The calling company is listed in the account's `allowedCompanies`.
- In `manual` mode: the calling company has a `companyRouting` entry
  populated (extension ranges + queue IDs minimum).
- The XAPI client_id / client_secret secrets are populated and the PBX
  is reachable from the Paperclip instance.

## How to invoke

Pull the day stats — once for the whole company, then optionally per
queue.

```bash
TODAY=$(curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n \
    --arg agent "$PAPERCLIP_AGENT_ID" \
    --arg run "$PAPERCLIP_RUN_ID" \
    --arg company "$PAPERCLIP_COMPANY_ID" \
    '{
      tool: "3cx-tools:pbx_today_stats",
      parameters: {},
      runContext: { agentId: $agent, runId: $run, companyId: $company }
    }')")

OFFERED=$(echo "$TODAY" | jq -r '.data.offered')
ANSWERED=$(echo "$TODAY" | jq -r '.data.answered')
ABANDONED=$(echo "$TODAY" | jq -r '.data.abandoned')
ABANDON_PCT=$(echo "$TODAY" | jq -r '.data.abandonRate * 100 | floor')
AHT=$(echo "$TODAY" | jq -r '.data.avgHandleSec')
SLA=$(echo "$TODAY" | jq -r '.data.sla.answeredWithinTargetPct')
```

Optionally, list queues and pull per-queue status for the top breakdown:

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

Compose the summary line and post it as an issue comment on the day's
"Daily numbers" issue (or create a fresh issue per day, your choice — a
single rolling issue tends to be cleaner). Use the standard issue API,
not a plugin call.

```bash
SUMMARY="📞 PBX today: ${OFFERED} offered, ${ANSWERED} answered, ${ABANDONED} abandoned (${ABANDON_PCT}%), AHT ${AHT}s, SLA ${SLA}%."
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/issues/$DAILY_ISSUE_ID/comments" \
  -d "$(jq -n --arg body "$SUMMARY" '{ body: $body }')"
```

## Failure modes (worth pattern-matching on)

| Plugin error | What to do |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | Operator hasn't ticked the calling company on the account. Surface a one-time setup-needed note to the board, then stop. |
| `[ECOMPANY_NOT_ROUTED]` | Manual mode and no routing entry. Same — escalate to operator with a setup-needed note. |
| `[E3CX_AUTH]` | Credentials wrong or rotated. Don't keep retrying; file an issue and pause this routine until cleared. |
| `[E3CX_NETWORK]` | PBX unreachable. Likely transient. Retry once on next routine fire. |

## Configuration

- Routine cadence: cron `0 18 * * 1-5` (weekday end-of-day local time).
- `DAILY_ISSUE_ID` env: UUID of the rolling daily-numbers issue, or unset to create a fresh issue per day.

## Notes

- `pbx_today_stats` is implemented to fall back to `pbx_call_history`
  aggregation if the 3CX report endpoint is unavailable. Counts will
  match the wallboard within ±1 (in-flight calls).
- This skill is a pure read; no `allowMutations` required.
