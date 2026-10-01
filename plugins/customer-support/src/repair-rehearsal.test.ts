import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rmdir, writeFile, unlink, rm } from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { buildRepairRehearsal } from "./repair-rehearsal.js";
import { buildRepairRecipe } from "./repair-catalog.js";
import { diagnosticScript, validateDiagnosticOptions } from "./diagnostic-catalog.js";

function execute(script: string, directory: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { windowsHide: true, env: { ...process.env, TMP: directory, TEMP: directory }, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; }); child.on("error", reject); child.on("close", code => code === 0 ? resolve(output) : reject(new Error(output))); child.stdin.end(script);
  });
}
test("controlled rehearsal rejects arbitrary identifiers/options and pins a unique write/cleanup pair", () => {
  assert.throws(() => buildRepairRehearsal("../../staff-file")); assert.throws(() => buildRepairRecipe("rehearse_remote_write", { directory: "Anywhere" }));
  const first = buildRepairRehearsal(); const second = buildRepairRehearsal(); assert.notEqual(first.rehearsalId, second.rehearsalId);
  assert.ok(first.script.includes("CreateNew")); assert.ok(first.verificationScript.includes("-cne $marker")); assert.ok(first.verificationScript.includes("Remove-Item -LiteralPath $file"));
  assert.ok(!first.verificationScript.includes("-Recurse")); assert.ok(!first.script.includes("Restart-Service"));
  assert.throws(() => validateDiagnosticOptions("repair_rehearsal", undefined)); assert.throws(() => validateDiagnosticOptions("repair_rehearsal", {}));
  assert.throws(() => validateDiagnosticOptions("repair_rehearsal", { rehearsalId: "../../staff-file" }));
});
test("Windows controlled rehearsal writes and verifies cleanup, preserves existing/changed content and supports reviewed recovery", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-rehearsal-test-")); const rehearsal = buildRepairRehearsal(); const path = join(directory, `paperclip-support-rehearsal-${rehearsal.rehearsalId}.txt`);
  try {
    await execute(rehearsal.script, directory); assert.equal((await readdir(directory)).length, 1); const marker = await readFile(path, "utf8"); assert.ok(marker.endsWith(rehearsal.rehearsalId));
    const inspection = diagnosticScript(await readFile(new URL("../scripts/Get-SupportRehearsal.ps1", import.meta.url), "utf8"), validateDiagnosticOptions("repair_rehearsal", { rehearsalId: rehearsal.rehearsalId }));
    const observed = JSON.parse(await execute(inspection, directory)); assert.equal(observed.exists, true); assert.equal(observed.markerMatches, true); assert.equal(observed.redirected, false); assert.ok(!JSON.stringify(observed).includes(directory));
    await assert.rejects(execute(rehearsal.script, directory)); assert.equal(await readFile(path, "utf8"), marker);
    await execute(rehearsal.verificationScript, directory); assert.deepEqual(await readdir(directory), []);
    assert.equal(JSON.parse(await execute(inspection, directory)).exists, false);
    await execute(rehearsal.recoveryScript, directory); await execute(rehearsal.cleanupVerificationScript, directory);
    await execute(rehearsal.script, directory); await writeFile(path, "changed content");
    await assert.rejects(execute(rehearsal.recoveryScript, directory)); assert.equal(await readFile(path, "utf8"), "changed content");
    // Restore only this test's known marker, then exercise the reviewed cleanup.
    await writeFile(path, marker); await execute(rehearsal.recoveryScript, directory); await execute(rehearsal.cleanupVerificationScript, directory);
    assert.deepEqual(await readdir(directory), []);
  } finally { try { await unlink(path); } catch {} await rmdir(directory); }
});
test("actual WMI receipt collector handles an empty successful output file and cleans its staging folder", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "support-empty-receipt-test-"));
  const helper = new URL("../scripts/Invoke-SupportRemoteWmiScript.ps1", import.meta.url);
  const source = await readFile(helper, "utf8");
  // Execute the real transport helper with isolated filesystem mapping and fake
  // WMI process creation. No network, password or remote command is used.
  const mock = `param()
$ErrorActionPreference='Stop'; $global:fixture=[IO.Path]::GetTempPath(); $global:stage=$null
function Map-Path([string]$value) { if ($value.StartsWith('\\\\pc.example.local\\C$\\Windows\\Temp\\')) { return Join-Path $global:fixture (($value -split '\\\\') | Select-Object -Last 1) }; return $value }
function New-PSDrive { }
function Remove-PSDrive { }
function New-Item { param($Path,$ItemType,[switch]$Force,$ErrorAction); if ($Path.StartsWith('\\\\')) { $global:stage=Map-Path $Path; Microsoft.PowerShell.Management\\New-Item -ItemType Directory -Path $global:stage } }
function Copy-Item { param($LiteralPath,$Destination,$ErrorAction); Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination (Join-Path $global:stage 'task.ps1') }
function Set-Content { param($LiteralPath,$Value,$Encoding); Microsoft.PowerShell.Management\\Set-Content -LiteralPath (Join-Path $global:stage 'runner.cmd') -Value $Value -Encoding $Encoding }
function Invoke-WmiMethod { [IO.File]::WriteAllText((Join-Path $global:stage 'output.txt'),''); [IO.File]::WriteAllText((Join-Path $global:stage 'exit.txt'),'0'); [IO.File]::WriteAllText((Join-Path $global:stage 'identity.txt'),'EXAMPLE\\support'); [pscustomobject]@{ReturnValue=0;ProcessId=1234} }
function Test-Path { param($LiteralPath,$PathType); if ($LiteralPath.StartsWith('\\\\')) { $leaf=($LiteralPath -split '\\\\') | Select-Object -Last 1; $path=if ($leaf.StartsWith('paperclip-support-')) { $global:stage } else { Join-Path $global:stage $leaf }; return Microsoft.PowerShell.Management\\Test-Path -LiteralPath $path }; Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath }
function Get-Content { param($LiteralPath,[switch]$Raw); $path=Join-Path $global:stage (($LiteralPath -split '\\\\') | Select-Object -Last 1); Microsoft.PowerShell.Management\\Get-Content -LiteralPath $path -Raw }
function Convert-Path { param($LiteralPath); $LiteralPath }
function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force); $path=[IO.Path]::GetFullPath($global:stage); if (-not $path.StartsWith($global:fixture,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture cleanup escaped' }; Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $path -Recurse -Force }
function Add-Content { }
$inputFile=Join-Path $global:fixture 'input.ps1'; [IO.File]::WriteAllText($inputFile,'# controlled fixture')
$helper=[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString("base64")}')))
try { & $helper -Target pc.example.local -ScriptPath $inputFile -Company example -CaseReference EMPTY-OUTPUT -ExpectedIdentity 'EXAMPLE\\support' } catch { [Console]::Error.WriteLine($_.ScriptStackTrace); throw }
`;
  try {
    const receipt = JSON.parse(await execute(mock, directory)); assert.equal(receipt.status, "succeeded"); assert.equal(receipt.exitCode, 0); assert.equal(receipt.output, "");
    assert.deepEqual(await readdir(directory), ["input.ps1"]);
  } finally {
    const cleanup = resolve(directory); assert.ok(cleanup.startsWith(resolve(tmpdir()) + sep) && basename(cleanup).startsWith("support-empty-receipt-test-"));
    await rm(cleanup, { recursive: true, force: true });
  }
});
