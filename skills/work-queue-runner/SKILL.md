---
name: work-queue-runner
description: Generic claim → process → complete loop for any Paperclip work queue. Pulls one pending item at a time, claims it (race-safe), invokes the agent's domain expertise to handle the payload, then marks the item completed or failed. Reusable across any company and any queue — pass the queue slug as `queueSlug` in the routine. Conservative — never silently drops items, never marks as `done` without first running the handler. The HOW (what to do with each payload) lives in the agent's persona and other skills; this skill owns the WHEN and WHERE plumbing.
---

# Work Queue Runner

Pulls work-queue items from a single queue and walks each through the
`pending → claimed → completed | failed` lifecycle. The skill is the
**plumbing**, not the domain logic — the agent invoking it is expected
to know what to do with the payloads it sees, either through its
persona or through other skills it imports.

The **same skill runs against any work queue**. The queue identifier is
a parameter, so one routine per (company, queue) is all you need.

## When to invoke

- A scheduled routine fires `work-queue-runner` on whatever cadence
  matches the queue's freshness needs (typical: every 5 min for live
  queues like inbound leads; hourly for batch queues like Rollbar).
- The agent claims **one item per heartbeat** by default. Set
  `maxItemsPerRun` in the routine variables to claim more — but
  remember each item is a heartbeat, so a generous cap rarely makes
  sense.

## Routine setup convention

| Field | Use placeholder? | Example |
|---|---|---|
| `title` | NO — hardcode queue slug | `Run support queue` |
| `description` | YES — `{{queueSlug}}` | `Drain pending items from the {{queueSlug}} work queue using work-queue-runner.` |
| `variables` | one entry: `{name: "queueSlug", defaultValue: "support"}` | |
| `assigneeAgentId` | the agent that should process items | |

Hardcode the title so the placeholder syntax doesn't leak into the UI
list. When cloning for a new queue, update the title and the
`defaultValue`.

## Pre-conditions

- A work queue with the given slug exists in the calling company and
  is `isActive: true`. If the queue is paused or missing, the run
  exits clean with a comment.
- The calling agent has access to the work-queue-item endpoints. Agents
  can claim, complete, fail, and cancel via the standard board agent
  authn — no extra grant needed.
- The agent knows how to handle the payloads in this queue. Either via
  the agent's AGENTS.md or via another skill the agent imports.

## Parameters (passed in by the routine)

| Param | Required | Notes |
|---|---|---|
| `queueSlug` | yes | Slug of the queue (e.g. `support`, `rollbar-errors`, `inbound-leads`). Resolved per-company. |
| `maxItemsPerRun` | no | Max items to claim and process this heartbeat. Default 1. Cap hard at 10 — beyond that, prefer more frequent routine runs. |
| `failureRetryHint` | no | What to put in the `reason` when handling raises. Default `Handler raised — see issue comment for details.` |

## Environment variables (from the heartbeat)

