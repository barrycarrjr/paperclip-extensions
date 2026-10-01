$ErrorActionPreference = 'Stop'
[pscustomobject]@{
  computer = $env:COMPUTERNAME
  identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
} | ConvertTo-Json -Compress
