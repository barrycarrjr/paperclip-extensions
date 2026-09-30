$ErrorActionPreference = 'Stop'
@{ disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [pscustomobject]@{ drive=$_.DeviceID; sizeGB=[math]::Round($_.Size / 1GB, 1); freeGB=[math]::Round($_.FreeSpace / 1GB, 1) }
}) } | ConvertTo-Json -Depth 4 -Compress
