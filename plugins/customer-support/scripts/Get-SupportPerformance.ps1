$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = @(Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage)
$processes = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 @{n='name';e={$_.ProcessName}}, @{n='id';e={$_.Id}}, @{n='memoryMB';e={[math]::Round($_.WorkingSet64 / 1MB)}})
[pscustomobject]@{
  computer = $env:COMPUTERNAME
  sampledAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  cpuLoadPercent = $cpu
  totalMemoryMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
  freeMemoryMB = [math]::Round($os.FreePhysicalMemory / 1024)
  lastBootUtc = $os.LastBootUpTime.ToUniversalTime().ToString('o')
  largestProcesses = $processes
} | ConvertTo-Json -Depth 4 -Compress
