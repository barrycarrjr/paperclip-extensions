# google-workspace plugin

Calendar, Tasks, Sheets, and Drive operations exposed as Paperclip agent tools. Multi-account, per-company isolation, OAuth-driven.

## What this plugin registers

| Tool | What it does | Mutation? |
|---|---|---|
| `google_test_auth` | Verify a configured account can authenticate. | no |
| `gcal_list_calendars` | List all calendars the account can see. | no |
| `gcal_list_events` | List events in a time window. Defaults to today through 7 days out. | no |
| `gcal_get_event` | Fetch a single event by ID. | no |
| `gcal_freebusy` | Returns busy intervals on the named calendars. | no |
| `gcal_create_event` | Create a new calendar event. | yes |
| `gcal_update_event` | Partial update of an existing event (`events.patch`). | yes |
| `gcal_delete_event` | Delete a calendar event. | yes |
| `gtasks_list_lists` | List Google Tasks lists. | no |
| `gtasks_list_tasks` | List tasks in a list. | no |
| `gtasks_create_task` | Create a task in a list. | yes |
| `gtasks_update_task` | Partial update of a task. | yes |
| `gtasks_complete_task` | Mark a task as completed. | yes |
| `gtasks_delete_task` | Delete a task. | yes |
| `gsheet_get_metadata` | Spreadsheet title + tabs (id, title, gridProperties). | no |
| `gsheet_read` | Read a range as a 2D array. | no |
| `gsheet_append` | Append rows to a range. | yes |
| `gsheet_update` | Overwrite a range. | yes |
| `gsheet_create` | Create a new spreadsheet. Optional `parentFolderId` moves it via Drive. | yes |
| `gsheet_find_by_name` | Drive search shortcut for spreadsheets matching a name. | no |
| `gdrive_list_folder` | List items in a Drive folder. | no |
| `gdrive_search` | Pass-through Drive search using Google's query syntax. | no |
| `gdrive_get_file_metadata` | Drive metadata for a single file. | no |
| `gdrive_create_folder` | Create a Drive folder. | yes |
| `gdrive_upload_file` | Upload a file (inline base64 or `localPath`). | yes |

Mutation tools require the **"Allow create/update/delete tools"** master switch on the plugin settings page (off by default — fresh installs are read-only).

## Setup

### 1. Create a Google Cloud OAuth client

