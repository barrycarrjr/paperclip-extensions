[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$ScriptPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Company,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$CaseReference,

  [ValidatePattern('^[A-Za-z0-9_.-]+\\[A-Za-z0-9_.@$-]+$')]
  [string]$ExpectedIdentity,

  [System.Management.Automation.PSCredential]$Credential,

  [string[]]$AttemptedTransports = @(),

  [switch]$AllowProcessExecutionPolicyBypass,

  [ValidateRange(10, 600)]
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

$source = (Resolve-Path -LiteralPath $ScriptPath).Path
if ([System.IO.Path]::GetExtension($source) -ne '.ps1') {
  throw 'ScriptPath must point to a PowerShell .ps1 file.'
}

$scriptHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$runId = [guid]::NewGuid().ToString('N')
$folderName = 'paperclip-support-' + $runId
$remoteFolder = 'C:\Windows\Temp\' + $folderName
$driveName = 'P' + $runId.Substring(0, 7)
$driveArgs = @{
  Name = $driveName
  PSProvider = 'FileSystem'
  Root = "\\$Target\C$"
  Scope = 'Script'
  ErrorAction = 'Stop'
}
if ($Credential) { $driveArgs.Credential = $Credential }

Write-Verbose "Connecting to the administrative share on $Target"
$null = New-PSDrive @driveArgs
$shareFolder = "\\$Target\C$\Windows\Temp\$folderName"
$completed = $false
$status = 'failed'
$remoteExitCode = $null
$remoteIdentity = $null
$output = ''
$processId = $null
$startedAtUtc = (Get-Date).ToUniversalTime().ToString('o')

try {
  Write-Verbose "Staging reviewed script for $Target"
  $null = New-Item -ItemType Directory -Path $shareFolder -ErrorAction Stop
  Copy-Item -LiteralPath $source -Destination ($shareFolder + '\task.ps1') -ErrorAction Stop

  $taskPath = $remoteFolder + '\task.ps1'
  $outputPath = $remoteFolder + '\output.txt'
  $exitPath = $remoteFolder + '\exit.txt'
  $identityPath = $remoteFolder + '\identity.txt'
  $runnerPath = $remoteFolder + '\runner.cmd'
  $executionPolicy = if ($AllowProcessExecutionPolicyBypass) { ' -ExecutionPolicy Bypass' } else { '' }
  $runner = @('@echo off', ('whoami > "' + $identityPath + '" 2>&1'))
  if ($ExpectedIdentity) {
    $runner += ('set /p PC_IDENTITY=<"' + $identityPath + '"')
    $runner += ('if /I not "%PC_IDENTITY%"=="' + $ExpectedIdentity + '" (')
    $runner += ('  echo Remote identity did not match expected identity. The script was not run. > "' + $outputPath + '"')
    $runner += ('  echo 10 > "' + $exitPath + '"')
    $runner += '  exit /b 10'
    $runner += ')'
  }
  $runner += ('powershell.exe -NoLogo -NoProfile -NonInteractive' + $executionPolicy + ' -File "' + $taskPath + '" > "' + $outputPath + '" 2>&1')
  $runner += ('echo %errorlevel% > "' + $exitPath + '"')
  Set-Content -LiteralPath ($shareFolder + '\runner.cmd') -Value $runner -Encoding Ascii

  $wmiArgs = @{
    Class = 'Win32_Process'
    Name = 'Create'
    ArgumentList = @('cmd.exe /d /c "' + $runnerPath + '"')
    ComputerName = $Target
    ErrorAction = 'Stop'
  }
  if ($Credential) { $wmiArgs.Credential = $Credential }
  Write-Verbose "Starting the remote process on $Target"
  $created = Invoke-WmiMethod @wmiArgs
  if ($created.ReturnValue -ne 0) {
    throw "Remote process creation returned code $($created.ReturnValue)."
  }
  $processId = $created.ProcessId

  $exitFile = $shareFolder + '\exit.txt'
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  Write-Verbose "Waiting up to $TimeoutSeconds seconds for remote script completion"
  while (-not (Test-Path -LiteralPath $exitFile)) {
    if ((Get-Date) -ge $deadline) {
      $status = 'timed_out'
      throw "Remote script did not finish within $TimeoutSeconds seconds. Its files remain at $remoteFolder for inspection."
    }
    Start-Sleep -Milliseconds 500
  }

  $remoteExitCode = [int](Get-Content -LiteralPath $exitFile -Raw).Trim()
  $identityFile = $shareFolder + '\identity.txt'
  if (Test-Path -LiteralPath $identityFile) {
    $remoteIdentity = (Get-Content -LiteralPath $identityFile -Raw).Trim()
  }
  $outputFile = $shareFolder + '\output.txt'
  if (Test-Path -LiteralPath $outputFile) {
    $output = (Get-Content -LiteralPath $outputFile -Raw).TrimEnd()
  }
  $completed = $true
  $status = if ($remoteExitCode -eq 0) { 'succeeded' } elseif ($remoteExitCode -eq 10) { 'identity_mismatch' } else { 'script_failed' }

  [pscustomobject]@{
    runId = $runId
    company = $Company
    caseReference = $CaseReference
    target = $Target
    transport = 'wmi_dcom_smb'
    attemptedTransports = $AttemptedTransports
    processExecutionPolicyBypass = [bool]$AllowProcessExecutionPolicyBypass
    scriptSha256 = $scriptHash
    processId = $processId
    remoteIdentity = $remoteIdentity
    exitCode = $remoteExitCode
    status = $status
    output = $output
  } | ConvertTo-Json -Depth 3
} finally {
  if ($completed -and (Test-Path -LiteralPath $shareFolder)) {
    $resolvedFolder = Convert-Path -LiteralPath $shareFolder
    if (-not [string]::Equals($resolvedFolder.TrimEnd('\'), $shareFolder.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'Remote cleanup path did not match the staged folder.'
    }
    Remove-Item -LiteralPath $shareFolder -Recurse -Force
  }
  Remove-PSDrive -Name $driveName -Force

  $auditBase = [System.Environment]::GetFolderPath('LocalApplicationData')
  if ([string]::IsNullOrWhiteSpace($auditBase)) { $auditBase = [System.IO.Path]::GetTempPath() }
  $auditFolder = Join-Path $auditBase 'Paperclip\SupportRemoteCommands'
  $null = New-Item -ItemType Directory -Path $auditFolder -Force
  $audit = [pscustomobject]@{
    runId = $runId
    startedAtUtc = $startedAtUtc
    finishedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    company = $Company
    caseReference = $CaseReference
    target = $Target
    transport = 'wmi_dcom_smb'
    attemptedTransports = $AttemptedTransports
    processExecutionPolicyBypass = [bool]$AllowProcessExecutionPolicyBypass
    scriptSha256 = $scriptHash
    processId = $processId
    remoteIdentity = $remoteIdentity
    status = $status
    exitCode = $remoteExitCode
  } | ConvertTo-Json -Compress
  Add-Content -LiteralPath (Join-Path $auditFolder 'audit.jsonl') -Value $audit -Encoding UTF8
}

if ($remoteExitCode -ne 0) { exit 1 }
exit 0
