# google-workspace plugin

Calendar, Tasks, Docs, Sheets, and Drive operations exposed as Paperclip agent tools. Multi-account, per-company isolation, OAuth-driven.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab - including the in-browser **Connect a Google account** wizard that walks the entire OAuth flow with no terminal needed. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.3.32**: Add checked Docs edits and Drive read, rename and move tools. Existing mutation settings and host approval still apply.

- **v0.3.31** - Add exact-ID Google Docs text and heading reads, revision-protected insert/append/range replacement, bounded Drive content reads and native exports, rename and file moves with preflight version checks. All new mutations declare `actionType: change_files` for host approval policy and omit host repeat caching. Docs retries require the original revision to remain current; rename/move allow intentional repeated destinations. Keep existing tools, OAuth scopes and Desktop connection flow. No Drive delete, trash, document copies or local link-file mirrors.

- **v0.3.30** - Replaces unsupported device consent with Desktop app loopback authorization, including PKCE, state validation, expiring one-use sessions, and a private callback fallback.

- **v0.3.29** - Replace unsupported device consent with Desktop app loopback authorization, state and PKCE validation, one-use expiring sessions and a private pasted-callback fallback for remote browsers or Docker workers. Fix wizard routes and portable secret names; preserve existing config fields and keep mutations off by default.

- **v0.3.28** - Add scoped Support Desk verification of worker-host Markdown copies against an exact Drive folder, bounded downloads and disposable restore/read-back/cleanup. Counts only; no upload or in-place restore.

- Development: scoped Support Desk Markdown cloud backup verification. An exact company/account opt-in binds a local source root **on this Google worker host** and a Drive backup folder. Compares file metadata and actual downloaded contents, tests a temporary local restore, removes temporary files, and emits counts without file text, names, paths or hashes. Current configuration is rechecked throughout. No upload, in-place restore, execution or provider changes. The existing Google tools keep their prior behavior.


- **v0.3.27** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.26** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.25** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.24** - Declares a Google Calendar connector, so Paperclip's Calendar pages can show per company whether a Google account is actually hooked up and link back here to fix it. `refreshTokenRef` is marked required, so an account added before its refresh token has been fetched reads as not connected rather than passing as set up. No change to tools or behaviour.

- **v0.3.23** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.22** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.21** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.20** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.19** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.18** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.17** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.16** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.15** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.14** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.13** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.12** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.11** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.10** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.9** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.8** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.7** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.6** - Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.3.5** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.4** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.3** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.2** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

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
| `gdoc_read` | Read selected-tab body text, structured headings, paragraph indices and revision; list tabs when a choice is needed. | no |
| `gdoc_insert_text` | Insert plain text at a paragraph index with a required current revision. | yes |
| `gdoc_append_text` | Append plain text before the selected tab body's final newline with a required current revision. | yes |
| `gdoc_replace_text` | Replace one exact paragraph text range after matching its revision and expected text. | yes |
| `gdrive_read_file` | Read bounded UTF-8 text or base64 bytes by exact ID, exporting supported native formats. | no |
| `gdrive_rename_file` | Patch only a file's name, retaining its ID and parents. | yes |
| `gdrive_move_file` | Move one file from an explicitly expected parent to a validated folder in one PATCH. | yes |

Mutation tools require the **"Allow create/update/delete tools"** master switch on the plugin settings page (off by default - fresh installs are read-only).

## Setup

### Recommended: use the in-Paperclip setup wizard

The plugin ships a UI-driven setup wizard at:

```
/<company>/setup-account
```

(Any company in the URL works - the wizard is for adding instance-level accounts; pick whichever company URL you happen to be on.)

The wizard handles Google consent, secret creation and account registration for you: it runs Google's Desktop app authorization flow, creates the 3 secrets in the company you pick, and registers the account on the plugin. You only need to do **step 1** (creating the OAuth client in Google Cloud) yourself, because that's on Google's side, not Paperclip's.

### 1. Create a Google Cloud OAuth client

