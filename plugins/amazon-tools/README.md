# Amazon Seller Tools (paperclip plugin)

Read-only access to a seller's own Amazon Seller Central data through the
Selling Partner API (SP-API): orders without buyer details, FBA and
merchant-fulfilled inventory, settlements, financial events and reports.
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

- **v0.1.0** - First release. Ten read-only tools (accounts, orders, order detail, settlements, settlement detail, financial events, inventory, request/list/get report), connection test via **Test Configuration**, activity entry per tool call, back-off on Amazon throttling, buyer details kept out of agent context. Amazon Advertising is not included yet.

## What agents get, and what they don't

| Data | Tool | Notes |
|---|---|---|
| Seller accounts | `amazon_list_accounts` | Only accounts the calling company may use. No credentials. |
| Orders | `amazon_list_orders`, `amazon_get_order` | Allowlisted fields only. No buyer name, email, phone, street, city or postal code. Ship-to is reduced to state/region and country. Gift messages are dropped. |
| Settlements / payouts | `amazon_list_settlements`, `amazon_get_settlement` | Financial event groups. The payout bank account tail is dropped. |
| Financial events | `amazon_list_financial_events` | Shipments, refunds, fees, adjustments by posted date. Empty event lists are removed and each list is capped. |
| Inventory | `amazon_get_inventory_summary` | `fba` (default) or `merchant` (per SKU, needs the seller ID). |
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

## Setup (summary)

1. **Register as a private developer** in Seller Central (Apps and Services
   → Develop Apps). Request only: Finance and Accounting; Inventory and Order
   Tracking; optionally Selling Partner Insights (sales and traffic) and
   Product Listing (only for merchant-fulfilled inventory; Amazon bundles
   read and write in that role, the plugin only reads). Do not request any
   buyer-PII role.
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
   | Seller ID | merchant token; only for merchant inventory |
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
