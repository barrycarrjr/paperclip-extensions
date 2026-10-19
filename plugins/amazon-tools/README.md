# Amazon Seller Tools (paperclip plugin)

Read-only access to a seller's own Amazon Seller Central data through the
Selling Partner API (SP-API): orders without buyer details, FBA and
merchant-fulfilled inventory, settlements, financial events, reports,
listings, catalog content, offers and A+ content, plus **Listing Watch**:
scheduled snapshots of every listing with a log of what changed.
Multi-account, per-account `allowedCompanies`.

**The plugin never writes to Amazon.** Every SP-API call goes through one
request function that only allows the GET operations below, plus
`createReport` (asking Amazon to build a report, which changes nothing in the
seller account). Any other method or path fails with `[EWRITE_BLOCKED]`
before a request is sent, even if the app's roles would allow it.

Built for a seller registered as a **private developer** for their own
Seller Central account: no public app listing and no third-party
authorization flow.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool/event shapes.

## Recent changes

- **v0.2.0** - Listing tools and Listing Watch. Six new read-only tools: `amazon_list_listings`, `amazon_get_listing` (with the content you submitted), `amazon_get_catalog_item` (what Amazon shows), `amazon_get_item_offers` (Buy Box and other sellers), `amazon_get_aplus_content`, `amazon_list_listing_changes`. Two scheduled jobs snapshot every listing (status, issues, price, Buy Box every 6 hours; content, images, category and A+ daily) into the plugin's own tables and record each changed field. New per-account **Listing Watch** switch. New capabilities: plugin database and scheduled jobs. Needs the Product Listing and Pricing roles and the account's Seller ID.
- **v0.1.0** - First release. Ten read-only tools (accounts, orders, order detail, settlements, settlement detail, financial events, inventory, request/list/get report), connection test via **Test Configuration**, activity entry per tool call, back-off on Amazon throttling, buyer details kept out of agent context. Amazon Advertising is not included yet.

## What agents get, and what they don't

| Data | Tool | Notes |
|---|---|---|
| Seller accounts | `amazon_list_accounts` | Only accounts the calling company may use. No credentials. |
| Orders | `amazon_list_orders`, `amazon_get_order` | Allowlisted fields only. No buyer name, email, phone, street, city or postal code. Ship-to is reduced to state/region and country. Gift messages are dropped. |
| Settlements / payouts | `amazon_list_settlements`, `amazon_get_settlement` | Financial event groups. The payout bank account tail is dropped. |
| Financial events | `amazon_list_financial_events` | Shipments, refunds, fees, adjustments by posted date. Empty event lists are removed and each list is capped. |
| Inventory | `amazon_get_inventory_summary` | `fba` (default) or `merchant` (per SKU, needs the seller ID). |
| Listings | `amazon_list_listings`, `amazon_get_listing` | Status, issues, price, fulfillment quantity, and the title, bullets, description, search terms and brand you submitted. Needs the Seller ID. |
| Detail page | `amazon_get_catalog_item` | What Amazon shows: title, brand, category, product type, bullets, description, images, sales ranks. |
| Offers / Buy Box | `amazon_get_item_offers` | New-condition offers: Buy Box holder (us, other, none) and price, offer count, each seller's price and FBA flag. |
| A+ content | `amazon_get_aplus_content` | Published A+ documents with status, badges, module types and a change fingerprint. Needs Brand Registry. |
| Listing changes | `amazon_list_listing_changes` | Reads Listing Watch's change log and last checks from the plugin's own tables. Never calls Amazon. |
| Reports | `amazon_request_report`, `amazon_list_reports`, `amazon_get_report` | Allowlisted report types only (below). Columns with buyer contact or address details are removed from table reports. |

Restricted data (buyer PII) is never requested, so no Restricted Data Token
is needed and none is ever created.

### Allowed report types

| Report type | Requestable |
|---|---|
| `GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2` | No, Amazon creates it each settlement period. Find it with `amazon_list_reports`. |
| `GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA` | Yes (city and postal columns are removed) |
| `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` | Yes |
| `GET_FBA_MYI_ALL_INVENTORY_DATA` | Yes |
| `GET_AFN_INVENTORY_DATA` | Yes |
| `GET_FBA_REIMBURSEMENTS_DATA` | Yes |
| `GET_FBA_STORAGE_FEE_CHARGES_DATA` | Yes |
| `GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA` | Yes |
| `GET_MERCHANT_LISTINGS_ALL_DATA` | Yes |
| `GET_FLAT_FILE_OPEN_LISTINGS_DATA` | Yes |
| `GET_SALES_AND_TRAFFIC_REPORT` | Yes, with `reportOptions` `dateGranularity` / `asinGranularity` |

