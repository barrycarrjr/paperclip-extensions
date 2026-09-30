$ErrorActionPreference = 'Stop'
$certificates = @(Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.NotAfter -lt (Get-Date).AddDays(30) } | Sort-Object NotAfter)
@{ total = $certificates.Count; certificates = @($certificates | Select-Object -First 40 Subject, Thumbprint, NotBefore, NotAfter, HasPrivateKey); note = 'Machine personal store only. No private key is read or exported.' } | ConvertTo-Json -Depth 5 -Compress
