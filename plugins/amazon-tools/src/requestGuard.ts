import { fail } from "./safety.js";
const reads:Record<string,RegExp> = {
  searchOrders:/^\/orders\/2026-01-01\/orders$/,
  getOrder:/^\/orders\/2026-01-01\/orders\/[0-9-]+$/,
  listTransactions:/^\/finances\/2024-06-19\/transactions$/,
  listBalances:/^\/finances\/2024-06-19\/balances$/,
  getInventorySummaries:/^\/fba\/inventory\/v1\/summaries$/,
  searchListingsItems:/^\/listings\/2021-08-01\/items\/[A-Z0-9]+$/,
  getListingsItem:/^\/listings\/2021-08-01\/items\/[A-Z0-9]+\/[^/]+$/,
  getCatalogItem:/^\/catalog\/2022-04-01\/items\/[A-Z0-9]{10}$/,
  getItemOffers:/^\/products\/pricing\/v0\/items\/[A-Z0-9]{10}\/offers$/,
  getReports:/^\/reports\/2021-06-30\/reports$/,
  getReport:/^\/reports\/2021-06-30\/reports\/[a-zA-Z0-9._-]+$/,
  getReportDocument:/^\/reports\/2021-06-30\/documents\/[a-zA-Z0-9._:%-]+$/,
  searchContentDocuments:/^\/aplus\/2020-11-01\/contentDocuments$/,
  searchContentPublishRecords:/^\/aplus\/2020-11-01\/contentPublishRecords$/,
  getContentDocument:/^\/aplus\/2020-11-01\/contentDocuments\/[a-zA-Z0-9._:%-]+$/,
  getSubscription:/^\/notifications\/v1\/subscriptions\/[A-Z_]+$/,
  getDestinations:/^\/notifications\/v1\/destinations$/,
};
export function assertRequest(operation:string,method:string,path:string,governed=false) {
  if(method==="GET" && reads[operation]?.test(path))return;
  if(governed && operation==="createReport" && method==="POST" && path==="/reports/2021-06-30/reports")return;
  fail("EWRITE_BLOCKED");
}
