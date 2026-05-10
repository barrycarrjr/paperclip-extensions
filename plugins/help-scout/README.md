# Help Scout (paperclip plugin)

Customer-support operations on Help Scout — find / get / create
conversations, replies, internal notes, status changes, assignments,
tag management, customer lookups + creation, and day/week/custom
reports.

Multi-account, per-account `allowedCompanies` isolation, optional
per-account `allowedMailboxes` allow-list, and a master `allowMutations`
gate.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.4.3** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.2** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

- **v0.4.1** — Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

## Tools registered

| Tool | Kind | Notes |
|---|---|---|
| `helpscout_list_mailboxes` | read | Returns id/name/email; filtered by `allowedMailboxes`. |
| `helpscout_find_conversation` | read | Search by mailbox / status / query / tag / assignedTo / since. |
| `helpscout_get_conversation` | read | Single by ID; pass `embed=threads` to include bodies. |
| `helpscout_find_customer` | read | Search by email / query / firstName / lastName. |
| `helpscout_find_user` | read | Help Scout users (operators), not end customers. |
| `helpscout_get_day_report` | read | Day report. Cached 60 s. |
| `helpscout_get_week_report` | read | 7-day report. Cached 60 s. |
| `helpscout_get_custom_report` | read | Custom range. Optional grouping by tag/user/mailbox. |
| `helpscout_create_conversation` | mutation | Idempotent on `idempotencyKey` (stored as a tag). |
| `helpscout_send_reply` | mutation | Sends an email to the customer (or `imported=true` to record without sending). |
| `helpscout_add_note` | mutation | Internal note; customer never sees. |
| `helpscout_change_status` | mutation | active / pending / closed / spam. |
| `helpscout_assign_conversation` | mutation | Assign or unassign (userId=null). |
| `helpscout_add_label` | mutation | Adds tags (read-then-write union). Lowercased. |
| `helpscout_remove_label` | mutation | Removes tags. |
| `helpscout_create_customer` | mutation | Idempotent on email. |
| `helpscout_update_customer_properties` | mutation | Patch custom properties. |

Every tool accepts an optional `account` parameter; if omitted, falls
back to the configured `defaultAccount`.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\help-scout
pnpm install
pnpm build

# Then from your paperclip checkout:
cd %USERPROFILE%\paperclip
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\help-scout
```

The plugin worker reloads automatically after install and after every
config save. No manual paperclip restart needed.

## Configure

Help Scout's Mailbox API uses OAuth2 with the **client_credentials** grant.
The plugin handles token exchange and refresh automatically — you provide
the Client ID and Client Secret once, the plugin trades them for short-lived
(48h) access tokens and refreshes when they expire.

### 1. Create a Help Scout custom app

1. Sign in to Help Scout as an admin user on the account.
2. Top-right avatar → **Your Profile** → **My Apps** (in the left sidebar).
3. Click **Create App**.
4. Fill in:
   - **App Name**: e.g. `Paperclip`.
   - **Redirection URL**: any URL — Help Scout requires the field but doesn't
     use it for the client_credentials grant. `https://www.google.com` is
     what Help Scout's own docs suggest for placeholder.
5. Click **Create**. The next page shows the **App ID** (= Client ID) and
   **App Secret** (= Client Secret). The App Secret is shown only once.

### 2. Store both as paperclip secrets

In `<COMPANY-PREFIX>/company/settings/secrets`, create **two** secrets. Use the all-caps snake_case convention shared by other plugin secrets (`IMAP_PERSONAL_PASS`, `SLACK_BOT_TOKEN`, etc.) so they sort together:

1. `HELPSCOUT_CLIENT_ID` — value: the App ID from step 1.
2. `HELPSCOUT_SECRET_ID` — value: the App Secret from step 1.

Copy both UUIDs.

### 3. Add the account row — first save

Open `/instance/settings/plugins/help-scout`. Click **+ Add item** under
Help Scout accounts. Fill in:

| Field | Example | Notes |
|---|---|---|
| `Identifier` | `support` | Short stable ID agents pass as `account`. Lowercase, no spaces. **Don't change after skills reference it.** |
| `Display name` | `Customer Support` | Free-form label. |
| `OAuth2 Client ID` | (UUID of `HELPSCOUT_CLIENT_ID` secret from step 2) | The plugin resolves at runtime. |
| `OAuth2 Client Secret` | (UUID of `HELPSCOUT_SECRET_ID` secret from step 2) | Same Help Scout app. |
| `Allowed companies` | tick the LLC | Empty = unusable. Single-company is typical. |

(Optionally) set **Default account key** at the top to the identifier
above so agents can omit `account` on every call. Click **Save Configuration**.

The Default mailbox and Allowed mailbox IDs fields don't appear yet —
they're hidden until both credential refs are filled and saved, because
they need to call Help Scout's API to populate.

### 4. Pick the mailbox — second pass

After step 3's save the same row reveals two new fields:

- **Default mailbox** — a dropdown of every mailbox visible on the
  Help Scout account, populated by calling `/v2/mailboxes` with the
  saved credentials. Pick the default for this account key.
- **Allowed mailbox IDs** — checkboxes for the same list. Leave empty
  to allow all mailboxes; tick specific ones to restrict.

