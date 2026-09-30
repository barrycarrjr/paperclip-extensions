import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { jobSource } from "./job-folders.js";

// Execute the actual scripts with synthetic provider results, without accessing a PC.
async function powershell(source: string) {
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { windowsHide: true, timeout: 20_000 });
  return JSON.parse(result.stdout);
}
test("battery capacity treats unsupported estimates as unknown and keeps a real ratio", { skip: process.platform !== "win32" }, async () => {
  const result = await powershell(`function Get-CimInstance { @([pscustomobject]@{Name='Unsupported';DesignCapacity=0;FullChargeCapacity=0},[pscustomobject]@{Name='Example';DesignCapacity=50000;FullChargeCapacity=40000}) }\n${await jobSource("Get-SupportBattery.ps1")}`);
  assert.equal(result.status, "available");
  assert.equal(result.batteries[0].capacityPercent, null);
  assert.equal(result.batteries[0].capacityAvailable, false);
  assert.equal(result.batteries[1].capacityPercent, 80);
  const unavailable = await powershell(`function Get-CimInstance { throw 'Provider unavailable' }\n${await jobSource("Get-SupportBattery.ps1")}`);
  assert.equal(unavailable.status, "unavailable");
});
test("crash observations omit messages and do not mistake another provider for a bugcheck", { skip: process.platform !== "win32" }, async () => {
  const result = await powershell(`function Get-WinEvent { @([pscustomobject]@{Id=1001;ProviderName='Other';TimeCreated=(Get-Date);Message='0x00000001 example private path'},[pscustomobject]@{Id=1001;ProviderName='Microsoft-Windows-WER-SystemErrorReporting';TimeCreated=(Get-Date);Message='Bugcheck 0x0000009f example private path'}) }\n${await jobSource("Get-SupportCrashes.ps1")}`);
  assert.equal(result.events[0].bugcheckCode, null);
  assert.equal(result.events[1].bugcheckCode, "0x0000009f");
  assert.doesNotMatch(JSON.stringify(result), /private path|Message/);
});
test("hardware sections fail independently and AI environment returns metadata only", { skip: process.platform !== "win32" }, async () => {
  const hardware = await powershell(`function Get-CimInstance { param($ClassName) if($ClassName -eq 'Win32_PnPSignedDriver'){throw 'No driver provider'}; [pscustomobject]@{Name='Example device';ConfigManagerErrorCode=10;DriverPath='private driver path'} }; function Get-PhysicalDisk { throw 'No storage provider' }\n${await jobSource("Get-SupportHardware.ps1")}`);
  assert.equal(hardware.sections.devices.status, "available");
  assert.equal(hardware.sections.drivers.status, "unavailable");
  assert.equal(hardware.sections.disks.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(hardware.sections), /private driver path/);
  const environment = await powershell(await jobSource("Get-SupportAIEnvironment.ps1"));
  assert.equal(environment.tools.length, 11);
  assert.equal(environment.pathChecks.length, 2);
  for (const tool of environment.tools) assert.deepEqual(Object.keys(tool).sort(), ["available", "commandType", "fileVersion", "name"]);
  assert.match(environment.limitations, /MCP handshake/);
});
