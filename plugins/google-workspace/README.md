# google-workspace plugin

Calendar, Tasks, Sheets, and Drive operations exposed as Paperclip agent tools. Multi-account, per-company isolation, OAuth-driven.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab — including the in-browser **Connect a Google account** wizard that walks the entire OAuth flow with no terminal needed. This README is an overview of capabilities and a reference for tool/event shapes.

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

### Recommended: use the in-Paperclip setup wizard

The plugin ships a UI-driven setup wizard at:

```
/<company>/plugins/google-workspace/setup-account
```

(Any company in the URL works — the wizard is for adding instance-level accounts; pick whichever company URL you happen to be on.)

The wizard handles steps 2–4 below for you: it runs Google's OAuth device flow, creates the 3 secrets in the company you pick, and registers the account on the plugin. You only need to do **step 1** (creating the OAuth client in Google Cloud) yourself, because that's on Google's side, not Paperclip's.

### 1. Create a Google Cloud OAuth client

Once per Google account family (your personal, an LLC's, etc.). One OAuth client can grant any number of accounts under it.

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Pick (or create) a project. The project doesn't have to match your Workspace org — it just owns the OAuth client.
3. **Enable APIs** (APIs & Services → Library): Calendar API, Tasks API, Sheets API, Drive API.
4. **Configure OAuth consent screen** — pick "External" (unless you're using a Google Workspace and want "Internal"). Add your email under "Test users" while the app is in test mode. The plugin doesn't need verification because each operator only authorizes their own accounts.
5. **Create OAuth 2.0 Client ID**:
   - Application type: **TVs and Limited Input devices** if you'll use the in-Paperclip wizard (recommended). This is required for the device flow that the wizard runs.
   - **Desktop app** if you'll use the CLI helper as a fallback (loopback redirect, redirect URI doesn't need to be allowlisted).
6. Note the resulting **Client ID** and **Client Secret**. These are the only things you'll paste — the wizard takes care of everything else.

### 2. Run the wizard

Open `/<company>/plugins/google-workspace/setup-account` in Paperclip. Steps:

1. Pick an **account identifier** (e.g. `personal`, `acme-print`) — this is the short ID agents pass as the `account` param.
2. Paste the **Client ID** and **Client Secret** from step 1.
3. Pick the **owner company** — where the 3 secrets get stored.
4. Tick the **allowed companies** — which companies' agents may use this account.
5. Click **"Connect Google account"**. The wizard:
   - Calls Google's device-flow endpoint, displays a short user code and a verification URL.
   - You open the URL on any device (this browser tab, your phone, doesn't matter), enter the code, and grant access as the Google account you want this account to act as.
   - The wizard polls Google until you grant, then exchanges the code for a refresh token.
   - Creates the 3 secrets in the owner company (named `google-<key>-client-id`, `google-<key>-client-secret`, `google-<key>-refresh-token`).
   - Adds the account entry on the plugin's instance config with the secret UUIDs filled in.

After the wizard finishes, the read-only tools (`gcal_list_events`, `gtasks_list_lists`, etc.) work immediately. Flip **"Allow create/update/delete tools"** on at the top of `/instance/settings/plugins/google-workspace` when you want mutation tools active.

### Fallback: CLI helper

If the device flow doesn't fit (e.g. headless setup, scripting), the original CLI helper still works for OAuth Desktop clients:

```bash
cd /path/to/paperclip-extensions/plugins/google-workspace
GOOGLE_CLIENT_ID="…" GOOGLE_CLIENT_SECRET="…" pnpm grant <account-key>
```

It opens a localhost listener, runs the OAuth consent in your browser, and prints the refresh token with copy-paste instructions for creating the 3 secrets manually on the Secrets page and pasting the UUIDs into the plugin settings page.

### (Optional) Tighten scopes

The plugin defaults to:

- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/tasks`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/drive` (full Drive — chosen so `document-filing` skills can write into existing personal folders without the share-the-folder dance that `drive.file` would require)
- `https://www.googleapis.com/auth/userinfo.email` and `userinfo.profile` (for `google_test_auth`)

If you don't need Drive, set `scopes` on the account to a narrower list and re-run the grant script with `GOOGLE_SCOPES="space,separated,scope,urls"` to obtain a fresh refresh token bound to those scopes. The new refresh token replaces the old one — update the secret value.

## Sample tool calls

All examples assume `account: "personal"` is configured.

### Calendar — list events for the next 24 hours

```json
{
  "tool": "gcal_list_events",
  "params": {
    "account": "personal",
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
    "account": "personal",
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
    "account": "personal",
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
    "account": "personal",
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
    "account": "personal",
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
    "account": "personal",
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
    "account": "personal",
    "query": "name contains 'invoice' and mimeType = 'application/pdf'"
  }
}
```

### Drive — upload from local path

```json
{
  "tool": "gdrive_upload_file",
  "params": {
    "account": "personal",
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
