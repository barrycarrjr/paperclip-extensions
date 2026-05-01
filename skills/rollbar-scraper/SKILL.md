---
name: rollbar-scraper
description: Scan Rollbar for high-frequency or critical errors and auto-file GitHub tickets for ones that don't already have one. Anchor use case for the rollbar-tools + github-tools plugin pair. Use when a routine fires it (typical: hourly or 4×/day) or when an operator asks "what's burning on Rollbar?"
---

# Rollbar Scraper

Cross-plugin chain: `rollbar-tools:rollbar_get_top_items` → triage →
`github-tools:github_create_issue` for the worst items. Idempotent on
Rollbar item ID, so re-running doesn't duplicate tickets.

## When to invoke

- A scheduled routine fires `rollbar-scraper` (cadence typically
  hourly or every 4 hours).
- Operator says "what's on fire" / "any new bugs."

## Pre-conditions

- `rollbar-tools` plugin installed + `ready`, at least one project.
- `github-tools` plugin installed + `ready`, mutations enabled,
  default repo set or specified per call.
- The calling company is in both plugins' `allowedCompanies`.
- The Rollbar project's `environment` is set so we don't surface dev
  noise.

## Flow

1. Call `rollbar-tools:rollbar_get_top_items` with `since` = one hour
   ago, `levels: ["critical", "error"]`, `limit: 20`.
2. For each item that meets the threshold (default: `total_occurrences >= 10`
   in the window OR level === "critical"), call
   `github-tools:github_create_issue` with:
   - `title`: `[Rollbar] <item.title> (×<count>)`
   - `body`: stack-frame summary + Rollbar item URL +
     "First seen: <first_occurrence_at> · Environment: <environment>"
   - `labels`: `["bug", "rollbar"]`
   - `idempotencyKey`: `rollbar-fp-<itemId>` — guarantees one
     ticket per Rollbar item across re-runs.
3. (Optional) Mute the Rollbar item with `rollbar_mute_item` for 24
   hours so we don't refile if a ticket already exists. Requires the
   project's `writeTokenRef` and `allowMutations=true` on rollbar-tools.

## How to invoke

Both plugin calls follow the standard plugin-tool execute envelope.
See `github-ticket-poster` and `support-day-report` for examples.

Skeleton for the chain:

```bash
TOP=$(curl ... '{ tool: "rollbar-tools:rollbar_get_top_items", parameters: { since: "<iso-1h-ago>", levels: ["critical","error"], limit: 20 }, runContext: {...} }')

# For each item meeting threshold:
for item in $(jq -r '.result.data.items[] | select(.totalOccurrences >= 10 or .level == "critical") | @base64' <<< "$TOP"); do
  ITEM=$(echo "$item" | base64 -d)
  ITEM_ID=$(jq -r .id <<< "$ITEM")
  TITLE=$(jq -r '"[Rollbar] " + .title + " (×" + (.totalOccurrences|tostring) + ")"' <<< "$ITEM")

  curl ... '{ tool: "github-tools:github_create_issue", parameters: { title: "'"$TITLE"'", body: "...", labels: ["bug","rollbar"], idempotencyKey: "rollbar-fp-'"$ITEM_ID"'" }, runContext: {...} }'
done
```

The `idempotencyKey` is the safety net — running this skill every hour
won't keep opening new tickets for the same fingerprint; it'll just
no-op after the first one.

## Threshold tuning

Default threshold is conservative — `>= 10 occurrences in 1h` OR
`level === "critical"`. Adjust per project:

- High-traffic apps: bump to 50 occurrences
- Quiet apps: drop to 3 occurrences but limit to `level=critical`
- Greenfield project: default; tune after first month

The threshold lives in the skill's prose, not the plugin.

## After filing

Append a comment to the parent paperclip routine issue:

```
Filed <n> GitHub issue(s) from <m> top Rollbar items.
- Threshold: occurrences ≥ 10 OR critical
- Deduped: <k> already had open tickets
- New tickets: #<n1>, #<n2>, …
```

## Errors

- `[EDISABLED]` on github_create_issue — operator hasn't enabled
  mutations. Don't loop; surface.
- `[EGITHUB_FORBIDDEN_REPO]` — target repo not in allow-list. Surface.
- `[EROLLBAR_AUTH]` / `[ECOMPANY_NOT_ALLOWED]` — auth/access issue.
  Surface.

## Pre-requisites

- Both plugins installed and `ready`.
- A real Rollbar read token + GitHub PAT configured.
- `defaultProject` on rollbar-tools, `defaultOwner` + `defaultRepo`
  on github-tools (or pass them per call).
- Mutations enabled on github-tools (and optionally on rollbar-tools
  if you also want to mute filed items).

## Out of scope

- Auto-resolving fixed bugs (separate skill).
- Cross-project aggregation — run once per project.
- Sentry / other error-tracking sources — would need per-source
  plugins.
