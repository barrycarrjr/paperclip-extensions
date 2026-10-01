param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Target,

  [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'

if ($Target -notmatch '^[A-Za-z0-9._-]+$') {
  throw 'Target must be a DNS hostname or IP address.'
}

$fileName = 'paperclip-support-probe-' + [guid]::NewGuid().ToString('N') + '.txt'
$remotePath = 'C:\Windows\Temp\' + $fileName
$command = 'cmd.exe /d /c whoami > "' + $remotePath + '" 2>&1'
$wmiArgs = @{
  Class = 'Win32_Process'
  Name = 'Create'
  ArgumentList = @($command)
  ComputerName = $Target
  ErrorAction = 'Stop'
}
if ($Credential) { $wmiArgs.Credential = $Credential }

$driveName = 'P' + [guid]::NewGuid().ToString('N').Substring(0, 7)
$driveArgs = @{
  Name = $driveName
  PSProvider = 'FileSystem'
  Root = "\\$Target\C$"
  Scope = 'Script'
  ErrorAction = 'Stop'
}
if ($Credential) { $driveArgs.Credential = $Credential }

$null = New-PSDrive @driveArgs
try {
  $localPath = $driveName + ':\Windows\Temp\' + $fileName
  $created = Invoke-WmiMethod @wmiArgs
  if ($created.ReturnValue -ne 0) {
    throw "Remote process creation returned code $($created.ReturnValue)."
  }

  $found = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-Path -LiteralPath $localPath) { $found = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $found) { throw 'Remote process started, but its output file was not found within 10 seconds.' }

  $identity = (Get-Content -LiteralPath $localPath -Raw).Trim()
  Remove-Item -LiteralPath $localPath -Force
  [pscustomobject]@{
    target = $Target
    processId = $created.ProcessId
    remoteIdentity = $identity
    outputFileRemoved = $true
  } | ConvertTo-Json -Compress
} finally {
  Remove-PSDrive -Name $driveName -Force
}