Order reports are deliberately absent: with the wrong roles they can carry
buyer details. `amazon_get_report` also refuses to read a report of any other
type, including one created outside Paperclip.

## Listing Watch

Turn on **Listing Watch** for an account (it needs the **Seller ID**, your
Merchant Token). Two scheduled jobs then snapshot every listing and record
each field that differs from the previous snapshot. They only read from
Amazon: no AWS account, no push notifications.

| Job | When (UTC) | Fields |
|---|---|---|
| `listing_watch_status` | every 6 hours at :17 | `status`, `issues`, `title`, `mainImage`, `ourPrice`, `buyBoxHolder`, `buyBoxPrice`, `offerCount`, `otherSellers` |
| `listing_watch_content` | daily at 07:43 | `submittedTitle`, `liveTitle`, `titleOverridden`, `submittedBullets`, `liveBullets`, `submittedDescription`, `searchTerms`, `brand`, `category`, `productType`, `images`, `aplus` |

- The first run of each job saves a baseline and records nothing.
- A listing that appears or disappears after the baseline is recorded as field `listing` (`added` / `removed`).
- If the offers call fails for an ASIN, the previous Buy Box values are kept, so a failure never looks like a lost Buy Box.
- If A+ content is refused (no Brand Registry), A+ is skipped for that run and noted, never recorded as removed.
- Calls are paced to Amazon's published rates (offers about one every 2 seconds), so a large catalog takes a while.

Storage, in the plugin's database namespace (slug `amazon`):
`listing_snapshots` (latest snapshot per SKU and check), `listing_changes`
(one row per changed field) and `listing_watch_runs` (one row per check).

## Setup (summary)

1. **Register as a private developer** in Seller Central (Apps and Services
   → Develop Apps). Request only: Finance and Accounting; Inventory and Order
   Tracking; optionally Selling Partner Insights (sales and traffic),
   Product Listing (listings, catalog content, A+ content and
   merchant-fulfilled inventory; Amazon bundles read and write in that role,
   the plugin only reads) and Pricing (offers and Buy Box). Do not request
   any buyer-PII role.
2. **Create an SP API app client** with the same roles, copy its LWA client
   ID and client secret, then **Authorize** it to get a refresh token
   (`Atzr|...`). Re-authorize after any role change.
3. **Create three Paperclip secrets** in the owning company (e.g.
   `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`,
   `AMAZON_REFRESH_TOKEN`) and copy their UUIDs.
4. **Configure the plugin**. Under **Seller accounts** add one item:

   | Field | Value |
   |---|---|
   | Display name | e.g. "Demo Store" |
   | Identifier | e.g. `demo-store` (agents pass this as `account`) |
   | Allowed companies | the company that owns the store |
   | Region | `na`, `eu` or `fe` |
   | Marketplace IDs | e.g. `ATVPDKIKX0DER` (US); the first is the default |
   | Seller ID | merchant token; needed for listings, merchant inventory and Listing Watch |
   | Listing Watch | on to snapshot listings on a schedule |
   | LWA client ID / client secret / refresh token | the three secret UUIDs |

   Set **Default account**, save, wait 30 seconds, then click **Test
   Configuration**. It signs in to Amazon and checks that each marketplace ID
   belongs to the account.

Credentials stay inside the plugin worker. Short-lived LWA access tokens are
cached in memory only, per company and account, and refreshed a minute
before they expire. Tool output, errors, activity entries and logs never
contain a secret value; any value Amazon echoes back is replaced with
`[REDACTED]`.

## Tool reference

Every tool takes an optional `account` (the Identifier). Without it the
default account is used, and if only one account exists, that one. The
calling company (`runContext.companyId`) must be in the account's Allowed
companies.

Sample invocation (through `POST /api/plugins/tools/execute`):

```json
{
  "tool": "amazon-tools:amazon_list_orders",
  "parameters": { "account": "demo-store", "createdAfter": "2026-01-01T00:00:00Z", "orderStatuses": ["Shipped"] },
  "runContext": { "agentId": "<agent uuid>", "runId": "<run uuid>", "companyId": "<company uuid in allowedCompanies>" }
}
```