Once per Google account family (your personal, an LLC's, etc.). One OAuth client can grant any number of accounts under it.

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Pick (or create) a project. The project doesn't have to match your Workspace org - it just owns the OAuth client.
3. **Enable APIs** (APIs & Services, Library): Calendar API, Tasks API, Docs API, Sheets API, Drive API.
4. **Configure OAuth consent screen** - pick "External" (unless you're using a Google Workspace and want "Internal"). Add your email under "Test users" while the app is in test mode. Google may require verification for External apps using sensitive or restricted scopes. In Testing status, add each authorizing email as a test user; these grants normally expire after seven days. Internal apps are limited to their Workspace organization.
5. **Create OAuth 2.0 Client ID**:
   - Application type: **Desktop app** for both the wizard and CLI helper. The wizard chooses a random local port; Desktop clients need no redirect URI allowlist. TVs and Limited Input devices cannot request the Calendar, Tasks, Sheets and full Drive scopes used here.
6. Note the resulting **Client ID** and **Client Secret**. These are the only things you'll paste - the wizard takes care of everything else.

### 2. Run the wizard

Open `/<company>/setup-account` in Paperclip. Steps:

1. Pick an **account identifier** (e.g. `personal`, `acme-print`) - this is the short ID agents pass as the `account` param.
2. Paste the **Client ID** and **Client Secret** from step 1.
3. Pick the **owner company** - where the 3 secrets get stored.
4. Tick the **allowed companies** - which companies' agents may use this account.
5. Click **"Connect Google account"**. The wizard:
   - Starts a ten-minute Desktop app consent session with a random loopback port, state and PKCE (a one-use code verifier). Open **Google consent** and grant access as the Google account you want to connect.
   - If the browser and worker share a host, the callback completes automatically. If the worker is remote or in Docker and the final local page cannot be reached, copy its complete `http://127.0.0.1:<port>/oauth/callback?...` URL from the address bar into the wizard's callback field. Keep this temporary URL private; it contains the authorization code. Do not paste it into logs or messages.
   - The worker validates the original callback address and state, exchanges the code once, and returns the refresh token to the wizard. Cancel, expiry and worker shutdown remove the session and close the listener. At most eight sessions can be active.
   - Creates the 3 secrets in the owner company (named `google_<key>_client_id`, `google_<key>_client_secret`, `google_<key>_refresh_token`; account-key hyphens become underscores, so `acme-print` uses `google_acme_print_*`). Secret names must match `^[A-Za-z_][A-Za-z0-9_]*$`.
   - If any standard secret name already exists, appends a random suffix to all three new names instead of rotating old secrets that other accounts may share. The completion page shows their actual names. Reusing an account identifier replaces that account's refs, allowed companies and scope selection while preserving other account fields and instance settings.
   - Adds or reconnects the account on the plugin's instance config with the new secret UUIDs filled in.

After the wizard finishes, the read-only tools (`gcal_list_events`, `gtasks_list_lists`, etc.) work immediately. Flip **"Allow create/update/delete tools"** on at the top of `/instance/settings/plugins/google-workspace` when you want mutation tools active.

The wizard follows [Google's installed-app authorization guidance](https://developers.google.com/identity/protocols/oauth2/native-app).

### Fallback: CLI helper

For terminal setup, use the CLI helper with the same Desktop app client:

```bash
cd /path/to/paperclip-extensions/plugins/google-workspace
GOOGLE_CLIENT_ID="…" GOOGLE_CLIENT_SECRET="…" pnpm grant <account-key>
```

It opens a localhost listener, runs the OAuth consent in your browser, and prints the refresh token with copy-paste instructions for creating the 3 secrets at `/<company>/company/settings/secrets` and choosing them using **Pick from your secrets** in the plugin Configuration tab. The dropdown stores their UUID references.

### (Optional) Tighten scopes

The plugin defaults to:

- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/tasks`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/drive` (full Drive - chosen so `document-filing` skills can write into existing personal folders without the share-the-folder dance that `drive.file` would require)
- `https://www.googleapis.com/auth/userinfo.email` and `userinfo.profile` (for `google_test_auth`)

If you don't need Drive, set `scopes` on the account to a narrower list and re-run the grant script with `GOOGLE_SCOPES="space,separated,scope,urls"` to obtain a fresh refresh token bound to those scopes. The new refresh token replaces the old one - update the secret value.

## Docs and Drive content requirements

Enable the Google Docs API in the account's existing Google Cloud project before using `gdoc_*`. The existing full Drive grant authorizes Docs reads and writes; adding a `documents` scope is not required. Restricted grants still need an API-supported scope and file access: Docs reads accept `documents.readonly`, `documents`, `drive.readonly`, `drive` or `drive.file`; edits accept `documents`, `drive` or `drive.file`. `drive.file` only covers eligible app-authorized files. These tools never request extra consent, edit saved scopes or replace credentials. A forbidden response requires the operator to review API enablement, file permissions and the existing grant.

Every new tool requires a host company context and one unambiguous configured account allowed for that company. Missing or empty allowlists deny access before resolving credentials. Explicit portfolio-wide `*` retains its existing meaning. Credential references, company access and the mutation switch are rechecked throughout a call. No new UI or file store is introduced.

### Docs text and revisions

Call `gdoc_read` with the exact Drive file ID as `documentId`. If `requiresTabSelection` is true, choose a returned `tabId` and read again. Body text includes table cells and generated table-of-contents text; headings preserve their named style, heading ID and Google indices. Headers, footers, footnotes, comments and images are not rendered. Unsupported inline elements appear as an object-replacement character and increment `unsupportedElements`; their paragraphs cannot be edited through these tools. Reads request `DEFAULT_FOR_CURRENT_ACCESS` and return Google's applied `suggestionsViewMode`. Viewers receive `PREVIEW_WITHOUT_SUGGESTIONS`; hidden suggestions cannot be detected by `hasSuggestions`. Commenters and editors normally receive inline suggestions. Edits explicitly fetch `SUGGESTIONS_INLINE` and refuse visible suggestions; resolve them before editing.

Reads are capped at 2 MiB of provider JSON. The entire serialized tool result is capped at 64 KiB, including repeated paragraph/heading text, escaped characters and tab metadata. Each page includes at most 100 intersecting paragraphs and their headings. Text pages request up to 10,000 UTF-16 units by default, with a maximum of 20,000; the result budget may shorten them further. Metadata that cannot fit fails explicitly. A `nextOffset` is a returned-text offset, distinct from Google paragraph indices. Pass it as `offset` with the previous `readToken` as `requiredReadToken` and keep the same selected `tabId`. The token hashes the selected tab's full visible text and paragraph data before pagination, including indices, styles, editability, unsupported-element count and suggestion presence, plus the tab list, document ID, title, available revision and applied suggestions view, with canonical object keys. Temporary image/chart URLs and other unrendered response fields are excluded. Changed visible data or tab selection fails instead of mixing pages. It works for viewers and commenters without additional Drive scopes. Editors may continue to use the previous `revisionId` as `requiredRevisionId`. A later page may end without covering earlier text: `complete` means this page reaches the end. `paragraphs[].textStartIndex` identifies the first returned character when editable, including a clipped paragraph. Heading text can also be clipped by pagination; continue from `nextOffset` without skipping text.

All edits require editor access and `requiredRevisionId` from a fresh read. Google only returns revision IDs to editors; a read token does not grant edit access or substitute for an editor revision. A missing editor revision or forbidden pre-edit read produces an explicit edit-access error. Google enforces the revision in `writeControl.requiredRevisionId` so concurrent changes reject the entire operation. `gdoc_insert_text` takes a Google `index` inside plain paragraph text; `gdoc_append_text` targets the chosen tab's body end. `gdoc_replace_text` takes `startIndex`, exclusive `endIndex`, `expectedText` and replacement `text`. It replaces exactly one nonempty range inside one plain paragraph, excluding its final newline, with one atomic delete-and-insert request. It does not perform an unrestricted batch update, whole-document rewrite or global search-and-replace. Indices use UTF-16 units and cannot split a Unicode character. Each edit inserts 1 to 20,000 units; empty replacement text is not supported.

Inserted text inherits nearby formatting according to Google Docs rules. Markdown is plain text, not a request to create headings; existing paragraph styles remain. Formatting inside replaced text may inherit its neighbors rather than preserve each removed text run. Characters that Google would silently strip are rejected. All writes remain subject to the plugin mutation switch and the host's `change_files` approval policy. Attempts are logged before writing; a failed completion log returns a success warning so callers do not repeat a completed operation. Docs edits omit `writes: true` and bypass host repeat caching while retaining `actionType: change_files` approval. Failures before dispatch throw a sanitized RPC error; failures after dispatch return a sanitized error, including uncertain outcomes. Remote writes are never automatically retried. After any failed or uncertain write, read the remote document before deciding to retry. If the cause is fixed and the original revision is unchanged, identical arguments can be submitted again. If a write succeeded but its response was lost, the changed revision refuses those arguments without a second edit; Google's atomic required-revision check also refuses a stale revision if preflight reads race. A repeat after confirmed success is refused rather than replaying a cached success. Do not substitute a newer revision merely to repeat an uncertain edit; inspect the text and decide whether any edit remains necessary.

### Drive content and file moves

`gdrive_read_file` reads the exact `fileId`, checks download capability and verifies the same file version before and after downloading. Ordinary files use `files.get` with `alt=media`; supported Google-native files use `files.export`. It never follows shortcuts, local `.gdoc` files or provider download redirects. The default `maxBytes` is 32 KiB, enforced on streamed bytes even without a reliable Content-Length. Callers may explicitly choose 1 through 1,048,576 bytes (1 MiB). Base64 expands the bytes, so the default binary result is about 44 KiB and an explicit maximum read can return about 1.4 MiB of JSON. Larger content fails without returning partial data. Each provider read is limited to ten seconds, within a 25-second call budget; host calls and an underlying OAuth refresh may finish later, but cannot dispatch a file request after that budget expires.

Text must be valid UTF-8 and is paginated with `offset`, `maxChars`, `nextOffset` and `requiredVersion`, using the same 10,000 default and 20,000 maximum UTF-16 page sizes. Binary files return a whole bounded base64 `content` string; they do not use text pagination. Native export choices:

| Native type | Supported exports | Default |
|---|---|---|
| Google Docs | `text/plain`, `text/markdown`, `application/pdf` | `text/plain` |
| Google Sheets | `text/csv`, `text/tab-separated-values`, `application/pdf` | Explicit choice required |
| Google Slides | `text/plain`, `application/pdf` | `text/plain` |
| Google Drawings | `image/png`, `image/svg+xml`, `application/pdf` | Explicit choice required |

CSV and TSV export only the first sheet, explicitly labeled in the result. Use the existing `gsheet_read` tool for a particular sheet and range, or `gdoc_read` for structured headings. Other native formats fail explicitly. PDF, PNG and other binary formats are bytes, not extracted text. These bounded exports do not create or store another Drive document.

`gdrive_rename_file` patches only `name`. `gdrive_move_file` requires `expectedParentId` and `destinationFolderId`; the current parent must match the expected source and the destination must be an existing untrashed folder. It refuses parentless files, multiple parents and folder-tree moves. One PATCH adds the destination while removing only the expected source; an already-arrived file returns `unchanged`. The original file ID remains unchanged. Both tools recheck the file version immediately before the PATCH and refuse a changed or missing version. Google's Drive v3 metadata-update reference does not document an `If-Match` contract, so these tools do not send that header or claim server-enforced race protection. A concurrent change between the last GET and PATCH can still be overwritten or alter the move outcome. These destination-setting tools retain `actionType: change_files` approval but omit host repeat caching so rename A, rename B, rename A and move out, back, out each execute. After an uncertain response, read the exact file before deciding to retry. Moving a file can change inherited folder access. There is no Drive delete or trash tool; archival remains an operator-controlled move workflow.

Primary API references: [Docs get and authorization scopes](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get), [Docs revision control](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate), [text requests, UTF-16 indices and formatting](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request), [Drive downloads and exports](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats), [Drive metadata patches](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update) and [moving files between folders](https://developers.google.com/workspace/drive/api/guides/folder).

## Official Google Workspace MCP evaluation (2026-10-18)

The [May 1 announcement](https://workspaceupdates.googleblog.com/2026/05/agent-tools-and-security-updates-for-workspace-developers.html) introduced the public preview. Current primary references list [Docs](https://developers.google.com/workspace/docs/api/reference/mcp) and [Sheets](https://developers.google.com/workspace/sheets/api/reference/mcp) servers in addition to [Drive](https://developers.google.com/workspace/drive/api/reference/mcp). The earlier product list is no longer complete.

Unauthenticated `tools/list` requests to all three public `/mcp/v1` endpoints returned HTTP 200 on this date. Docs advertised `read_doc` and `update_doc`; Sheets advertised six tools for values, formulas, spreadsheet metadata/updates and dimension insertion. Drive advertised eight tools, including `read_file_content` and `download_file_content`, with no rename or move tool. Discovery is not an account connection or file-access test. Google's [Drive content reference](https://developers.google.com/workspace/drive/api/reference/mcp/tools_list/read_file_content) says its natural-language output may be incomplete for large files and can change format; it is not a stable structured-heading contract.

No authenticated account-specific MCP test was run. Missing access: confirmed [Developer Preview Program](https://developers.google.com/workspace/preview) membership for a designated test account and Cloud project, enabled product/MCP services, a separate OAuth client configured for AI-agent use, consent and an authorized synthetic test file. The [setup guide](https://developers.google.com/workspace/guides/configure-mcp-servers) supports External consent configuration, but that alone does not establish consumer-account preview eligibility. Consumer compatibility and this operator's file access remain unverified. No live credentials were inspected, permissions broadened or External MCP server registered.

The plugin additions address only confirmed gaps in this plugin while preserving the existing connection and Sheets/Drive tools. Once an operator can test the official service, evaluate it through a separately approved External MCP connection, initially with read-only synthetic fixtures. Do not reuse or replace this plugin's OAuth client automatically. Any live integration or write acceptance remains separate from the mocked API and isolated-host verification here.

## Focused verification

From `plugins/google-workspace`, run `pnpm test`, `pnpm typecheck`, `pnpm build`, then `pnpm test:worker`. Dependencies can be installed with `pnpm install --frozen-lockfile --ignore-scripts`; no SDK repack or lockfile update is needed.

Tests use fake credentials and synthetic API data. They cover company/account denial before credentials, account cache separation and revocation, exact HTTP URLs/methods/bodies, viewer/commenter pagination, applied suggestion views, snapshot and revision guards, complete serialized response budgets, giant paragraphs, formatting boundaries, native exports and binary handling, streamed read limits, redacted failures, audit failures, pre-send retry versus uncertain post-send repeat protection, repeated rename/move sequences, preflight version checks, existing Sheets/Drive regression, and loopback HTTP dispatch. The built-worker check uses an isolated synthetic RPC host, denies network access and verifies registration, health, company denial and pre-send RPC error propagation with mutations disabled. Neither test is live Google account acceptance or proof of the full host approval UI.

Operator acceptance still requires the intended account's connection, API enablement and a separately authorized synthetic file: read headings/tabs, edit with a current revision, verify stale-revision rejection, rename without changing ID, then move between disposable test folders and verify parents and effective access. Perform no live mutation without that separate authorization.

## Sample tool calls

All examples assume `account: "personal"` is configured.

### Calendar - list events for the next 24 hours

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

### Calendar - create an event

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

### Tasks - list tasks in a list

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

### Tasks - create a task

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

### Sheets - read a range

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

### Sheets - append a row

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

### Drive - search

```json
{
  "tool": "gdrive_search",
  "params": {
    "account": "personal",
    "query": "name contains 'invoice' and mimeType = 'application/pdf'"
  }
}
```

### Drive - upload from local path

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
- OAuth tokens auto-refresh - `google-auth-library` handles the access-token round-trip. Only the long-lived refresh token is stored in Paperclip secrets.
- An OAuth2 client is cached per `(companyId, accountKey)` tuple. Re-resolving secrets after they change in Paperclip's secret store happens transparently when the cache key's secret refs change.
- Idempotency keys on mutation tools are best-effort (in-memory, 30-min TTL, 1000-entry LRU). Worker restart wipes the cache. Google APIs don't support native idempotency keys, so this is the closest practical implementation.

## Migration / future work

- **Hosted callback option.** The wizard currently uses a worker loopback listener with a private paste fallback for remote browsers. A future host-owned HTTPS callback could remove that manual step.
- **Service-account flow.** Useful for Workspace shared inboxes (no per-user consent). Deferred to v0.2 - refresh-token works for shared inboxes too, just less elegant.
- **Audit logging of `[ECOMPANY_NOT_ALLOWED]` rejections.** Currently logged at warn level only; could write `activity_log` entries when the SDK exposes that helper.

## Versioning

- `0.1.0` - initial release: Calendar, Tasks, Sheets, Drive, Auth.

## Support Desk backup verification

1. Connect Google OAuth normally, allowing the exact company (portfolio-wide `*` alone does not enable this check).
2. Under that account's **Support Desk backup verification**, save a profile key, exact company, exact Drive folder ID and absolute Markdown source folder **on this worker host**. Enable the profile. No workstation path or company path is included in this plugin's shipped defaults.
3. In Support Desk's company directory, save a specialist connection with plugin key `google-workspace`, this Google account key, and area `automations`.
4. In Clippy request `support_check_specialist` using that directory record, `operation: backup_verify`, `resourceId: <saved-profile-key>`. Read the returned receipt with `support_get_specialist_observation`.

Only `matched_and_restore_tested` means every supported observed source file matched cloud metadata, downloaded bytes and the temporary restore. Empty, partial, missing, different, extra, ambiguous or unavailable trees return `needs_review`; access/configuration/source-change failures return an unavailable receipt. Bounds: 50 Markdown files, 1 MiB each, 8 MiB total source, five nested levels, 30 directories, 500 local entries and 200 cloud entries, 45-second overall budget and at most 10 seconds per provider read. Larger trees require separate bounded profiles; a paginated listing is explicitly incomplete. Shortcuts and Google-native documents are not ordinary Markdown backups.

This is a present-time verification of worker-host files. It does not establish historical retention, an atomic Drive snapshot or an automatic sync schedule. It does not upload or restore to the live source. Configure a trusted worker OS account and private temporary directory; downloaded test files may contain sensitive company contents and stay internal until cleanup. Local filesystem administrators are trusted; this is not a sandbox against a malicious host administrator. A persistent restore/upload requires a separately reviewed write workflow.

Provider reference: [Drive file metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) and [download blobs with files.get](https://developers.google.com/workspace/drive/api/guides/manage-downloads).
