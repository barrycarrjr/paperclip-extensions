---
name: github-ticket-poster
description: File a GitHub issue against the operator's repos. Use when an agent needs to create a tracked ticket — e.g. a Rollbar error fingerprint should become a bug, or a research finding deserves a tracked follow-up. Idempotent on a key the caller chooses, so retrying or re-running the same heartbeat won't create duplicates.
---

# GitHub Ticket Poster

Creates a GitHub issue via the `github-tools` paperclip plugin. Used by
any skill that needs to externalize an action item into the operator's
GitHub backlog rather than keeping it in a paperclip issue.

## When to invoke

- A scheduled skill detected something that should land on a developer's
  backlog (e.g. `rollbar-scraper` saw a new high-frequency error and
  decided to file a bug).
- An agent's research finished and the natural next step is "open a
  ticket so someone tracks this in source control."
- A heartbeat is wrapping up and noticed a TODO that needs a tracked
  follow-up across repos.

If the action is just internal triage, use a paperclip issue — don't
echo it into GitHub.

## Pre-conditions

- The `github-tools` plugin is installed and `ready`
  (`/instance/settings/plugins/github-tools`).
- At least one account is configured with a PAT, the calling company
  is in its `allowedCompanies`, and `allowMutations` is true.
- The target repo is in the account's `allowedRepos` (or `allowedRepos`
  is empty).
- The PAT has Issues: write permission for the target repo.

If any of those don't hold, the API call returns a clear error code
(`[ECOMPANY_NOT_ALLOWED]`, `[EGITHUB_FORBIDDEN_REPO]`, `[EDISABLED]`,
etc.) — surface it to the operator, don't silently swallow.

## How to invoke

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n \
    --arg agent "$PAPERCLIP_AGENT_ID" \
    --arg run "$PAPERCLIP_RUN_ID" \
    --arg company "$PAPERCLIP_COMPANY_ID" \
    --arg title "Refund window expired before customer could redeem" \
    --arg body "Customer report: …\nFingerprint: deadbeef\nFirst seen: 2026-05-01" \
    --arg idem "rollbar-fp-deadbeef" \
    '{
      tool: "github-tools:github_create_issue",
      parameters: {
        title: $title,
        body: $body,
        labels: ["bug", "production"],
        idempotencyKey: $idem
      },
      runContext: {
        agentId: $agent,
        runId: $run,
        companyId: $company
      }
    }')"
```

The tool name uses the `<pluginId>:<toolName>` format —
`github-tools:github_create_issue`.

Available parameters:

| Param | Type | Required | Notes |
|---|---|---|---|
| `account` | string | no | Falls back to `defaultAccount`. |
| `owner` | string | no | Falls back to `defaultOwner` on the account. |
| `repo` | string | no | Falls back to `defaultRepo` on the account. |
| `title` | string | yes | Issue title. |
| `body` | string | no | Markdown body. |
| `labels` | string[] | no | Existing labels are reused; missing labels return `[EGITHUB_VALIDATION]` (GitHub auto-creates them only via the issue create payload, so missing labels here are added). |
| `assignees` | string[] | no | GitHub usernames. |
| `milestone` | number | no | Milestone number (not title). |
| `idempotencyKey` | string | no | Dedup key. The plugin auto-creates and applies a `paperclip:idempotency-<slug>` label, then searches for that label before opening a duplicate. |

## Idempotency

If you pass `idempotencyKey`, calling twice returns the same issue
number. Use this whenever the calling skill might re-run the same
heartbeat (a Rollbar fingerprint, a daily lint sweep, a recurring
dependency-update check). Pick a key that's stable per logical event,
not per run.

Examples:

| Caller | Good idempotencyKey |
|---|---|
| rollbar-scraper | `rollbar-fp-<fingerprint>` |
| dep-update-watcher | `dep-update-<package>-<major>.<minor>` |
| migration-failure-watcher | `migration-fail-<migration-name>` |

## Response

On success the API returns (HTTP 200):

```json
{
  "pluginId": "github-tools",
  "toolName": "github_create_issue",
  "result": {
    "content": "Created your-org/your-repo#456.",
    "data": {
      "id": 1234567890,
      "number": 456,
      "title": "…",
      "state": "open",
      "labels": ["bug", "production", "paperclip:idempotency-rollbar-fp-deadbeef"],
      "url": "https://github.com/your-org/your-repo/issues/456",
      "createdAt": "2026-05-01T18:30:00Z"
    }
  }
}
```

If the call deduped to an existing issue:

```json
{
  "result": {
    "content": "Idempotent: returning existing #456 on your-org/your-repo.",
    "data": { "number": 456, "url": "…", "deduped": true }
  }
}
```

## After posting

Append a comment to the parent paperclip issue with:

```
GitHub ticket: <repo>#<number> — <url>
- Idempotency: <key> (deduped: yes/no)
```

Audit trail. Lets the next heartbeat (or a human) see this skill already
filed the ticket.

## Errors

- `[EDISABLED]` — operator hasn't enabled mutations on github-tools yet.
  Don't retry; report and ask the operator.
- `[EGITHUB_FORBIDDEN_REPO]` — repo isn't in the account's allowedRepos.
  Either operator adds it, or pick a repo that is allowed.
- `[EGITHUB_VALIDATION]` — GitHub rejected the body. Common causes:
  unknown assignee username, milestone number that doesn't exist on the
  repo, or a label name with disallowed characters. Read the message
  before retrying.
- `[EGITHUB_RATE_LIMIT]` — back off (Octokit already retried 3× with
  backoff before surfacing this). Don't loop.

## Pre-requisites for this skill to work

- `github-tools` plugin installed + `ready`.
- At least one account configured with a PAT.
- Operator has flipped `allowMutations` to true.
- The target repo is accessible to the PAT and (if `allowedRepos` is set)
  in that allow-list.

## Out of scope for this skill

- Closing or commenting on existing issues — use `github_close_issue` /
  `github_add_comment` directly.
- Creating PRs — separate skill (push branches via git first).
- Writing across multiple repos in one call — call this skill per-repo.
