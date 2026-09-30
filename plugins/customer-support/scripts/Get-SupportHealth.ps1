$ErrorActionPreference = 'Stop'
$sections = @{}
function Read-SupportSection([string]$Name, [scriptblock]$Read) {
  try { $sections[$Name] = @{ status = 'available'; data = (& $Read) } }
  catch { $sections[$Name] = @{ status = 'unavailable'; reason = 'This check could not be read. Use the individual diagnostic to investigate.' } }
}
Read-SupportSection 'inventory' {
  (& {
# SUPPORT_INVENTORY_SCRIPT
  }) | ConvertFrom-Json
}
Read-SupportSection 'performance' {
  $os = Get-CimInstance Win32_OperatingSystem
  @{ cpuLoadPercent = @(Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage)
    totalMemoryMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
    freeMemoryMB = [math]::Round($os.FreePhysicalMemory / 1024)
    lastBootUtc = $os.LastBootUpTime.ToUniversalTime().ToString('o') }
}
Read-SupportSection 'storage' {
  @{ disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    @{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB, 1); freeGB = [math]::Round($_.FreeSpace / 1GB, 1) }
  }) }
}
Read-SupportSection 'services' {
  @{ stoppedAutomaticServices = @(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" | Select-Object -First 50 @{n='name';e={$_.Name}}, @{n='state';e={$_.State}}, @{n='exitCode';e={$_.ExitCode}}) }
}
Read-SupportSection 'events' {
  $events = @()
  try { $events = @(Get-WinEvent -FilterHashtable @{ LogName='System'; StartTime=(Get-Date).AddHours(-24); Level=@(1,2) } -MaxEvents 20 -ErrorAction Stop | Select-Object @{n='atUtc';e={$_.TimeCreated.ToUniversalTime().ToString('o')}}, Id, ProviderName, LevelDisplayName) }
  catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
  @{ hours=24; limit=20; events=$events; note='Event metadata only. Recent errors do not prove an ongoing fault.' }
}
Read-SupportSection 'updates' {
  $pending = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
  @{ pendingRestart = @{ servicing=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
    windowsUpdate=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'); fileRename=[bool]$pending.PendingFileRenameOperations } }
}
Read-SupportSection 'printers' {
  if (-not (Get-Command Get-Printer -ErrorAction SilentlyContinue)) { throw 'PrintManagement is unavailable' }
  @{ spooler=[string](Get-Service Spooler).Status; printers=@(Get-Printer | Select-Object -First 40 Name, PrinterStatus, JobCount) }
}
@{ sampledAtUtc=(Get-Date).ToUniversalTime().ToString('o'); sections=$sections
  note='A bounded health snapshot, not continuous monitoring. Missing checks are not healthy results. No changes or raw event messages were collected.' } | ConvertTo-Json -Depth 9 -Compress
