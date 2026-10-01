import { createHash } from "node:crypto";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import { ns,person } from "./interactive-support.js";
import { IntakeError,type Config } from "./routing.js";
import type { DirectoryRecord } from "./directory-schema.js";
import { validPublicCheckUrl } from "./storefront-schema.js";
import { storefrontOrderTools } from "./storefront-orders-schema.js";
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
async function profile(ctx:PluginContext,cfg:Config,run:ToolRunContext,input:Record<string,unknown>){
  const actor=person(run);
  if(run.userPermission!=="support:diagnose"||typeof input.profileId!=="string"||!uuid.test(input.profileId)||typeof input.accountId!=="string")throw new IntakeError(403,"Choose a saved company storefront/account with diagnostic permission");
  const accounts=(cfg.storefrontOrderAccounts??[]).filter(a=>a.id===input.accountId),account=accounts[0];
  if(accounts.length!==1||!account?.enabled||!account.allowedCompanies?.includes(actor.companyId)||!uuid.test(account.keyRef)||!uuid.test(account.secretRef))throw new IntakeError(403,"Exact company WooCommerce account not opted in");
  if(!validPublicCheckUrl(account.siteOrigin)||new URL(account.siteOrigin).pathname!=="/")throw new IntakeError(422,"Use an exact public HTTPS WordPress origin without a path");
  const [record]=await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2 AND kind='storefront'`,[actor.companyId,input.profileId]);
  if(!record||!validPublicCheckUrl(record.details.website??"")||new URL(record.details.website!).origin!==new URL(account.siteOrigin).origin)throw new IntakeError(403,"WooCommerce account must match this company's saved storefront");
  return{actor,account,record,hash:createHash("sha256").update(JSON.stringify(account)).digest("hex")};
}
async function smallJson(response:Response){
  if(!response.ok||!response.headers.get("content-type")?.includes("application/json")||!response.body)throw new IntakeError(502,"Order read unavailable; inspect the Read key, order reference and provider access");
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;if((bytes+=part.value.length)>100000)throw new IntakeError(502,"Order response exceeded the supported bound");chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const value=JSON.parse(Buffer.concat(chunks).toString("utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw new IntakeError(502,"Unsupported order metadata");return value as Record<string,unknown>;
}
function time(value:unknown){if(value===null||value===undefined||value==="")return null;if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(value))return null;const text=value.endsWith("Z")?value:value+"Z";return Number.isFinite(Date.parse(text))?text:null;}
export async function inspectStorefrontOrder(ctx:PluginContext,getConfig:()=>Promise<Config>,run:ToolRunContext,input:Record<string,unknown>){
  if(typeof input.orderId!=="number"||!Number.isSafeInteger(input.orderId)||input.orderId<1||input.orderId>999999999999999)throw new IntakeError(422,"Use the exact numeric reported WooCommerce order ID");
  const initial=await profile(ctx,await getConfig(),run,input);
  const guard=async()=>{const fresh=await profile(ctx,await getConfig(),run,input);if(fresh.hash!==initial.hash||fresh.record.version!==initial.record.version||fresh.record.details.website!==initial.record.details.website)throw new IntakeError(409,"Storefront account/profile changed; review it before another read");};
  const [key,secret]=await Promise.all([ctx.secrets.resolve(initial.account.keyRef,run.companyId),ctx.secrets.resolve(initial.account.secretRef,run.companyId)]);
  if(!key||!secret||key.includes(":"))throw new IntakeError(422,"WooCommerce key/secret unavailable");await guard();
  const url=new URL(`/wp-json/wc/v3/orders/${input.orderId}`,initial.account.siteOrigin);
  url.searchParams.set("_fields","id,status,date_created_gmt,date_modified_gmt,date_paid_gmt,date_completed_gmt,payment_method");
  // The native host bridge pins validated public DNS and never follows redirects.
  // Its real host timeout (currently 30 seconds) applies; AbortSignals do not cross RPC.
  const response=await ctx.http.fetch(url.href,{method:"GET",redirect:"manual",headers:{Authorization:`Basic ${Buffer.from(`${key}:${secret}`,"utf8").toString("base64")}`,Accept:"application/json"}});
  const value=await smallJson(response);await guard();
  if(value.id!==input.orderId||typeof value.status!=="string")throw new IntakeError(502,"Order identity/status did not match the reported reference");
  const known=["pending","processing","on-hold","completed","cancelled","refunded","failed","checkout-draft"];
  const gateways=["bacs","cheque","cod","paypal","stripe","woocommerce_payments"];
  const result={orderId:input.orderId,status:known.includes(value.status)?value.status:"unrecognized_custom_status",paymentMethod:typeof value.payment_method==="string"&&gateways.includes(value.payment_method)?value.payment_method:typeof value.payment_method==="string"&&value.payment_method?"other_gateway":null,createdAtUtc:time(value.date_created_gmt),modifiedAtUtc:time(value.date_modified_gmt),recordedPaymentAtUtc:time(value.date_paid_gmt),recordedCompletionAtUtc:time(value.date_completed_gmt),observedAtUtc:new Date().toISOString()};
  await ctx.activity.log({companyId:run.companyId,message:"Reported storefront order metadata inspected",entityType:"support_storefront",entityId:initial.record.id,metadata:{userId:initial.actor.userId,orderId:input.orderId,status:result.status,profileVersion:initial.record.version}});
  return{...result,provider:"woocommerce",profileId:initial.record.id,limitations:"One exact reported order, not an order search or root cause. Recorded statuses/timestamps do not prove gateway settlement, customer notification, production, shipment or delivery; null payment time does not establish nonpayment. No customer PII, order keys, financial totals or raw provider errors are returned. No order/admin/payment changes. Uses the host's pinned public HTTP bridge and its host timeout; the 100 KB bound applies to the returned JSON, not the bridge's upstream network transfer."};
}
export function registerStorefrontOrderTools(ctx:PluginContext,getConfig:()=>Promise<Config>){for(const tool of storefrontOrderTools)ctx.tools.register(tool.name,tool,async(params,run)=>{try{return{data:await inspectStorefrontOrder(ctx,getConfig,run,params as Record<string,unknown>)};}catch(error){return{error:error instanceof IntakeError?error.message:"Storefront order read unavailable; no order or admin change occurred"};}});}
