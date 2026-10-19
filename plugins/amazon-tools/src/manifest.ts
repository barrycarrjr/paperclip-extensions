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
function tool(name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = [], options: { writes?: boolean; timeoutMs?: number } = {}): PluginToolDeclaration {
  return { name: `amazon_${name}`, displayName: `Amazon ${name.replace(/_/g, " ")}`, description,
    // Declared on every tool: the host otherwise guesses from the name, and a
    // read named "publish" would be held for approval like a write.
    writes: options.writes ?? false, executionTimeoutMs: options.timeoutMs ?? 70_000,
    parametersSchema: { type: "object", additionalProperties: false, properties: { account: { ...str(40), description: "Configured connection key. May be omitted if this company has exactly one connection." }, ...properties }, required } };
}
const report = { timeoutMs: 120_000 };
export const TOOLS: PluginToolDeclaration[] = [
  tool("test_connection", "Test seller authorization with a one-item Listings Items read.", { marketplaceId }),
  tool("list_settlements", "List Amazon-generated V2 settlement report metadata, not a fictitious settlements endpoint.", { createdSince: time, createdUntil: time, cursor, limit: count("Reports per call, also Amazon's page size.") }),
  tool("get_settlement", "Retrieve a V2 settlement report and projected rows, including deposit date and total amount. reportId is from list_settlements. Continue with offset set to nextOffset until it is null.", { reportId: str(128), offset: offset("TSV row offset. Use nextOffset from the previous call."), limit: count("Most rows returned per call.") }, ["reportId"], report),
  tool("list_financial_events", "Read transactions via Finances 2024-06-19. 180-day maximum, more than two minutes old. Account-wide by default to include US merchant transactions; data may lag 48 hours. Amazon pages hold up to 500 transactions; every one is reachable through nextCursor.", { postedAfter: time, postedBefore: time, marketplaceId, transactionStatus: { type: "string", enum: ["RELEASED", "DEFERRED", "DEFERRED_RELEASED"] }, relatedIdentifierName: { type: "string", enum: ["ORDER_ID", "FINANCIAL_EVENT_GROUP_ID"] }, relatedIdentifierValue: str(128), cursor }, ["postedAfter"]),
  tool("get_balances", "Read current or historical account balances, not a guaranteed bank payout schedule.", { asOfDate: { ...str(10), format: "date" }, cursor }),
  tool("get_inventory_summary", "Read FBA inventory from Inventory API, or merchant live availability from Listings Items. Select fulfillment explicitly. MERCHANT pages hold at most 20 listings. Amazon's FBA page tokens expire 30 seconds after they are issued: continue FBA cursors promptly, narrow with sku, or use the FBA inventory report for a full snapshot.", { fulfillment: { type: "string", enum: ["FBA", "MERCHANT"] }, marketplaceId, sku: str(100), cursor, limit: count("Most records returned per call. MERCHANT also sends it as Amazon's page size, capped at 20.") }, ["fulfillment"]),
  tool("list_orders", "Read Orders 2026-01-01 without BUYER, RECIPIENT, TAX or PAYMENT datasets. Supply exactly one start: createdAfter or lastUpdatedAfter, and only its matching end. Maximum window 730 days; end must be more than two minutes old. Omitted end uses now minus three minutes on the first call, then stays fixed through cursors. Amazon's default usage plan allows a burst of 20 calls, then about one call per 179 seconds.", { createdAfter: { ...time, description: "Start of a maximum 730-day creation window. Required unless lastUpdatedAfter is supplied." }, createdBefore: { ...time, description: "Creation window end, more than two minutes old. Only with createdAfter; omitted end is fixed on the first call." }, lastUpdatedAfter: { ...time, description: "Start of a maximum 730-day update window. Required unless createdAfter is supplied." }, lastUpdatedBefore: { ...time, description: "Update window end, more than two minutes old. Only with lastUpdatedAfter; omitted end is fixed on the first call." }, marketplaceId, cursor, limit: count("Orders per call, also Amazon's page size.") }),
  tool("get_order", "Read order and item summaries with financial totals and fulfillment status, without buyer information or customization.", { orderId: str(19) }, ["orderId"]),
  tool("list_reports", "List only allowlisted report metadata. Continue using the same filters and nextCursor.", { reportType: { type: "string", enum: [...REPORT_TYPES] }, createdSince: time, createdUntil: time, cursor, limit: count("Reports per call, also Amazon's page size.") }, ["reportType"]),
  tool("request_report", "Ask Amazon to generate an allowlisted inventory or sales report. Sales requires dataStartTime within two years and a maximum 30-day window ending more than two minutes ago. Omitted dataEndTime is the earlier of now minus three minutes and start plus 30 days, so delayed approval stays within the limit. Both inventory types refuse dates. This creates a report at Amazon, so it is declared as a write: Paperclip may hold an agent's call for a person to approve, and repeats of the same call in one run replay the first result. No listing, price, order or other business data changes. Settlement reports cannot be requested. Never repeat after an uncertain outcome; list_reports first.", { reportType: { type: "string", enum: REPORT_TYPES.slice(1), description: "Sales and traffic requires dataStartTime. Inventory reports refuse dataStartTime and dataEndTime." }, marketplaceId, dataStartTime: { ...time, description: "Required for GET_SALES_AND_TRAFFIC_REPORT, within two years. Forbidden for inventory reports." }, dataEndTime: { ...time, description: "Sales only: after start, at most 30 days later, more than two minutes old. If omitted, the earlier of now minus three minutes and start plus 30 days. Forbidden for inventory reports." } }, ["reportType"], { writes: true }),
  tool("get_report", "Check an allowlisted report and, if DONE, retrieve projected data. No raw document, URL, buyer PII, or unrestricted report types. TSV reports continue with offset and nextOffset. The sales and traffic report has two independent arrays: pass dateOffset and/or asinOffset for the arrays you want, continuing each from nextDateOffset or nextAsinOffset until it is null. Omitting both reads both from the start.", { reportId: str(128), offset: offset("TSV row offset. For the sales and traffic report, a shorthand that starts both arrays at this offset."), dateOffset: offset("Sales and traffic only: offset into salesAndTrafficByDate."), asinOffset: offset("Sales and traffic only: offset into salesAndTrafficByAsin."), limit: count("Most rows returned per call, per array.") }, ["reportId"], report),
  tool("get_catalog_item", "Read current catalog content for an ASIN. Selected public product attributes only. This is catalog state, not a rendered detail page or attribution of who overrode content.", { asin: str(10), marketplaceId }, ["asin"]),
  tool("get_listing", "Read this seller's submitted attributes, issues and live inventory for comparison with catalog data. No listing edits.", { sku: str(100), marketplaceId }, ["sku"]),
  tool("list_aplus_content", "List A+ document metadata owned by the authorized seller. Brand/marketplace eligibility applies.", { marketplaceId, cursor }),
  tool("get_aplus_content", "Read an A+ document's metadata, module types and bounded text, whole modules per call. Continue with moduleOffset set to nextModuleOffset until it is null. No media downloads or publish operations.", { contentReferenceKey: str(128), marketplaceId, moduleOffset: offset("Module offset. Use nextModuleOffset from the previous call.") }, ["contentReferenceKey"]),
  tool("list_aplus_publish_records", "Find A+ content references associated with an ASIN in one marketplace.", { asin: str(10), marketplaceId, cursor }, ["asin"]),
  tool("get_notification_subscription", "Inspect an existing seller-authorized subscription for one supported Listing Watch notification type. Does not create resources, subscribe or consume events.", { notificationType: { type: "string", enum: [...NOTIFICATIONS] }, payloadVersion: str(16) }, ["notificationType"]),
  tool("list_notification_destinations", "Inspect existing application-level destinations using grantless Notifications auth. Returns IDs and resource types only; does not reveal resource ARNs or ingest events.", { cursor }),
];
const SETUP = `# Amazon Seller Tools setup

1. Register as a private SP-API developer for your own seller account and self-authorize your app. Do not use the operator's Claude login. Obtain LWA client ID, client secret and refresh token. AWS IAM credentials and SigV4 are not required for SP-API.
2. Grant Finance and Accounting, Amazon Fulfillment, Inventory and Order Tracking, Product Listing, Brand Analytics and (for ANY_OFFER_CHANGED inspection) Pricing as needed. These Amazon roles can include writes; this plugin exposes only fixed reads plus report generation. Do not request restricted roles. Orders 2026-01-01 gates buyer and recipient data by those roles alone, with no Restricted Data Token step, and this plugin never asks for that data. Brand Analytics and A+ eligibility depend on Amazon account approval.
3. On the Secrets page of each company that will use the connection, create a secret, for example AMAZON_SP_API_CREDENTIALS. Its value is JSON with exactly clientId, clientSecret, refreshToken and sellerId string fields. The settings form cannot create secrets: its Encrypted LWA credentials JSON field picks an existing secret of the company or takes a pasted secret ID. Never paste raw credentials into a plain config field. Saving stores a reference; the plugin has no credentials read-back action.
4. In Configuration, add one connection per seller and pick that secret. Choose NA, EU or FE and marketplace IDs in that region. Select explicit allowed companies. Missing, empty, wildcard or malformed lists deny access. The referenced secret must belong to the calling company. Use separate connection entries and company-owned secrets when different companies need access.
5. Save. Configuration validation is local only. From an allowed company's agent call amazon_test_connection; it resolves the secret inside the worker and reads one listing. Health reports worker readiness, not Amazon connectivity. A successful connection test does not prove every optional role.
6. amazon_request_report is declared as a write because it creates a report at Amazon. Under Paperclip's default policy for writes without an action category, an agent's call waits for a person to approve it. All other tools are declared reads.
7. Provision any Notifications destination/subscription outside this plugin under your own approved process. Inspection needs subscriptions for this same app and seller. No SQS receive/delete, EventBridge consumer, resource creation or event ingestion ships here.

Ads uses separate authentication and remains phase 2. See README for exact endpoints, bounds and account prerequisites.`;
const manifest: PaperclipPluginManifestV1 & { setupInstructions: string } = {
  id: "amazon-tools", apiVersion: 1, version: "0.1.0", displayName: "Amazon Seller Tools",
  description: "Read-only seller finance, reports, inventory, orders, catalog, A+ and existing Notifications inspection via SP-API, plus allowlisted report generation.",
  author: "Barry Carr & Tony Allard", categories: ["connector", "automation"], setupInstructions: SETUP,
  capabilities: ["agent.tools.register", "instance.settings.register", "secrets.read-ref", "http.outbound", "activity.log.write"],
  entrypoints: { worker: "./dist/worker.js" }, tools: TOOLS,
  instanceConfigSchema: {
    type: "object", additionalProperties: false, required: ["accounts"],
    properties: { accounts: { type: "array", title: "Seller connections", maxItems: 20, items: {
      type: "object", additionalProperties: false, required: ["key", "credentialsRef", "region", "marketplaceIds", "allowedCompanies"],
      properties: {
        key: { ...str(40), pattern: "^[a-z0-9][a-z0-9-]*$", title: "Connection key" },
        credentialsRef: { ...str(128), format: "secret-ref", title: "Encrypted LWA credentials JSON", description: "Pick a company secret created on the Secrets page, holding clientId, clientSecret, refreshToken and sellerId. Only its reference is saved in configuration." },
        region: { type: "string", enum: ["NA", "EU", "FE"], title: "SP-API region" },
        marketplaceIds: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { ...str(32), pattern: "^[A-Z0-9]+$" }, title: "Marketplace IDs", description: "Up to ten marketplace IDs served by the selected SP-API region." },
        allowedCompanies: { type: "array", uniqueItems: true, items: { type: "string", format: "company-id" }, title: "Allowed companies", description: "Explicit companies only. Empty or wildcard denies access. Credentials must belong to each calling company." },
      },
    } } },
  },
};
export default manifest;
