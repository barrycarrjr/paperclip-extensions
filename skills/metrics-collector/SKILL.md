---
name: metrics-collector
description: Pull a revenue / growth / churn snapshot from a configured Stripe account and post it as an issue comment or write it to the agent's metrics state. Use when the agent needs current MRR, ARR, active subscriptions, signups (7d / 30d), or 30d churn rate — typically from a CEO morning briefing, a board update, or a scheduled metrics check. Never invents numbers; when Stripe isn't reachable or returns a multi-currency error, says so explicitly.
---

# Metrics Collector

Pulls a current revenue snapshot from Stripe via the `stripe-tools`
paperclip plugin (`stripe_get_metrics_snapshot`). The tool returns
**approximate** MRR / ARR / churn / signups computed by aggregating
Stripe subscriptions and customers on the fly — accurate enough for
daily / weekly cadence, not a substitute for Stripe Sigma at month-end.

## When to invoke

You're in a heartbeat and need current revenue / growth metrics.
Examples:
- The board asked for an MRR / churn check before a meeting.
- The agent's morning briefing routine includes "report current numbers."
- An issue requires answering "are we trending up or down this week?".
- A scheduled metrics-pull routine is comparing this week to last.

## Pre-conditions

- The `stripe-tools` plugin is installed and an account is configured for
  the calling company (`/instance/settings/plugins/stripe-tools` →
  Allowed companies includes this `companyId`). If not, the call returns
  `[ECOMPANY_NOT_ALLOWED]` — surface that to the board, don't fabricate
  numbers.
- For a portfolio-wide briefing where the agent runs in Portfolio
  Operations, point at the right `account` per company — or call the
  tool once per company by switching the agent context.

## How to invoke

Plugin tools are NOT exposed as Claude Code MCP tools. They live in
paperclip's plugin tool registry and are invoked via a paperclip API call.
**Do not search ToolSearch / MCP** for `stripe_get_metrics_snapshot` — it
won't be there.

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg run "$PAPERCLIP_RUN_ID" --arg company "$PAPERCLIP_COMPANY_ID" '{
    tool: "stripe-tools:stripe_get_metrics_snapshot",
    parameters: {
      account: "main"
    },
    runContext: {
      agentId: $agent,
      runId: $run,
      companyId: $company
    }
  }')"
```

`account` is optional — if you omit it, the plugin's `defaultAccount`
config kicks in. If your company has multiple Stripe accounts (live +
test, or per-brand), pass the right one explicitly.

You can pin the snapshot to a specific moment by adding `asOfDate` (ISO
timestamp). Default is now. The plugin caches the result for ~5 minutes
keyed by `(companyId, account, asOfDate-bucket)`, so calling repeatedly
in the same window is cheap.

## Response shape

```json
{
  "pluginId": "stripe-tools",
  "toolName": "stripe_get_metrics_snapshot",
  "result": {
    "content": "Snapshot (main as of 2026-04-30T13:11:00.000Z): MRR 482300 usd, 142 active subs.",
    "data": {
      "asOfDate": "2026-04-30T13:11:00.000Z",
      "currency": "usd",
      "mrrCents": 482300,
      "arrCents": 5787600,
      "activeSubs": 142,
      "signups7d": 8,
      "signups30d": 31,
      "cancellations30d": 4,
      "churnRate30d": 0.027
    }
  }
}
```

| Field | Meaning |
|---|---|
| `mrrCents` | Monthly recurring revenue, in the smallest currency unit. Sum of `subscription.items[].price.unit_amount * quantity`, normalized to a 30.4375-day month. |
| `arrCents` | `mrrCents × 12`. |
| `activeSubs` | Count of subscriptions with `status = active` right now. |
| `signups7d` / `signups30d` | Count of customers created in the trailing 7d / 30d windows. |
| `cancellations30d` | Count of subscriptions cancelled in the trailing 30d. |
| `churnRate30d` | `cancellations30d / (activeSubs + cancellations30d)`. |

Convert cents to dollars by dividing by 100 when reporting to humans
(`$4,823.00 MRR`, not `MRR 482300 cents`).

## When the call fails

| Error | What it means | What to do |
|---|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in the configured account's `allowedCompanies`. | Tell the board the plugin isn't wired for this company yet — don't guess numbers. |
| `[EACCOUNT_REQUIRED]` | No `account` param and no `defaultAccount` in plugin config. | Pass an explicit `account` that exists. |
| `[EACCOUNT_NOT_FOUND]` | The account key you passed isn't configured. | List configured accounts via `GET /api/plugins/stripe-tools/config`, pick the right one. |
| `[ESTRIPE_AUTH]` | Stripe rejected the API key. | Operator action: secret rotated or invalidated. Surface to the board. |
| `[ESTRIPE_PERM]` | The restricted key lacks read scope. | Operator action: re-issue the restricted key with the scopes from the plugin README. |
| `[ESTRIPE_MIXED_CURRENCY]` | Active subs span multiple currencies. | v0.1.0 doesn't FX-convert. Either consolidate to single-currency subs at the Stripe level, or wait for a v0.2.0 with FX support. |
| `[ESTRIPE_RATE_LIMIT]` | Stripe rate-limited. | Wait the cache TTL (~5 min) and retry — the cached snapshot is fine for most reporting needs. |

In all error cases: tell the board the snapshot wasn't available and why.
Never fabricate numbers, never round "approximately" from memory.

## Reporting style

- Always quote the `asOfDate` from the response, not "right now."
- Translate cents to currency (`$4,823.00`) when reporting to humans.
- Show change-over-time only if you have a previous snapshot to compare —
  if not, say "no prior snapshot to compare against."
- Lead with the number that matters most for the question. If the board
  asked about churn, lead with churn; if about growth, lead with signups.
- For a CEO morning briefing, default to: MRR, active subs, signups7d,
  churn30d. Skip ARR unless asked.

## Combining with other plugins

This skill is single-source (Stripe). For a fuller picture combine with:
- `google-analytics` plugin → traffic / conversion funnel
- `email-tools` → deliver the report by email
- (future) `revenuecat-tools` → app-side subscriptions if any LLC uses it

Each is a separate tool call. Don't try to bundle them into one ask.
