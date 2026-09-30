$ErrorActionPreference = 'Stop'
$pending = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
@{
  recentHotfixes = @(Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 15 HotFixID, InstalledOn)
  updateService = [string](Get-Service wuauserv).Status
  pendingRestart = @{ servicing = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'); windowsUpdate = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'); fileRename = [bool]$pending.PendingFileRenameOperations }
  note = 'Hotfix history is incomplete; this does not establish update compliance.'
} | ConvertTo-Json -Depth 5 -Compress