| Var | What |
|---|---|
| `PAPERCLIP_API_URL` | Local API base, e.g. `http://localhost:3100` |
| `PAPERCLIP_API_KEY` | Agent's run token; injected by the heartbeat |
| `PAPERCLIP_COMPANY_ID` | Calling company (the queue's company) |
| `PAPERCLIP_ISSUE_ID` | This run's issue, where you append the heartbeat comment |

## Workflow

### 1. Resolve the queue

```bash
QUEUE=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/work-queues" \
  | jq -r --arg slug "$QUEUE_SLUG" '.[] | select(.slug == $slug)')

QUEUE_ID=$(echo "$QUEUE" | jq -r '.id // empty')
QUEUE_ACTIVE=$(echo "$QUEUE" | jq -r '.isActive // false')
```

If `QUEUE_ID` is empty: comment "Queue '<slug>' not found in this company." and exit.
If `QUEUE_ACTIVE` is `false`: comment "Queue '<slug>' is paused; nothing to do." and exit clean.

### 2. List pending items

```bash
ITEMS=$(curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/work-queues/$QUEUE_ID/items?status=pending&limit=$MAX_ITEMS_PER_RUN")
```

Items come back ordered by priority desc, createdAt asc — the next one
to claim is `.[0]`. If empty, exit clean with a "no pending items" comment.

### 3. Claim the next item

Iterate up to `maxItemsPerRun` items. For each:

```bash
CLAIM_RESP=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/work-queue-items/$ITEM_ID/claim")
HTTP=$(echo "$CLAIM_RESP" | tail -n1)
BODY=$(echo "$CLAIM_RESP" | sed '$d')
```

- `200` → claim won. Continue to step 4.
- `409` → another agent claimed it first. Skip this item, try the next
  one in the list. Don't surface as an error — it's expected on busy
  queues.
- `403` or `404` → log and stop the run; the queue config or grants
  changed.

### 4. Process the payload

The payload is `BODY.payload` — a JSON object whose shape depends on
the queue. Domain knowledge for handling each queue's payload lives
in the **agent's** persona + other imported skills, not in this
skill. Examples of what an agent might do:

- `support` queue → use `help-scout` plugin tools to read the
  conversation, draft a reply, post it.
- `rollbar-errors` queue → use `github-tools` to file or update an
  issue if the error is recurring.
- `inbound-leads` queue → use `phone-tools` to place a qualifying
  call.

The point is: this skill **doesn't** prescribe the handler. It just
makes sure the lifecycle is clean.

When invoking other tools or skills here, **stay inside the budget
and approval gates** that already apply to the calling agent — claim
race + complete is not a license to spend without limit.

### 5. Mark the item complete or failed

On success — payload was handled and durable side-effects were made:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/work-queue-items/$ITEM_ID/complete" \
  -d "$(jq -nc --arg issueId "$LINKED_ISSUE_ID" '{issueId: ($issueId // null)}')"
```

Pass `issueId` if the handling created or updated a linked issue, so
the queue item points back at the canonical record.

On failure — handler raised, ran out of budget, or hit a permission
gate:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/work-queue-items/$ITEM_ID/fail" \
  -d "$(jq -nc --arg reason "$FAILURE_REASON" '{reason: $reason}')"
```

Failed items aren't auto-retried by the platform. The operator (or a
follow-up skill) re-enqueues if appropriate. **Do not call
`/cancel`** — cancel is for pending items the operator wants to drop,
not for failures during processing.

### 6. Report

Append a comment on **this run's issue** (`PAPERCLIP_ISSUE_ID`):

```
Work-queue runner — <queueSlug> — <UTC timestamp>
- Pending in queue at start: <pendingCount>
- Items attempted: <attempted>
- Items completed: <completed>
- Items failed: <failed>
- Items lost to claim race (skipped): <raceLost>

<one bullet per processed item with item ID, summary, and outcome>
```

Keep the comment short — durable details belong on the linked issue
(if any), not the run's heartbeat thread.

## Failure modes

- **Queue empty** — exit clean with a one-line comment. Don't call
  this a failure; an empty queue means the system is keeping up.
- **All items lost to claim race** — exit clean. Comment that
  contention is happening; if it's chronic the routine cadence is
  too slow relative to the producer rate.
- **Handler raised** — call `/fail` with the reason, comment the
  details on the linked issue (if any) or on this run's issue, and
  move on to the next item. One bad payload should not block the
  whole queue.
- **Auth or 5xx from the API** — bail. The platform itself is
  unhealthy; another sweep will pick up where this one left off.

## Why this is a skill, not a plugin

Plugins are for tools the platform exposes to agents. This is a
*procedure* the agent runs that uses already-existing platform
endpoints. Putting it in a plugin would force the LLM-agnostic
constraint and add a maintenance surface for what is fundamentally
just a curl loop. As a skill it stays simple, transparent, and
adapter-neutral.
