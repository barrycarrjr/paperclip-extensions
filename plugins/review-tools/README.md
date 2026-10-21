# review-tools plugin

Multi-platform customer review management and response suite for a portfolio. Supports Google Business Profile (with expansion architecture for additional review APIs such as Trustpilot, Yelp, Facebook, and App Store). Detects incoming review notifications, creates Paperclip issues with suggested replies, posts approved replies back via review provider APIs, and surfaces a unified review dashboard. Multi-account, per-company isolation, OAuth-driven.

> **Setup walkthrough** also lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/job/error shapes.

## Recent changes

- **v0.2.0**: Connecting Google works from inside the app, and a failure now
  says which thing is wrong.

  The plugin had been unable to read a single review since 2026-10-06. Two
  separate faults, and neither was visible in the settings.

  First, the refresh token. It is held in three secrets that this plugin
  shared with the google-workspace plugin, so when that plugin was
  reconnected on 2026-10-19 the shared token was replaced with one granted
  for Google Calendar. A Calendar token authenticates perfectly here and can
  read nothing, so the daily sync went on reporting success while fetching
  no reviews at all, and the email poll failed 202 times in a row with
  "Request had insufficient authentication scopes". This version gives the
  plugin its own secrets, named for it, so reconnecting another Google
  plugin can no longer log this one out.

  Second, the location. Its Google account id and location id were both set
  to the same number, which cannot be right: they are different ids. Every
  call for that location would have failed even with a good token. There was
  no way to discover the right values, because the script that lists
  accounts called a v4 path Google answers with a 404 HTML page. Account
  listing moved to the Account Management API and location listing to the
  Business Information API; both are now used, and the new page lists the
  locations so the two ids are picked rather than typed.

  New **Google connection** page (route `reviews-setup`), per company:
  it asks Google what the stored token can actually do rather than reporting
  what the settings say, runs the consent flow in the browser with a
  loopback callback, refuses to save a grant that is missing permission to
  manage business listings, and lists the real locations to choose from. It
  also points out a location whose two ids are identical.

  Error messages now separate the three refusals that all arrive as an HTTP
  403 and all used to read the same: a token missing a permission
  (`EAUTH_SCOPE`), an API not switched on in the Google Cloud project
  (`EGBP_API_DISABLED`), and no approved quota (`EGBP_QUOTA`, which for this
  API usually means the access request has not been granted). A refused
  token refresh says whether Google rejected the refresh token
  (`EAUTH_INVALID_GRANT`) or the client credentials (`EAUTH_CLIENT`),
  instead of the bare word "invalid_grant".

  Email polling: the job tried to mark each notification read, which needs a
  write permission the plugin does not ask for and should not have, so it
  failed silently every time and every message stayed unread and was
  re-fetched for ever. It no longer depends on that, and a first run is
  limited to the last seven days so switching polling on cannot open a task
  for every review notification in the mailbox's history.

  Still to do, and it needs a person: someone has to run the consent once
  on the new page. Nothing here can grant Google access on their behalf.

- **v0.1.15**: Patch bump for the cross-plugin release so Plugin Manager offers the current build. No additional functional changes.

- **v0.1.14** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.
  near-white background while the name inherited the theme's text colour, so
  under the dark theme the name was near-white on near-white. The cards now use
  the host's `--card` surface, and the "needs attention" variant tints that
  surface with amber instead of replacing it.

- **v0.1.12** - Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.11**: Fixes a blank Reviews page. The whole page failed to load in
  v0.1.10 and showed a dashed placeholder instead.

  Paperclip does not give a plugin's browser code the real React. It swaps
  every `import ... from "react"` for a small stand-in that hands back a fixed
  list of React names. The reply editor added in v0.1.10 asked that stand-in
  for `useReducer`, which is not on the list. A browser checks those names
  before it runs any of the file, so the one missing name stopped the entire
  page from starting, not just the reply box, and nothing was left to register
  the page with the host. v0.1.9 asked React for nothing and was unaffected.

  The editor now keeps the same state in `useState` and calls the same
  `reduceEditor` function through a small wrapper, so nothing about how the
  reply box behaves has changed. A new test reads the imports in every source
  file, and in the built bundle when one is present, and fails if any of them
  asks for a name the stand-in does not hand back.

