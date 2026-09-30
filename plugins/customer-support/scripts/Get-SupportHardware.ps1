$ErrorActionPreference = 'Stop'
$sections = @{}
try {
  $problems = @(Get-CimInstance Win32_PnPEntity -Filter 'ConfigManagerErrorCode <> 0' | Select-Object -First 40 Name,PNPClass,Manufacturer,ConfigManagerErrorCode,Status)
  $network = @(Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=True' | Select-Object -First 20 Name,Manufacturer,NetEnabled,NetConnectionStatus,ConfigManagerErrorCode)
  $sections.devices = @{ status='available'; problems=$problems; networkAdapters=$network; limit=40 }
} catch { $sections.devices = @{ status='unavailable' } }
try {
  $sections.drivers = @{ status='available'; samples=@(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceClass -in @('NET','DISPLAY','MEDIA','SCSIADAPTER','HDC') } | Select-Object -First 40 DeviceName,DeviceClass,Manufacturer,DriverProviderName,DriverVersion,DriverDate,IsSigned); limit=40 }
} catch { $sections.drivers = @{ status='unavailable' } }
try {
  $sections.disks = @{ status='available'; samples=@(Get-PhysicalDisk | Select-Object -First 20 FriendlyName,MediaType,HealthStatus,OperationalStatus,Size); limit=20 }
} catch { $sections.disks = @{ status='unavailable'; missing='Storage module/provider' } }
@{ observedAtUtc=[DateTime]::UtcNow.ToString('o'); sections=$sections; limitations='Driver metadata and device/storage provider reports only, not definitive hardware failure or compatibility. No driver updates, firmware, stress tests or private driver paths. A disabled device is not necessarily broken. Match parts against the observed exact model and official vendor guidance; warranty records are company directory data.' } | ConvertTo-Json -Depth 7 -Compress
