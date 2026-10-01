$ErrorActionPreference = 'Stop'
if (-not (Get-Command Get-SmbShare -ErrorAction SilentlyContinue)) { @{ supported = $false; missing = 'SmbShare module' } | ConvertTo-Json -Compress; return }
$result = @{ shares = @(Get-SmbShare | Select-Object -First 30 Name, Description, Special, CurrentUsers); note = 'Share access differs from effective NTFS file access. Files and file contents are not read.' }
if ($SupportOptions.share) {
  $name = [string]$SupportOptions.share
  if (-not (@(Get-SmbShare | Where-Object { $_.Name -eq $name }).Count)) { throw 'Exact share name was not found.' }
  $result.access = @(Get-SmbShareAccess -Name $name | Select-Object -First 40 AccountName, AccessControlType, AccessRight)
}
$result | ConvertTo-Json -Depth 5 -Compress
