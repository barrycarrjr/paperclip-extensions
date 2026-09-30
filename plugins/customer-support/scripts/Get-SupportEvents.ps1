$ErrorActionPreference = 'Stop'
$log = 'System'; $hours = 24; $limit = 20
if ($SupportOptions.log) { $log = [string]$SupportOptions.log }
if ($SupportOptions.hours) { $hours = [int]$SupportOptions.hours }
if ($SupportOptions.limit) { $limit = [int]$SupportOptions.limit }
$names = @{ System = 'System'; Application = 'Application'; GroupPolicy = 'Microsoft-Windows-GroupPolicy/Operational'; PrintService = 'Microsoft-Windows-PrintService/Admin' }
$events = @()
try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = $names[$log]; StartTime = (Get-Date).AddHours(-$hours); Level = @(1,2,3) } -MaxEvents $limit -ErrorAction Stop | ForEach-Object {
    $message = [string]$_.Message
    if ($message.Length -gt 500) { $message = $message.Substring(0,500) + ' [truncated]' }
    [pscustomobject]@{ atUtc = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id; provider = $_.ProviderName; level = $_.LevelDisplayName; message = $message }
  })
} catch {
  if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
}
@{ log = $names[$log]; hours = $hours; limit = $limit; events = $events; note = 'Messages are bounded excerpts and can contain private operational details. No matches does not establish overall health.' } | ConvertTo-Json -Depth 5 -Compress
