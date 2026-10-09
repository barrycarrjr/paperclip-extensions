# insurance-portals

Paperclip plugin that signs in to insurance carrier customer portals and saves the current policy and declarations-page PDFs to Google Drive, either through the Google Drive for desktop folder on this computer or through the Drive API. **Read-only**: it never pays, changes a policy or submits anything.

Carriers: **Foremost**, **Liberty Mutual**, **Selective**.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.2.3**: After the password, sign-in is only treated as finished once any loading spinner or dimmed "please wait" screen has cleared and the page has real content (a sign-out control, or several links outside the footer). Fixes Foremost, where the run declared itself signed in under the loading screen and found no documents. Each page also waits (up to 45 seconds) for its loading screen before links are read. A loading screen still up 90 seconds after the password stops the run with `ELOGIN_STUCK`. Site matching now ignores port numbers.
- **v0.2.2**: Sign-in now waits (up to 20 seconds after the user name, 30 after the password) for the page to actually change before deciding what to do next. Fixes Foremost, where the password box appears a few seconds after Continue on the same page and the run gave up with `ELOGIN_REJECTED ... kept asking for the user name`. A failed run now always saves `99-failed.png` and a note of which boxes were on screen (never their contents), and the error names the screenshot folder when Debug screenshots is on.
- **v0.2.1**: Operator lane for running without an agent: `start-fetch` (params `carrier`, `destination`; company from the request) starts a run in the background and returns a `jobId`; `fetch-status` (`jobId`) returns its state and result. Needed because plugin actions are cut off after 30 seconds. Board-only and gated by Allowed companies like the tool. The result now includes `debugDir` when Debug screenshots is on.
- **v0.2.0**: New **Save to** setting (`auto` / `local` / `google-drive`) and **Local folder**. `auto` (the default) saves into a folder on this computer whenever the three Google fields are empty; with **Local folder** blank it finds the Google Drive for desktop "My Drive" folder by itself (only when exactly one account is signed in), so files sync to Drive with no Google keys. Same rules as Drive: folders created as needed, identical files skipped, nothing overwritten or deleted, and nothing written outside the folder (links that point outside are refused). Author changed to Bryon Stout.
- **v0.1.0**: First release. One agent tool, `insurance_fetch_documents`. Portal credentials, the code mailbox app password and the Google Drive OAuth secrets are all plugin secrets; agents never see them or the login codes.

## Agent tool

| Tool | What it does |
|---|---|
| `insurance_fetch_documents` | Signs in to one carrier portal, finds the current policy and declarations-page PDFs, and saves them to a Drive folder (local Drive for desktop folder or Drive API). Returns file names and Drive links. Up to 5 minutes (host maximum). |

Parameters:

| Name | Type | Notes |
|---|---|---|
| `carrier` | `"foremost" \| "liberty_mutual" \| "selective"` | Which portal. |
| `destination` | string | Folder path under My Drive (or under **Local folder**), e.g. `Insurance/Liberty Mutual/2026`. Missing folders are created. `..` is refused. |

Result `data`: `{ carrier, destination, files: [{ name, id, link, status: "saved" \| "already_saved" }], pagesVisited, blockedWriteRequests, notes, seconds }`. For a local save, `id` is the file's path and `link` is null.

Files are named `<Carrier> - <document label> - <YYYY-MM-DD>.pdf`. A file already in the folder with the same bytes is skipped; a different file with the same name is saved alongside as `... (2).pdf`. Nothing in Drive is overwritten or deleted.

## How it stays read-only

1. **Click allow-list.** During sign-in it only types into the user name, password and code boxes and clicks the sign-in / "Send Email" / verify buttons. After sign-in it only follows links whose text reads like a document or a policy's own page, and never anything that mentions paying, changing, cancelling, submitting, claims, paperless, settings or signing out.
2. **Request guard.** Once signed in, every request from every tab is checked before it leaves Chrome. `PUT`, `PATCH` and `DELETE` are blocked outright; `POST`s to addresses that look like payments, changes, endorsements, claims, preferences or submissions are blocked. The count is returned as `blockedWriteRequests`.
3. **One password attempt.** The password is submitted at most once per run, so a wrong password can never lock the account by retrying.
4. **No robot-check solving.** A CAPTCHA stops the run with `[ECAPTCHA]`.

## Login codes

