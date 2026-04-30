# Stripe Tools (paperclip plugin)

Exposes Stripe operations as agent tools — read-only customer / subscription /
charge / balance / dispute lookups, optional gated mutations (coupons +
promotion codes), CSV export, and an approximate MRR / ARR / churn metrics
snapshot.

Multi-account aware. Every Stripe account is scoped to a per-resource
`allowedCompanies` list — agents in the wrong company get
`[ECOMPANY_NOT_ALLOWED]`. Mutations are off by default.

## Tools registered

| Tool | Kind | Notes |
|---|---|---|
| `stripe_search_customers` | read | Stripe Search query syntax |
| `stripe_get_customer` | read | with optional `expand` |
| `stripe_list_subscriptions` | read | filters: customerId / status / priceId / createdAfter |
| `stripe_get_subscription` | read | expands `latest_invoice` and `items.data.price` |
| `stripe_list_charges` | read | filters: customerId / status / createdAfter / createdBefore |
| `stripe_get_balance_summary` | read | available / pending / reserved per currency |
| `stripe_list_disputes` | read | default `status=needs_response` |
| `stripe_get_metrics_snapshot` | read | MRR / ARR / active subs / churn30d / signups7d/30d. Single-currency only. |
| `stripe_create_coupon` | write | gated by `allowMutations` |
| `stripe_create_promotion_code` | write | gated by `allowMutations` |
| `stripe_export_charges_csv` | export | streams charges between `from` / `to` to a CSV file |

Every read tool accepts an optional `account` parameter; if omitted, falls
back to the configured `defaultAccount`. Every write tool also accepts an
optional `idempotencyKey`.

## Install

```bash
cd %USERPROFILE%\paperclip-extensions\plugins\stripe-tools
pnpm install
pnpm build

# Then from your paperclip checkout:
cd %USERPROFILE%\paperclip
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local %USERPROFILE%\paperclip-extensions\plugins\stripe-tools
```

The plugin worker reloads automatically when the install finishes and again
whenever its instance config is saved. No manual paperclip restart needed.

> Don't use `npx paperclipai` — that fetches the published package, which
> won't have your fork's changes. Always run the CLI through pnpm from the
> paperclip workspace.

## Configure

The setup is two-step per Stripe account: create the API key + paperclip
secret, then bind the account in the plugin config.

### 1. Create a Stripe restricted API key

In Stripe → Developers → API keys → **Create restricted key**. Pick the
scopes the plugin actually needs. Keep the key as narrow as possible:

| Resource | Read | Write | When to enable write |
|---|---|---|---|
| Customers | ✅ | — | — |
| Subscriptions | ✅ | — | — |
| Charges | ✅ | — | — |
| Balance | ✅ | — | — |
| Disputes | ✅ | — | — |
| Invoices | ✅ | — | needed by `stripe_get_subscription` (latest_invoice expansion) |
| Prices | ✅ | — | — |
| Coupons | ✅ | ✅ | only if you'll set `allowMutations=true` |
| Promotion codes | ✅ | ✅ | only if you'll set `allowMutations=true` |
| Balance transactions | ✅ | — | needed by `stripe_export_charges_csv` (fee/net columns) |

Copy the key (`rk_live_...` or `rk_test_...`). You'll paste it into a
paperclip secret next.

### 2. Store the key as a paperclip secret

1. Open `<COMPANY-PREFIX>/company/settings/secrets` in the paperclip UI
   (any company is fine; secrets are looked up by UUID).
2. Click **+ Create secret**.
3. Name it descriptively (e.g. `STRIPE_LIVE_KEY` or `STRIPE_TEST_KEY`).
4. Provider: `Local encrypted` (the default).
5. Value: paste the restricted key value. Save.
6. Copy the secret's UUID — visible in the secrets list, or via
   `GET /api/companies/<companyId>/secrets`.

### 3. Bind the account in the plugin config

Open `/instance/settings/plugins/stripe-tools`. Click **+ Add item** under
Stripe accounts. Fill in:

