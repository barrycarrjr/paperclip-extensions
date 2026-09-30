$ErrorActionPreference = 'Stop'
if (-not (Get-Command Get-Printer -ErrorAction SilentlyContinue)) { @{ supported = $false; missing = 'PrintManagement module' } | ConvertTo-Json -Compress; return }
$queues = @(Get-Printer | Select-Object -First 40 Name, DriverName, PortName, PrinterStatus, JobCount, Shared)
$result = @{ spooler = [string](Get-Service Spooler).Status; printers = $queues; ports = @(Get-PrinterPort | Select-Object -First 40 Name, PrinterHostAddress, PortNumber) }
if ($SupportOptions.printer) {
  $queue = [string]$SupportOptions.printer
  if (-not (@(Get-Printer | Where-Object { $_.Name -eq $queue }).Count)) { throw 'Exact printer queue was not found.' }
  $result.jobs = @(Get-PrintJob -PrinterName $queue | Select-Object -First 30 ID, JobStatus, Size, @{n='submittedAtUtc';e={$_.SubmittedTime.ToUniversalTime().ToString('o')}})
  $result.note = 'Job IDs can be recycled. Recheck immediately before cancelling a job. Document names and contents are omitted.'
}
$result | ConvertTo-Json -Depth 5 -Compress
