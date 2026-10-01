$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$system = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$product = Get-CimInstance Win32_ComputerSystemProduct
$machineGuid = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction SilentlyContinue).MachineGuid
$addresses = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notlike '127.*' -and $_ -notlike '169.254.*' } | Select-Object -Unique -First 20)
$commands = @('Get-WinEvent','Get-Printer','Get-NetIPConfiguration','Get-ADDomain','Get-GPO','Get-ScheduledTask','Get-SmbShare','Get-MpComputerStatus','Get-VM')
$available = @($commands | ForEach-Object { [pscustomobject]@{ name = $_; available = [bool](Get-Command $_ -ErrorAction SilentlyContinue) } })
[pscustomobject]@{
  computer = $env:COMPUTERNAME
  sampledAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  os = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture
  manufacturer = $system.Manufacturer; model = $system.Model; serial = $bios.SerialNumber
  hardwareUuid = $product.UUID; machineGuid = $machineGuid; ipv4Addresses = $addresses
  memoryMB = [math]::Round($system.TotalPhysicalMemory / 1MB)
  domain = $system.Domain; domainJoined = $system.PartOfDomain; domainRole = $system.DomainRole
  powershellVersion = $PSVersionTable.PSVersion.ToString()
  commands = $available
} | ConvertTo-Json -Depth 5 -Compress