| Field | Example | Notes |
|---|---|---|
| `Display name` | `Production live` | Free-form label shown on this settings page. You can rename it later without breaking anything. |
| `Identifier` | `main` | Short stable ID agents pass as the `account` parameter. Lowercase, no spaces. **Don't change after skills start using it.** |
| `Allowed companies` | `["company-uuid-1"]` or `["*"]` | Which paperclip companies can use this account. Empty = unusable. |
| `Mode` | `live` or `test` | Informational. Used for log labelling so you don't mix live/test. |
| `Restricted secret key (UUID of secret)` | (paste secret UUID from step 2) | Stored as a UUID. The plugin resolves it at runtime via the secrets store. |
| `Stripe API version pin (optional)` | (blank) | Leave blank unless you need to align with specific webhook payloads. |

Set `Default account key` if you want agents to be able to omit `account`
from tool calls. **Strict fail mode**: if an agent calls a tool from a
company that isn't in the default account's `allowedCompanies`, the call
fails with `[ECOMPANY_NOT_ALLOWED]` rather than silently falling back.
Agents must explicitly pass `account` to reach a non-default account.

Find paperclip company UUIDs via `GET /api/companies` or the company list
URL.

### 4. (Optional) Enable mutations

| Field | Value |
|---|---|
| `Allow mutating tools` | `true` |

Only flip this on after you've reviewed which agents/skills can call
`stripe_create_coupon` and `stripe_create_promotion_code`. Read tools are
unaffected.

Save. The worker auto-restarts and the new config takes effect on the next
tool call.

## Tool reference

Every tool is invoked via:

```http
POST /api/plugins/tools/execute
Content-Type: application/json

{
  "tool": "stripe-tools.<tool-name>",
  "params": { ... },
  "runContext": {
    "agentId": "...",
    "runId": "...",
    "companyId": "<must-be-in-account-allowedCompanies>",
    "projectId": "..."
  }
}
```

The `companyId` in `runContext` is checked against the resolved account's
`allowedCompanies`. Mismatch → `[ECOMPANY_NOT_ALLOWED]`.

### `stripe_search_customers`

```json
{
  "tool": "stripe-tools.stripe_search_customers",
  "params": { "query": "email:'jane@example.com'", "account": "main", "limit": 10 }
}
```

Returns `{ customers: [...], hasMore, nextPage }`. Slim customer shape:
`{ id, email, name, created, metadata }`.

### `stripe_get_customer`

```json
{
  "tool": "stripe-tools.stripe_get_customer",
  "params": { "customerId": "cus_NffrFeUfNV2Hib", "expand": ["subscriptions"] }
}
```

### `stripe_list_subscriptions` / `stripe_get_subscription`

```json
{
  "tool": "stripe-tools.stripe_list_subscriptions",
  "params": { "status": "active", "limit": 100 }
}
```

```json
{
  "tool": "stripe-tools.stripe_get_subscription",
  "params": { "subscriptionId": "sub_1MowQVLkdIwHu7ixeRlqHVzs" }
}
```

### `stripe_list_charges`

```json
{
  "tool": "stripe-tools.stripe_list_charges",
  "params": {
    "customerId": "cus_NffrFeUfNV2Hib",
    "createdAfter": "2026-01-01T00:00:00Z",
    "limit": 100
  }
}
```

### `stripe_get_balance_summary`

```json
{ "tool": "stripe-tools.stripe_get_balance_summary", "params": {} }
```

Returns `{ available, pending, reserved }` arrays of `{ currency, amount }`.

### `stripe_list_disputes`

```json
{
  "tool": "stripe-tools.stripe_list_disputes",
  "params": { "status": "needs_response" }
}
```

### `stripe_get_metrics_snapshot`

```json
{
  "tool": "stripe-tools.stripe_get_metrics_snapshot",
  "params": { "asOfDate": "2026-04-30T00:00:00Z" }
}
```

Returns:

```json
{
  "asOfDate": "2026-04-30T00:00:00.000Z",
  "currency": "usd",
  "mrrCents": 482300,
  "arrCents": 5787600,
  "activeSubs": 142,
  "signups7d": 8,
  "signups30d": 31,
  "cancellations30d": 4,
  "churnRate30d": 0.027
}
```

