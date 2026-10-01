param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Target,

  [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = 'Stop'

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.ConnectAsync($HostName, $Port)
    return $connect.Wait(2500) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

$address = @()
try {
  $address = @([System.Net.Dns]::GetHostAddresses($Target) | ForEach-Object { $_.IPAddressToString })
} catch { }

$ports = [ordered]@{}
foreach ($port in 22, 135, 445, 3389, 5985, 5986) {
  $ports[[string]$port] = Test-TcpPort -HostName $Target -Port $port
}

$transports = @(
  [ordered]@{ name = 'winrm_https'; kind = 'command'; reachable = $ports['5986']; authenticated = $null; error = $null },
  [ordered]@{ name = 'winrm_http'; kind = 'command'; reachable = $ports['5985']; authenticated = $null; error = $null },
  [ordered]@{ name = 'wmi_dcom_smb'; kind = 'command'; reachable = ($ports['135'] -and $ports['445']); authenticated = $null; error = $null },
  [ordered]@{ name = 'smb'; kind = 'files'; reachable = $ports['445']; authenticated = $null; error = $null },
  [ordered]@{ name = 'ssh'; kind = 'command_unconfigured'; reachable = $ports['22']; authenticated = $null; error = $null },
  [ordered]@{ name = 'rdp'; kind = 'interactive'; reachable = $ports['3389']; authenticated = $null; error = $null }
)

if ($Credential) {
  foreach ($entry in $transports) {
    if (-not $entry.reachable) { continue }
    try {
      switch ($entry.name) {
        'winrm_https' {
          $null = Test-WSMan -ComputerName $Target -UseSSL -Authentication Kerberos -Credential $Credential -ErrorAction Stop
          $entry.authenticated = $true
        }
        'winrm_http' {
          $null = Test-WSMan -ComputerName $Target -Authentication Kerberos -Credential $Credential -ErrorAction Stop
          $entry.authenticated = $true
        }
        'wmi_dcom_smb' {
          $null = Get-WmiObject -Class Win32_OperatingSystem -ComputerName $Target -Credential $Credential -ErrorAction Stop
          $entry.authenticated = $true
        }
        'smb' {
          $driveName = 'P' + [guid]::NewGuid().ToString('N').Substring(0, 7)
          $null = New-PSDrive -Name $driveName -PSProvider FileSystem -Root "\\$Target\C$" -Credential $Credential -Scope Script -ErrorAction Stop
          try { $entry.authenticated = Test-Path -LiteralPath "\\$Target\C$\Windows\Temp" }
          finally { Remove-PSDrive -Name $driveName -Force }
        }
      }
    } catch {
      $entry.authenticated = $false
      $entry.error = $_.Exception.Message
    }
  }
  $wmi = $transports | Where-Object { $_.name -eq 'wmi_dcom_smb' }
  $smb = $transports | Where-Object { $_.name -eq 'smb' }
  if ($wmi.authenticated -eq $true -and $smb.authenticated -ne $true) {
    $wmi.authenticated = $false
    $wmi.error = 'WMI authenticated, but the administrative SMB share is unavailable.'
  }
}

[pscustomobject]@{
  target = $Target
  checkedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  addresses = $address
  ports = $ports
  transports = $transports
} | ConvertTo-Json -Depth 5 -Compress
