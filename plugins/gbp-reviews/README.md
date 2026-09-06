# gbp-reviews plugin

Google Business Profile review management for a portfolio. Detects incoming review notification emails, creates Paperclip issues with suggested replies, posts approved replies back via the GBP API (from an agent tool or from the Reviews page), and surfaces a per-location review dashboard. Multi-account, per-company isolation, OAuth-driven.

> **Setup walkthrough** also lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/job/error shapes.

## Recent changes

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
  panel, to a review Barry wrote on a listing he owns, is to be made with him
  present and then removed in Google's console; the result (receipt shown,
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
| `poll-review-emails` | `*/15 * * * *` | Searches the configured Gmail inbox for unread GBP review notifications, parses them, and creates a review issue with a drafted reply. Skipped unless `gmailAccountKey` is set. |
| `sync-all-reviews` | `0 6 * * *` | Pulls every configured location's reviews via the My Business API into the local table; opens issues for new unreplied reviews. |
| `send-weekly-digest` | `0 8 * * 1` | Creates a per-location weekly digest issue (counts, avg rating, unreplied list). |

### UI

- `ReviewSummaryWidget`: dashboard widget showing per-location unreplied / avg / total.
- `ReviewDashboardPage`: full page at route `gbp-reviews`. Location cards open the location's reviews (`?location=<key>`), and a review opens the reply editor beside the list (`&review=<name>`). From HQ the lists are readable across every company but nothing can be posted; open the location's own company to reply.

The page talks to the worker through five bridge handlers: `review-summary` (the cards), `review-list` (one location's rows, newest first with unreplied on top, plus the last sync time), `review-detail` (the stored row, a live read of the reply Google holds right now, the suggested reply and the "Posts as" line), `review-post-reply` (the guarded post; see `src/replyGuard.ts`) and `review-sync-location` (Sync now). Every handler scopes on the company the host stamped into `params.hostScope` and refuses with `[ESCOPE]` when it is missing, so a companyId the browser sends is never trusted. Unsent drafts live only in the person's browser (`localStorage` key `gbp-reviews:draft:<companyId>:<reviewName>`).

## Setup

### 1. Create a Google Cloud OAuth client

Once per Google account that has **Owner or Manager** access to the GBP location(s).

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Pick (or create) a project.
3. **Enable APIs** (APIs & Services → Library): **My Business Account API** and **Gmail API**.
4. **Create OAuth 2.0 Client ID**: Application type **Web application**. Add `http://localhost:8080/callback` as an Authorized redirect URI.
   - Note: the "TVs and Limited Input devices" (device-code) flow does **not** support the `business.manage` scope. Web application type is required for GBP.
5. Note the **Client ID** and **Client Secret**.

Scopes requested:

- `https://www.googleapis.com/auth/business.manage`
- `https://www.googleapis.com/auth/gmail.readonly` (only needed for Phase 1 email polling)

### 2. Get a refresh token

From the `paperclip-extensions` repo:

```bash
cd plugins/gbp-reviews
GBP_CLIENT_ID="…" GBP_CLIENT_SECRET="…" pnpm grant
```

It opens a localhost listener, runs the OAuth consent in your browser, and prints the refresh token. Use a Google account with Owner/Manager access to the location(s).

### 3. Create Paperclip secrets

For each account, create three secrets (names are cosmetic, the config references them by UUID; `ALL_CAPS_SNAKE_CASE` to match the env-var names above):

- `GBP_CLIENT_ID` → the OAuth client ID
- `GBP_CLIENT_SECRET` → the OAuth client secret
- `GBP_REFRESH_TOKEN` → the refresh token from step 2

### 4. Configure the plugin (Configuration tab)

Add a **GBP account** entry:

| Field | Example | Notes |
|---|---|---|
| Key | `primary-gbp` | Short stable ID referenced by locations. |
| OAuth client ID / secret / Refresh token | _(secret UUIDs)_ | Paste the UUIDs of the three secrets. |
| Allowed companies | _(company UUIDs)_ | Which companies' agents may use this account. Empty = unusable (fail-safe deny). |

Add a **GBP location** entry per location:

| Field | Example | Notes |
|---|---|---|
| Key | `main-st-store` | Short stable ID. |
| Display name | `Main St Store` | Shown in issues, digests, and the dashboard. |
| Google Account ID | `1234567890` | Numeric GBP account ID: find it with `pnpm tsx scripts/list-accounts.ts`. |
| Location ID | `1234567890123456789` | Numeric GBP location ID. |
| Account key | `primary-gbp` | References the account entry above. |
| Target company ID | _(company UUID)_ | Paperclip company where review issues are created. |

To enable Phase 1 email polling, set **Gmail account key** to the account whose refresh token includes the `gmail.readonly` scope.

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
| `[EAUTH]` | Failed to obtain a GBP access token. | Re-run the grant script; the refresh token may be revoked/expired. |
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
- `0.1.10`: the Reviews page reply editor and the shared guarded post path. Requires a host that stamps `params.hostScope` on bridge calls; on an older host every screen shows an access sentence rather than data.