- **v0.1.10**: People can reply to a review from the Reviews page, through one
  guarded path shared with the agent tool.

  Each location card on the Reviews page now opens that location's reviews,
  newest first with the unreplied ones on top, and each review opens a reply
  box on the right. One line above the box says exactly where the reply will
  go ("Posts as: Main St Store, using the Google account owner@example.com"),
  taken from the plugin settings and not editable on the page. "Start from
  the suggested reply" drops in the plugin's template for that star rating;
  whatever is typed is kept in the person's own browser until it is posted or
  cleared. "Post to Google" opens an inline confirm panel showing the exact
  text and the sentence "Anyone can read this on Google. Paperclip cannot
  take it down afterwards; only Google's console can." A reply already on
  Google is shown before a word is typed, and replacing it needs a second,
  separate tick with the old and new text side by side. Afterwards a short
  receipt lists what happened (checked Google, posted, recorded, task still
  open with a link), the review flips to replied, and the dashboard count
  drops. "Sync now" on each location pulls in reviews that arrived since the
  last sync, including ones that so far only came in by email.

  Safety: the worker acts only on the company the host validated (the host
  now stamps `params.hostScope` on every bridge call and refuses a mismatched
  `params.companyId`); the Post button is not shown at all when posting is
  switched off, the account is not allowed, the page is HQ's roll-up, Google
  could not be checked, an earlier attempt is still pending, or the person's
  role can only read, and one plain sentence says why. Every post, human or
  agent, goes through `postReplyGuarded`: an audit row in the new
  `reply_posts` table before the write, an idempotency key per confirm panel
  (kept across a retry, replaced only when the text changes), one in-flight
  attempt per review across tabs and workers, and a live read of Google
  immediately before the write so a reply is only ever replaced by a person
  who saw that exact reply and asked to. An agent can never replace a reply.
  A lost connection after the write marks the attempt unknown and the retry
  checks Google first, so nothing posts twice. The reviews row records where
  a reply came from (`reply_source`: human, agent, or google).

  Also: the suggested-reply template now takes the numeric rating the table
  stores (it expected Google's ONE..FIVE strings, so every stored review was
  offered the low-rating apology), no longer quotes the customer's complaint
  back, and has no long dashes. The review issue's instruction line points at
  Sync now instead of a comment phrase. The `allowReplies` setting text now
  says it covers people as well as agents.

  Attended live check: not yet done. One real post through the confirm
  panel, to a review the operator wrote on a listing they own, is to be made
  with them present and then removed in Google's console; the result (receipt shown,
  `reply_posts` row posted, host activity row present, review flipped to
  replied, summary count dropped, a second click made no second post, and a
  later `gbp_reply_to_review` on the same review held for approval and then
  refused with `[EREPLY_EXISTS]`) will be recorded here once it has been run.

- **v0.1.9**: Three security fixes to company scoping and the reply tool.

  An account's empty allowed-companies list used to skip the check entirely,
  letting any company use any Google account; it now denies, and "*" is the
  explicit way to allow everyone. A review email whose business name matched
  no location used to be filed under the first location regardless of how
  many were configured, so one company's review opened an issue in another;
  it is now skipped and logged unless only one location exists. The reply and
  read tools used to put a caller-supplied review name straight into the
  Google URL with no check that it belonged to the named location or that the
  location belonged to the calling company; both are now checked and the name
  is rebuilt from validated parts. Failures are reported as failures, the
  local record after a post no longer silently fails, and the package now has
  a test script so its 21 tests run in CI.

- **v0.1.8**: A company now sees only its own review locations.

  The dashboard listed every configured location to every company. Its handler
  looped the whole location list and never looked at the company the page was
  opened in, so an operator in one company saw another's locations, review
  counts, unreplied backlog and average rating. The dashboard widget made the
  same unscoped call, so it leaked the same data wherever it was placed.

  Every location already recorded the company it belongs to; that field was
  used when creating review issues but never when reading them. It is now used
  for both. The portfolio root still gets the cross-company roll-up, and the
  page says which of the two you are looking at. Fails closed: no company in
  context shows nothing rather than everything.

  Adds the read-only `companies.read` capability, needed only to tell whether
  the viewing company is the portfolio root.

