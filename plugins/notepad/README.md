# `notepad` plugin

Per-company freeform notepad mounted in the company sidebar. Operators jot
ideas, meeting notes, and half-formed asks somewhere that isn't the issue
tracker — and when a note is ready, a one-click **Convert to issue** action
runs it through the company's chat-agent (Clippy) for an AI cleanup pass and
creates a real issue.

The source note is kept (status `converted`, with a link to the resulting
issue) so the audit trail survives.

## Quickstart

1. Install the plugin and enable it.
2. Open the plugin's settings page → **Configuration** → tick the company
   (or companies) that should see the Notepad in their sidebar.
3. Switch to one of those companies. **Notepad** appears in the left nav.
4. Click **+ New note** and start typing — auto-saves after 800 ms.
5. When ready, click **Convert to issue** → modal previews the cleaned
   title and body → **Open issue** to jump to the new tracker entry.

No API keys, no SIP trunks, no OAuth dance. The plugin is self-contained.

## Configuration

| Field | Default | Purpose |
|---|---|---|
| **Allowed companies** | (none — fail-safe deny) | Which companies see the Notepad and can read/write notes. Tick **Portfolio-wide** for `["*"]`. Each company's notes are isolated — no cross-company reads. |
| **Use AI cleanup on convert** | on | When on, the convert flow opens a session with the company's chat-agent and asks for a cleaned `{title, body}` JSON object. When off, the issue is created with the note's first line as title and the rest as body — no LLM call. |
| **Cleanup agent (optional)** | (auto-pick) | Override which agent runs the cleanup. Auto-pick uses the first agent in the company with role `assistant` (Clippy). Set this only if you have multiple chat-style agents and want a specific one. |
| **Show in sidebar** | on | Off = the page is still reachable at `/:companyPrefix/notepad` but no nav link. |

## How "Convert to issue" works

1. Operator clicks **Convert to issue** on a draft note.
2. Modal opens — operator can untick **Use AI cleanup** to skip the LLM call
   for this convert.
3. On submit:
   - **Cleanup path:** plugin opens a one-shot session with the company's
     chat-agent (`ctx.agents.sessions.create`), sends a deterministic prompt
     asking for a `{title, body}` JSON object, collects stdout chunks until
     `done`, and parses the JSON. Robust extraction tries raw → ```json
     fence-stripped → first `{...}` block. Times out at 60 s.
   - **Raw path:** plugin uses `note.title || first line of body` as the
     title and the full body as the description.
4. Plugin calls `ctx.issues.create({ companyId, title, description, actor: { actorUserId } })`.
   The operator's user id is taken from the API request actor so the issue's
   audit trail shows them as the creator.
5. Note row is updated: `status='converted'`, `converted_to_issue_id=<id>`,
   `converted_at=now()`.
6. Modal preview shows the cleaned title and body, with a side-by-side
   compare against the original. **Open issue** navigates to the tracker.

If cleanup fails for any reason (no chat-agent available, session error,
unparseable response, timeout), the convert **always** falls back to the
raw-text path and surfaces a `[ECONVERT_FAILED_LLM]` warning. The operator
still gets an issue.

## Tools

None. The Notepad is operator-driven; agents don't read or write notes.

If a future skill wants agent-side note creation (e.g. a research-summary
skill), `note_create` / `note_list` tools can be added without breaking the
existing UI surface.

## Error codes

- `[ECOMPANY_NOT_ALLOWED]` — calling company isn't in `allowedCompanies`.
- `[ENOTE_NOT_FOUND]` — note id doesn't exist in this company.
- `[ENOTE_ALREADY_CONVERTED]` — convert called twice on the same note;
  returns the existing `issueId` rather than creating a duplicate.
- `[ECONVERT_FAILED_LLM]` — cleanup dispatch failed; convert fell back to
  raw text and produced an issue. Surfaced as a non-fatal warning.

## Architecture

```
operator types/edits ──► Notepad page ──► /api/plugins/notepad/api/notes
                          (React, plugin                │
                           UI bundle)                   ▼
                                                worker.ts (companyId-scoped)
                                                        │
                                                        ▼
                                        plugin_notepad_<hash> schema
                                        ┌──────────────────────────┐
                                        │ notes                    │
                                        │   id, company_id, title, │
                                        │   body, status,          │
                                        │   converted_to_issue_id, │
                                        │   converted_at,          │
                                        │   created_at, updated_at │
                                        └──────────────────────────┘
                                                        │
              "Convert to issue" ──► worker.ts ─────────┴───► ctx.agents.sessions
                                                              .create / sendMessage
                                                              / close
                                                              ──► JSON {title, body}
                                                              ──► ctx.issues.create
                                                                    + actor.actorUserId
                                                              ──► UPDATE notes
                                                                    SET status,
                                                                        converted_to_*
```

## Local development

```bash
cd plugins/notepad
pnpm install
pnpm typecheck
pnpm build
```

Install into Paperclip from the dev shell:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip-extensions/plugins/notepad","isLocalPath":true}'
```

After install, refresh the Paperclip UI and open the plugin's settings page
to allow-list a company. The migration runs automatically on first install.

## Recent changes

- **v0.1.5** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.4** — Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.1.3** — AI cleanup now **expands** notes into structured issues (Description / Steps to reproduce / Acceptance criteria) instead of tightening them. The convert modal result now shows an "AI expanded" or "Raw text — AI unavailable" badge so you can confirm whether the LLM was actually invoked. Button label changes to "Expanding with AI…" during the AI path. Checkbox label updated to match new behaviour.

- **v0.1.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.1** — Patch bump. The Converted tab now works once the host plugin-database validator accepts plugin SELECTs that JOIN against `public.issues` (host-side fix landed alongside this release). No plugin-code change beyond the version bump.

- **0.1.0 (2026-05-09)** — Initial release. Per-company sidebar entry +
  `/:companyPrefix/notepad` page; CRUD over notes; convert-to-issue flow
  with optional Clippy cleanup pass and graceful raw-text fallback. Uses
  `database.namespace.*` (first plugin in this folder to do so) and
  `agent.sessions.*` for the cleanup dispatch — no LLM SDK in the plugin.
