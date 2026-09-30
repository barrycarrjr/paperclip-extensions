$ErrorActionPreference = 'Stop'
if (-not (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) { @{ supported = $false; missing = 'ScheduledTasks module' } | ConvertTo-Json -Compress; return }
$failures = @(); $count = 0
foreach ($task in @(Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' })) {
  $info = $task | Get-ScheduledTaskInfo
  if ($info.LastTaskResult -ne 0 -and $info.LastRunTime.Year -gt 2000) {
    $count++
    if ($failures.Count -lt 30) { $failures += [pscustomobject]@{ name = $task.TaskName; path = $task.TaskPath; state = [string]$task.State; lastResult = $info.LastTaskResult; lastRun = $info.LastRunTime; nextRun = $info.NextRunTime } }
  }
}
@{ count = $count; tasks = $failures; note = 'Nonzero status may represent an in-progress or scheduler condition; check the task documentation. Action arguments are omitted.' } | ConvertTo-Json -Depth 5 -Compress
