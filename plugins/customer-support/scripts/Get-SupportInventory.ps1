$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$system = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$commands = @('Get-WinEvent','Get-Printer','Get-NetIPConfiguration','Get-ADDomain','Get-GPO','Get-ScheduledTask','Get-SmbShare','Get-MpComputerStatus','Get-VM')
$available = @($commands | ForEach-Object { [pscustomobject]@{ name = $_; available = [bool](Get-Command $_ -ErrorAction SilentlyContinue) } })
[pscustomobject]@{
  computer = $env:COMPUTERNAME
  sampledAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  os = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture
  manufacturer = $system.Manufacturer; model = $system.Model; serial = $bios.SerialNumber
  memoryMB = [math]::Round($system.TotalPhysicalMemory / 1MB)
  domain = $system.Domain; domainJoined = $system.PartOfDomain; domainRole = $system.DomainRole
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  commands = $available
} | ConvertTo-Json -Depth 5 -Compress
