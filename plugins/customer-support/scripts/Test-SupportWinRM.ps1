param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Target,

  [string]$ExpectedIdentity = '',

  [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'

if ($Target -notmatch '^[A-Za-z0-9._-]+$') {
  throw 'Target must be a DNS hostname for Kerberos authentication.'
}

$result = [ordered]@{
  target = $Target
  checkedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  clientIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  tcp5985Reachable = $false
  wsmanResponded = $false
  kerberosAuthenticated = $false
  authenticated = $false
  stage = 'tcp'
  remoteComputer = $null
  remoteIdentity = $null
  identityMatches = $null
  error = $null
}

try {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync($Target, 5985)
    $result.tcp5985Reachable = $connect.Wait(2500) -and $client.Connected
  } finally {
    $client.Dispose()
  }
  if (-not $result.tcp5985Reachable) { throw 'TCP port 5985 is not reachable from this host.' }

  $result.stage = 'wsman'
  $null = Test-WSMan -ComputerName $Target -ErrorAction Stop
  $result.wsmanResponded = $true

  $result.stage = 'kerberos'
  $testArgs = @{
    ComputerName = $Target
    Authentication = 'Kerberos'
    ErrorAction = 'Stop'
  }
  if ($Credential) { $testArgs.Credential = $Credential }
  $null = Test-WSMan @testArgs
  $result.kerberosAuthenticated = $true

  $result.stage = 'remote_shell'
  $options = New-PSSessionOption -OpenTimeout 20000 -OperationTimeout 20000
  $invokeArgs = @{
    ComputerName = $Target
    Authentication = 'Kerberos'
    SessionOption = $options
    ErrorAction = 'Stop'
  }
  if ($Credential) { $invokeArgs.Credential = $Credential }
  $remote = Invoke-Command @invokeArgs -ScriptBlock {
    [pscustomobject]@{
      computer = $env:COMPUTERNAME
      identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    }
  }

  $result.authenticated = $true
  $result.remoteComputer = $remote.computer
  $result.remoteIdentity = $remote.identity
  if ($ExpectedIdentity) {
    $result.stage = 'identity'
    $result.identityMatches = [string]::Equals($remote.identity, $ExpectedIdentity, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $result.identityMatches) { throw 'Remote identity does not match the expected account.' }
  }
  $result.stage = 'complete'
} catch {
  $result.error = $_.Exception.Message
}

[pscustomobject]$result | ConvertTo-Json -Depth 3
if (-not $result.authenticated -or $result.identityMatches -eq $false) { exit 1 }
