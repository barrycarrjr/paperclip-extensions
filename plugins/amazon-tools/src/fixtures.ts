import type { Transport, HttpReply } from "./safety.js";
import { AmazonService } from "./amazon.js";
import { AmazonError } from "./safety.js";
export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const REF = "33333333-3333-4333-8333-333333333333";
export const MARKET = "ATVPDKIKX0DER";
export const CREDS = { clientId:"example-client-not-real",clientSecret:"example-secret-not-real",refreshToken:"example-refresh-not-real",sellerId:"SELLEREXAMPLE" };
export const ACCESS = "example-access-not-real";
export const account = () => ({key:"seller",credentialsRef:REF,region:"NA",marketplaceIds:[MARKET],allowedCompanies:[COMPANY]});
export const json = (value: unknown, status = 200, headers: Record<string,string> = {}): HttpReply => ({status,headers,body:Buffer.from(JSON.stringify(value))});
export const TOKEN = () => json({access_token:ACCESS,token_type:"bearer",expires_in:3600});
// Shared service and worker cases: upstream text is deliberately unsafe and
// must never appear in a fixed, sanitized error or audit entry.
export const LWA_FAILURES = [
  { name: "reset", reply: () => { throw Error(CREDS.clientSecret); }, code: "ENETWORK", host: "unavailable" },
  { name: "DNS/refused", reply: () => { throw Object.assign(new AmazonError("ENETWORK"), { notSent: true }); }, code: "ENETWORK", host: "unavailable" },
  { name: "503", reply: () => json({ error: CREDS.clientSecret }, 503), code: "EHTTP", host: "unavailable" },
  { name: "429", reply: () => json({ error: CREDS.clientSecret }, 429, { "retry-after": "5" }), code: "ERATE", host: "unavailable", retry: 5 },
  { name: "400", reply: () => json({ error: "invalid_grant", description: CREDS.clientSecret }, 400), code: "EAUTH", host: "needs_reconnect" },
  { name: "401", reply: () => json({ error: "invalid_client", description: CREDS.clientSecret }, 401), code: "EAUTH", host: "needs_reconnect" },
  { name: "malformed grant", reply: () => json({ access_token: CREDS.clientSecret, token_type: "bearer" }), code: "EAUTH", host: "needs_reconnect" },
  { name: "malformed JSON", reply: () => ({ status: 200, headers: {}, body: Buffer.from(CREDS.clientSecret) }), code: "EAUTH", host: "needs_reconnect" },
] as const;
// The host currently serializes ordinary handler failures as -32603 and
// preserves only the message. Missing and foreign secrets share one message.
export const HOST_FAILURES = [
  { lookup: "secret", message: "Rate limit exceeded for secret resolution", rpc: -32603, code: "EHOST", host: "unavailable" },
  { lookup: "secret", message: "Host lookup timed out", rpc: -32003, code: "EHOST", host: "unavailable" },
  { lookup: "config", message: "Host config temporarily unavailable", rpc: -32603, code: "EHOST", host: "unavailable" },
  { lookup: "secret", message: CREDS.clientSecret, rpc: -32603, code: "EHOST", host: "unavailable" },
  { lookup: "secret", message: `Secret not found: ${REF}`, rpc: -32603, code: "ECREDENTIALS", host: "needs_reconnect" },
  { lookup: "secret", message: `No version found for secret: ${REF}`, rpc: -32603, code: "ECREDENTIALS", host: "needs_reconnect" },
  { lookup: "secret", message: `Invalid secret reference: ${REF}`, rpc: -32603, code: "ECREDENTIALS", host: "needs_reconnect" },
  { lookup: "secret", message: 'Plugin "amazon-tools" is missing required capability "secrets.read-ref" for method "secrets.resolve"', rpc: -32001, code: "ECONFIG", host: "not_authorized" },
  { lookup: "secret", message: 'Plugin "amazon-tools" is missing required capability "secrets.read-ref" for method "secrets.resolve"', rpc: -32603, code: "ECONFIG", host: "not_authorized" },
] as const;
export interface Call { url: URL; method: string; headers: Record<string,string>; body?: string }
export function fixture(handler: (c: Call) => HttpReply | Promise<HttpReply> = () => json({})) {
  let config: any = {accounts:[account()]}; let secret = JSON.stringify(CREDS); let resolves = 0;
  let clock = Date.now(); const calls: Call[] = []; const waits: number[]=[];
  const ctx = {
    config:{ get:async()=>config },
    secrets:{resolve:async(ref:string,company?:string)=>{resolves++;if(ref!==REF||company!==COMPANY)throw Error("wrong scope");return secret;},store:async()=>({secretRef:REF})},
  };
  const send: Transport = async(url,method,headers,body)=>{
    const c={url,method,headers,body};calls.push(c);
    if(url.hostname==="api.amazon.com")return TOKEN();
    return handler(c);
  };
  const deps={send,now:()=>clock,sleep:async(ms:number)=>{waits.push(ms);clock+=ms;}};
  const service=new AmazonService(ctx,deps);
  return { service,ctx,deps,calls,waits,get resolves(){return resolves;},setConfig:(c:any)=>config=c,setSecret:(s:string)=>secret=s,advance:(ms:number)=>clock+=ms };
}
