import type { PaperclipPluginManifestV1, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

export const REPORT_TYPES = ["GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2", "GET_FLAT_FILE_OPEN_LISTINGS_DATA", "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA", "GET_SALES_AND_TRAFFIC_REPORT"] as const;
export const NOTIFICATIONS = ["ANY_OFFER_CHANGED", "LISTINGS_ITEM_STATUS_CHANGE", "LISTINGS_ITEM_ISSUES_CHANGE", "BRANDED_ITEM_CONTENT_CHANGE"] as const;
// Each call finishes its own work this long before the host stops waiting, so
// an interrupted report request is reported as uncertain, never lost.
export const TIMEOUT_MARGIN_MS = 20_000;
const str = (maxLength = 256) => ({ type: "string", minLength: 1, maxLength });
const time = { ...str(35), format: "date-time" };
const count = (description = "Most records returned per call.") => ({ type: "integer", minimum: 1, maximum: 100, default: 25, description });
const offset = (description: string) => ({ type: "integer", minimum: 0, maximum: 100000, description });
const marketplaceId = { ...str(32), description: "One configured marketplace. Required when the connection has more than one." };
const cursor = { ...str(64), description: "Opaque nextCursor from this tool, company, connection and exact query; repeat the other arguments unchanged. Each new cursor is valid for up to 15 minutes. Amazon's provider tokens have separate lifetimes: FBA 30 seconds (plugin uses 25), Orders 24 hours. EPAGE_EXPIRED means the next provider page needs an expired token; cached records remain readable within the local cursor lifetime." };
// Accepted legacy spellings are normalized before the strict service schema.
// Unsupported legacy filters deliberately return an actionable ECOMPAT error.
function legacyParameters(name:string):Record<string,unknown> {
  const token={...str(16000),description:"Rejected: restart with opaque cursor; provider tokens have no caller binding."};
  const many={type:"array",maxItems:100,items:str(256)};
  switch(name) {
    case "get_order": return {includeItems:{type:"boolean",description:"Legacy true is accepted; false returns ECOMPAT because this tool always includes safe item summaries."}};
    case "list_orders": return {marketplaceIds:many,maxResults:count(),nextToken:token,orderStatuses:many,fulfillmentChannels:many};
    case "list_settlements": return {maxResults:count(),nextToken:token,startedAfter:time,startedBefore:time};
    case "get_settlement": return {settlementId:{...str(128),description:"Rejected financial event group ID. Use list_settlements for reportId, or list_financial_events with an explicit group filter."},maxPerType:count(),nextToken:token};
    case "list_financial_events": return {maxPerType:count(),nextToken:token};
    case "get_inventory_summary": return {channel:{type:"string",enum:["fba","merchant"]},skus:many,nextToken:token};
    case "request_report": return {marketplaceIds:many,reportOptions:{type:"object",description:"Rejected: report options are fixed for safety."}};
    case "list_reports": return {reportTypes:many,processingStatuses:many,nextToken:token,pageSize:count(),maxResults:count()};
    case "list_listings": return {pageSize:count(),maxResults:count(),nextToken:token};
    default:return {};
  }
}
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = [], options: { writes?: boolean; timeoutMs?: number } = {}): PluginToolDeclaration {
  return { name: `amazon_${name}`, displayName: `Amazon ${name.replace(/_/g, " ")}`, description,
    // Declared on every tool: the host otherwise guesses from the name, and a
    // read named "publish" would be held for approval like a write.
    writes: options.writes ?? false, executionTimeoutMs: options.timeoutMs ?? 70_000,
    parametersSchema: { type: "object", additionalProperties: false,
      properties: { account: { ...str(40), description: "Configured connection key. Defaults to configured defaultAccount or the company's only connection." }, ...legacyParameters(name), ...properties }, required } };
}
const report = { timeoutMs: 120_000 };
export const TOOLS: PluginToolDeclaration[] = [
  tool("list_accounts", "List currently authorized seller connections without credential references."),
  tool("list_listings", "Search seller listings in one marketplace. Whole records and scoped opaque cursors.", {marketplaceId,cursor,limit:count()}),
  tool("get_item_offers", "Read new-condition offers and Buy Box evidence without locations or feedback.", {asin:str(10),marketplaceId}, ["asin"]),
  tool("list_listing_changes", "Read company-owned Listing Watch changes and recent checks. Legacy unowned history is retained privately, never inferred. Repeat filters unchanged with nextCursor.", {since:{...time,description:"Defaults to seven days ago, then fixed through the cursor chain."},marketplaceId,sku:str(100),asin:str(10),field:str(100),cursor,limit:count()}),
  tool("test_connection", "Test seller authorization with a one-item Listings Items read.", { marketplaceId }),
  tool("list_settlements", "List Amazon-generated V2 settlement report metadata, not a fictitious settlements endpoint.", { createdSince: time, createdUntil: time, cursor, limit: count("Reports per call, also Amazon's page size.") }),
  tool("get_settlement", "Retrieve a V2 settlement report and projected rows, including deposit date and total amount. reportId is from list_settlements. Continue with offset set to nextOffset until it is null.", { reportId: str(128), offset: offset("TSV row offset. Use nextOffset from the previous call."), limit: count("Most rows returned per call.") }, [], report),
  tool("list_financial_events", "Read transactions via Finances 2024-06-19. 180-day maximum, more than two minutes old. Account-wide by default to include US merchant transactions; data may lag 48 hours. Amazon pages hold up to 500 transactions; every one is reachable through nextCursor.", { postedAfter: time, postedBefore: time, marketplaceId, transactionStatus: { type: "string", enum: ["RELEASED", "DEFERRED", "DEFERRED_RELEASED"] }, relatedIdentifierName: { type: "string", enum: ["ORDER_ID", "FINANCIAL_EVENT_GROUP_ID"] }, relatedIdentifierValue: str(128), cursor }, ["postedAfter"]),
  tool("get_balances", "Read current or historical account balances, not a guaranteed bank payout schedule.", { asOfDate: { ...str(10), format: "date" }, cursor }),
  tool("get_inventory_summary", "Read FBA inventory from Inventory API, or merchant live availability from Listings Items. Select fulfillment explicitly. MERCHANT pages hold at most 20 listings. Amazon's FBA page tokens expire 30 seconds after they are issued: continue FBA cursors promptly, narrow with sku, or use the FBA inventory report for a full snapshot.", { fulfillment: { type: "string", enum: ["FBA", "MERCHANT"] }, marketplaceId, sku: str(100), cursor, limit: count("Most records returned per call. MERCHANT also sends it as Amazon's page size, capped at 20.") }, []),
  tool("list_orders", "Read Orders 2026-01-01 without BUYER, RECIPIENT, TAX or PAYMENT datasets. Supply exactly one start: createdAfter or lastUpdatedAfter, and only its matching end. Maximum window 730 days; end must be more than two minutes old. Omitted end uses now minus three minutes on the first call, then stays fixed through cursors. Amazon's default usage plan allows a burst of 20 calls, then about one call per 179 seconds.", { createdAfter: { ...time, description: "Start of a maximum 730-day creation window. Required unless lastUpdatedAfter is supplied." }, createdBefore: { ...time, description: "Creation window end, more than two minutes old. Only with createdAfter; omitted end is fixed on the first call." }, lastUpdatedAfter: { ...time, description: "Start of a maximum 730-day update window. Required unless createdAfter is supplied." }, lastUpdatedBefore: { ...time, description: "Update window end, more than two minutes old. Only with lastUpdatedAfter; omitted end is fixed on the first call." }, marketplaceId, cursor, limit: count("Orders per call, also Amazon's page size.") }),
  tool("get_order", "Read order and item summaries with financial totals and fulfillment status, without buyer information or customization.", { orderId: str(19) }, ["orderId"]),
  tool("list_reports", "List only allowlisted report metadata. Continue using the same filters and nextCursor.", { reportType: { type: "string", enum: [...REPORT_TYPES] }, createdSince: time, createdUntil: time, cursor, limit: count("Reports per call, also Amazon's page size.") }, []),
  tool("request_report", "Ask Amazon to generate an allowlisted inventory or sales report. Sales requires dataStartTime within two years and a maximum 30-day window ending more than two minutes ago. Omitted dataEndTime is the earlier of now minus three minutes and start plus 30 days, so delayed approval stays within the limit. Both inventory types refuse dates. This creates a report at Amazon, so it is declared as a write: Paperclip may hold an agent's call for a person to approve, and repeats of the same call in one run replay the first result. No listing, price, order or other business data changes. Settlement reports cannot be requested. Never repeat after an uncertain outcome; list_reports first.", { reportType: { type: "string", enum: REPORT_TYPES.slice(1), description: "Sales and traffic requires dataStartTime. Inventory reports refuse dataStartTime and dataEndTime." }, marketplaceId, dataStartTime: { ...time, description: "Required for GET_SALES_AND_TRAFFIC_REPORT, within two years. Forbidden for inventory reports." }, dataEndTime: { ...time, description: "Sales only: after start, at most 30 days later, more than two minutes old. If omitted, the earlier of now minus three minutes and start plus 30 days. Forbidden for inventory reports." } }, ["reportType"], { writes: true }),
  tool("get_report", "Check an allowlisted report and, if DONE, retrieve projected data. No raw document, URL, buyer PII, or unrestricted report types. TSV reports continue with offset and nextOffset. The sales and traffic report has two independent arrays: pass dateOffset and/or asinOffset for the arrays you want, continuing each from nextDateOffset or nextAsinOffset until it is null. Omitting both reads both from the start.", { reportId: str(128), offset: offset("TSV row offset. For the sales and traffic report, a shorthand that starts both arrays at this offset."), dateOffset: offset("Sales and traffic only: offset into salesAndTrafficByDate."), asinOffset: offset("Sales and traffic only: offset into salesAndTrafficByAsin."), limit: {...count("Legacy 101 to 500 clamps to 100 whole rows; continue using next offsets."),maximum:500} }, ["reportId"], report),
  tool("get_catalog_item", "Read current catalog content for an ASIN. Selected public product attributes only. This is catalog state, not a rendered detail page or attribution of who overrode content.", { asin: str(10), marketplaceId }, ["asin"]),
  tool("get_listing", "Read this seller's submitted attributes, issues and live inventory for comparison with catalog data. No listing edits.", { sku: str(100), marketplaceId }, ["sku"]),
  tool("list_aplus_content", "List A+ document metadata owned by the authorized seller. Brand/marketplace eligibility applies.", { marketplaceId, cursor }),
  tool("get_aplus_content", "Read an A+ document's metadata, module types and bounded text, whole modules per call. Continue with moduleOffset set to nextModuleOffset until it is null. No media downloads or publish operations. Legacy asin instead of contentReferenceKey reads at most five complete documents; larger results need the reference and offset tools.", { contentReferenceKey: str(128), marketplaceId, moduleOffset: offset("Module offset. Use nextModuleOffset from the previous call.")  , asin:str(10)}, []),
  tool("list_aplus_publish_records", "Find A+ content references associated with an ASIN in one marketplace.", { asin: str(10), marketplaceId, cursor }, ["asin"]),
  tool("get_notification_subscription", "Inspect an existing seller-authorized subscription for one supported Listing Watch notification type. Does not create resources, subscribe or consume events.", { notificationType: { type: "string", enum: [...NOTIFICATIONS] }, payloadVersion: str(16) }, ["notificationType"]),
  tool("list_notification_destinations", "Inspect existing application-level destinations using grantless Notifications auth. Returns IDs and resource types only; does not reveal resource ARNs or ingest events.", { cursor }),
];
const SETUP = `# Amazon Seller Tools setup

1. Register as a private SP-API developer for your own seller account and self-authorize your app. Do not use an operator's assistant login. Obtain LWA client ID, client secret and refresh token. AWS IAM credentials and SigV4 are not required for SP-API.
2. Grant Finance and Accounting, Amazon Fulfillment, Inventory and Order Tracking, Product Listing, Brand Analytics and (for ANY_OFFER_CHANGED inspection) Pricing as needed. These Amazon roles can include writes; this plugin exposes only fixed reads plus report generation. Do not request restricted roles. Orders 2026-01-01 gates buyer and recipient data by those roles alone, with no Restricted Data Token step, and this plugin never asks for that data. Brand Analytics and A+ eligibility depend on Amazon account approval.
3. On the Secrets page of each company that will use the connection, create a secret, for example AMAZON_SP_API_CREDENTIALS. Its value is JSON with exactly clientId, clientSecret, refreshToken and sellerId string fields. The settings form cannot create secrets: its Encrypted LWA credentials JSON field picks an existing secret of the company or takes a pasted secret ID. Never paste raw credentials into a plain config field. Saving stores a reference; the plugin has no credentials read-back action.
4. In Configuration, add one connection per seller and pick that secret. Choose NA, EU or FE and marketplace IDs in that region. Select explicit allowed companies. Missing, empty, wildcard or malformed lists deny access. The referenced secret must belong to the calling company. Use separate connection entries and company-owned secrets when different companies need access.
5. Save. Configuration validation is local only. From an allowed company's agent call amazon_test_connection; it resolves the secret inside the worker and reads one listing. Health reports worker readiness, not Amazon connectivity. A successful connection test does not prove every optional role.
6. amazon_request_report is declared as a write because it creates a report at Amazon. Under Paperclip's default policy for writes without an action category, an agent's call waits for a person to approve it. All other tools are declared reads.
7. Provision any Notifications destination/subscription outside this plugin under your own approved process. Inspection needs subscriptions for this same app and seller. No SQS receive/delete, EventBridge consumer, resource creation or event ingestion ships here.

Upgrade from deployed 0.2.0: the same nine capabilities mean automatic activation on stored config, with no approval pause. Correct every entry BEFORE upgrading, or disable the old watch first. New installs or 0.1.0 capability escalation can require approval. Existing lowercase regions, name, defaultAccount, three secret references and explicit listingWatch switches are accepted after strict validation. Legacy sellerId is now mandatory even for finance-only entries; keys must be unique lowercase alphanumeric/hyphen strings up to 40 characters; update stale defaultAccount and replace wildcard allowlists. Bounds: 20 accounts, 20 explicit company IDs, 10 unique marketplaces, 120-character names, no unknown fields. One bad entry rejects all accounts. Configuration is never rewritten. Never combine credentialsRef with legacy credential fields. All references must belong to the calling company. Wildcards must be replaced with explicit company IDs. Old unowned watch rows stay retained and private; 0.3.0 starts fresh company-owned baselines. Listing Watch has a 240-second total work budget and at most 100 enumeration pages and 2,000 listings plus 4 MiB snapshot/change bounds; local budget or required-read failures preserve prior snapshots; optional provider/source unavailability can save known evidence with complete:false and coverage counts. Read health for the latest status/content check of every configured marketplace, including missing, failed or degraded checks. Long selected watch text uses a prefix and full-text hash; unknown sources preserve prior evidence, while absent fields from successful sources are observed empty values. See README compatibility rules.

A+ monitoring records document name/status and hashes complete selected text plus supported image upload identity, alternative text and crop dimensions before display cuts. A module with more than 50 text items or more than 32 KiB of display strings can still be monitored; public content tools keep their 50-text limit and truncated flag. Hash bounds remain 256 KiB of selected UTF-8 text, 2,000 visited nodes, 24 levels and 100 children per declared array, with at most 100 modules and ten module pages per document; exceeding them fails the check without replacing its earlier snapshot. Image identity is never returned in clear. Comparison deliberately excludes videos, video thumbnails, standard comparison-table ASINs, highlight flags, decorator types/content (only declared structure presence can affect the hash), image position/color options, raw URLs and unknown fields. Full 0.2.0 raw-module comparison parity is not claimed.

Sellers without A+ eligibility will see every content check incomplete and every content job failed. Without the Pricing role, every status check is incomplete and every status job fails. Any ASIN-less listing makes both checks incomplete and both jobs fail on every run until resolved.

Before enabling Listing Watch, an operator must run amazon_list_listings from an allowed company for a known issue-free listing in each marketplace and inspect the returned issues key. It must be present as an empty array. If it is omitted, leave the watch disabled and report the response shape for review; the current conservative handling marks the status check incomplete. This live acceptance check has not been run.

An unchanged limitation: a provider 429 with Retry-After above ten seconds blocks its operation bucket; a later local refusal can be counted as budget, aborting the check without saving other evidence.

Ads uses separate authentication and remains phase 2. See README for exact endpoints, bounds and account prerequisites.`;
const manifest: PaperclipPluginManifestV1 & { setupInstructions: string } = {
  id: "amazon-tools", apiVersion: 1, version: "0.3.0", displayName: "Amazon Seller Tools",
  description: "Company-scoped seller reads and Listing Watch via SP-API, plus governed allowlisted report generation.",
  author: "Paperclip contributors", categories: ["connector", "automation"], setupInstructions: SETUP,
  capabilities: ["agent.tools.register", "instance.settings.register", "secrets.read-ref", "http.outbound", "activity.log.write", "database.namespace.read", "database.namespace.write", "database.namespace.migrate", "jobs.schedule"],
  database:{namespaceSlug:"amazon",migrationsDir:"migrations"},
  jobs:[{jobKey:"listing_watch_status",displayName:"Listing Watch status",schedule:"17 */6 * * *"},{jobKey:"listing_watch_content",displayName:"Listing Watch content",schedule:"43 7 * * *"}],
  entrypoints: { worker: "./dist/worker.js" }, tools: TOOLS,
  instanceConfigSchema: {
    type: "object", additionalProperties: false, required: ["accounts"],
    properties: { defaultAccount:{...str(40),title:"Default account"}, accounts: { type: "array", title: "Seller connections", maxItems: 20, items: {
      type: "object", additionalProperties: false, required: ["key", "region", "marketplaceIds", "allowedCompanies"],
      properties: {
        name:{...str(120),title:"Account name"},
        listingWatch:{type:"boolean",default:false,title:"Listing Watch",description:"Off unless explicitly enabled. Each allowed company must own all credential references."},
        sellerId:{...str(64),title:"Legacy seller ID"},
        lwaClientIdRef:{...str(128),format:"secret-ref",title:"Legacy LWA client ID reference"},
        lwaClientSecretRef:{...str(128),format:"secret-ref",title:"Legacy LWA client secret reference"},
        refreshTokenRef:{...str(128),format:"secret-ref",title:"Legacy refresh token reference"},
        key: { ...str(40), pattern: "^[a-z0-9][a-z0-9-]*$", title: "Connection key" },
        credentialsRef: { ...str(128), format: "secret-ref", title: "Encrypted LWA credentials JSON", description: "Pick a company secret created on the Secrets page, holding clientId, clientSecret, refreshToken and sellerId. Only its reference is saved in configuration." },
        region: { type: "string", enum: ["NA", "EU", "FE", "na", "eu", "fe"], title: "SP-API region" },
        marketplaceIds: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { ...str(32), pattern: "^[A-Z0-9]+$" }, title: "Marketplace IDs", description: "Up to ten marketplace IDs served by the selected SP-API region." },
        allowedCompanies: { type: "array", maxItems:20, uniqueItems: true, items: { type: "string", format: "company-id" }, title: "Allowed companies", description: "Explicit companies only. Empty or wildcard denies access. Credentials must belong to each calling company." },
      },
    } } },
  },
};
export default manifest;
