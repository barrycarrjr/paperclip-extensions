# To-dos

A private personal to-do list. One line of text, a tick box, an optional due date.

This is the scratchpad, not the issue tracker. Issues are for work that a team can
see, assign, review and run agents against. A to-do is the thing you would
otherwise scribble on a Post-it: "call the accountant", "renew the insurance",
"chase that invoice". Writing one costs a keystroke and commits you to nothing.

## Why this exists

Paperclip had nowhere to put a quick note before this plugin:

| Surface | Why it did not fit |
|---|---|
| Issues | Creatable only through a large modal with assignee, reviewer, approver, project, workspace and label pickers. |
| Reminders | Stored as calendar events, and the schedule is mandatory. A reminder cannot be undated, so it cannot hold "do this sometime". |
| Memories | Free-form text, but built for agents to recall facts. No done state. |
| Inbox | Read-only triage. Nothing originates there. |

## How the scoping works, and why it looks odd

**Your to-dos belong to you, not to a company.** Rows are matched on your user id.
Nobody else can see them: not other members of your companies, not instance
admins, not agents.

That means the list is the **same in every company**. Switching from HQ to
Personal shows you the same items, because there is nothing company-shaped about
"call the accountant".

The odd-looking part: every request still carries a `companyId`, because the host
requires each board-auth plugin route to resolve a company before it will run.
That company proves you are a legitimate signed-in board user. **It never filters
which rows you get.**

> If you are editing this plugin: do not "fix" this by adding a company filter to
> the queries. It would silently split the list into a different one per company,
> which is the single most likely way to break it. The warnings are repeated in
> `migrations/001_init.sql` and `src/todos.ts`, and `src/todos.test.ts` fails the
> build if any query builder starts mentioning a company or stops binding the
> owner as `$1`.

Because of this, set **Allowed companies** to Portfolio-wide (`["*"]`). A narrower
list does not hide your items from anyone, it just makes the list vanish from the
sidebar while you are standing in a company that is not on it.

## What it does

- **Quick capture from the sidebar.** A one-line input under the nav entry.
  Type, press Enter, keep working. It clears and keeps focus so you can rattle
  off several in a row without leaving the page you are on.
- **A page** at `/:companyPrefix/todos` with the full list.
- **Tick to complete.** Done items drop into a collapsed `Done (n)` section
  rather than vanishing, so unticking a mistake is one click. Toggling done never
  touches the sort order, so an unticked item returns to exactly where it was.
- **Drag to reorder.** Fractional indexing, the same scheme core issues use, so a
  move rewrites only the row that moved.
- **Optional due dates.** Overdue items highlight. A date is due at the end of
  its day, not at midnight, so something due Thursday is not overdue on Thursday
  morning.
- **Click the text to rename.** Enter commits, Escape cancels.
- **Promote to issue.** When something turns out to be real work, one click
  creates a proper issue with you as the author, in whichever company you are
  currently looking at. The to-do stays put so you can still tick it off, and it
  records which issue it became.

Nothing here wakes an agent, sends a notification, or puts anything in an inbox.

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `allowedCompanies` | required | Where the plugin is switched on. Use `["*"]`. Empty means unusable (fail-safe deny). |
| `showInSidebar` | `true` | Off keeps the page reachable with no nav link. |
| `showCaptureBox` | `true` | Off leaves the nav link without the one-line input. |

## API routes

All board-auth, all scoped to the calling user.

| routeKey | method | path |
|---|---|---|
| `todos.list` | GET | `/todos` |
| `todos.create` | POST | `/todos` |
| `todos.update` | PATCH | `/todos/:todoId` |
| `todos.delete` | DELETE | `/todos/:todoId` |
| `todos.clear-done` | POST | `/todos/clear-done` |
| `todos.promote` | POST | `/todos/:todoId/promote-to-issue` |

`update`, `delete` and `promote` answer `404` identically whether the row is
missing or belongs to somebody else, so a row id cannot be used to probe for the
existence of another person's items.

## Tools

| Tool | What it does |
|---|---|
| `todo_add` | Add an item, with an optional due date. |
| `todo_list` | Read the caller's list back, optionally including done items. |
| `todo_complete` | Tick an item off, or put it back. |
| `todo_remove` | Delete an item outright. |

These let you say "add call the accountant to my list" or "tick off the
insurance one" in chat.

**They always act on the list of whoever is talking.** No tool takes an owner as
a parameter, so the model cannot name a person and reach someone else's items.
The owner comes from `runContext.userId`, which the host fills in from the
authenticated session.

**Agents running on their own cannot use them at all.** An agent run has no
person behind it, so `runContext.userId` is null and every tool refuses with
`ETODO_NO_OWNER` rather than guessing an owner.

`todo_complete` and `todo_remove` find an item by a fragment of its text, since
a chat caller has no row ids. A fragment matching more than one item fails with
`ETODO_AMBIGUOUS` and lists the candidates, rather than picking the first. That
is deliberate: silently ticking off the wrong item is worse than asking again.

### Host requirement

`runContext.userId` was added to Paperclip core alongside this plugin (it did not
exist before, which is why v0.1.0 shipped without tools). On an older host the
field is absent, the tools refuse with `ETODO_NO_OWNER`, and the page and sidebar
carry on working normally.

## Development

```bash
pnpm install
pnpm build        # or: pnpm dev  (esbuild watch)
pnpm test         # node --test, tests live beside the source
pnpm typecheck
```

The database namespace is fixed at `plugin_todolist_d9adb30a71`. The host derives
it as `plugin_<namespaceSlug>_<first 10 hex of sha256(pluginId)>`, so it is
hardcoded in the migration and must not be edited without changing the plugin id.

Tests are pure-function only, matching the rest of this repo: there is no
database fixture in the harness. The access guarantee is covered by asserting the
shape of every generated statement rather than by running them.

## Recent changes

- **v0.2.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **0.2.0** (2026-08-12) Added the four Clippy tools (`todo_add`, `todo_list`,
  `todo_complete`, `todo_remove`), now that Paperclip core passes the calling
  user's id through to plugin tool calls. Matching by text fragment refuses
  ambiguous hits instead of picking one. Agent runs are refused outright.
- **0.1.0** (2026-08-12) First release. Private per-user to-do list with sidebar
  quick capture, a full page with drag reordering and optional due dates, a
  collapsed done section, and promote-to-issue. No agent tools yet, see "Why
  Clippy cannot reach this yet".
