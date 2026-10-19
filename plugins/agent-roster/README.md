# Agent roster

Review the agents in one company using recorded work and costs, then explicitly
confirm a reversible pause when appropriate. No agent is automatically paused,
resumed or terminated.

> Install and setup walkthrough: open this plugin's settings in Paperclip and
> follow the Setup tab. This README covers behavior, capabilities and limits.

## Setup

1. Build and publish the plugin through the extensions release process. On an
   isolated test instance, install Agent roster from the Plugin Library.
2. In Configuration, select Allowed companies. An empty or missing list denies
   everyone. Portfolio-wide deliberately selects every company using `"*"`.
   Each request still reads only its host-verified company's records; malformed
   lists fail closed, including a wildcard mixed with non-string entries.
3. Select an allowed company and open Agent roster from the sidebar. Its
   dashboard widget has content only when that company has idle agents.
4. If Hand-off is installed and enabled for that company, recorded production
   work links to the corresponding agent's host run. Missing access, a missing
   plugin and failed requests are disclosed instead of showing an empty result.

No credentials, external accounts, routines or new schedules are needed.

## Keep or remove guidance

An agent earns its place with a recurring job from the Hand-off audit or regular
assigned work. Add a new agent only for a job the audit found, not from a fixed
template. Review one company at a time and decide keep, pause or terminate using
the actual evidence. Costs and agent names belong in the private app, not public
issues or pull requests.

Pause requires a board confirmation, records each request attempt before the change
and records completion afterward. Retried requests create further activity entries
with the same request ID so every attempt remains auditable, even if another board
user resumed the agent between attempts. If the first activity write fails, nothing is
changed. If completion logging fails after pausing, the UI explicitly says the
agent is paused and keeps the confirmation available: retry with the same request
ID to finish logging. Do not cancel the confirmation before retrying that partial
result. Open agent links to core controls for resuming or board-only termination.
Pausing stops new runs; it does not terminate the agent, reassign issues or cancel
an already running execution.

On an authenticated instance, Pause also requires the same `agents:create`
permission as the core agent page. The host enforces this on every request and
the worker requires its permission stamp before any agent lookup or mutation.
Instance administrators and local trusted board access retain the core exemptions
through that host stamp. Older hosts without permission stamping cannot pause.
Viewers cannot pause agents. Request correlation IDs also work on plain-HTTP
private-network installations where `crypto.randomUUID` is unavailable.

## Activity and verdicts

Every non-terminated agent has a row with name, role, status, last started run,
started runs in the last 30 and 90 days, recorded costs in the last 30 days,
visible open assigned issues, Hand-off production jobs when available and verdict.
Time windows are rolling UTC timestamps, including the exact lower boundary and
excluding future entries. Queued runs without a start time do not count. Costs
are recorded `cost_events.cost_cents` in USD, not estimates or unrecorded provider
bills. Open issues exclude done, cancelled and hidden issues.

Verdicts appear in this order:

- Idle: at least 7 days old, no started run in 30 days and no newer host heartbeat.
- Low use: fewer than 4 started runs in 30 days and no open assigned issues.
- Active: remaining agents with established activity or assigned work.
- New: created within 7 days; never flagged regardless of activity or cost.

The New rule takes priority. Exactly 7 days old is eligible for review. A heartbeat
newer than the 30-day cutoff prevents an Idle verdict, matching the core service's
additional activity safeguard. Hand-off job evidence does not change the verdict.
The widget totals costs for Idle rows only and includes paused agents. Its content
is empty when there are no Idle rows. Pausing an Idle agent does not remove it from
that count; its recorded activity must change or the board must terminate it.

`ROSTER_THRESHOLDS` exports both 7 and 30 in one place alongside the low-use and
90-day history thresholds. They mirror the named core constants. Compatibility
note: the 2026-10-18 issue brief requests idle eligibility after 7 days, but the
reviewed core `structural-findings.ts` also uses its 30-day cutoff for candidate
age. Consequently agents aged 7 to 30 days can be Idle here but absent from that
API. This plugin implements the explicit brief; it makes no core change.