You only need to do this **once per Google account family** (e.g. once for your personal Workspace, once for an LLC's Workspace). All accounts under the same OAuth client can share its client ID/secret.

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Pick (or create) a project. The project doesn't have to match your Workspace org — it just owns the OAuth client.
3. **Enable APIs** (APIs & Services → Library): Calendar API, Tasks API, Sheets API, Drive API. The Google People API is *not* required (we use `oauth2.userinfo.get` for `google_test_auth`, which is part of the OAuth2 v2 API and is enabled by default).
4. **Configure OAuth consent screen** — pick "External" (unless you're using a Google Workspace and want "Internal"). Add your email under "Test users" while the app is in test mode. The plugin doesn't need verification because each operator only authorizes their own accounts.
5. **Create OAuth 2.0 Client ID**:
   - Application type: **Desktop app** (loopback redirect — the simplest path; `http://localhost:54321/oauth/callback` works without any allowlist).
   - Or: **Web application** with `http://localhost:54321/oauth/callback` as an authorized redirect URI. Either works — Desktop is simpler.
6. Note the resulting **Client ID** and **Client Secret**.

### 2. Obtain a refresh token

Run the helper script per Google account you want the plugin to act as:

```bash
cd /path/to/paperclip-extensions/plugins/google-workspace
GOOGLE_CLIENT_ID="…" GOOGLE_CLIENT_SECRET="…" pnpm grant <account-key>
```

Where `<account-key>` is the short identifier you'll later use in plugin config (e.g. `barry-personal`, `m3-printing`).

The script:

1. Spins up a localhost listener on port 54321.
2. Opens the Google OAuth consent screen in your browser.
3. After consent, catches the redirect, exchanges the code for a refresh token.
4. Prints the refresh token to your terminal with copy-paste instructions.

If port 54321 is in use, free it before running. (The redirect URI is hardcoded; no override flag yet.)

### 3. Wire secrets and plugin config in Paperclip

Once you have a `refresh_token`:

1. **Pick the company that should own this Google account** (e.g. the Personal company for a personal Google account; M3 Media for the M3 Printing shared inbox). The plugin enforces that only allowed companies can use each account.
2. **Open the company's Secrets page** (`/instance/settings/companies/<company>/secrets`) and create three secrets:
   - `google-<account-key>-client-id` → the OAuth Client ID
   - `google-<account-key>-client-secret` → the OAuth Client Secret
   - `google-<account-key>-refresh-token` → the refresh token printed by the script
3. **Open the plugin settings page** (`/instance/settings/plugins/google-workspace`) and add an account entry:
   - Identifier: the same `<account-key>` you used above
   - Email: the Google email this account authenticates as (informational)
   - Allowed companies: tick the company UUID(s) that should be able to use this account. Use "Portfolio-wide" only if every company should share the account (rare).
   - clientIdRef / clientSecretRef / refreshTokenRef: paste the secret UUIDs from step 2 (the page shows a picker; pick by name).
4. Optionally set **defaultAccount** to one of the configured `<account-key>` values so agents can omit the `account` parameter.
5. **Allow mutations** (the master switch at the top of the settings page) only after you've smoke-tested with read-only tools and you trust the agent's calls. Default is off.

The configured account is now usable from any agent run inside an allowed company.

### 4. (Optional) Tighten scopes

The plugin defaults to:

- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/tasks`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/drive` (full Drive — chosen so `document-filing` skills can write into existing personal folders without the share-the-folder dance that `drive.file` would require)
- `https://www.googleapis.com/auth/userinfo.email` and `userinfo.profile` (for `google_test_auth`)

If you don't need Drive, set `scopes` on the account to a narrower list and re-run the grant script with `GOOGLE_SCOPES="space,separated,scope,urls"` to obtain a fresh refresh token bound to those scopes. The new refresh token replaces the old one — update the secret value.

## Sample tool calls

All examples assume `account: "barry-personal"` is configured.

### Calendar — list events for the next 24 hours

```json
{
  "tool": "gcal_list_events",
  "params": {
    "account": "barry-personal",
    "timeMin": "2026-04-30T00:00:00Z",
    "timeMax": "2026-05-01T00:00:00Z"
  }
}
```

### Calendar — create an event

```json
{
  "tool": "gcal_create_event",
  "params": {
    "account": "barry-personal",
    "summary": "Lunch with Tony",
    "start": { "dateTime": "2026-05-02T12:00:00-05:00" },
    "end":   { "dateTime": "2026-05-02T13:00:00-05:00" },
    "location": "Cafe X",
    "attendees": [{ "email": "tony@example.com" }]
  }
}
```

Requires `allowMutations: true`.

### Tasks — list tasks in a list

```json
{
  "tool": "gtasks_list_tasks",
  "params": {
    "account": "barry-personal",
    "listId": "MTAyMz...",
    "showCompleted": false
  }
}
```

(Find the `listId` first via `gtasks_list_lists`.)

### Tasks — create a task

```json
{
  "tool": "gtasks_create_task",
  "params": {
    "account": "barry-personal",
    "listId": "MTAyMz...",
    "title": "Pay invoice 1234",
    "due": "2026-05-08T00:00:00Z"
  }
}
```

### Sheets — read a range

```json
{
  "tool": "gsheet_read",
  "params": {
    "account": "barry-personal",
    "spreadsheetId": "1abc...",
    "range": "Sheet1!A1:D100"
  }
}
```

### Sheets — append a row

```json
{
  "tool": "gsheet_append",
  "params": {
    "account": "barry-personal",
    "spreadsheetId": "1abc...",
    "range": "Sheet1!A:D",
    "values": [["2026-04-30", "Acme Corp", "lead", "warm"]]
  }
}
```

### Drive — search

```json
{
  "tool": "gdrive_search",
  "params": {
    "account": "barry-personal",
    "query": "name contains 'invoice' and mimeType = 'application/pdf'"
  }
}
```

### Drive — upload from local path

```json
{
  "tool": "gdrive_upload_file",
  "params": {
    "account": "barry-personal",
    "name": "report.pdf",
    "localPath": "/tmp/report.pdf",
    "parentFolderId": "0ABC..."
  }
}
```

## Error codes

The plugin wraps Google API errors in a stable `[E…]` envelope so skills can pattern-match.

| Code | Meaning | Typical fix |
|---|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | The calling company isn't in the account's `allowedCompanies` list. | Add the company UUID on the plugin settings page, or use `["*"]` for portfolio-wide. |
| `[EACCOUNT_REQUIRED]` | No `account` parameter and no `defaultAccount` configured. | Pass `account` or set a default in plugin settings. |
| `[EACCOUNT_NOT_FOUND]` | The named account isn't configured. | Check spelling; account keys are lowercase. |
| `[EMUTATIONS_DISABLED]` | A mutation tool was called but the master switch is off. | Flip "Allow create/update/delete tools" to true on the plugin settings page. |
| `[EINVALID_INPUT]` | A required parameter was missing or malformed. | Check the tool's `parametersSchema` on the settings page. |
| `[ECONFIG]` | The configured secret resolved but came back empty. | Re-paste the secret UUID; verify the secret has a non-empty value. |
| `[ECONFIG_SECRET_MISSING]` | A configured secret-ref UUID does not exist in the company's secrets store. | Verify the UUIDs on the plugin settings page; create the missing secret in the company's Secrets page. |
| `[EGOOGLE_INVALID_GRANT]` | Google rejected the refresh token. | Re-run `pnpm grant <account-key>` and update the secret. Common cause: revoked from `myaccount.google.com/permissions`. |
| `[EGOOGLE_FORBIDDEN]` | The OAuth grant doesn't include the needed scope, or the API isn't enabled in your Google Cloud project. | Check enabled APIs in Google Cloud Console; re-grant with broader scopes if needed. |
| `[EGOOGLE_NOT_FOUND]` | The Google resource (event/task/file) doesn't exist or the authorized user can't see it. | Verify the ID; check Drive sharing. |
| `[EGOOGLE_RATE_LIMIT]` | Google is throttling requests on this OAuth client. | Wait and retry; consider spreading load across multiple OAuth clients. |
| `[EGOOGLE_<other>]` | Other Google API error. | The message follows the bracketed code. |
| `[EGOOGLE_UNKNOWN]` | Unrecognized error shape. | Check worker logs for the raw error. |

## Per-company isolation

This plugin enforces the same `allowedCompanies` pattern as `email-tools`, `social-poster`, and `google-analytics`. Every account entry lists which Paperclip companies are allowed to use it. Empty list = unusable (fail-safe deny). `["*"]` = portfolio-wide.

When an agent in company A invokes a tool addressing an account that isn't allowed for A, the call is rejected with `[ECOMPANY_NOT_ALLOWED]` before any secret is resolved or any Google API is called. Blocked attempts are logged at warn level (`ECOMPANY_NOT_ALLOWED`) so the operator can review them in the plugin's health dashboard.

## Bundle and runtime notes

- The worker bundle is ~1.7 MB (per-API `@googleapis/*` packages, not the umbrella `googleapis`).
- OAuth tokens auto-refresh — `google-auth-library` handles the access-token round-trip. Only the long-lived refresh token is stored in Paperclip secrets.
- An OAuth2 client is cached per `(companyId, accountKey)` tuple. Re-resolving secrets after they change in Paperclip's secret store happens transparently when the cache key's secret refs change.
- Idempotency keys on mutation tools are best-effort (in-memory, 30-min TTL, 1000-entry LRU). Worker restart wipes the cache. Google APIs don't support native idempotency keys, so this is the closest practical implementation.

## Migration / future work

- **In-app OAuth consent flow.** The current setup requires running the CLI helper. A v0.2 follow-up could add a Paperclip-core route that hosts the OAuth callback so the consent dance can happen inside the settings page. Pending core SDK work (plugin-owned HTTP routes).
- **Service-account flow.** Useful for Workspace shared inboxes (no per-user consent). Deferred to v0.2 — refresh-token works for shared inboxes too, just less elegant.
- **Audit logging of `[ECOMPANY_NOT_ALLOWED]` rejections.** Currently logged at warn level only; could write `activity_log` entries when the SDK exposes that helper.

## Versioning

- `0.1.0` — initial release: Calendar, Tasks, Sheets, Drive, Auth.
