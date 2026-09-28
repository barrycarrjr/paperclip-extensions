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

  [ValidateSet('Auto', 'WinRMHttps', 'WinRMHttp', 'Wmi')]
  [string]$Transport = 'Auto',

  [switch]$AllowProcessExecutionPolicyBypass,

  [ValidateRange(10, 600)]
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

$source = (Resolve-Path -LiteralPath $ScriptPath).Path
if ([System.IO.Path]::GetExtension($source) -ne '.ps1') {
  throw 'ScriptPath must point to a PowerShell .ps1 file.'
}

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync($HostName, $Port)
    return $connect.Wait(2500) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Test-TransportFailure([string]$Message) {
  if ($Message -match '(?i)(access is denied|unauthorized|logon failure|incorrect password|credentials were rejected|not authorized)') {
    return $false
  }
  return $Message -match '(?i)(2150859046|0x80338126|timed? out|cannot complete the operation|connection refused|network path|not reachable|cannot connect|firewall)'
}

$candidates = switch ($Transport) {
  'Auto' { @('WinRMHttps', 'Wmi', 'WinRMHttp') }
  default { @($Transport) }
}
$attempts = @()

foreach ($candidate in $candidates) {
  Write-Verbose "Trying $candidate for $Target"
  if ($candidate -eq 'Wmi') {
    if ($Transport -eq 'Auto' -and ((-not (Test-TcpPort -HostName $Target -Port 135)) -or (-not (Test-TcpPort -HostName $Target -Port 445)))) {
      $attempts += 'Wmi: TCP 135 or 445 unreachable'
      continue
    }
    $wmiArgs = @{
      Target = $Target
      ScriptPath = $source
      Company = $Company
      CaseReference = $CaseReference
      ExpectedIdentity = $ExpectedIdentity
      AttemptedTransports = $attempts
      TimeoutSeconds = $TimeoutSeconds
      AllowProcessExecutionPolicyBypass = $AllowProcessExecutionPolicyBypass
    }
    if ($Credential) { $wmiArgs.Credential = $Credential }
    & (Join-Path $PSScriptRoot 'Invoke-SupportRemoteWmiScript.ps1') @wmiArgs -Verbose:($VerbosePreference -eq 'Continue')
    exit $LASTEXITCODE
  }

  if ($Target -in @('localhost', '127.0.0.1')) {
    $attempts += "$candidate`: Kerberos requires a DNS or NetBIOS hostname"
    if ($Transport -ne 'Auto') { throw "$candidate requires a DNS or NetBIOS hostname for Kerberos." }
    continue
  }

  $port = if ($candidate -eq 'WinRMHttps') { 5986 } else { 5985 }
  if (-not (Test-TcpPort -HostName $Target -Port $port)) {
    $attempts += "$candidate`: TCP $port unreachable"
    if ($Transport -ne 'Auto') { throw "$candidate requires TCP $port on $Target." }
    continue
  }

  $sessionArgs = @{
    ComputerName = $Target
    Authentication = 'Kerberos'
    SessionOption = (New-PSSessionOption -OpenTimeout 10000 -OperationTimeout 30000)
    ErrorAction = 'Stop'
  }
  if ($Credential) { $sessionArgs.Credential = $Credential }
  if ($candidate -eq 'WinRMHttps') { $sessionArgs.UseSSL = $true }

  $session = $null
  try {
    Write-Verbose "Opening $candidate session"
    $session = New-PSSession @sessionArgs
  } catch {
    $message = $_.Exception.Message
    $attempts += "$candidate`: $message"
    if ($Transport -ne 'Auto' -or -not (Test-TransportFailure $message)) {
      throw
    }
    continue
  }

  $runId = [guid]::NewGuid().ToString('N')
  $startedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  $scriptHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
  $status = 'failed'
  $exitCode = $null
  $remoteIdentity = $null
  try {
    $remoteIdentity = [string](Invoke-Command -Session $session -ScriptBlock {
      [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    } -ErrorAction Stop)
    if ($ExpectedIdentity -and -not [string]::Equals($remoteIdentity, $ExpectedIdentity, [System.StringComparison]::OrdinalIgnoreCase)) {
      $status = 'identity_mismatch'
      throw "Remote identity $remoteIdentity did not match expected identity $ExpectedIdentity. The script was not run."
    }
    if ((Get-Item -LiteralPath $source).Length -gt 65536) {
      throw 'WinRM script size exceeds 64 KiB. Select the Wmi transport for this file.'
    }
    $scriptBody = Get-Content -LiteralPath $source -Raw
    $result = Invoke-Command -Session $session -ArgumentList $scriptBody -ScriptBlock {
      param([string]$Body)
      $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      try {
        $ErrorActionPreference = 'Stop'
        $text = (& ([scriptblock]::Create($Body)) 2>&1 | Out-String).TrimEnd()
        [pscustomobject]@{ identity = $identity; exitCode = 0; output = $text }
      } catch {
        [pscustomobject]@{ identity = $identity; exitCode = 1; output = $_.ToString() }
      }
    } -ErrorAction Stop
    $exitCode = [int]$result.exitCode
    $status = if ($exitCode -eq 0) { 'succeeded' } else { 'script_failed' }
    [pscustomobject]@{
      runId = $runId
      company = $Company
      caseReference = $CaseReference
      target = $Target
      transport = $candidate
      attemptedTransports = $attempts
      scriptSha256 = $scriptHash
      remoteIdentity = $remoteIdentity
      exitCode = $exitCode
      status = $status
      output = $result.output
    } | ConvertTo-Json -Depth 4
  } finally {
    Remove-PSSession $session
    $auditBase = [System.Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($auditBase)) { $auditBase = [System.IO.Path]::GetTempPath() }
    $auditFolder = Join-Path $auditBase 'Paperclip\SupportRemoteCommands'
    $null = New-Item -ItemType Directory -Path $auditFolder -Force
    [pscustomobject]@{
      runId = $runId
      startedAtUtc = $startedAtUtc
      finishedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
      company = $Company
      caseReference = $CaseReference
      target = $Target
      transport = $candidate
      attemptedTransports = $attempts
      scriptSha256 = $scriptHash
      remoteIdentity = $remoteIdentity
      status = $status
      exitCode = $exitCode
    } | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $auditFolder 'audit.jsonl') -Encoding UTF8
  }
  if ($exitCode -ne 0) { exit 1 }
  exit 0
}

throw "No remote command transport was available for $Target. Attempts: $($attempts -join '; ')"