## Permissions and data access

- `instance.settings.register`: allowed-company configuration.
- `database.namespace.read`: five declared core tables only, `agents`,
  `heartbeat_runs`, `cost_events`, `issues` and `companies`. Every subquery filters
  company. The companion core's Morning Brief passes the company route prefix;
  the scoped company lookup retains safe widget links on older hosts without it.
- `database.namespace.migrate`: required by the SDK for any database declaration.
  The migrations directory contains no SQL; no plugin tables are needed.
- `agents.read`, `agents.pause`: verify the agent belongs to the company and
  invoke the host pause function after confirmation. Pending-approval agents
  cannot be paused here.
- `activity.log.write`: request and completion entries, with a shared request ID,
  agent reference and the requesting board user.
- `api.routes.register`: two board-only company-resolved API routes. Pause declares
  the host-enforced `agents:create` user permission, matching the core action.
- `ui.sidebar.register`, `ui.page.register`, `ui.dashboardWidget.register`: the
  three UI surfaces, all using the host's light/dark theme tokens.

API routes under `/api/plugins/agent-roster/api`, always with `?companyId=...`:

- `GET /roster`, key `roster.list`: roster and idle cost summary.
- `POST /agents/:agentId/pause`, key `roster.pause`: body
  `{ "confirmed": true, "requestId": "example-request-1" }`. Reuse the same
  request ID when retrying. The host supplies board identity and company;
  body fields cannot grant access. Denied companies and board members without the
  required Pause permission receive 403.

Data hooks `roster.visible`, `roster.list` and `roster.widget` have matching
worker registrations. They trust only `hostScope.companyId` stamped by the host,
reject conflicting caller company IDs and check current configuration on every
request. A host without that verified scope fails closed. Disallowed companies
receive no sidebar entry, roster page content or widget content. Hook errors render
explicit errors.

Complete UI hiding requires the companion core fix for
[issue #118](https://github.com/barrycarrjr/paperclip/issues/118): company-scoped
plugin discovery and hidden empty widget frames. Install that host change alongside
this plugin. Older hosts can still show an empty card or an Agent roster discovery
link for a denied company, and an empty card when no agents are Idle. The worker
still refuses disallowed companies. Portfolio-wide selection is accepted by both
the worker and companion core. The companion change filters discovery without
granting data access or exposing the plugin's configuration.

The SDK cannot query another plugin's namespace and has no authorized cross-plugin
worker data client. The UI therefore reads Hand-off's existing board-only
`/api/plugins/handoff-pipeline/api/summary?companyId=...` with the current session;
it checks both aggregate and job company IDs. It never uses worker credentials,
direct SQL against Hand-off or an unscoped endpoint. Only production runs with
both `hostAgentId` and `hostRunId` produce links. Historical examples and Draft
skill links never imply agent ownership. No routines are read, no termination
capability is requested and no agent tools are exposed.

## Development and verification

From `plugins/agent-roster`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Use the repository's existing vendored SDK. Do not repack SDK tarballs or update
other plugins' lockfiles for this plugin. The build checks installed SDK contents.

Tests execute the actual aggregate SQL against synthetic in-memory PGlite data,
verify date boundaries, verdicts, company denial, host scope, explicit pause
confirmation, activity failures and retry behavior. UI tests verify markup,
theme use, errors, widget visibility, company links and Hand-off provenance.
The HTTP test starts an ephemeral loopback server around the actual worker API
handler with synthetic host clients and tests roster reads, denials and a logged
pause through real HTTP. That fixture does not prove Paperclip authentication,
Plugin Library installation or a browser's interactive behavior.

Before release, install from the Plugin Library on an isolated Paperclip instance
with synthetic companies. Confirm idle, active and new rows, the one-idle-agent
widget, a confirmed pause plus both activity entries, and 403/no UI for a denied
company. Verify the page in both themes and optional Hand-off links. Never install
into the current live instance merely to perform this check.

## Recent changes

- 0.1.0: initial company-scoped roster, rolling costs and activity, optional
  Hand-off host-run links, idle dashboard widget and board-confirmed audited pause.
