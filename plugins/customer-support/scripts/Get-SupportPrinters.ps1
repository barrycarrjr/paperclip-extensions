$ErrorActionPreference = 'Stop'
$result = @{ sampledAtUtc = [DateTime]::UtcNow.ToString('o'); limitations = 'Computer/account-visible queues only. No document names, job owners, contents, SNMP communities, driver paths or physical printer status are read. Use the printer status tool for a direct IPP observation.' }
try { $result.spooler = [string](Get-Service Spooler).Status } catch { $result.spooler = 'unavailable' }
if (-not (Get-Command Get-Printer -ErrorAction SilentlyContinue)) {
  $result.supported = $false; $result.missing = 'PrintManagement module'
  try { $result.printers = @(Get-CimInstance Win32_Printer | Select-Object -First 40 Name, DriverName, PortName, PrinterStatus, WorkOffline, DetectedErrorState, Shared) } catch { $result.printersUnavailable = $true }
  $result | ConvertTo-Json -Depth 5 -Compress; return
}
$allQueues = @(Get-Printer)
$queues = $allQueues
if ($SupportOptions.printer) { $queues = @($allQueues | Where-Object { $_.Name -eq [string]$SupportOptions.printer }); if ($queues.Count -ne 1) { throw 'Exact printer queue was not found.' } }
$result.supported = $true; $result.totalQueues = $allQueues.Count
$result.printers = @($queues | Select-Object -First 40 Name, DriverName, PortName, PrinterStatus, JobCount, Shared, KeepPrintedJobs)
try { $result.ports = @(Get-PrinterPort | Select-Object -First 40 Name, PrinterHostAddress, PortNumber, Protocol, SNMPEnabled) } catch { $result.portsUnavailable = $true }
try { $result.drivers = @(Get-PrinterDriver | Select-Object -First 40 Name, Manufacturer, PrinterEnvironment, MajorVersion) } catch { $result.driversUnavailable = $true }
try { $result.deviceStatus = @(Get-CimInstance Win32_Printer | Where-Object { -not $SupportOptions.printer -or $_.Name -eq [string]$SupportOptions.printer } | Select-Object -First 40 Name, WorkOffline, PrinterStatus, ExtendedPrinterStatus, DetectedErrorState) } catch { $result.deviceStatusUnavailable = $true }
if ($SupportOptions.printer) {
  $queue = [string]$SupportOptions.printer
  $result.jobs = @(Get-PrintJob -PrinterName $queue | Select-Object -First 30 ID, JobStatus, Size, @{n='submittedAtUtc';e={$_.SubmittedTime.ToUniversalTime().ToString('o')}})
  $result.note = 'Job IDs can be recycled. Recheck immediately before cancelling a job. Document names and contents are omitted.'
}
$result | ConvertTo-Json -Depth 5 -Compress
