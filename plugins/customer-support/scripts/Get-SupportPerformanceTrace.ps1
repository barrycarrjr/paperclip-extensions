$ErrorActionPreference = 'Stop'
$samples = @()
for ($i = 0; $i -lt 6; $i++) {
  if ($i -gt 0) { Start-Sleep -Seconds 3 }
  $os = Get-CimInstance Win32_OperatingSystem
  $samples += [pscustomobject]@{
    atUtc = (Get-Date).ToUniversalTime().ToString('o')
    cpuLoadPercent = @(Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage)
    freeMemoryMB = [math]::Round($os.FreePhysicalMemory / 1024)
  }
}
@{ computer = $env:COMPUTERNAME; samples = $samples; durationSeconds = 15 } | ConvertTo-Json -Depth 5 -Compress
