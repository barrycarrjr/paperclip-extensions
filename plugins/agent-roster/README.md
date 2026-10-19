# Agent roster

Agent roster shows, for one company at a time, which agents are idle or barely used and what each one costs. The board can then pause an agent, open it to terminate it, or mark it as kept on purpose.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for its data and action shapes.

## Recent changes

- **v0.1.1**: Set the author to "Paperclip contributors". No functional changes.

- **v0.1.0**: Initial roster page, sidebar item and dashboard widget. Idle, Low use, Active, New and Kept verdicts; Pause for instance admins; Keep marks with a note.

## Why

Every agent costs tokens and adds noise. An agent earns its place when it has a recurring job (for example one found by the Hand-off work audit) or regular assigned work. Add a new agent only for such a job, not from a fixed template, and review the roster now and then for agents that no longer have one.

## Set up

1. Install the plugin and select its **Allowed companies**. An empty list denies every company.
2. Open **Agent roster** in an allowed company's sidebar, or visit `/:companyPrefix/agent-roster`.

## What the page shows

One row per agent that is not terminated, idle and low use first:

| Column | Source |
| --- | --- |
| Agent, role or title, paused | `agents` |
| Verdict | see below |
| Last run, runs in the last 30 and 90 days | `heartbeat_runs` |
| Cost in the last 30 days | `cost_events` |
| Open issues (not done or cancelled) | `issues` |

Verdicts:

| Verdict | Rule |
| --- | --- |
| Idle | Older than 7 days and no run in 30 days. Same rule and numbers as Paperclip's `idle_agent` structural finding. |
| Low use | 3 runs or fewer in 30 days and no open issues. |
| Kept on purpose | Idle or Low use, with a keep mark from the board. |
| Active | Everything else. |
| New | Created in the last 7 days. Never flagged. |

The dashboard widget shows the number of idle and low use agents and their cost over 30 days. It hides itself when there are none.

## Actions

| Action key | Who | What it does |
| --- | --- | --- |
| `roster.pause-agent` | Instance admins | Pauses the agent. Resume it from the agent page. Logged in the activity log. |
| `roster.keep-agent` | Any board member of the company | Marks a flagged agent as kept on purpose, with a required note (up to 500 characters). Logged. |
| `roster.unkeep-agent` | Any board member of the company | Removes the keep mark. Logged. |

Agent roster never pauses or terminates an agent by itself, and cannot terminate at all: open the agent page for that.

Every data handler and action takes the company from the host-checked `hostScope`, never from page parameters, and refuses a company that is not on the allowed list. Calls without `hostScope` (as an agent's call would arrive) are refused.

## Data handlers

| Key | Returns |
| --- | --- |
| `roster.sidebar-visible` | `{ visible }` |
| `roster.list` | `{ roster: { rows, summary }, canPause }` |
| `roster.summary` | `{ enabled: false }` or `{ enabled: true, summary }` |

## Storage

The host applies `migrations/` into the plugin namespace with slug `roster`. Its one table, `keep_marks`, holds one row per kept agent: company, agent, note, who marked it and when. The manifest grants read-only access to the core `agents`, `heartbeat_runs`, `cost_events` and `issues` tables.

## Not included

- Which Hand-off jobs an agent runs: plugins cannot read another plugin's tables.
- Routines assigned to an agent: plugins cannot read the core `routines` table.

## Build

From `plugins/agent-roster/`:

```sh
npx -y pnpm@9 install
pnpm test
pnpm typecheck
pnpm build
```
