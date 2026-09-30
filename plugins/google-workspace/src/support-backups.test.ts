import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { verifyMarkdownBackup, type BackupFile, type BackupDrive } from "./backup-verification.js";
import { backupProfile, driveBackupPort, readBackupObservation, registerBackupObservations } from "./support-backups.js";
import type { InstanceConfig } from "./googleAuth.js";
import { observationEvent, observationHash, type ObservationRequest } from "../../../lib/support-observations.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompany = "22222222-2222-4222-8222-222222222222";
const folder = {id:"root",name:"Backup",mimeType:"application/vnd.google-apps.folder",version:"1"};
const bytes = Buffer.from("# Example skill\nOnly synthetic test contents.\n");
const file: BackupFile = {id:"file",name:"SKILL.md",parents:["root"],mimeType:"text/markdown",size:String(bytes.length),md5Checksum:createHash("md5").update(bytes).digest("hex"),version:"1",modifiedTime:"2026-01-01T00:00:00Z",capabilities:{canDownload:true}};
async function fixture() {
  const base = await mkdtemp(join(tmpdir(),"paperclip-backup-fixture-")); const source = join(base,"source"); await mkdir(source); await writeFile(join(source,"SKILL.md"),bytes);
  const calls: string[] = []; let listing = [structuredClone(file)]; let meta = structuredClone(file); let downloaded: Buffer = bytes;
  const port: BackupDrive = {metadata:async id=>{calls.push(`metadata:${id}`);return id==="root"?folder:meta;},children:async id=>{calls.push(`children:${id}`);return{files:listing,incomplete:false};},download:async id=>{calls.push(`download:${id}`);return downloaded;}};
  const cfg: InstanceConfig = {accounts:[{key:"example",allowedCompanies:[companyId],clientIdRef:"33333333-3333-4333-8333-333333333333",clientSecretRef:"44444444-4444-4444-8444-444444444444",refreshTokenRef:"55555555-5555-4555-8555-555555555555",backupVerificationProfiles:[{key:"skills",companyId,sourceRoot:source,driveFolderId:"root",enabled:true}]}]};
  let resolves = 0; const activity: any[] = [];
  const ctx = {config:{get:async()=>cfg},secrets:{resolve:async()=>{resolves++;return "synthetic-google-test-value";}},activity:{log:async (event:any)=>activity.push(event)},logger:{warn:()=>{}}} as unknown as PluginContext;
  const value = {version:1 as const,requestId:randomUUID(),companyId,provider:"google-workspace" as const,account:"example",operation:"backup_verify",resourceId:"skills",expiresAt:new Date(Date.now()+120000).toISOString()};
  const request: ObservationRequest = {...value,requestSha256:observationHash(value)};
  return {base,source,port,cfg,ctx,request,calls,activity,resolves:()=>resolves,setListing:(value:BackupFile[])=>{listing=value;},setMeta:(value:BackupFile)=>{meta=value;},setDownload:(value:Buffer)=>{downloaded=value;},close:async()=>{const path=resolve(base);assert.equal(dirname(path),resolve(tmpdir()));assert.ok(basename(path).startsWith("paperclip-backup-fixture-"));await rm(path,{recursive:true,force:true});}};
}

test("cloud backup verification compares actual bytes, performs an isolated restore, cleans it and emits only counts",async()=>{
  const f = await fixture();
  try {
    const before = new Set(await readdir(tmpdir()));
    const result = await readBackupObservation(f.ctx,f.request,()=>f.port);
    assert.equal(result.status,"matched_and_restore_tested");assert.equal(result.restoreTestedFiles,1);assert.equal(result.temporaryFilesRemoved,true);
    assert.ok(f.calls.includes("download:file"));assert.deepEqual(await readFile(join(f.source,"SKILL.md")),bytes);
    assert.ok(!(await readdir(tmpdir())).some(name=>name.startsWith("paperclip-backup-check-")&&!before.has(name)));
    const output = JSON.stringify([result,f.activity]); assert.ok(!output.includes(f.source));assert.ok(!output.includes("SKILL.md"));assert.ok(!output.includes(bytes.toString()));assert.ok(!output.includes(file.md5Checksum!));
  } finally {await f.close();}
});

test("missing, changed, ambiguous, paginated and unsupported cloud files never report verified backup",async()=>{
  const f = await fixture();
  try {
    f.setListing([]);assert.equal((await verifyMarkdownBackup(f.source,"root",f.port,async()=>{})).missing,1);
    f.setListing([{...file,md5Checksum:"0".repeat(32)}]);assert.equal((await verifyMarkdownBackup(f.source,"root",f.port,async()=>{})).different,1);
    f.setListing([file,{...file,id:"duplicate"}]);const ambiguous=await verifyMarkdownBackup(f.source,"root",f.port,async()=>{});assert.equal(ambiguous.status,"needs_review");assert.equal(ambiguous.ambiguous,1);
    f.setListing([file]);f.setDownload(Buffer.from("wrong content"));assert.equal((await verifyMarkdownBackup(f.source,"root",f.port,async()=>{})).restoreTestedFiles,0);
    f.setDownload(bytes);f.setMeta({...file,version:"2"});assert.equal((await verifyMarkdownBackup(f.source,"root",f.port,async()=>{})).unavailable,1);
    f.setMeta(file);const partial={...f.port,children:async()=>({files:[file],incomplete:true})};assert.equal((await verifyMarkdownBackup(f.source,"root",partial,async()=>{})).status,"needs_review");
    f.setListing([{...file,mimeType:"application/vnd.google-apps.document",md5Checksum:null}]);assert.equal((await verifyMarkdownBackup(f.source,"root",f.port,async()=>{})).unavailable,1);
  } finally {await f.close();}
});