Click **Save Configuration** again.

## Tag normalization

Help Scout tags are case-sensitive in the API but the UI displays them
case-insensitively. To avoid duplicate `Refund` / `refund` / `REFUND`
tags accumulating, the plugin lowercases every tag on input AND every
tag returned in `slimConversation.tags`. If you need exact-case tags
for some other integration, this normalization is the wrong default —
file a follow-up.

## Idempotency

### `helpscout_create_conversation`

Pass `idempotencyKey: "<your-key>"`. The plugin:

1. Searches the configured mailbox for a conversation tagged
   `paperclip-idem-<key>` (lowercased).
2. If found, returns that conversation's id with `deduped: true`.
3. Otherwise creates the conversation AND tags it with the same idem
   tag for next time.

So calling twice with the same key returns the same conversation.

### `helpscout_create_customer`

Idempotent on email — searches first by email, returns the existing
customer if present, otherwise creates.

If you also pass `idempotencyKey`, it's stored in the customer's
`paperclip_idem_key` custom property (for completeness; the email is the
real dedup key).

## Reports caching

`helpscout_get_day_report` / `_week_report` / `_custom_report` are cached
in memory for 60 seconds per `(account, mailboxId, date-range)`. Skills
that compose multiple reports in one heartbeat won't hit the API
multiple times. Restart the plugin (or save the config to reload the
worker) to flush the cache.

## Rate limits

Help Scout limits to 200 requests/minute per token. The plugin doesn't
retry on 429 — it surfaces `[EHELP_SCOUT_RATE_LIMIT] retry after Ns`
and lets the calling skill decide. Each successful response includes
`X-RateLimit-Remaining-Minute` which you can monitor in the plugin's
debug logs.

## Tool usage examples

### Pull yesterday's day report

```ts
await tools.invoke("helpscout_get_day_report", {});
// → { content: "Day report for 2026-04-30…", data: { … } }
```

### Find unanswered conversations from the last hour

```ts
await tools.invoke("helpscout_find_conversation", {
  status: "active",
  since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
});
```

### Reply to a customer

```ts
await tools.invoke("helpscout_send_reply", {
  conversationId: "987654321",
  body: "Thanks for getting in touch — I've issued the refund.\n\n— Support",
});
```

(Requires `allowMutations=true` on the plugin settings page.)

### Add a label

```ts
await tools.invoke("helpscout_add_label", {
  conversationId: "987654321",
  labels: ["refund", "vip"],
});
```

The plugin reads existing tags, unions with `["refund", "vip"]`, and
PUTs the full set. Existing tags survive.

## Error codes

| Code | Meaning |
|---|---|
| `[EACCOUNT_REQUIRED]` | No account param and no default. |
| `[EACCOUNT_NOT_FOUND]` | Account identifier not in plugin config. |
| `[ECOMPANY_NOT_ALLOWED]` | Calling company isn't in this account's `allowedCompanies`. |
| `[ECONFIG]` | Account lacks `clientIdRef`/`clientSecretRef` or one of the secrets didn't resolve. |
| `[EHELP_SCOUT_TOKEN_EXCHANGE]` | Help Scout's OAuth2 endpoint rejected the credentials. Verify both secrets resolve to the values shown in Help Scout's My Apps page. |
| `[EDISABLED]` | Mutation tool called while `allowMutations=false`. |
| `[EINVALID_INPUT]` | Required param missing or contradictory. |
| `[EHELP_SCOUT_MAILBOX_NOT_ALLOWED]` | The addressed mailbox isn't in the account's `allowedMailboxes`. |
| `[EHELP_SCOUT_AUTH]` | 401 — token invalid/expired/revoked. |
| `[EHELP_SCOUT_FORBIDDEN]` | 403 — token lacks permission. |
| `[EHELP_SCOUT_NOT_FOUND]` | 404 — conversation/customer/mailbox doesn't exist. |
| `[EHELP_SCOUT_INVALID]` | 422 — Help Scout rejected the body (e.g. bad status enum). |
| `[EHELP_SCOUT_RATE_LIMIT]` | 429 — too many requests; retry after the indicated seconds. |
| `[EHELP_SCOUT_NETWORK]` | Network error before the request reached Help Scout. |
| `[EHELP_SCOUT_SERVER_5xx]` | Help Scout returned a 5xx. |
| `[EHELP_SCOUT_<status>]` | Other HTTP status. |

## `allowedCompanies` cheatsheet

Same as every other paperclip plugin:

| Setting | Behavior |
|---|---|
| Missing or `[]` | Account exists in config but is unusable. |
| `["company-uuid-A"]` | Only company A's agents can use it. |
| `["*"]` | Portfolio-wide. Rare for support since accounts usually belong to one team. |

## Out of scope (this version)

- Inbound webhooks (when a customer replies, etc.) — needs a
  Paperclip-level inbound HTTP path. See cross-plugin webhook
  discussion in `paperclip-extensions/plugin-plans/README.md`.
- Beacon (chat widget) operations.
- Workflow Builder.
- File attachments on replies.
- Bulk operations (tag many, close many) — could be added if a skill
  needs them.

## Versioning

`0.1.0` — initial release. 17 tools across reads / mutations / reports.
