import { fail, object, compatibilityFailure } from "./safety.js";

// Raw provider tokens have no company, query or credential binding. Financial
// event group IDs are not report IDs. Neither can be reinterpreted safely.
export function compatibleParams(operation:string,raw:unknown):Record<string,any> {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))fail();
  const p={...object(raw)};
  if(["nextToken","settlementId","maxPerType","orderStatuses","fulfillmentChannels","processingStatuses","reportOptions","sellerSkus","details","startedAfter","startedBefore"].some(k=>p[k]!==undefined))fail("ECOMPAT");
  if(p.pageSize!==undefined){if(!["list_listings","list_reports"].includes(operation)||p.limit!==undefined||p.maxResults!==undefined)fail("ECOMPAT");p.limit=p.pageSize;delete p.pageSize;}
  if(operation==="get_order"&&p.includeItems!==undefined){if(p.includeItems!==true)compatibilityFailure("items");delete p.includeItems;}
  if(operation==="get_report"&&typeof p.limit==="number"&&Number.isInteger(p.limit)&&p.limit>100&&p.limit<=500)p.limit=100;
  if(p.channel!==undefined){if(operation!=="get_inventory_summary"||p.fulfillment!==undefined||!["fba","merchant"].includes(p.channel))fail("ECOMPAT");p.fulfillment=p.channel==="fba"?"FBA":"MERCHANT";delete p.channel;}
  if(p.skus!==undefined){if(operation!=="get_inventory_summary"||p.sku!==undefined||!Array.isArray(p.skus)||p.skus.length!==1)fail("ECOMPAT");p.sku=p.skus[0];delete p.skus;}
  if(p.maxResults!==undefined){if(p.limit!==undefined)fail("ECOMPAT");p.limit=p.maxResults;delete p.maxResults;}
  if(p.marketplaceIds!==undefined){if(p.marketplaceId!==undefined||!Array.isArray(p.marketplaceIds)||p.marketplaceIds.length!==1)fail("ECOMPAT");p.marketplaceId=p.marketplaceIds[0];delete p.marketplaceIds;}
  if(p.reportTypes!==undefined){if(p.reportType!==undefined||!Array.isArray(p.reportTypes)||p.reportTypes.length!==1)fail("ECOMPAT");p.reportType=p.reportTypes[0];delete p.reportTypes;}
  if(operation==="get_aplus_content" && (p.asin===undefined)===(p.contentReferenceKey===undefined))fail("ECOMPAT");
  return p;
}
