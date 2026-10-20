// Synthetic, local-only fixtures. No global transport or clock replacements.
import { readFile, appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { fixture, account, COMPANY, MARKET, json } from "./fixtures.js";
import { ListingWatch } from "./watch.js";
import { AmazonError } from "./safety.js";
export const NS="plugin_amazon_d696b53491", ASIN="B000000001";
export async function watchFixture() {
  const pg=new PGlite(),statements:{kind:string;sql:string;params:unknown[]}[]=[];
  const validators=process.env.AMAZON_HOST_SQL_VALIDATORS?await import(pathToFileURL(process.env.AMAZON_HOST_SQL_VALIDATORS).href):undefined;
  if(validators && validators.derivePluginDatabaseNamespace("amazon-tools","amazon")!==NS)throw Error("Namespace mismatch");
  await pg.exec(`CREATE SCHEMA ${NS}`);
  for(const file of ["0001_listing_watch.sql","0002_company_watch.sql"]) {
    const migration=await readFile(new URL(`../migrations/${file}`,import.meta.url),"utf8");
    for(const sql of migration.split(";").filter(s=>s.trim()))validators?.validatePluginMigrationStatement(sql,NS);
    await pg.exec(migration);
  }
  let title="Example title",status=["BUYABLE"],price=10,ours=true,offersFail=false,aplusFail=false,signFail=false;
  let aplusName="Example content",aplusStatus="APPROVED",imageUpload="example-upload-1",documentName="Example document",metadataName=true;
  let description="Example description",moduleText="Example module",noAsin=false,noSummary=false,paged=false,latency=0;
  let skuList=["SKU-1","SKU-2"],next=false,pageFails=false,secretEcho=false,distinctAsins=false;
  let aplusModules:unknown[]|undefined,catalogChildren=0,unusedAttributeItems=0;
  const unused=()=>unusedAttributeItems?{color:Array.from({length:unusedAttributeItems},()=>({value:"Example color"}))}:{};
  // Model the provider's selected data sets, rather than hiding an unwanted
  // request by always returning a smaller reply. Identity fields stay present.
  const selected=(value:Record<string,unknown>,url:URL,identity:string)=>Object.fromEntries(Object.entries(value).filter(([key])=>key===identity||!url.searchParams.has("includedData")||url.searchParams.get("includedData")!.split(",").includes(key)));
  const listing=(sku:string,market=MARKET)=>({sku,summaries:noSummary?[]:[{marketplaceId:market,...(noAsin?{}:{asin:distinctAsins?`B${String(skuList.indexOf(sku)).padStart(9,"0")}`:ASIN}),itemName:title,status,productType:"PRODUCT",mainImage:{link:"https://example.com/product.jpg"}}],issues:status.length?[]:[{code:"EXAMPLE",severity:"ERROR",message:"private contact excluded"}],offers:[{marketplaceId:market,offerType:"B2C",price:{amount:price,currencyCode:"USD"}}],attributes:{...unused(),item_name:[{value:"Example title",marketplace_id:market}],bullet_point:[{value:"Example bullet",marketplace_id:market}],product_description:[{value:secretEcho?"example-secret-not-real":description,marketplace_id:market}]}});
  const f=fixture(c=>{
    const p=c.url.pathname;const market=c.url.searchParams.get("marketplaceIds")??c.url.searchParams.get("marketplaceId")??MARKET;
    if(p.endsWith("/offers")){if(offersFail)return json({},403);return json({payload:{ASIN:p.split("/").at(-2),Summary:{TotalOfferCount:ours?1:2,BuyBoxPrices:[]},Offers:[{MyOffer:ours,IsBuyBoxWinner:true,SellerId:ours?"SELLEREXAMPLE":"EXAMPLEOTHER",ListingPrice:{Amount:ours?10:9,CurrencyCode:"USD"},ShipsFrom:{Country:"excluded"}}]}});}
    if(p.includes("/catalog/"))return json(selected({asin:p.split("/").at(-1),summaries:[{marketplaceId:market,itemName:title,brand:"Example brand"}],attributes:{...unused(),bullet_point:[{value:"Example bullet"}],product_description:[{value:description}]},relationships:[{marketplaceId:market,relationships:[{type:"VARIATION",childAsins:Array.from({length:catalogChildren},(_,i)=>`B${String(i).padStart(9,"0")}`)}]}]},c.url,"asin"));
    if(p.endsWith("/contentPublishRecords")){if(aplusFail)return json({},403);return json({publishRecordList:[{contentReferenceKey:"K-1"}]});}
    if(p.endsWith("/contentDocuments/K-1"))return json({contentRecord:{contentReferenceKey:"K-1",contentMetadata:{...(metadataName?{name:aplusName}:{}),status:aplusStatus},contentDocument:{name:documentName,contentModuleList:aplusModules??[{contentModuleType:"STANDARD_HEADER_IMAGE_TEXT",standardHeaderImageText:{headline:{value:moduleText},block:{image:{uploadDestinationId:imageUpload,altText:"Example image",imageCropSpecification:{size:{width:{value:100,units:"pixels"},height:{value:100,units:"pixels"}}}}}}}]}}});
    if(p.endsWith("/SELLEREXAMPLE")){if(pageFails&&c.url.searchParams.has("pageToken"))return json({},503);return json({items:(paged?skuList.slice(Number(c.url.searchParams.get("pageToken")??0),Number(c.url.searchParams.get("pageToken")??0)+20):skuList).map(sku=>selected(listing(sku,market),c.url,"sku")),...(paged&&Number(c.url.searchParams.get("pageToken")??0)+20<skuList.length?{pagination:{nextToken:String(Number(c.url.searchParams.get("pageToken")??0)+20)}}:next?{pagination:{nextToken:"provider-example-page"}}:{})});}
    if(p.includes("/listings/"))return json(selected(listing(decodeURIComponent(p.split("/").at(-1)!),market),c.url,"sku"));
    throw new Error("Unexpected synthetic endpoint");
  });
  f.setConfig({accounts:[{...account(),listingWatch:true}]});
  const send=f.deps.send;f.deps.send=async(...args)=>{if(signFail&&args[0].hostname==="api.amazon.com")return json({},401);const result=await send(...args);f.advance(latency);return result;};
  // The existing service captured its transport before the override.
  const {AmazonService}=await import("./amazon.js");const service=new AmazonService(f.ctx,f.deps);
  let failCommit=false,lostReply=false;
  const db:PluginContext["db"]={namespace:NS,
    async query<T>(sql:string,params:unknown[]=[]){validators?.validatePluginRuntimeQuery(sql,NS);statements.push({kind:"query",sql,params});const out=(await pg.query<T>(sql,JSON.parse(JSON.stringify(params)))).rows;return JSON.parse(JSON.stringify(out));},
    async execute(sql:string,params:unknown[]=[]){validators?.validatePluginRuntimeExecute(sql,NS);statements.push({kind:"execute",sql,params});if(failCommit&&sql.startsWith("WITH saved"))throw new AmazonError("EHOST");const r=await pg.query(sql,JSON.parse(JSON.stringify(params)));if(lostReply&&sql.startsWith("WITH saved")){lostReply=false;throw new AmazonError("EHOST");}return{rowCount:r.affectedRows??0};},
  };
  const logs:unknown[]=[],jobs=new Map();
  const ctx={...f.ctx,db,activity:{log:async(v:unknown)=>{logs.push(v);}},logger:{warn:()=>{}},jobs:{register:(key:string,handler:unknown)=>jobs.set(key,handler)}} as unknown as PluginContext;
  const watch=new ListingWatch(ctx,service,f.deps.now);
  const check=(kind:"status"|"content"="status")=>watch.check(COMPANY,"seller",kind,MARKET);
  return{...f,pg,ctx,service,watch,check,logs,jobs,statements,listing,
    set:(v:{aplusModules?:unknown[];catalogChildren?:number;unusedAttributeItems?:number;aplusName?:string;aplusStatus?:string;imageUpload?:string;documentName?:string;metadataName?:boolean;distinctAsins?:boolean;description?:string;moduleText?:string;noAsin?:boolean;noSummary?:boolean;paged?:boolean;latency?:number;title?:string;status?:string[];price?:number;ours?:boolean;offersFail?:boolean;aplusFail?:boolean;signFail?:boolean;skus?:string[];next?:boolean;pageFails?:boolean;secretEcho?:boolean;failCommit?:boolean;lostReply?:boolean})=>{aplusModules=v.aplusModules??aplusModules;catalogChildren=v.catalogChildren??catalogChildren;unusedAttributeItems=v.unusedAttributeItems??unusedAttributeItems;aplusName=v.aplusName??aplusName;aplusStatus=v.aplusStatus??aplusStatus;imageUpload=v.imageUpload??imageUpload;documentName=v.documentName??documentName;metadataName=v.metadataName??metadataName;distinctAsins=v.distinctAsins??distinctAsins;description=v.description??description;moduleText=v.moduleText??moduleText;noAsin=v.noAsin??noAsin;noSummary=v.noSummary??noSummary;paged=v.paged??paged;latency=v.latency??latency;title=v.title??title;status=v.status??status;price=v.price??price;ours=v.ours??ours;offersFail=v.offersFail??offersFail;aplusFail=v.aplusFail??aplusFail;signFail=v.signFail??signFail;skuList=v.skus??skuList;next=v.next??next;pageFails=v.pageFails??pageFails;secretEcho=v.secretEcho??secretEcho;failCommit=v.failCommit??failCommit;lostReply=v.lostReply??lostReply;},
    changes:async()=> (await pg.query<any>(`SELECT sku,kind,field,before,after FROM ${NS}.watch_changes_v2 ORDER BY sku,field`)).rows,
    close:async()=>{if(process.env.AMAZON_SQL_RECEIPT)await appendFile(process.env.AMAZON_SQL_RECEIPT,JSON.stringify(statements)+"\n");await pg.close();},
  };
}
