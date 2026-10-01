import { diagnosticScript } from "./diagnostic-catalog.js";
import { IntakeError } from "./routing.js";

export interface MachinePathSnapshot { status: string; sha256: string; registryKind: string }

// Windows tests replace only this registry adapter with an isolated file.
// They never write the developer's real machine environment.
export const machinePathProvider = String.raw`
function Read-SupportMachinePath {
  $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment',$false)
  if (-not $key) { throw 'Machine environment registry is unavailable' }
  try {
    $kind=[string]$key.GetValueKind('Path')
    $value=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($value -isnot [string] -or $kind -notin @('String','ExpandString')) { throw 'Unsupported machine PATH value' }
    [pscustomobject]@{ value=$value; kind=$kind }
  } finally { $key.Dispose() }
}
function Write-SupportMachinePath([string]$value,[string]$kind,[string]$expectedHash) {
  $key=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment',$true)
  if (-not $key) { throw 'Machine environment write access is unavailable' }
  try {
    $beforeKind=[string]$key.GetValueKind('Path')
    $before=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($before -isnot [string] -or $beforeKind -cne $kind -or (Get-SupportPathHash $before $beforeKind) -cne $expectedHash) { throw 'Machine PATH changed before the write' }
    $key.SetValue('Path',$value,[Microsoft.Win32.RegistryValueKind]::$kind)
    $key.Flush()
  } finally { $key.Dispose() }
}
`;

const guards = String.raw`
function Get-SupportPathHash([string]$value,[string]$kind) {
  $digest=[Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes('support-machine-path-v1'+[char]10+$kind+[char]10+$value)))).Replace('-','').ToLowerInvariant() } finally { $digest.Dispose() }
}
function Assert-SupportPathDirectory([string]$directory) {
  if ($directory -notmatch '^[A-Za-z]:\\' -or $directory -match '[%;"<>|?*]' -or $directory.Substring(3) -match '[:/]' -or $directory.Length -gt 200) { throw 'Use an exact local absolute directory' }
  foreach($part in $directory.Substring(3).Split('\')) { if (-not $part -or $part -in @('.','..') -or $part -match '[. ]$') { throw 'Ambiguous directory is unsupported' } }
  $item=Get-Item -LiteralPath $directory -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or -not $item.FullName.Equals($directory,[StringComparison]::OrdinalIgnoreCase)) { throw 'Exact directory was not found' }
  $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $selected=$true
  while ($item) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected directory or parent is unsupported' }
    $acl=Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
    if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'Directory and parents must have trusted machine owners' }
    $rights=[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($selected) { $rights=$rights -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes }
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $rights)) { throw 'Directory or parent grants unsupported non-administrator write access' }
    }
    $selected=$false; $item=$item.Parent
  }
}
function Get-SupportPathPrefix($state) {
  if ($state.kind -cne [string]$SupportOptions.registryKind) { throw 'Machine PATH registry type changed' }
  $suffix=';'+[string]$SupportOptions.directory
  if (-not $state.value.EndsWith($suffix,[StringComparison]::Ordinal)) { throw 'Machine PATH no longer has the exact appended entry' }
  $prefix=$state.value.Substring(0,$state.value.Length-$suffix.Length)
  if ((Get-SupportPathHash $prefix $state.kind) -cne [string]$SupportOptions.baselineHash) { throw 'Other machine PATH entries changed; recovery refused' }
  return $prefix
}
`;