Liberty Mutual and Selective email a one-time code. Where the portal offers a choice (Selective's pop-up), the plugin picks **email**. It then reads the code from the configured mailbox over IMAP:

- The folder is opened with `EXAMINE` (read-only). Nothing is marked read, moved or deleted.
- It searches only for mail **from** that carrier's domains (Foremost: foremost.com, e.g. policy.foremost.com; Liberty Mutual: libertymutual.com, e.g. DoNotReply@libertymutual.com; Selective: selective.com, e.g. AccountVerification@underwritingalerts.selective.com). It checks the sender's domain again on the envelope: the domain must be exactly the carrier's domain or end in `.` plus it, so look-alikes such as `underwritingalerts.selective.com.example.net` or `notselective.com` are ignored.
- It downloads the body of exactly **one** message: the newest from that carrier that arrived after the code was requested. Older codes are never used.
- The code goes straight into the portal. It is not logged and not returned to the agent.

Why the plugin holds its own mailbox and Drive secrets: Paperclip plugins cannot call each other's tools, so this plugin cannot borrow Email Tools or Google Workspace at run time. It can point at the **same secrets** those plugins use (the Gmail app password; the Google OAuth client ID, client secret and refresh token).

## Browser

Drives the locally installed Google Chrome over the DevTools pipe (`--remote-debugging-pipe`), with no Playwright or Puppeteer and no bundled browser. Each run uses a fresh, throwaway profile that is deleted afterwards. Chrome runs invisibly unless **Show the browser window** is on. The only disguise is dropping "Headless" from the browser's user-agent string.

## Configuration

| Field | Kind |
|---|---|
| Allowed companies | company picker (empty = nobody) |
| Foremost / Liberty Mutual / Selective user name and password (6 fields) | secret refs |
| Code mailbox address | text |
| Code mailbox app password | secret ref |
| Code mailbox IMAP host / folder | text (`imap.gmail.com` / `INBOX`) |
| Google OAuth client ID / client secret / refresh token | secret refs (refresh token needs Drive scope); only needed for Drive API saving |
| Save to | `auto` (default: Drive API if all three Google fields are set, else local folder), `local`, `google-drive` |
| Local folder | optional path; blank = the Google Drive for desktop "My Drive" folder, found automatically. `~` = home folder |
| Chrome path | optional text |
| Show the browser window | boolean |
| Debug screenshots | boolean: saves a PNG per step to a temp folder named in the plugin log. Stays on the machine; can show policy details. |
| Most documents per run | 1 to 50, default 20 |

All secrets must belong to the company that calls the tool.

Operator actions `start-fetch` / `fetch-status` run the same fetch without an agent (see Recent changes). An operator action, `check-setup` (`POST /api/plugins/:id/actions/check-setup`), starts Chrome, reads each configured secret, signs in to the mailbox read-only, and opens the save location (local folder, or a Drive sign-in). It does not sign in to any carrier.

## Error codes

| Code | Meaning |
|---|---|
| `ECOMPANY_NOT_ALLOWED` | Calling company is not in Allowed companies. |
| `EINVALID_INPUT` / `EINVALID_DESTINATION` | Bad carrier or Drive path. |
| `ECONFIG_MISSING` / `ESECRET_UNREADABLE` | A setting is blank, or its secret is missing or belongs to another company. |
| `ECHROME_NOT_FOUND` | Chrome not found. |
| `EDRIVE_AUTH` / `EDRIVE_API` | Google refused the Drive sign-in, or a Drive call failed. Checked **before** signing in to the carrier. |
| `ELOCAL_ROOT` / `ELOCAL_WRITE` | The local folder is missing or not found automatically, or a file could not be written. Checked **before** signing in to the carrier. |
| `ELOGIN_REJECTED` | The portal refused the user name or password. Not retried. |
| `ECODE_TIMEOUT` / `ECODE_REJECTED` / `EMAIL_AUTH_FAILED` | No code email within about 2 minutes, the portal refused the code, or the mailbox sign-in failed. |
| `ECAPTCHA` | The portal showed a robot check. |
| `ELOGIN_TIMEOUT` | Sign-in did not finish in time. |
| `ELOGIN_STUCK` | The portal's loading screen was still up 90 seconds after the password was sent. |

## Limits

- Portals change. Sign-in steps were checked against each carrier's current login page. Finding documents after sign-in uses link-text rules and may need tuning per carrier once run against a real account; **Debug screenshots** exist for that.
- A run must finish inside the host's 5-minute tool limit, including the wait for the code email.
- One run at a time per Paperclip instance.

## Tests

```sh
pnpm test
```

Runs the rule tests, a fake IMAP server test of the mailbox limits, a fake Drive test, and end-to-end runs in real Chrome against a local fake portal (skipped when Chrome is not installed).