- **v0.1.7**: Location names are visible in dark mode. The location cards painted a fixed
  near-white background while the name inherited the theme's text colour, so
  under the dark theme the name was near-white on near-white. The cards now use
  the host's `--card` surface, and the "needs attention" variant tints that
  surface with amber instead of replacing it.

- **v0.1.6**: Rotating the OAuth credentials now takes effect on the next call.

  The Google OAuth client was cached against *which secrets* it was built from,
  not their values. Rotating any of the three (client id, client secret, or
  refresh token) keeps the same references and changes the values underneath,
  so the cache kept using the old credentials with no error until the worker
  restarted. That matters most for the refresh token, which is precisely what
  you rotate when one leaks or expires.

  The cache now compares a digest of the resolved values too. Same bug and same
  fix as slack-tools v0.4.27, found there first.

- **v0.1.5**: Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.4**: Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.3**: Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.2**: Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.1**: Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.0**: initial release: email polling → review issues (Phase 1), agent reply tools + GBP API posting (Phase 2), daily sync, weekly digest, and dashboard widget/page (Phase 3).

## What this plugin registers

### Agent tools

| Tool | What it does | Mutation? |
|---|---|---|
| `gbp_list_reviews` | List reviews for a configured location. Defaults to unreplied only. | no |
| `gbp_get_review` | Fetch a single review by its GBP resource name. | no |
| `gbp_sync_location` | Pull all reviews for one location into the local table. | writes local DB |
| `gbp_reply_to_review` | Post a reply to a review via the GBP API. | yes |

`gbp_reply_to_review` requires the **"Allow posting replies to GBP"** master switch (`allowReplies`, off by default, so a fresh install suggests replies but never posts). The same switch covers people posting from the Reviews page. The agent tool never replaces a reply that is already on Google; only a person, from the Reviews page, can do that, and only after being shown it.

### Scheduled jobs

| Job | Schedule (cron) | What it does |
|---|---|---|
| `poll-review-emails` | `*/15 * * * *` | Searches the configured Gmail inbox for review notifications since the last run, parses them, and creates a review issue with a drafted reply. A first run looks back seven days. Skipped unless `gmailAccountKey` is set. |
| `sync-all-reviews` | `0 6 * * *` | Pulls every configured location's reviews via the My Business API into the local table; opens issues for new unreplied reviews. |
| `send-weekly-digest` | `0 8 * * 1` | Creates a per-location weekly digest issue (counts, avg rating, unreplied list). |

### UI

- `ReviewSummaryWidget`: dashboard widget showing per-location unreplied / avg / total.
- `GoogleSetupPage`: full page at route `reviews-setup`. Connects a Google account, says what the stored token can actually do, and lists real locations to choose from. Bridge handlers `google-connection` and `google-locations` (reads), and the actions `google_connect_start`, `google_connect_poll`, `google_connect_submit_callback` and `google_connect_cancel`. Both reads scope on the host's company stamp like every other handler here.
- `ReviewDashboardPage`: full page at route `reviews`. Location cards open the location's reviews (`?location=<key>`), and a review opens the reply editor beside the list (`&review=<name>`). From HQ the lists are readable across every company but nothing can be posted; open the location's own company to reply.

