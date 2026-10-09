# insurance-portals

Paperclip plugin that signs in to insurance carrier customer portals and saves the current policy and declarations-page PDFs to Google Drive, either through the Google Drive for desktop folder on this computer or through the Drive API. **Read-only**: it never pays, changes a policy or submits anything.

Carriers: **Foremost**, **Liberty Mutual**, **Selective**.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.6.0**: Prepared for Liberty Mutual and Selective from their sign-in pages and public help, with a full rehearsal of each in tests.
  - Policy numbers with letters and dashes ("H37-291-123456-40") are recognised; phone numbers, dates and card endings are not policy numbers.
  - A code sent by text by default is switched to email through "Try another method" and similar; if the portal offers no way to switch, the run stops with `ECODE_BY_TEXT` explaining what to change.
  - On a page that lists documents, a dated entry counts as a document even without a PDF mark ("Policy Change Confirmation 03/12/2026"); bills, statements, payments and entries that start with an action are excluded.
  - Plain boxes that act as buttons (pointer cursor and a click handler, as on Selective) are clickable, count toward "signed in", and are followed.
  - A code step shown over the sign-in form (Selective's pop-up) is handled; the button after the code boxes ("Next") is pressed, never the form's "Log In".
  - Entries named by a policy number are followed to that policy's page; a click that changes the page's content without changing its address is read.
- **v0.5.3**: A run where every document was already saved no longer says it "found no policy or declarations PDFs". Seen on a repeat Foremost run: all 11 documents recognised as already saved, nothing downloaded again.
- **v0.5.2**: The "Stopped early to stay inside the 5-minute tool limit" note now appears only when the time limit actually cut work short. On the real Foremost run all 11 listed documents across 4 policies were fetched, yet the note appeared because the run finished close to the limit.
- **v0.5.1**: Foremost shows every policy's documents at the same web address (the chosen policy is kept inside the page, not in the address). Pages and buttons already handled are now tracked per policy, not per address, so policies 2 onward are no longer skipped as "already read"; reaching another policy is judged by the page content changing, and a page that mentions a different policy but not the one wanted is skipped rather than saved under the wrong name. Reproduced with a test that fails on 0.4.3 exactly as the real run did.
- **v0.5.0**: A review of everything seen on the real Foremost account plus the Liberty Mutual and Selective sign-in pages, fixing each thing that could stop a run rather than only the first failure.
  - Policy to policy without the browser's Back: for each policy the run tries the policy's own documents button, then the **Policies** menu in the page header, then the home page again, then the general documents picker. Bill, payment, autopay and claim entries are never chosen even though they name the policy too.
  - A click that something floats over (a "Chat Support" button, a banner) goes to the intended element directly; pages are no longer scrolled sideways.
  - After sign-in, pop-ups asking to go paperless, set up autopay, confirm contact details and similar are declined ("Not now", "Skip", "No thanks", "Close"); a cookie banner is rejected. Nothing that enrolls, accepts or saves is ever clicked.
  - A sign-out button only counts as "signed in" once the run has left the sign-in site (Liberty Mutual's sign-in page shows a "Log out" button).
  - The label of a typing box ("Username/email") is no longer mistaken for the "send code by email" choice.
  - Several code boxes (Selective shows four) are filled according to how many characters each accepts.
  - With Debug screenshots on, `nav-log.json` records each step between policies, and an unreachable policy leaves a screenshot and the page's link list.
- **v0.4.3**: PDFs that open in Chrome's viewer are taken as they arrive (at the response stage) instead of being requested a second time; on Foremost each PDF takes the portal about 11 seconds to build, so this halves the time per document. A policy's documents button is also found by its policy number when its wording differs, and when per-policy buttons cannot be found after stepping back, the general "View policy documents" picker is used for the remaining policies. A missing button leaves a screenshot and the page's link list in the debug folder.
- **v0.4.2**: From the first real Foremost save. The whole document is read for the policy period (up to 40 pages; Foremost's declarations page is deep in the renewal packet) and Foremost's layout is recognised: the two dates side by side followed by "12:01 A.M.". Only a pair 150 to 400 days apart counts as a term. After stepping back, the next button is waited for (up to 20 seconds) instead of being given up on, which had stopped the run after the first policy. Documents already saved under a name with term dates (same policy, document and posted date) are not downloaded again, so an interrupted run resumes and monthly runs fetch only new documents; they still appear in the result as `already_saved` with their term and current/prior. PDFs sent as downloads (`application/octet-stream`, `Content-Disposition: ...pdf`) are recognised. With Debug screenshots on, `pdf-capture-log.json` records how each PDF arrived and how long it took.
- **v0.4.1**: Faster on Foremost. A button that lands on another page has that page read immediately and the run steps back with the browser's Back (reloading only if Back loses the page), instead of reloading the starting page after every click. When a page has per-policy "documents" buttons, the general one (Foremost's policy picker) is skipped, and policies already read are not read again. On the real account the previous version spent its time reloading and ran out of time on the first policy's list.
- **v0.4.0**: Every term, not just the current one. All documents the portal lists are fetched; each PDF's policy period is read from its own text (pdf.js, bundled, pure JavaScript) and the file is named `<Carrier> - <address> - Policy <number> - Term <from> to <to> - <document> (posted <date>)`. Documents without a printed period (endorsements, notices) take the term their posted date falls in. Each file in the result carries `policy`, `term`, `posted` and `current` (true for the term covering today, else the latest). New per-call parameter `terms` (`all` | `current`) and setting **Terms to fetch by default** (default `all`) for monthly current-only runs. The fetch date is no longer part of the file name.
- **v0.3.2**: Tuned on the real Foremost account. A "Policy documents" button (one per policy) is treated as the way to a list, not as a document, and every one on a page is followed. Entries the portal marks as PDFs (a PDF icon) count as documents even when named only "RENEWAL 05/14/2026". From each policy's list only the current term is kept: the newest renewal / new-business / declarations document and anything posted after it. Files are named by the street address and policy number shown on the portal, with dates as YYYY-MM-DD. A link that opens a page instead of a PDF is read as a page after 5 seconds instead of 15. Blocked requests are listed (method and address, no query) in the result and the debug folder.
- **v0.3.1**: Finding documents after sign-in, tuned on the real Foremost portal. Waits for a page's main area to fill in before reading it. A button that opens a menu (Foremost's "Policies, select policy from dropdown") has each item visited; documents a click reveals (a "Documents" tab) are saved on the spot. Footer links are never used to navigate, icon names in link text ("chevron_right") are ignored, and each page's buttons are tried per page rather than once per run.
- **v0.3.0**: **Remember sign-in between runs** (on by default). Each carrier gets its own Chrome profile kept under `~/.paperclip/insurance-portals/profiles/<carrier>` (folder private to the user, never in a synced folder: one inside Google Drive, Dropbox, iCloud or OneDrive is refused). Whenever a sign-in page offers "remember this device", "trust this browser", "don't ask again" or "keep me signed in", the plugin ticks or clicks it, so later runs can skip the emailed code, and a still-valid session skips sign-in entirely. The emailed code remains the fallback. Chrome runs with a mock keychain so a background run never raises a macOS keychain prompt. New settings: **Remember sign-in between runs**, **Browser profiles folder**.
- **v0.2.4**: Foremost asks how to send a one-time code (text, call or email) and only shows its **Email me** button after Email is picked. The run now picks Email, then clicks the send button that appears ("Email me", "Send code" and similar, never text or call). If no code boxes appear within 60 seconds of choosing email, the run stops with `ECODE_STEP`.
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
| `terms` | `"all" \| "current"` | Optional. Default from settings (`all`). `current` keeps only the current term. |
| `destination` | string | Folder path under My Drive (or under **Local folder**), e.g. `Insurance/Liberty Mutual/2026`. Missing folders are created. `..` is refused. |

Result `data`: `{ carrier, destination, terms, files: [{ name, id, link, status: "saved" \| "already_saved", policy, term: { from, to } \| null, posted, current }], pagesVisited, blockedWriteRequests, blockedPaths, notes, seconds }`. For a local save, `id` is the file's path and `link` is null.

Files are named `<Carrier> - <address> - Policy <number> - Term <from> to <to> - <document> (posted <date>).pdf`; parts the portal or the PDF do not show are left out. A file already in the folder with the same bytes is skipped; a different file with the same name is saved alongside as `... (2).pdf`. Nothing in Drive is overwritten or deleted.

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

Drives the locally installed Google Chrome over the DevTools pipe (`--remote-debugging-pipe`), with no Playwright or Puppeteer and no bundled browser. With **Remember sign-in between runs** on (the default), each carrier has its own kept profile under `~/.paperclip/insurance-portals/profiles/<carrier>` holding its cookies and "remembered device" marks; the folder is created private (0700) and a stale lock left by a crashed Chrome is cleared before launch. With it off, each run uses a throwaway profile deleted afterwards. To make a carrier forget this computer, delete its profile folder. Chrome runs invisibly unless **Show the browser window** is on. The only disguise is dropping "Headless" from the browser's user-agent string.

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
| Remember sign-in between runs | boolean, default on |
| Browser profiles folder | optional path; blank = `~/.paperclip/insurance-portals/profiles`; synced folders refused |
| Show the browser window | boolean |
| Debug screenshots | boolean: saves a PNG per step to a temp folder named in the plugin log. Stays on the machine; can show policy details. |
| Terms to fetch by default | `all` (default) or `current` |
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
| `ECODE_STEP` | The portal asked how to send a code, but no code boxes appeared after choosing email. |
| `EPROFILE_FOLDER` | The browser profiles folder is inside a synced folder. |
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
