# insurance-portals

Paperclip plugin that signs in to insurance carrier customer portals and saves the current policy and declarations-page PDFs to a Google Drive folder. **Read-only**: it never pays, changes a policy or submits anything.

Carriers: **Foremost**, **Liberty Mutual**, **Selective**.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.1.0**: First release. One agent tool, `insurance_fetch_documents`. Portal credentials, the code mailbox app password and the Google Drive OAuth secrets are all plugin secrets; agents never see them or the login codes.

## Agent tool

| Tool | What it does |
|---|---|
| `insurance_fetch_documents` | Signs in to one carrier portal, finds the current policy and declarations-page PDFs, and saves them to a Drive folder. Returns file names and Drive links. Up to 5 minutes (host maximum). |

Parameters:

| Name | Type | Notes |
|---|---|---|
| `carrier` | `"foremost" \| "liberty_mutual" \| "selective"` | Which portal. |
| `destination` | string | Drive folder path under My Drive, e.g. `Insurance/Liberty Mutual/2026`. Missing folders are created. `..` is refused. |

Result `data`: `{ carrier, destination, files: [{ name, id, link, status: "saved" \| "already_saved" }], pagesVisited, blockedWriteRequests, notes, seconds }`.

Files are named `<Carrier> - <document label> - <YYYY-MM-DD>.pdf`. A file already in the folder with the same bytes is skipped; a different file with the same name is saved alongside as `... (2).pdf`. Nothing in Drive is overwritten or deleted.

## How it stays read-only

1. **Click allow-list.** During sign-in it only types into the user name, password and code boxes and clicks the sign-in / "Send Email" / verify buttons. After sign-in it only follows links whose text reads like a document or a policy's own page, and never anything that mentions paying, changing, cancelling, submitting, claims, paperless, settings or signing out.
2. **Request guard.** Once signed in, every request from every tab is checked before it leaves Chrome. `PUT`, `PATCH` and `DELETE` are blocked outright; `POST`s to addresses that look like payments, changes, endorsements, claims, preferences or submissions are blocked. The count is returned as `blockedWriteRequests`.
3. **One password attempt.** The password is submitted at most once per run, so a wrong password can never lock the account by retrying.
4. **No robot-check solving.** A CAPTCHA stops the run with `[ECAPTCHA]`.

## Login codes

Liberty Mutual and Selective email a one-time code. Where the portal offers a choice (Selective's pop-up), the plugin picks **email**. It then reads the code from the configured mailbox over IMAP:

- The folder is opened with `EXAMINE` (read-only). Nothing is marked read, moved or deleted.
- It searches only for mail **from** that carrier's domains (Foremost: foremost.com, myforemostaccount.com; Liberty Mutual: libertymutual.com; Selective: selective.com, selectiveinsurance.com) and checks the sender's domain again on the envelope, so look-alikes such as `libertymutual.com.example.net` are ignored.
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
| Google OAuth client ID / client secret / refresh token | secret refs (refresh token needs Drive scope) |
| Chrome path | optional text |
| Show the browser window | boolean |
| Debug screenshots | boolean: saves a PNG per step to a temp folder named in the plugin log. Stays on the machine; can show policy details. |
| Most documents per run | 1 to 50, default 20 |

All secrets must belong to the company that calls the tool.

An operator action, `check-setup` (`POST /api/plugins/:id/actions/check-setup`), starts Chrome, reads each configured secret, signs in to the mailbox read-only and signs in to Drive. It does not sign in to any carrier.

## Error codes

| Code | Meaning |
|---|---|
| `ECOMPANY_NOT_ALLOWED` | Calling company is not in Allowed companies. |
| `EINVALID_INPUT` / `EINVALID_DESTINATION` | Bad carrier or Drive path. |
| `ECONFIG_MISSING` / `ESECRET_UNREADABLE` | A setting is blank, or its secret is missing or belongs to another company. |
| `ECHROME_NOT_FOUND` | Chrome not found. |
| `EDRIVE_AUTH` / `EDRIVE_API` | Google refused the Drive sign-in, or a Drive call failed. Checked **before** signing in to the carrier. |
| `ELOGIN_REJECTED` | The portal refused the user name or password. Not retried. |
| `ECODE_TIMEOUT` / `ECODE_REJECTED` / `EMAIL_AUTH_FAILED` | No code email within about 2 minutes, the portal refused the code, or the mailbox sign-in failed. |
| `ECAPTCHA` | The portal showed a robot check. |
| `ELOGIN_TIMEOUT` | Sign-in did not finish in time. |

## Limits

- Portals change. Sign-in steps were checked against each carrier's current login page. Finding documents after sign-in uses link-text rules and may need tuning per carrier once run against a real account; **Debug screenshots** exist for that.
- A run must finish inside the host's 5-minute tool limit, including the wait for the code email.
- One run at a time per Paperclip instance.

## Tests

```sh
pnpm test
```

Runs the rule tests, a fake IMAP server test of the mailbox limits, a fake Drive test, and end-to-end runs in real Chrome against a local fake portal (skipped when Chrome is not installed).