The page talks to the worker through five bridge handlers: `review-summary` (the cards), `review-list` (one location's rows, newest first with unreplied on top, plus the last sync time), `review-detail` (the stored row, a live read of the reply Google holds right now, the suggested reply and the "Posts as" line), `review-post-reply` (the guarded post; see `src/replyGuard.ts`) and `review-sync-location` (Sync now). Every handler scopes on the company the host stamped into `params.hostScope` and refuses with `[ESCOPE]` when it is missing, so a companyId the browser sends is never trusted. Unsent drafts live only in the person's browser (`localStorage` key `review-tools:draft:<companyId>:<reviewName>`).

## Setup

All of this happens on the **Google connection** page inside a company (route `reviews-setup`). No terminal, and no pasting a refresh token between fields.

### Run sheet

1. Google Cloud console: pick the project that has Business Profile API access.
2. Enable **My Business Account Management API**, **My Business Business Information API**, **Google My Business API**, and **Gmail API** if you want email polling.
3. Create an OAuth client, type **Desktop app** (simplest), or reuse a Web application client that has `http://127.0.0.1:54321/oauth/callback` among its authorised redirect URIs. Copy the client ID and secret.
4. Paperclip: open the company, then **Google connection**. Name the account, paste the ID and secret, press **Connect to Google**.
5. Grant every permission. STOP if the page says a permission is missing: nothing is saved, and reviews cannot be read without `business.manage`.
6. **Choose which locations to watch**: pick the listing group, then the location. The account id and location id are filled in for you.
7. Turn on **Allow posting review replies** in the plugin settings when replies should actually publish.

### Which redirect address is used

A Desktop app client accepts any loopback address. A Web application client accepts only the addresses registered on it, so the page tries, in order, `http://127.0.0.1:54321/oauth/callback`, then `http://localhost:8080/callback` (the two the earlier terminal scripts told people to register), then a random loopback port. Each is checked with Google first, without a browser: Google answers an unregistered address with a redirect to its error page before anyone signs in. A client that accepts none of them is reported on the page with the address to register, rather than sending anyone to Google's "redirect_uri_mismatch" screen.

### Which API is on which host

Worth knowing, because getting it wrong fails in a way that reads like a missing location:

| What | Host | Why |
|---|---|---|
| Reviews, replies | `mybusiness.googleapis.com/v4` | Never migrated. v4 is correct here and is not going away for reviews. |
| Listing the accounts a credential can see | `mybusinessaccountmanagement.googleapis.com/v1` | The v4 `/accounts` path answers 404 with an HTML page. |
| Listing locations | `mybusinessbusinessinformation.googleapis.com/v1` | Needs an explicit `readMask`. |

### Secrets

The page creates three secrets named `review_tools_<account>_client_id`, `_client_secret` and `_refresh_token`, owned by the company you connect from, and references them by UUID.

They are deliberately **not** shared with the google-workspace plugin. Sharing one set of `gbp_*` secrets between the two is what caused the October 2026 outage: reconnecting Workspace replaced the refresh token with a Calendar-scoped one, which authenticated perfectly and could not read a single review.

### Doing it from a terminal instead

`scripts/grant.ts` and `scripts/list-accounts.ts` still work and are the fallback when a browser cannot reach this machine. The page is the supported path.

## Error codes

The plugin wraps errors in a stable `[E…]` envelope so skills can pattern-match.

| Code | Meaning | Typical fix |
|---|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | The calling company isn't in the account's `allowedCompanies`. | Add the company UUID on the settings page. |
| `[EACCOUNT_NOT_FOUND]` | The named account key isn't configured. | Check spelling; keys are matched case-insensitively. |
| `[ELOCATION_NOT_FOUND]` | The named location key isn't configured. | Add the location, or check the key. |
| `[EREPLIES_DISABLED]` | A reply was attempted while `allowReplies` is off. | Flip "Allow posting replies to GBP" on the settings page. |
| `[EINVALID_INPUT]` | `replyText` empty or over the 4096-char limit, a review name that is not a Google review, or a confirm panel that reused its key with different text. | Adjust the reply text, or start a new attempt. |
| `[ESCOPE]` | A page handler was called without the host's company stamp (an older host, or an instance-admin call with no company). | Open the page inside a company; deploy the host that stamps `params.hostScope`. |
| `[EROLLUP_READ_ONLY]` | A post was attempted from HQ's cross-company roll-up. | Open the location's own company to reply. |
| `[EREVIEW_NOT_FOUND]` | The review is not in the local table yet. | Press Sync now on its location, then open it again. |
| `[EREPLY_EXISTS]` | A reply is already on Google and the caller did not ask to replace it (an agent never can). | On the Reviews page, tick "Replace the reply that is already on Google". |
| `[EREPLY_CHANGED]` | The reply on Google changed, or was removed, since the person opened the review. | Open the review again to see the current reply. |
| `[EDUPLICATE_IN_PROGRESS]` | Another attempt on the same review is still in flight (another tab, another worker, or an agent). | Wait a moment, then open the review again. |
| `[EPOST_UNCONFIRMED]` | The connection dropped after the write was sent, so it is not known whether Google received it. | Try again; the retry checks Google first and will not post twice. |
| `[ECONFIG]` | A required secret-ref is missing, or a secret resolved empty. | Re-paste the secret UUIDs; verify non-empty values. |
| `[ECONFIG_SECRET_MISSING]` | A configured secret-ref UUID doesn't exist in the company's store. | Create the missing secret; fix the UUID. |
| `[EAUTH]` | Failed to obtain a Google access token for a reason not listed below. | Reconnect the account on the Google connection page. |
| `[EAUTH_SCOPE]` | The token was granted without the permission the call needs. The message names which one. | Reconnect the account and leave every permission ticked. This is what the October 2026 outage looked like. |
| `[EAUTH_INVALID_GRANT]` | Google no longer accepts the refresh token: revoked, expired, or minted by a different OAuth client. | Reconnect the account. |
| `[EAUTH_CLIENT]` | Google does not recognise the OAuth client ID and secret. | Check both against the Google Cloud console. |
| `[EGBP_API_DISABLED]` / `[EGMAIL_API_DISABLED]` | The named API is not enabled on the Cloud project behind the OAuth client. | Enable it under APIs and Services, then press Check again. |
| `[EGBP_QUOTA]` / `[EGMAIL_QUOTA]` | Google refused over quota. | A Business Profile quota of zero means API access has not been approved for that project; that is a request to Google, not a setting. |
| `[EGBP_HTTP_<status>]` | The My Business API returned an error. | The message follows the code. `invalid_grant` → re-grant. |
| `[EGMAIL_HTTP_<status>]` | The Gmail API returned an error. | Confirm the refresh token includes `gmail.readonly`. |
| `[EGBP_UNKNOWN]` | Unrecognized error shape. | Check worker logs for the raw error. |

## Per-company isolation

Each account entry lists which Paperclip companies may use it (`allowedCompanies`). When an agent in company A invokes a tool addressing an account that isn't allowed for A, the call is rejected with `[ECOMPANY_NOT_ALLOWED]` before any secret is resolved or any Google API is called. Locations carry a `targetCompanyId` that determines where their review issues are created.

> **Note:** if one Google account is shared across multiple companies on its `allowedCompanies` list, any of those companies' agents can address any location served by that account. Use one account per isolation boundary if you need strict per-location separation.

## Bundle and runtime notes

- Auth uses `google-auth-library`; only the long-lived refresh token is stored in Paperclip secrets: access tokens are fetched on demand.
- An OAuth2 client is cached per `(companyId, accountKey)` tuple and re-resolved transparently when the secret refs change.
- Review records are stored in a plugin-namespaced Postgres schema (`migrations/001_create_reviews.sql`, plus `002_reply_posts.sql` for the `reply_source` column and the `reply_posts` audit table), keyed by the GBP review resource name. An email-sourced review opens an issue but is NOT stored in the table until the next sync (the daily one at 06:00, or Sync now on the Reviews page): its synthetic `email/<messageId>` name is not a Google resource name and is refused by `parseReviewName`, so it never appears in the editor and can never be sent to Google.
- Phase 1 email parsing is heuristic (subject/body regex against Google's notification format) and falls back gracefully when fields can't be extracted; `sync-all-reviews` (the API path) is the source of truth.

## Versioning

- `0.1.0`: initial release.
- `0.2.0`: the Google connection page, this plugin's own secrets, current account and location APIs, and error messages that separate the three different HTTP 403s. Needs one consent run by a person before reviews flow.
- `0.1.10`: the Reviews page reply editor and the shared guarded post path. Requires a host that stamps `params.hostScope` on bridge calls; on an older host every screen shows an access sentence rather than data.