export function validateMachinePathDirectory(directory: unknown): string {
  if(typeof directory!=="string"||directory.length>200||! /^[a-z]:\\/i.test(directory)||/[%;"<>|?*\x00-\x1f]/.test(directory)||/[:/]/.test(directory.slice(3))||directory.slice(3).split("\\").some(part=>!part||part==="."||part===".."||/[. ]$/.test(part)))throw new IntakeError(422,"Use one exact existing local absolute directory, without environment variables or redirects");
  return directory;
}

export function buildMachinePathRepair(directory: unknown,snapshot: MachinePathSnapshot) {
  const exact=validateMachinePathDirectory(directory);
  if(snapshot.status!=="available"||! /^[a-f0-9]{64}$/.test(snapshot.sha256)||!["String","ExpandString"].includes(snapshot.registryKind))throw new IntakeError(409,"Run a fresh ai_environment diagnostic with an available machine PATH snapshot");
  const options={directory:exact,baselineHash:snapshot.sha256,registryKind:snapshot.registryKind};
  const prelude="$ErrorActionPreference='Stop'\n"+machinePathProvider+guards;
  const script=String.raw`
Assert-SupportPathDirectory ([string]$SupportOptions.directory)
$state=Read-SupportMachinePath
if ($state.kind -cne [string]$SupportOptions.registryKind -or (Get-SupportPathHash $state.value $state.kind) -cne [string]$SupportOptions.baselineHash) { throw 'Machine PATH changed since diagnosis' }
foreach($entry in $state.value.Split(';')) {
  $existing=[Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"')).TrimEnd('\')
  if ($existing.Equals([string]$SupportOptions.directory,[StringComparison]::OrdinalIgnoreCase)) { throw 'Directory already exists in machine PATH' }
}
$updated=$state.value+';'+[string]$SupportOptions.directory
if ($updated.Length -gt 16000) { throw 'Resulting machine PATH exceeds the supported bound' }
Assert-SupportPathDirectory ([string]$SupportOptions.directory)
Write-SupportMachinePath $updated $state.kind ([string]$SupportOptions.baselineHash)
$after=Read-SupportMachinePath
$null=Get-SupportPathPrefix $after
@{status='machine_path_appended'; requiresNewEnvironment=$true} | ConvertTo-Json -Compress
`;
  const verification="Assert-SupportPathDirectory ([string]$SupportOptions.directory)\n$null=Get-SupportPathPrefix (Read-SupportMachinePath)\n@{status='configuration_verified'; toolExecutionVerified=$false} | ConvertTo-Json -Compress";
  const recovery=String.raw`
$state=Read-SupportMachinePath
if ($state.kind -ceq [string]$SupportOptions.registryKind -and (Get-SupportPathHash $state.value $state.kind) -ceq [string]$SupportOptions.baselineHash) { @{status='original_path_already_present'} | ConvertTo-Json -Compress; return }
$prefix=Get-SupportPathPrefix $state
Write-SupportMachinePath $prefix $state.kind (Get-SupportPathHash $state.value $state.kind)
$after=Read-SupportMachinePath
if ((Get-SupportPathHash $after.value $after.kind) -cne [string]$SupportOptions.baselineHash) { throw 'Recovery configuration verification failed' }
@{status='original_machine_path_restored'} | ConvertTo-Json -Compress
`;
  const recoveryVerification="$state=Read-SupportMachinePath\nif ((Get-SupportPathHash $state.value $state.kind) -cne [string]$SupportOptions.baselineHash) { throw 'Original machine PATH has not been restored' }";
  return {script:diagnosticScript(prelude+script,options),verificationScript:diagnosticScript(prelude+verification,options),recoveryScript:diagnosticScript(prelude+recovery,options),recoveryVerificationScript:diagnosticScript(prelude+recoveryVerification,options),priorState:{machinePathSha256:snapshot.sha256,registryKind:snapshot.registryKind},expectedEffect:"Append the exact existing trusted directory to machine PATH",recoveryNotes:"Preserves the raw previous entries and registry type. Recovery removes only the exact appended suffix when its remaining prefix matches the captured SHA256. Other PATH changes refuse recovery; inspect before another action. Existing processes, services and staff sessions retain their current environment. This does not install, launch, authenticate or prove availability of a tool. It changes future machine environments for all users. Registry guards are rechecks, not an atomic lock against external administrators; privileges and trusted local administrator access are prerequisites."};
}