test("exact company/profile opt-in precedes Secrets and revocation or changed source stops verification",async()=>{
  const f = await fixture();
  try {
    await assert.rejects(readBackupObservation(f.ctx,{...f.request,companyId:otherCompany},()=>f.port));assert.equal(f.resolves(),0);assert.equal(f.calls.length,0);
    f.cfg.accounts![0]!.allowedCompanies=["*"];assert.throws(()=>backupProfile(f.cfg,companyId,"example","skills"));f.cfg.accounts![0]!.allowedCompanies=[companyId];
    f.cfg.accounts![0]!.backupVerificationProfiles!.push({...f.cfg.accounts![0]!.backupVerificationProfiles![0]!});assert.throws(()=>backupProfile(f.cfg,companyId,"example","skills"));f.cfg.accounts![0]!.backupVerificationProfiles!.pop();
    const revoke={...f.port,children:async(id:string)=>{const result=await f.port.children(id);f.cfg.accounts![0]!.backupVerificationProfiles![0]!.enabled=false;return result;}};
    await assert.rejects(readBackupObservation(f.ctx,f.request,()=>revoke));assert.ok(!f.calls.includes("download:file"));
    f.cfg.accounts![0]!.backupVerificationProfiles![0]!.enabled=true;
    const changing={...f.port,download:async()=>{await writeFile(join(f.source,"SKILL.md"),"Changed while checking");return bytes;}};
    await assert.rejects(readBackupObservation(f.ctx,f.request,()=>changing));assert.equal(f.activity.length,0);
  } finally {await f.close();}
});

test("local junctions and oversized source Markdown are refused before any cloud read",async()=>{
  const f=await fixture();
  try {
    await mkdir(join(f.base,"other"));await symlink(join(f.base,"other"),join(f.source,"linked"),process.platform==="win32"?"junction":"dir");
    await assert.rejects(verifyMarkdownBackup(f.source,"root",f.port,async()=>{}));assert.equal(f.calls.length,0);
    const large=join(f.base,"large");await mkdir(large);await writeFile(join(large,"SKILL.md"),Buffer.alloc(1024*1024+1));
    await assert.rejects(verifyMarkdownBackup(large,"root",f.port,async()=>{}));assert.equal(f.calls.length,0);
  } finally {await f.close();}
});

test("Drive adapter pins reads, bounds media and reports incomplete listings without following redirects",async()=>{
  const calls:any[]=[];const api={files:{get:async(p:any,o:any)=>{calls.push([p,o]);return{data:p.alt?bytes:file};},list:async(p:any,o:any)=>{calls.push([p,o]);return{data:{files:[file],nextPageToken:"another-page"}};}}};
  const port=driveBackupPort(api as any,Date.now()+45000);
  assert.equal((await port.children("root")).incomplete,true);await port.metadata("file");assert.deepEqual(await port.download("file"),bytes);
  for(const [,options] of calls){assert.equal(options.maxRedirects,0);assert.equal(options.retry,false);assert.ok(options.timeout<=10000);assert.equal(options.maxContentLength,1024*1024);}
  assert.equal(calls[0][0].q,"'root' in parents and trashed = false");assert.equal(calls[2][0].alt,"media");assert.equal(calls[2][1].responseType,"arraybuffer");
});

test("only host-stamped Support Desk requests trigger the bridge, failures reveal no source content",async()=>{
  const f=await fixture();const handlers=new Map<string,Function>();const receipts:any[]=[];
  try {
    const ctx={...f.ctx,events:{on:(name:string,handler:Function)=>handlers.set(name,handler),emit:async(name:string,company:string,payload:any)=>receipts.push({name,company,payload})}} as unknown as PluginContext;
    registerBackupObservations(ctx);const handler=handlers.get(observationEvent)!;
    const event={eventType:observationEvent,actorType:"plugin",actorId:"customer-support",companyId,payload:f.request};
    await handler({...event,actorId:"another-plugin"});assert.equal(receipts.length,0);
    await handler({...event,payload:{...f.request,resourceId:"../other"}});assert.equal(receipts.length,0);
    f.cfg.accounts![0]!.backupVerificationProfiles![0]!.enabled=false;await handler(event);
    assert.equal(receipts[0].payload.status,"unavailable");assert.equal(f.resolves(),0);assert.ok(!JSON.stringify(receipts).includes(f.source));
  } finally {await f.close();}
});
