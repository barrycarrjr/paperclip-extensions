import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,writeFile,readFile,readdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname,basename,resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext,ToolRunContext } from "@paperclipai/plugin-sdk";
import { buildJobFolder,createJobFolder,prepareJobFolder,searchJobFolders,jobSource } from "./job-folders.js";
import { diagnosticScript } from "./diagnostic-catalog.js";
import { validJobRoot,validJobTemplate,validJobComponent } from "./job-folder-schema.js";
import { saveDirectory } from "./support-directory.js";
import type { Config } from "./routing.js";
import type { DirectoryRecord } from "./directory-schema.js";
const companyId="11111111-1111-4111-8111-111111111111",otherCompanyId="22222222-2222-4222-8222-222222222222";
const cfg: Config={remoteAccessProfiles:[{id:"office",companyId,credentialUser:"EXAMPLE\\support",passwordRef:"33333333-3333-4333-8333-333333333333",scopes:[{kind:"dns_suffix",value:"example.local",transport:"Wmi"}]}]};
const run={companyId,userId:"operator",chatSessionId:"chat",userPermission:"support:repair",userConfirmed:true} as ToolRunContext;
const example={id:"44444444-4444-4444-8444-444444444444",kind:"file_root",name:"Example jobs",version:1,updated_at:"",details:{target:"files.example.local",root:"D:\\Jobs",namingTemplate:"{date}.{customer}-{sequence}",originalsFolder:"Original files"}} as DirectoryRecord;
async function fixture(){const db=new PGlite(),namespace="plugin_customer_support_0c69412611";await db.exec(`CREATE SCHEMA ${namespace}`);for(const file of (await readdir(new URL("../migrations/",import.meta.url))).filter(name=>name.endsWith(".sql")).sort())await db.exec(await readFile(new URL(`../migrations/${file}`,import.meta.url),"utf8"));
const ctx={db:{namespace,query:async(sql:string,params:unknown[])=>(await db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await db.query(sql,params)).affectedRows})},activity:{log:async()=>{}}} as unknown as PluginContext;
const profile=await saveDirectory(ctx,cfg,companyId,"operator",{kind:example.kind,name:example.name,details:example.details});return{ctx,db,profile};}
test("job roots/naming reject traversal, drive roots, special names and executable customer text",async()=>{
for(const value of ["C:\\","\\\\server\\share","C:\\Jobs\\..\\Other","C:\\Jobs\\link.","C:\\Jobs\\CON","C:\\Jobs\\[all]"])assert.equal(validJobRoot(value),false);
assert.equal(validJobRoot("D:\\Department\\Jobs"),true);assert.equal(validJobTemplate("{date}.{customer}-{sequence}"),true);assert.equal(validJobTemplate("{customer}\\{date}-{sequence}"),false);
for(const value of ["..","Customer; Remove-Item C:\\","NUL.txt","Client\\Other"])assert.equal(validJobComponent(value),false);
await assert.rejects(buildJobFolder(example,{date:"2027-02-30",customer:"Example",sequence:1}));
assert.equal((await buildJobFolder(example,{date:"2026-09-30",customer:"Example Customer",sequence:2})).folderName,"09302026.Example Customer-02");
});
test("folder creation binds profile, exact preview, company, person and verification; repeat cannot run twice",async()=>{
const f=await fixture();let calls=0;try{const input={profileId:f.profile.id,date:"2026-09-30",customer:"Example Customer",sequence:1};const plan=await prepareJobFolder(f.ctx,cfg,run,input);const runner=async()=>{calls++;return{runId:"example",status:"succeeded",exitCode:0}};
await assert.rejects(createJobFolder(f.ctx,async()=>cfg,{...run,userConfirmed:false},plan,runner));await assert.rejects(createJobFolder(f.ctx,async()=>cfg,{...run,companyId:otherCompanyId},plan,runner));await assert.rejects(createJobFolder(f.ctx,async()=>cfg,run,{...plan,root:"D:\\Other"},runner));
const result=await createJobFolder(f.ctx,async()=>cfg,run,plan,runner);assert.equal((result as { status: string }).status,"verified");assert.equal(calls,2);await createJobFolder(f.ctx,async()=>cfg,run,plan,runner);assert.equal(calls,2);
const newPlan=await prepareJobFolder(f.ctx,cfg,run,{...input,sequence:2});await saveDirectory(f.ctx,cfg,companyId,"operator",{id:f.profile.id,expectedVersion:1,kind:"file_root",name:example.name,details:{...example.details,root:"D:\\Other"}});await assert.rejects(createJobFolder(f.ctx,async()=>cfg,run,newPlan,runner),/changed/);assert.equal(calls,2);
}finally{await f.db.close();}});
test("job searches return explicit findings and never equate a failed remote read with no jobs",async()=>{const f=await fixture();try{const diagnosticRun={...run,userPermission:"support:diagnose"} as ToolRunContext;const input={profileId:f.profile.id,query:"literal [customer]",staleDays:30};let script="";const result=await searchJobFolders(f.ctx,cfg,diagnosticRun,input,async(_ctx,_access,_caseId,code)=>{script=code;return{runId:"example",status:"succeeded",exitCode:0,output:JSON.stringify({folders:[],partial:true})}});assert.equal((result.findings as any).partial,true);assert.ok(script.includes("IndexOf"));await assert.rejects(searchJobFolders(f.ctx,cfg,diagnosticRun,input,async()=>({runId:null,status:"script_failed",exitCode:1})),/no empty/);}finally{await f.db.close();}});
test("Windows rehearsal creates/verifies only a new job, refuses duplicates and never reads documents",{skip:process.platform!=="win32"},async()=>{const temp=await mkdtemp(join(tmpdir(),"support-jobs-"));try{const record={...example,details:{...example.details,root:temp}};const plan=await buildJobFolder(record,{date:"2026-09-30",customer:"Example",sequence:1});const scriptPath=join(temp,"test.ps1");await writeFile(scriptPath,plan.script);await promisify(execFile)("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath],{windowsHide:true});await writeFile(scriptPath,plan.verificationScript);await promisify(execFile)("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath],{windowsHide:true});await writeFile(scriptPath,plan.script);await assert.rejects(promisify(execFile)("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath],{windowsHide:true}));
const search=(await jobSource("Get-SupportJobFolders.ps1")).replace("# SUPPORT_JOB_FOLDER_GUARD",await jobSource("Support-JobFolderGuard.ps1"));await writeFile(scriptPath,diagnosticScript(search,{root:temp,originalsFolder:"Original files",query:"Example",dateToken:"09302026",namePattern:"^[0-9]{8}\\.[A-Za-z]+-[0-9]{2}$",staleDays:30}));const output=await promisify(execFile)("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath],{windowsHide:true});assert.equal(JSON.parse(output.stdout).folders[0].originalsMissing,false);
}finally{assert.equal(dirname(resolve(temp)),resolve(tmpdir()));assert.ok(basename(temp).startsWith("support-jobs-"));await rm(temp,{recursive:true,force:true});}});
