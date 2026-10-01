$ErrorActionPreference = 'Stop'
$system = Get-CimInstance Win32_ComputerSystem
$result = @{ domain = $system.Domain; joined = $system.PartOfDomain; domainRole = $system.DomainRole; rsatAvailable = [bool](Get-Command Get-ADDomain -ErrorAction SilentlyContinue) }
if ($system.PartOfDomain -and $system.DomainRole -lt 4) {
  try { $result.secureChannel = Test-ComputerSecureChannel -ErrorAction Stop }
  catch { $result.secureChannelAvailable = $false }
}
$time = (& w32tm.exe /query /status 2>&1 | Out-String)
$result.timeStatusExitCode = $LASTEXITCODE; $result.timeStatus = $time.Substring(0,[math]::Min(3000,$time.Length))
if ($result.rsatAvailable) {
  $domain = Get-ADDomain -Current LocalComputer
  $result.directoryDomain = $domain.DNSRoot
  $result.controllers = @(Get-ADDomainController -Filter * -Server $domain.DNSRoot | Select-Object -First 20 HostName, Site, IsReadOnly, IsGlobalCatalog)
  if ($SupportOptions.userIdentity) {
    $user = Get-ADUser -Identity ([string]$SupportOptions.userIdentity) -Server $domain.DNSRoot -Properties LockedOut, PasswordExpired, PasswordLastSet, LastLogonDate
    $result.user = $user | Select-Object SamAccountName, Enabled, LockedOut, PasswordExpired, PasswordLastSet, LastLogonDate
  }
} elseif ($SupportOptions.userIdentity) { $result.userLookupUnavailable = 'ActiveDirectory module required on the target. No software was installed.' }
$result | ConvertTo-Json -Depth 5 -Compress