| Tool | Parameters | Returns |
|---|---|---|
| `amazon_list_accounts` | none | `{ accounts: [{ account, name, region, marketplaceIds, isDefault }] }` |
| `amazon_list_orders` | `createdAfter` (default 7 days ago), `createdBefore`, `lastUpdatedAfter`, `orderStatuses[]`, `fulfillmentChannels[]` (`AFN`/`MFN`), `marketplaceIds[]`, `maxResults` (1-100, default 50), `nextToken` | `{ orders, nextToken }` |
| `amazon_get_order` | `orderId` (required), `includeItems` (default true) | `{ order, items }` |
| `amazon_list_settlements` | `startedAfter` (default 90 days ago), `startedBefore`, `maxResults`, `nextToken` | `{ settlements, nextToken }` |
| `amazon_get_settlement` | `settlementId` (required), `maxPerType` (1-100, default 25), `nextToken` | `{ counts, events, truncated, nextToken }` |
| `amazon_list_financial_events` | `postedAfter` (required without `nextToken`), `postedBefore` (capped to 3 minutes ago), `maxPerType`, `nextToken` | `{ counts, events, truncated, nextToken }` |
| `amazon_get_inventory_summary` | `channel` (`fba` default, or `merchant`), `skus[]` (FBA up to 50; merchant required, up to 20), `marketplaceId`, `nextToken` | `{ channel, marketplaceId, items, nextToken }` |
| `amazon_request_report` | `reportType` (required, requestable types above), `dataStartTime`, `dataEndTime`, `marketplaceIds[]`, `reportOptions` | `{ reportId, reportType }` |
| `amazon_list_reports` | `reportTypes[]` (default all allowed types), `processingStatuses[]`, `createdSince`, `pageSize` (1-100, default 20), `nextToken` | `{ reports, nextToken }` |
| `amazon_get_report` | `reportId` (required), `offset` (default 0), `limit` (1-500, default 100) | Status while building; once `DONE`: `{ report, format, totalRows, columns, rows, truncated }` |
| `amazon_list_listings` | `marketplaceId`, `pageSize` (1-20, default 20), `nextToken` | `{ marketplaceId, listings, total, nextToken }` |
| `amazon_get_listing` | `sku` (required), `marketplaceId` | `{ marketplaceId, listing }`, with `listing.submitted` |
| `amazon_get_catalog_item` | `asin` (required), `marketplaceId` | `{ marketplaceId, item }` |
| `amazon_get_item_offers` | `asin` (required), `marketplaceId` | `{ marketplaceId, asin, totalOfferCount, buyBox, offers }` |
| `amazon_get_aplus_content` | `asin` (required), `marketplaceId` | `{ marketplaceId, asin, documents }` |
| `amazon_list_listing_changes` | `since` (default 7 days ago), `sku`, `asin`, `field`, `limit` (1-500, default 100) | `{ since, changes, recentChecks }` |

Typical report flow: `amazon_request_report` → poll `amazon_get_report`
every minute or two until `processingStatus` is `DONE` → page through rows
with `offset`.

Each tool call (success or failure) writes one activity entry in the
calling company: e.g. "Amazon list orders (demo-store)", with the tool name,
account, agent, run and a small result summary such as a row count or error
code. No parameters that could carry personal data, and no secrets.

## Rate limits

SP-API throttles each operation separately. On HTTP 429 (and 500/503) the
plugin retries up to 4 times, honouring `Retry-After` when Amazon sends it,
otherwise backing off exponentially (1s, 2s, 4s, 8s, capped at 15s, with
jitter). If Amazon is still throttling, the tool returns
`[EAMAZON_RATE_LIMIT]`.

## Error codes

| Code | Meaning |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | The calling company is not in the account's Allowed companies, or the list is empty. |
| `[EACCOUNT_REQUIRED]` | No `account` given, no default set, and more than one account configured. |
| `[EACCOUNT_NOT_FOUND]` | No account with that Identifier. |
| `[ECONFIG]` | Account is missing a required field or a secret did not resolve. |
| `[EINVALID_INPUT]` | Bad or missing parameter (date, marketplace not on the account, too many SKUs, disallowed report option). |
| `[EREPORT_TYPE_BLOCKED]` | Report type is not on the allowed list. |
| `[EWRITE_BLOCKED]` | Internal guard: a call that is not on the read-only list was attempted. Should never reach an agent. |
| `[EAMAZON_AUTH]` | Login with Amazon rejected the credentials (`invalid_grant` = refresh token wrong or replaced; `Client authentication failed` = client ID/secret wrong). |
| `[EAMAZON_FORBIDDEN]` | HTTP 401/403: the app lacks the role for that data, or was not re-authorized after a role change. |
| `[EAMAZON_INVALID]` | HTTP 400 from Amazon. |
| `[EAMAZON_NOT_FOUND]` | HTTP 404 (unknown order, report, settlement or SKU). |
| `[EAMAZON_RATE_LIMIT]` | Still throttled after retries. |
| `[EAMAZON_UPSTREAM_<status>]` | Amazon server error after retries. |
| `[EAMAZON_<status>]` | Any other HTTP status. |
| `[EAMAZON_NETWORK]` | Amazon could not be reached. |
| `[EAMAZON_DOCUMENT]` | The report document could not be downloaded. |

## Not included yet

- **Amazon Advertising** (`getAdsReport`): the Ads API has its own
  registration and OAuth, separate from SP-API, so it is left for a later
  version.
