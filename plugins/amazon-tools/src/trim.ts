// Shapes Amazon responses into the trimmed JSON agents see.
//
// Orders use an allowlist, not a blocklist: any field Amazon adds later stays
// out until someone decides it is safe. That is what keeps buyer names,
// addresses, phone numbers and emails out of agent context.

type Obj = Record<string, unknown>;

function pick(src: unknown, keys: readonly string[]): Obj {
  const out: Obj = {};
  if (!src || typeof src !== "object") return out;
  for (const k of keys) {
    const v = (src as Obj)[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export const ORDER_FIELDS = [
  "AmazonOrderId",
  "PurchaseDate",
  "LastUpdateDate",
  "OrderStatus",
  "FulfillmentChannel",
  "SalesChannel",
  "OrderChannel",
  "ShipServiceLevel",
  "ShipmentServiceLevelCategory",
  "OrderTotal",
  "NumberOfItemsShipped",
  "NumberOfItemsUnshipped",
  "PaymentMethod",
  "MarketplaceId",
  "OrderType",
  "EarliestShipDate",
  "LatestShipDate",
  "EarliestDeliveryDate",
  "LatestDeliveryDate",
  "IsBusinessOrder",
  "IsPrime",
  "IsPremiumOrder",
  "IsGlobalExpressEnabled",
  "IsReplacementOrder",
  "IsSoldByAB",
  "IsISPU",
  "IsAccessPointOrder",
  "HasRegulatedItems",
] as const;

/** Only the coarse location, for tax and regional sales questions. */
const SHIP_TO_FIELDS = ["StateOrRegion", "CountryCode"] as const;

export function trimOrder(order: unknown): Obj {
  const out = pick(order, ORDER_FIELDS);
  const shipTo = pick((order as Obj | null)?.ShippingAddress, SHIP_TO_FIELDS);
  if (Object.keys(shipTo).length > 0) out.ShipTo = shipTo;
  return out;
}

export const ORDER_ITEM_FIELDS = [
  "OrderItemId",
  "ASIN",
  "SellerSKU",
  "Title",
  "QuantityOrdered",
  "QuantityShipped",
  "ItemPrice",
  "ItemTax",
  "ShippingPrice",
  "ShippingTax",
  "ShippingDiscount",
  "ShippingDiscountTax",
  "PromotionDiscount",
  "PromotionDiscountTax",
  "CODFee",
  "CODFeeDiscount",
  "ConditionId",
  "ConditionSubtypeId",
  "IsGift",
  "IsTransparency",
  "SerialNumberRequired",
  "PriceDesignation",
  "DeemedResellerCategory",
] as const;

export function trimOrderItem(item: unknown): Obj {
  const out = pick(item, ORDER_ITEM_FIELDS);
  const units = (item as Obj | null)?.ProductInfo as Obj | undefined;
  if (units?.NumberOfItems !== undefined) out.NumberOfItems = units.NumberOfItems;
  return out;
}

export function trimSettlement(group: unknown): Obj {
  // AccountTail (last digits of the payout bank account) and TraceId are left out.
  return pick(group, [
    "FinancialEventGroupId",
    "ProcessingStatus",
    "FundTransferStatus",
    "OriginalTotal",
    "ConvertedTotal",
    "FundTransferDate",
    "BeginningBalance",
    "FinancialEventGroupStart",
    "FinancialEventGroupEnd",
  ]);
}

/**
 * Financial events come back as ~40 lists, almost all empty. Drop the empty
 * ones, cap each list, and report how many of each kind there were.
 */
export function trimFinancialEvents(
  events: unknown,
  maxPerList: number,
): { counts: Record<string, number>; events: Obj; truncated: boolean } {
  const counts: Record<string, number> = {};
  const out: Obj = {};
  let truncated = false;
  if (events && typeof events === "object") {
    for (const [k, v] of Object.entries(events as Obj)) {
      if (!Array.isArray(v) || v.length === 0) continue;
      counts[k] = v.length;
      if (v.length > maxPerList) truncated = true;
      out[k] = v.slice(0, maxPerList).map(dropEmpty);
    }
  }
  return { counts, events: out, truncated };
}

/** Recursively remove nulls, empty arrays and empty objects. */
export function dropEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = value.map(dropEmpty).filter((v) => v !== undefined);
    return arr.length > 0 ? arr : undefined;
  }
  if (value && typeof value === "object") {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      const t = dropEmpty(v);
      if (t !== undefined) out[k] = t;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value === null ? undefined : value;
}

export function trimFbaInventory(summary: unknown): Obj {
  const s = (summary ?? {}) as Obj;
  const out = pick(s, [
    "sellerSku",
    "asin",
    "fnSku",
    "productName",
    "condition",
    "totalQuantity",
    "lastUpdatedTime",
  ]);
  const d = s.inventoryDetails as Obj | undefined;
  if (d) {
    out.fulfillableQuantity = d.fulfillableQuantity;
    out.inboundWorkingQuantity = d.inboundWorkingQuantity;
    out.inboundShippedQuantity = d.inboundShippedQuantity;
    out.inboundReceivingQuantity = d.inboundReceivingQuantity;
    out.reservedQuantity = (d.reservedQuantity as Obj | undefined)?.totalReservedQuantity;
    out.unfulfillableQuantity = (d.unfulfillableQuantity as Obj | undefined)?.totalUnfulfillableQuantity;
    out.researchingQuantity = (d.researchingQuantity as Obj | undefined)?.totalResearchingQuantity;
  }
  return dropEmpty(out) as Obj;
}

export function trimListingInventory(sku: string, item: unknown, marketplaceId: string): Obj {
  const i = (item ?? {}) as Obj;
  const summary = ((i.summaries as Obj[] | undefined) ?? []).find(
    (s) => s.marketplaceId === marketplaceId,
  ) ?? (i.summaries as Obj[] | undefined)?.[0];
  return dropEmpty({
    sellerSku: sku,
    asin: summary?.asin,
    itemName: summary?.itemName,
    status: summary?.status,
    fulfillmentAvailability: ((i.fulfillmentAvailability as Obj[] | undefined) ?? []).map((f) =>
      pick(f, ["fulfillmentChannelCode", "quantity"]),
    ),
  }) as Obj;
}

export function trimReport(report: unknown): Obj {
  return pick(report, [
    "reportId",
    "reportType",
    "processingStatus",
    "dataStartTime",
    "dataEndTime",
    "createdTime",
    "processingStartTime",
    "processingEndTime",
    "marketplaceIds",
    "reportScheduleId",
  ]);
}
