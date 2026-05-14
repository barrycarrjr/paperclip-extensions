# Social Poster (paperclip plugin)

Posts to Facebook Pages, Instagram Business accounts, and X (Twitter) via
their official APIs. Brand-variant aware (`standard` / `kids` content
guardrails); optional Facebook scheduling.

## Recent changes

- **v0.3.11** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.10** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.9** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.8** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.7** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.6** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.5** — Harden instanceConfigSchema with additionalProperties: false to reject unknown keys on config POST.

- **v0.3.4** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.3.0** — `setupInstructions` rendered as a Setup tab on the plugin's
  settings page (canonical install walkthrough); `name` field on each
  resource is now optional.
- **v0.2.0** — per-resource `allowedCompanies` isolation. Every Facebook
  page / Instagram account / X account now carries an `allowedCompanies`
  list. Agents calling from a company not on the list get back
  `[ECOMPANY_NOT_ALLOWED]`. Display name per resource on the settings
  form.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\social-poster
pnpm install
pnpm build

# Then from your paperclip checkout:
cd %USERPROFILE%\paperclip
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\social-poster
```

## Configure

Open `/instance/settings/plugins/social-poster`. Three resource arrays:
Facebook Pages, Instagram Business accounts, X accounts.

For every resource: set Display name (free-form, you can rename later),
Identifier (short stable ID agents pass — don't change after skills
reference it), and Allowed companies (list of company UUIDs allowed to
use it; `["*"]` for portfolio-wide; empty = unusable).

### Facebook Page

1. **Get a long-lived Page Access Token:**
   - Go to https://developers.facebook.com/tools/explorer.
   - Pick your app, switch to a User Access Token, request `pages_read_engagement`,
     `pages_manage_posts`, and (if you need scheduling) `pages_manage_metadata`.
   - Submit, then exchange for a long-lived token via
     `GET /oauth/access_token?grant_type=fb_exchange_token&...`.
   - Then `GET /me/accounts` with the long-lived user token; copy the page
     `access_token` from that response. That's the Page Access Token.
2. **Create a paperclip secret** with the token. Copy its UUID.
3. **Add a Facebook Page row** in the plugin settings:

| Field | Notes |
|---|---|
| Display name | e.g. "Brand A FB" |
| Identifier | e.g. `acme` — short stable ID agents pass as the `page` parameter |
| Allowed companies | e.g. `["company-uuid"]` |
| Page ID | Numeric Page ID — Page Settings → About |
| Page Access Token | Paste the secret UUID from step 2 |
| Brand variant | `standard` (default) or `kids` (rejects adult content patterns) |

### Instagram Business account

Requires the IG account to be linked to a Facebook Page.

1. Get the IG Business User ID:
   - `GET https://graph.facebook.com/v19.0/<page-id>?fields=instagram_business_account&access_token=<page-token>`
   - The numeric `id` in the response is your `igUserId` (NOT the @handle).
2. The Page Access Token from the linked Facebook Page works for IG too —
   reuse the same secret UUID.
3. Add an Instagram Business account row:

| Field | Notes |
|---|---|
| Display name | e.g. "Brand A IG" |
| Identifier | e.g. `acme_ig` — short stable ID agents pass as the `account` parameter |
| Allowed companies | UUID list |
| Instagram User ID | Numeric IG Business Account ID |
| Access Token | Paste the linked Page's secret UUID |
| Brand variant | `standard` or `kids` |

### X (Twitter) account

Posting via X API v2 needs **OAuth 1.0a User Context** (all four credentials).

1. Create an X app at https://developer.x.com → Project & app dashboard.
2. Under your app: enable Read+Write permissions; regenerate the consumer
   key/secret if you change perms.
3. Generate Access Token + Access Token Secret under "Keys and tokens".
4. **Create FOUR paperclip secrets** (consumer key, consumer secret, access
   token, access token secret) and copy each UUID.
5. Add an X account row:

| Field | Notes |
|---|---|
| Display name | e.g. "Brand A X" |
| Identifier | e.g. `acme_x` — short stable ID agents pass as the `account` parameter |
| Allowed companies | UUID list |
| API Key (Consumer Key) | UUID of consumer-key secret |
| API Secret (Consumer Secret) | UUID of consumer-secret secret |
| Access Token | UUID of user-context access-token secret |
| Access Token Secret | UUID of access-token-secret secret |
| Brand variant | `standard` or `kids` |

### Master switch

| Field | Value |
|---|---|
| `allowPublish` | `true` to enable posting; `false` for draft-only mode |

## Tools

### `post_to_facebook`

| Param | Type | Required |
|---|---|---|
| `page` | string | yes — must match a configured page Identifier |
| `message` | string | yes |
| `image_url` | string | no — public HTTPS URL |
| `link` | string | no — for link-preview cards |
| `scheduled_publish_time` | number | no — Unix seconds, 10 min – 6 months in future |

### `post_to_instagram`

| Param | Type | Required |
|---|---|---|
| `account` | string | yes — must match a configured IG Identifier |
| `image_url` | string | yes — public HTTPS JPEG/PNG |
| `caption` | string | yes — hashtags inline |

### `post_to_x`

| Param | Type | Required |
|---|---|---|
| `account` | string | yes — must match a configured X Identifier |
| `text` | string | yes — max 280 chars |
| `in_reply_to_tweet_id` | string | no — for threading |

### Example invocation

```http
POST /api/plugins/tools/execute
{
  "tool": "social-poster.post_to_facebook",
  "params": { "page": "acme", "message": "Hello world" },
  "runContext": {
    "agentId": "...",
    "runId": "...",
    "companyId": "<must-be-in-page-allowedCompanies>",
    "projectId": "..."
  }
}
```

## Error codes

| Code | When |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in the resource's `allowedCompanies` list, or the list is empty. |
| `[EFACEBOOK_PUBLISH]` | Facebook Graph API rejected the post. Body contains the upstream error. |
| `[EINSTAGRAM_CONTAINER]` | IG media-container creation failed (step 1 of 2). |
| `[EINSTAGRAM_PUBLISH]` | IG media publish failed (step 2 of 2). |
| `[EX_PUBLISH]` | X API v2 rejected the tweet. |

## Authors

Barry Carr · Tony Allard
