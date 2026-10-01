$ErrorActionPreference = 'Stop'
$batteries = @()
try {
  $batteries = @(Get-CimInstance Win32_Battery | Select-Object -First 8 | ForEach-Object {
    $ratio = $null
    if ($_.DesignCapacity -gt 0 -and $_.FullChargeCapacity -gt 0) { $ratio = [Math]::Round(100.0 * $_.FullChargeCapacity / $_.DesignCapacity,1) }
    [pscustomobject]@{ name=$_.Name; status=$_.Status; batteryStatus=$_.BatteryStatus; chargePercent=$_.EstimatedChargeRemaining; designCapacityMWh=$_.DesignCapacity; fullChargeCapacityMWh=$_.FullChargeCapacity; capacityPercent=$ratio; capacityAvailable=($null -ne $ratio) }
  })
  $status = 'available'
} catch { $status = 'unavailable' }
@{ observedAtUtc=[DateTime]::UtcNow.ToString('o'); status=$status; batteries=$batteries; limitations='Battery provider estimates only. Zero/missing capacity means unavailable, not a failed battery or zero health. No batteries may mean a desktop or unsupported provider. No report file or firmware changes. Confirm replacement compatibility through the manufacturer and saved warranty record.' } | ConvertTo-Json -Depth 5 -Compress
