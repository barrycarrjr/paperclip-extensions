import { execFile } from "node:child_process";

export type DiscoveryName = { address: string; hostname: string; forwardAddresses: string[]; source?: "reverse_dns" | "saved_name_forward_dns" };
// OS DNS honors Windows name-resolution configuration used by existing saved-account diagnostics.
// Run it in a bounded child: native getnameinfo/getaddrinfo cannot be cancelled inside this worker.
const script = `
import {readFileSync} from 'node:fs';
import {lookupService,lookup} from 'node:dns/promises';
const {addresses,knownNames}=JSON.parse(readFileSync(0,'utf8'));
async function pool(items,count,task){let next=0;await Promise.all(Array.from({length:Math.min(count,items.length)},async()=>{while(next<items.length)await task(items[next++]);}));}
await Promise.all([pool(knownNames,4,async hostname=>{try{
  const forwardAddresses=(await lookup(hostname,{all:true,family:4})).slice(0,4).map(item=>item.address);
  for(const address of forwardAddresses)if(addresses.includes(address))process.stdout.write(JSON.stringify({address,hostname,forwardAddresses,source:'saved_name_forward_dns'})+'\\n');
}catch{}}),pool(addresses,12,async address=>{
  try{
    const {hostname}=await lookupService(address,0);
    if(hostname===address)return;
    let forwardAddresses=[];try{forwardAddresses=(await lookup(hostname,{all:true,family:4})).slice(0,4).map(item=>item.address);}catch{}
    process.stdout.write(JSON.stringify({address,hostname,forwardAddresses,source:'reverse_dns'})+'\\n');
  }catch{}
})]);`;

export function parseDiscoveryNames(output: string, addresses: string[]): DiscoveryName[] {
  const allowed = new Set(addresses); const result: DiscoveryName[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line);
      if (allowed.has(row.address) && typeof row.hostname === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/i.test(row.hostname) && Array.isArray(row.forwardAddresses)) {
        result.push({ address: row.address, hostname: row.hostname.toLowerCase(), forwardAddresses: row.forwardAddresses.slice(0, 4).filter((ip: unknown) => typeof ip === "string" && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)),
          ...(["reverse_dns", "saved_name_forward_dns"].includes(row.source) ? { source: row.source } : {}) });
      }
    } catch { /* Partial final line after a timeout is not evidence. */ }
  }
  return result.slice(0, addresses.length * 4);
}
export function resolveDiscoveryNames(addresses: string[], signal: AbortSignal, knownNames: string[] = []): Promise<DiscoveryName[]> {
  if (signal.aborted || !addresses.length) return Promise.resolve([]);
  return new Promise(resolve => {
    const child = execFile(process.execPath, ["--input-type=module", "--eval", script], {
      timeout: 5000, windowsHide: true, maxBuffer: 128_000, signal,
      env: { ...process.env, UV_THREADPOOL_SIZE: "16" },
    }, (_error, stdout) => resolve(parseDiscoveryNames(stdout, addresses)));
    child.stdin?.on("error", () => { /* Child may exit before accepting input. */ });
    child.stdin?.end(JSON.stringify({ addresses, knownNames: knownNames.slice(0, 50) }));
  });
}
