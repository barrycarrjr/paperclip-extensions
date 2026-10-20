import type { Shape } from "./safety.js";
const scalars = (keys: string): Record<string, true> => Object.fromEntries(keys.split(" ").map(k => [k, true]));
export const money = scalars("amount currencyCode");
export const currency = scalars("currencyAmount currencyCode");
const breakdown: Shape = { breakdownType: true, breakdownAmount: currency, breakdowns: [{ breakdownType: true, breakdownAmount: currency }] };
export const transaction: Shape = {
  ...scalars("transactionType transactionId transactionStatus postedDate"), totalAmount: currency,
  marketplaceDetails: scalars("marketplaceId marketplaceName"),
  relatedIdentifiers: [scalars("relatedIdentifierName relatedIdentifierValue")],
  breakdowns: [breakdown], items: [{ totalAmount: currency, breakdowns: [breakdown] }],
};
export const balance: Shape = {
  ...scalars("balanceType asOfDate lastUpdatedTime"), amount: currency,
  partnerMetadata: scalars("accountType marketplaceId"),
  balances: [{ balanceType: true, amount: currency, balances: [{ balanceType: true, amount: currency }] }],
};
export const order: Shape = {
  ...scalars("orderId createdTime lastUpdatedTime"), programs: [true],
  salesChannel: scalars("channelName marketplaceId marketplaceName"), proceeds: { grandTotal: money },
  fulfillment: scalars("fulfillmentStatus fulfilledBy fulfillmentServiceLevel"),
  orderItems: [{ ...scalars("orderItemId quantityOrdered"), product: scalars("asin sellerSku title"),
    proceeds: { proceedsTotal: money }, fulfillment: scalars("quantityFulfilled quantityUnfulfilled") }],
};
export const report: Shape = scalars("reportId reportType processingStatus createdTime processingStartTime processingEndTime dataStartTime dataEndTime");
const attrValue: Shape = [{ value: true, language_tag: true, marketplace_id: true }];
// Intentionally exclude product-type-specific contact and compliance attributes.
export const attributes: Shape = {
  item_name: attrValue, brand: attrValue, manufacturer: attrValue, bullet_point: attrValue,
  product_description: attrValue, generic_keyword: attrValue, color: attrValue, size: attrValue,
  model_name: attrValue, model_number: attrValue, part_number: attrValue,
  main_product_image_locator: [{ media_location: true, marketplace_id: true }],
  other_product_image_locator_1: [{ media_location: true, marketplace_id: true }],
};
const summary: Shape = {...scalars("marketplaceId asin itemName brand brandName manufacturer modelNumber partNumber itemClassification color size productType conditionType createdDate lastUpdatedDate"),mainImage:{link:true},browseClassification:{displayName:true}};
export const listing: Shape = {
  sku: true, summaries: [{ ...summary as object, status: [true] }], attributes,
  productTypes: [scalars("marketplaceId productType")],
  issues: [{ ...scalars("code severity"), attributeNames: [true], categories: [true] }],
  fulfillmentAvailability: [scalars("fulfillmentChannelCode quantity")],
  offers: [{marketplaceId:true,offerType:true,price:money}],
};
// Shipping locations, seller feedback, addresses and every unlisted field stay out.
const offerMoney = scalars("Amount CurrencyCode");
export const offers: Shape = {
  ASIN:true, Summary:{TotalOfferCount:true,BuyBoxPrices:[{LandedPrice:offerMoney}]},
  Offers:[{MyOffer:true,IsBuyBoxWinner:true,IsFulfilledByAmazon:true,SubCondition:true,SellerId:true,ListingPrice:offerMoney,Shipping:offerMoney}],
};
export const catalog: Shape = {
  asin: true, attributes, summaries: [summary],
  images: [{ marketplaceId: true, images: [scalars("variant link height width")] }],
  identifiers: [{ marketplaceId: true, identifiers: [scalars("identifierType identifier")] }],
  productTypes: [scalars("marketplaceId productType")],
  relationships: [{ marketplaceId: true, relationships: [{ type: true, parentAsins: [true], childAsins: [true] }] }],
};
// ListingWatch content snapshots use these fields only. Keep their ordinary
// array/node/string bounds fatal instead of ignoring a partial used value.
export const watchListing: Shape = {
  sku:true, attributes:{item_name:attrValue,brand:attrValue,bullet_point:attrValue,product_description:attrValue,generic_keyword:attrValue},
};
export const watchCatalog: Shape = {
  asin:true, attributes:{bullet_point:attrValue,product_description:attrValue},
  summaries:[{marketplaceId:true,itemName:true,brand:true,browseClassification:{displayName:true}}],
  images:[{marketplaceId:true,images:[{variant:true,link:true}]}],
  productTypes:[scalars("marketplaceId productType")],
};
export const inventory: Shape = {
  ...scalars("asin fnSku sellerSku condition totalQuantity lastUpdatedTime"),
  inventoryDetails: { ...scalars("fulfillableQuantity inboundWorkingQuantity inboundShippedQuantity inboundReceivingQuantity"),
    researchingQuantity: { totalResearchingQuantity: true, researchingQuantityBreakdown: [scalars("name quantity")] },
    reservedQuantity: scalars("totalReservedQuantity pendingCustomerOrderQuantity pendingTransshipmentQuantity fcProcessingQuantity"),
    unfulfillableQuantity: scalars("totalUnfulfillableQuantity customerDamagedQuantity warehouseDamagedQuantity distributorDamagedQuantity carrierDamagedQuantity defectiveQuantity expiredQuantity") },
};
export const contentMetadata: Shape = { contentReferenceKey: true, contentMetadata: { ...scalars("name marketplaceId status updateTime"), badgeSet: [true] } };
export const publishRecord: Shape = scalars("marketplaceId locale asin contentType contentSubType contentReferenceKey");
export const subscription: Shape = scalars("subscriptionId payloadVersion destinationId");
export const settlementColumns = "settlement-id settlement-start-date settlement-end-date deposit-date total-amount currency transaction-type order-id adjustment-id shipment-id marketplace-name amount-type amount-description amount fulfillment-id posted-date posted-date-time order-item-code sku quantity-purchased".split(" ");
export const inventoryColumns = "sku asin price your-price quantity seller-sku fnsku condition afn-warehouse-quantity afn-fulfillable-quantity afn-unsellable-quantity afn-reserved-quantity afn-total-quantity mfn-listing-exists mfn-fulfillable-quantity afn-listing-exists afn-inbound-working-quantity afn-inbound-shipped-quantity afn-inbound-receiving-quantity afn-researching-quantity".split(" ");
const metrics = scalars("unitsOrdered unitsOrderedB2B totalOrderItems totalOrderItemsB2B unitsRefunded refundRate claimsGranted unitsShipped ordersShipped browserPageViews browserPageViewsB2B mobileAppPageViews mobileAppPageViewsB2B pageViews pageViewsB2B browserSessions browserSessionsB2B mobileAppSessions mobileAppSessionsB2B sessions sessionsB2B buyBoxPercentage buyBoxPercentageB2B orderItemSessionPercentage orderItemSessionPercentageB2B unitSessionPercentage unitSessionPercentageB2B");
const sales = { ...metrics, orderedProductSales: money, orderedProductSalesB2B: money, shippedProductSales: money, claimsAmount: money, averageSalesPerOrderItem: money, averageSellingPrice: money };
export const salesDate: Shape = { date: true, salesByDate: sales, trafficByDate: metrics };
export const salesAsin: Shape = { ...scalars("parentAsin childAsin sku"), salesByAsin: sales, trafficByAsin: metrics };
