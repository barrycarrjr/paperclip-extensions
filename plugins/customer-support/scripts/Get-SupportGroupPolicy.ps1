$ErrorActionPreference = 'Stop'
$resultText = (& gpresult.exe /scope computer /r 2>&1 | Out-String)
$exit = $LASTEXITCODE
if ($resultText.Length -gt 8000) { $resultText = $resultText.Substring(0,8000) + ' [truncated]' }
$result = @{ scope = 'computer'; gpresultExitCode = $exit; summary = $resultText; rsatAvailable = [bool](Get-Command Get-GPO -ErrorAction SilentlyContinue); note = 'User policy must be checked for the affected user, not the support identity. Resultant policy may be stale until processing occurs.' }
if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) {
  try { $result.appliedGpos = @(Get-CimInstance -Namespace root/rsop/computer -ClassName RSOP_GPO -ErrorAction Stop | Select-Object -First 30 Name, GuidName, Enabled, AccessDenied, FilterAllowed) }
  catch { $result.rsopAvailable = $false }
}
$result | ConvertTo-Json -Depth 5 -Compress
