$ErrorActionPreference = 'Stop'
$events = @(); $status = 'available'
try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName='System'; StartTime=(Get-Date).AddDays(-7); Id=@(41,1001,6008) } -MaxEvents 30 -ErrorAction Stop | ForEach-Object {
    $code = $null
    if ($_.Id -eq 1001 -and $_.ProviderName -match 'WER-SystemErrorReporting|BugCheck') { $match = [regex]::Match([string]$_.Message,'0x[0-9a-fA-F]{8}'); if ($match.Success) { $code=$match.Value } }
    [pscustomobject]@{ atUtc=$_.TimeCreated.ToUniversalTime().ToString('o'); id=$_.Id; provider=$_.ProviderName; bugcheckCode=$code }
  })
} catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { $status='unavailable' } }
@{ observedAtUtc=[DateTime]::UtcNow.ToString('o'); status=$status; days=7; limit=30; events=$events; limitations='Event metadata/stop codes only; no dump contents, memory, raw messages or user paths. Power-loss events alone do not prove a driver fault. Correlate hardware, updates and event times; WinDbg analysis of an explicitly approved dump may be needed. No dump collection or upload is performed.' } | ConvertTo-Json -Depth 5 -Compress
