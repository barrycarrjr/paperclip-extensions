import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { REPORT_TYPE_NAMES, REQUESTABLE_REPORT_TYPES } from "./reports.js";

type ToolDecl = NonNullable<PaperclipPluginManifestV1["tools"]>[number];

const account = {
  type: "string",
  description: "Account identifier from the plugin settings. Optional: falls back to the default account.",
} as const;

const nextToken = {
  type: "string",
  description: "Pagination token from a previous call's `nextToken`.",
} as const;

export const TOOL_DEFS: ToolDecl[] = [
  {
    name: "amazon_list_accounts",
    displayName: "List Amazon seller accounts",
    description:
      "List the Amazon seller accounts this company may use, with their region and marketplace IDs. No credentials are returned.",
    parametersSchema: { type: "object", properties: {} },
  },
  {
    name: "amazon_list_orders",
    displayName: "List Amazon orders",
    description:
      "List orders without buyer personal details (no name, address, phone or email; only state/region and country). Defaults to orders created in the last 7 days.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        createdAfter: { type: "string", description: "ISO 8601. Default: 7 days ago. Ignored if lastUpdatedAfter is set." },
        createdBefore: { type: "string", description: "ISO 8601." },
        lastUpdatedAfter: { type: "string", description: "ISO 8601. Use instead of createdAfter to find recently changed orders." },
        orderStatuses: {
          type: "array",
          items: {
            type: "string",
            enum: ["Pending", "Unshipped", "PartiallyShipped", "Shipped", "Canceled", "Unfulfillable", "InvoiceUnconfirmed", "PendingAvailability"],
          },
        },
        fulfillmentChannels: { type: "array", items: { type: "string", enum: ["AFN", "MFN"] }, description: "AFN = FBA, MFN = merchant-fulfilled." },
        marketplaceIds: { type: "array", items: { type: "string" }, description: "Default: all marketplaces on the account." },
        maxResults: { type: "number", description: "1 to 100. Default 50." },
        nextToken,
      },
    },
  },
  {
    name: "amazon_get_order",
    displayName: "Get Amazon order",
    description: "Get one order and its line items, without buyer personal details.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        orderId: { type: "string", description: "Amazon order ID, e.g. 123-1234567-1234567." },
        includeItems: { type: "boolean", description: "Default true." },
      },
      required: ["orderId"],
    },
  },
  {
    name: "amazon_list_settlements",
    displayName: "List Amazon settlements",
    description:
      "List settlement periods (financial event groups): open/closed status, totals and payout dates. Defaults to groups started in the last 90 days.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        startedAfter: { type: "string", description: "ISO 8601. Default: 90 days ago." },
        startedBefore: { type: "string", description: "ISO 8601." },
        maxResults: { type: "number", description: "1 to 100. Default 50." },
        nextToken,
      },
    },
  },
  {
    name: "amazon_get_settlement",
    displayName: "Get Amazon settlement detail",
    description:
      "Get the financial events inside one settlement (financial event group): counts by event type and the events themselves, capped per type.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        settlementId: { type: "string", description: "FinancialEventGroupId from amazon_list_settlements." },
        maxPerType: { type: "number", description: "Events returned per event type, 1 to 100. Default 25." },
        nextToken,
      },
      required: ["settlementId"],
    },
  },
  {
    name: "amazon_list_financial_events",
    displayName: "List Amazon financial events",
    description:
      "Financial events (shipments, refunds, fees, adjustments, etc.) posted in a date range. Amazon only returns events posted at least 2 minutes ago.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        postedAfter: { type: "string", description: "ISO 8601. Required unless nextToken is given." },
        postedBefore: { type: "string", description: "ISO 8601. Default: now minus 3 minutes." },
        maxPerType: { type: "number", description: "Events returned per event type, 1 to 100. Default 25." },
        nextToken,
      },
    },
  },
  {
    name: "amazon_get_inventory_summary",
    displayName: "Get Amazon inventory",
    description:
      "Inventory levels. channel 'fba' (default) reads FBA inventory, for all SKUs or the SKUs given. channel 'merchant' reads merchant-fulfilled quantity for up to 20 SKUs (needs the account's seller ID).",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        channel: { type: "string", enum: ["fba", "merchant"] },
        skus: { type: "array", items: { type: "string" }, description: "Seller SKUs. Required for channel 'merchant'. FBA: up to 50." },
        marketplaceId: { type: "string", description: "Default: the account's first marketplace." },
        nextToken,
      },
    },
  },
  {
    name: "amazon_request_report",
    displayName: "Request Amazon report",
    description:
      "Ask Amazon to build a report from the allowed list. Returns a reportId; poll amazon_get_report until it is DONE. Reports take minutes to build.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        reportType: { type: "string", enum: REQUESTABLE_REPORT_TYPES },
        dataStartTime: { type: "string", description: "ISO 8601." },
        dataEndTime: { type: "string", description: "ISO 8601." },
        marketplaceIds: { type: "array", items: { type: "string" } },
        reportOptions: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Sales and traffic only: dateGranularity (DAY|WEEK|MONTH), asinGranularity (PARENT|CHILD|SKU).",
        },
      },
      required: ["reportType"],
    },
  },
  {
    name: "amazon_list_reports",
    displayName: "List Amazon reports",
    description:
      "List existing reports of the allowed types, newest first. Use it to find settlement reports, which Amazon creates on its own schedule.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        reportTypes: { type: "array", items: { type: "string", enum: REPORT_TYPE_NAMES } },
        processingStatuses: { type: "array", items: { type: "string", enum: ["CANCELLED", "DONE", "FATAL", "IN_PROGRESS", "IN_QUEUE"] } },
        createdSince: { type: "string", description: "ISO 8601. Amazon default: 90 days ago." },
        pageSize: { type: "number", description: "1 to 100. Default 20." },
        nextToken,
      },
    },
  },
  {
    name: "amazon_get_report",
    displayName: "Get Amazon report",
    description:
      "Get a report's status and, once DONE, a page of its rows. Columns with buyer contact or address details are removed.",
    parametersSchema: {
      type: "object",
      properties: {
        account,
        reportId: { type: "string" },
        offset: { type: "number", description: "First row to return. Default 0." },
        limit: { type: "number", description: "Rows to return, 1 to 500. Default 100." },
      },
      required: ["reportId"],
    },
  },
];
