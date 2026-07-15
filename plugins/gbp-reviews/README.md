# gbp-reviews plugin

Google Business Profile review management for a portfolio. Detects incoming review notification emails, creates Paperclip issues with AI-drafted replies, posts approved replies back via the GBP API, and surfaces a per-location review dashboard. Multi-account, per-company isolation, OAuth-driven.

> **Setup walkthrough** also lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/job/error shapes.

## Recent changes

- **v0.1.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.1.0** — initial release: email polling → review issues (Phase 1), agent reply tools + GBP API posting (Phase 2), daily sync, weekly digest, and dashboard widget/page (Phase 3).

## What this plugin registers

### Agent tools

| Tool | What it does | Mutation? |
|---|---|---|
| `gbp_list_reviews` | List reviews for a configured location. Defaults to unreplied only. | no |
| `gbp_get_review` | Fetch a single review by its GBP resource name. | no |
| `gbp_sync_location` | Pull all reviews for one location into the local table. | writes local DB |
| `gbp_reply_to_review` | Post a reply to a review via the GBP API. | yes |

`gbp_reply_to_review` requires the **"Allow posting replies to GBP"** master switch (`allowReplies`, off by default — fresh installs draft but never post).

### Scheduled jobs

| Job | Schedule (cron) | What it does |
|---|---|---|
| `poll-review-emails` | `*/15 * * * *` | Searches the configured Gmail inbox for unread GBP review notifications, parses them, and creates a review issue with a drafted reply. Skipped unless `gmailAccountKey` is set. |
| `sync-all-reviews` | `0 6 * * *` | Pulls every configured location's reviews via the My Business API into the local table; opens issues for new unreplied reviews. |
| `send-weekly-digest` | `0 8 * * 1` | Creates a per-location weekly digest issue (counts, avg rating, unreplied list). |

### UI

- `ReviewSummaryWidget` — dashboard widget showing per-location unreplied / avg / total.
- `ReviewDashboardPage` — full page at route `gbp-reviews`.

## Setup

### 1. Create a Google Cloud OAuth client

Once per Google account that has **Owner or Manager** access to the GBP location(s).

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Pick (or create) a project.
3. **Enable APIs** (APIs & Services → Library): **My Business Account API** and **Gmail API**.
4. **Create OAuth 2.0 Client ID** — Application type **Web application**. Add `http://localhost:8080/callback` as an Authorized redirect URI.
   - Note: the "TVs and Limited Input devices" (device-code) flow does **not** support the `business.manage` scope — Web application type is required for GBP.
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

For each account, create three secrets (names are cosmetic — the config references them by UUID; `ALL_CAPS_SNAKE_CASE` to match the env-var names above):

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
| Google Account ID | `1234567890` | Numeric GBP account ID — find it with `pnpm tsx scripts/list-accounts.ts`. |
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
| `[EINVALID_INPUT]` | `replyText` empty or over the 4096-char limit. | Adjust the reply text. |
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

- Auth uses `google-auth-library`; only the long-lived refresh token is stored in Paperclip secrets — access tokens are fetched on demand.
- An OAuth2 client is cached per `(companyId, accountKey)` tuple and re-resolved transparently when the secret refs change.
- Review records are stored in a plugin-namespaced Postgres schema (`migrations/001_create_reviews.sql`), keyed by the GBP review resource name. Email-sourced reviews use a synthetic `email/<messageId>` key.
- Phase 1 email parsing is heuristic (subject/body regex against Google's notification format) and falls back gracefully when fields can't be extracted; `sync-all-reviews` (the API path) is the source of truth.

## Versioning

- `0.1.0` — initial release.
