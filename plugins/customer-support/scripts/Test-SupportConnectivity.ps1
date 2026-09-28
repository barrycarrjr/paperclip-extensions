param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Target,

  [ValidateRange(1, 65535)]
  [int[]]$Port = @()
)

$ErrorActionPreference = 'Stop'

if ($Target -notmatch '^[A-Za-z0-9._:-]+$') {
  throw 'Target must be a hostname or IP address.'
}

$dnsAddresses = @()
try {
  $dnsAddresses = @([System.Net.Dns]::GetHostAddresses($Target) | ForEach-Object { $_.IPAddressToString })
} catch {
  # A missing DNS record is a result to report, not a reason to stop port checks.
}

$pingReachable = $false
try {
  $pingReachable = [bool](Test-Connection -ComputerName $Target -Count 1 -Quiet -ErrorAction Stop)
} catch {
  # ICMP may be blocked even when a management port is reachable.
}

$portResults = @()
foreach ($number in ($Port | Select-Object -Unique)) {
  $reachable = $false
  $detail = $null
  try {
    $probe = Test-NetConnection -ComputerName $Target -Port $number -InformationLevel Detailed -WarningAction SilentlyContinue
    $reachable = [bool]$probe.TcpTestSucceeded
  } catch {
    $detail = $_.Exception.Message
  }
  $portResults += [pscustomobject]@{
    port = $number
    tcpReachable = $reachable
    error = $detail
  }
}

[pscustomobject]@{
  target = $Target
  checkedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  dnsAddresses = $dnsAddresses
  pingReachable = $pingReachable
  ports = $portResults
} | ConvertTo-Json -Depth 5
