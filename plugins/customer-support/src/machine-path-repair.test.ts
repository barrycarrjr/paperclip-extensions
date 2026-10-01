import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { resolve, join, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { buildMachinePathRepair, machinePathProvider, validateMachinePathDirectory } from "./machine-path-repair.js";
import { buildRepairRecipe, prepareRepair } from "./repair-catalog.js";
import { openInteractiveCase } from "./interactive-support.js";
import type { Config } from "./routing.js";

const baseline="%SystemRoot%\\system32;C:\\ExampleOriginal";
const snapshot=(value=baseline,kind="ExpandString")=>({status:"available",sha256:createHash("sha256").update("support-machine-path-v1\n"+kind+"\n"+value,"utf8").digest("hex"),registryKind:kind});

test("machine PATH append needs evidence and rejects network, relative, expanded and ambiguous directories",()=>{
  for(const value of ["tools","\\\\server\\share","C:\\","C:\\Tools;Other","C:\\Tools\\..\\Other","C:\\Tools\\","C:\\Tools.\\Sub","C:\\%TEMP%","C:\\Tools:Other","C:/Tools","C:\\Tools\""])assert.throws(()=>validateMachinePathDirectory(value));
  assert.throws(()=>buildRepairRecipe("add_machine_path",{directory:"C:\\ExampleTools"}));
  assert.throws(()=>buildMachinePathRepair("C:\\ExampleTools",{...snapshot(),status:"unavailable"}));
  assert.throws(()=>buildMachinePathRepair("C:\\ExampleTools",{...snapshot(),registryKind:"MultiString"}));
  assert.throws(()=>buildRepairRecipe("add_machine_path",{directory:"C:\\ExampleTools",baselineHash:"made-up"},snapshot()));
  const plan=buildMachinePathRepair("C:\\ExampleTools",snapshot());
  for(const source of [plan.script,plan.verificationScript,plan.recoveryScript,plan.recoveryVerificationScript])assert.ok(source.length<16384);
  assert.doesNotMatch(JSON.stringify(plan),/ExampleOriginal|%SystemRoot%/);
  assert.match(plan.script,/DoNotExpandEnvironmentNames/);assert.match(plan.recoveryNotes,/not an atomic lock/);
});

async function execute(script:string){
  return new Promise<string>((resolveOutput,reject)=>{
    const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command","& ([scriptblock]::Create([Console]::In.ReadToEnd()))"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let output="";const timer=setTimeout(()=>{child.kill();reject(new Error("Fixture PowerShell timeout"));},20000);
    child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
    child.on("error",error=>{clearTimeout(timer);reject(error);});child.on("close",code=>{clearTimeout(timer);code===0?resolveOutput(output):reject(new Error(output));});child.stdin.end(script);
  });
}
async function windowsFixture(){
  const root=await mkdtemp(join(tmpdir(),"support-path-test-")),directory=join(root,"tools"),stateFile=join(root,"state.json");await mkdir(directory);
  const reset=async(value=baseline,kind="ExpandString")=>writeFile(stateFile,JSON.stringify({value,kind}));
  await reset();
  const options=Buffer.from(JSON.stringify({stateFile}),"utf8").toString("base64");
  const provider=String.raw`
$fixture=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('OPTIONS')) | ConvertFrom-Json
function Read-SupportMachinePath { Get-Content -LiteralPath $fixture.stateFile -Raw | ConvertFrom-Json }
function Write-SupportMachinePath([string]$value,[string]$kind,[string]$expectedHash) {
  $before=Read-SupportMachinePath
  if ($before.kind -cne $kind -or (Get-SupportPathHash $before.value $before.kind) -cne $expectedHash) { throw 'Fixture refused changed baseline' }
  [IO.File]::WriteAllText($fixture.stateFile,(@{value=$value;kind=$kind} | ConvertTo-Json -Compress))
}
function Get-Acl {
  param($LiteralPath,$ErrorAction)
  $acl=[pscustomobject]@{}
  $acl | Add-Member ScriptMethod GetOwner { param($type); [pscustomobject]@{Value='S-1-5-32-544'} }
  $acl | Add-Member ScriptMethod GetAccessRules { param($explicit,$inherited,$type); @() }
  return $acl
}
`.replace("OPTIONS",options);
  const run=async(script:string,extra="")=>execute(extra+script.replace(machinePathProvider,provider));
  const state=async()=>JSON.parse(await readFile(stateFile,"utf8"));
  const cleanup=async()=>{const target=resolve(root);assert.ok(target.startsWith(resolve(tmpdir())+sep)&&basename(target).startsWith("support-path-test-"));await rm(target,{recursive:true,force:true});};
  return{root,directory,reset,run,state,cleanup};
}

test("actual Windows recipe preserves raw PATH/type, verifies append and restores only its unchanged suffix",{skip:process.platform!=="win32"},async()=>{
  const f=await windowsFixture();try{
    for(const kind of ["String","ExpandString"]){
      await f.reset(baseline,kind);const plan=buildMachinePathRepair(f.directory,snapshot(baseline,kind));
      const result=JSON.parse(await f.run(plan.script));assert.equal(result.status,"machine_path_appended");assert.equal(result.requiresNewEnvironment,true);
      assert.deepEqual(await f.state(),{value:baseline+";"+f.directory,kind});
      const verified=JSON.parse(await f.run(plan.verificationScript));assert.equal(verified.toolExecutionVerified,false);
      await assert.rejects(f.run(plan.script));assert.deepEqual(await f.state(),{value:baseline+";"+f.directory,kind});
      await f.run(plan.recoveryScript);await f.run(plan.recoveryVerificationScript);assert.deepEqual(await f.state(),{value:baseline,kind});
      await f.run(plan.recoveryScript);assert.deepEqual(await f.state(),{value:baseline,kind});
      await f.run(plan.script);await f.reset(baseline+";C:\\OtherChange;"+f.directory,kind);
      await assert.rejects(f.run(plan.recoveryScript));await assert.rejects(f.run(plan.verificationScript));
      assert.equal((await f.state()).value,baseline+";C:\\OtherChange;"+f.directory);
    }
  }finally{await f.cleanup();}
});

test("actual Windows guards refuse stale, duplicate, missing, redirected and non-administrator-writable directories",{skip:process.platform!=="win32"},async()=>{
  const f=await windowsFixture();try{
    const plan=buildMachinePathRepair(f.directory,snapshot());
    await f.reset(baseline+";C:\\ExternalChange");await assert.rejects(f.run(plan.script));assert.equal((await f.state()).value,baseline+";C:\\ExternalChange");
    await f.reset(baseline,"String");await assert.rejects(f.run(plan.script));assert.equal((await f.state()).kind,"String");
    const duplicate=baseline+";"+f.directory.toUpperCase()+"\\";
    await f.reset(duplicate);await assert.rejects(f.run(buildMachinePathRepair(f.directory,snapshot(duplicate)).script));assert.equal((await f.state()).value,duplicate);
    await f.reset();await assert.rejects(f.run(buildMachinePathRepair(join(f.root,"absent"),snapshot()).script));
    const link=join(f.root,"redirect");await symlink(f.directory,link,"junction");await assert.rejects(f.run(buildMachinePathRepair(link,snapshot()).script));
    // Use the real ancestry/ACE checks with a synthetic ACL provider. This
    // avoids modifying local ACLs and still exercises the production checks.
    const unsafe=String.raw`
function Get-Acl {
  param($LiteralPath,$ErrorAction)
  $acl=[pscustomobject]@{}
  $acl | Add-Member ScriptMethod GetOwner { param($type); [pscustomobject]@{Value='S-1-5-32-544'} }
  $acl | Add-Member ScriptMethod GetAccessRules { param($a,$b,$type); @([pscustomobject]@{PropagationFlags=[Security.AccessControl.PropagationFlags]::None;AccessControlType=[Security.AccessControl.AccessControlType]::Allow;IdentityReference=[pscustomobject]@{Value='S-1-5-32-545'};FileSystemRights=[Security.AccessControl.FileSystemRights]::Modify}) }
  return $acl
}
`;
    // Override the fixture provider's empty ACL after its function definitions.
    await assert.rejects(f.run(plan.script.replace("\nAssert-SupportPathDirectory",unsafe+"\nAssert-SupportPathDirectory")));
    assert.deepEqual(await f.state(),{value:baseline,kind:"ExpandString"});
  }finally{await f.cleanup();}
});

test("PATH preparation uses only recent same-company case target/review evidence and saves recovery without executing",async()=>{
  const companyId="11111111-1111-4111-8111-111111111111",namespace="plugin_customer_support_0c69412611";
  const db=new PGlite();await db.exec('CREATE SCHEMA '+namespace);
  for(const name of(await readdir(new URL("../migrations/",import.meta.url))).filter(n=>n.endsWith(".sql")).sort())await db.exec(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
  const cfg:Config={remoteAccessProfiles:[{companyId,id:"example",credentialUser:"EXAMPLE\\support",passwordRef:"33333333-3333-4333-8333-333333333333",scopes:[{kind:"dns_suffix",value:"office.example.local",transport:"Wmi"}]}]};
  const run={companyId,userId:"operator",chatSessionId:"chat",userPermission:"support:repair"} as ToolRunContext;
  const ctx={db:{namespace,query:async(sql:string,params:unknown[])=>(await db.query(sql,params)).rows,execute:async(sql:string,params:unknown[])=>({rowCount:(await db.query(sql,params)).affectedRows})},activity:{log:async()=>{}}} as unknown as PluginContext;
  try{
    const opened=await openInteractiveCase(ctx,cfg,run,{target:"pc",summary:"Tool setup"}),input={caseId:opened.caseId,operation:"add_machine_path",options:{directory:"C:\\ExampleTools"}};
    await assert.rejects(prepareRepair(ctx,cfg,run,input));
    const save=async(target:string,version:number)=>{await db.query('DELETE FROM '+namespace+'.support_diagnostics');await db.query('INSERT INTO '+namespace+".support_diagnostics(company_id,case_id,check_kind,result,user_id) VALUES($1,$2,'ai_environment',$3::jsonb,'operator')",[companyId,opened.caseId,JSON.stringify({observedTarget:target,caseReviewVersion:version,findings:{machinePathSnapshot:snapshot()}})]);};
    await save("other.office.example.local",1);await assert.rejects(prepareRepair(ctx,cfg,run,input));
    await save(opened.target,0);await assert.rejects(prepareRepair(ctx,cfg,run,input));
    await save(opened.target,1);await db.exec('UPDATE '+namespace+".support_diagnostics SET created_at=now()-interval '31 minutes'");await assert.rejects(prepareRepair(ctx,cfg,run,input));
    await save(opened.target,1);const result=await prepareRepair(ctx,cfg,run,input);
    assert.ok(result.recoveryPlanId);assert.equal(result.priorState?.registryKind,"ExpandString");assert.equal(result.recoveryRepair?.target,opened.target);assert.equal(result.repair.target,opened.target);
    assert.doesNotMatch(JSON.stringify(result),/ExampleOriginal|%SystemRoot%/);
    assert.equal((await db.query<{n:number}>('SELECT count(*) AS n FROM '+namespace+'.support_actions')).rows[0]?.n,0);
    await assert.rejects(prepareRepair(ctx,cfg,{...run,companyId:"22222222-2222-4222-8222-222222222222"},input));
    await assert.rejects(prepareRepair(ctx,cfg,{...run,userPermission:"support:diagnose"},input));
  }finally{await db.close();}
});