The snapshot is **approximate**. MRR is computed by summing
`subscription.items[].price.unit_amount * quantity`, normalized to a
30.4375-day month. ARR = MRR × 12. Churn30d = cancellations / (active +
cancellations) over the last 30 days. The result is cached for ~5 minutes
keyed by `(companyId, account, asOfDate-bucket)`.

### `stripe_create_coupon` (mutation)

```json
{
  "tool": "stripe-tools.stripe_create_coupon",
  "params": {
    "name": "Free month - winback Apr 2026",
    "duration": "once",
    "percentOff": 100,
    "maxRedemptions": 1,
    "metadata": { "campaign": "winback-apr-2026" },
    "idempotencyKey": "winback-apr-2026-coupon-fred"
  }
}
```

Provide **either** `percentOff` **or** (`amountOff` + `currency`), not both.
For `duration: "repeating"`, also pass `durationInMonths`.

### `stripe_create_promotion_code` (mutation)

```json
{
  "tool": "stripe-tools.stripe_create_promotion_code",
  "params": {
    "couponId": "abc123",
    "code": "WINBACK-FRED",
    "customerId": "cus_NffrFeUfNV2Hib",
    "maxRedemptions": 1
  }
}
```

If `code` is omitted, Stripe auto-generates one and returns it in the
response.

### `stripe_export_charges_csv`

```json
{
  "tool": "stripe-tools.stripe_export_charges_csv",
  "params": {
    "from": "2026-04-01T00:00:00Z",
    "to":   "2026-04-30T23:59:59Z"
  }
}
```

Returns:

```json
{
  "path": "C:\\Users\\barry\\AppData\\Local\\Temp\\paperclip-stripe-tools\\main-charges-1743465600-1746075599-2026-04-30T13-12-05-123Z.csv",
  "rowCount": 412,
  "summary": {
    "totalGross": 482300,
    "totalNet": 467239,
    "totalRefunded": 0,
    "totalFee": 15061,
    "currency": "usd"
  }
}
```

Default columns: `id, created, customerEmail, amount, currency, status,
refunded, amountRefunded, fee, net, description`. Override via
`columns: [...]`. Override `outputPath` if you need the file written to a
specific location (the calling skill is responsible for delivering the file
— this plugin just writes it).

## Error codes

| Code | When |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | Calling `companyId` isn't in the resolved account's `allowedCompanies`, or the list is empty. |
| `[EACCOUNT_REQUIRED]` | No `account` param and no `defaultAccount` configured. |
| `[EACCOUNT_NOT_FOUND]` | The requested `account` key isn't configured. |
| `[ECONFIG]` | Account is configured but missing `secretKeyRef`, or the secret didn't resolve. |
| `[EDISABLED]` | Mutation tool called while `allowMutations=false`. |
| `[EINVALID_INPUT]` | Tool params failed validation (missing required, mismatched percentOff/amountOff, bad ISO date, etc.). |
| `[ESTRIPE_AUTH]` | Stripe rejected the API key. Wrong key, wrong mode (live/test), or revoked. |
| `[ESTRIPE_PERM]` | Stripe key lacks scope for the operation. Re-create the restricted key with the scope from the table above. |
| `[ESTRIPE_RATE_LIMIT]` | Stripe rate-limited the request. Retry with backoff. |
| `[ESTRIPE_INVALID_REQUEST]` | Stripe rejected the params (e.g. customer not found, malformed query). |
| `[ESTRIPE_IDEMPOTENCY]` | Idempotency key was reused with different params. |
| `[ESTRIPE_CONNECTION]` | Network error reaching Stripe. |
| `[ESTRIPE_API]` | Stripe-side outage. |
| `[ESTRIPE_MIXED_CURRENCY]` | Active subs span multiple currencies. v0.1.0 doesn't perform FX conversion — fix by configuring single-currency Stripe products, or wait for v0.2.0 with FX. |
| `[ESTRIPE_UNKNOWN]` | Other Stripe error. Look at the wrapped message for detail. |

## Authors

Barry Carr · Tony Allard
