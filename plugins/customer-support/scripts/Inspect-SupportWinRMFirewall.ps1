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

$sessionArgs = @{
  ComputerName = $Target
  SessionOption = (New-CimSessionOption -Protocol Dcom)
  OperationTimeoutSec = 15
}
if ($Credential) { $sessionArgs.Credential = $Credential }

$session = New-CimSession @sessionArgs
try {
  $service = Get-CimInstance -CimSession $session -ClassName Win32_Service -Filter "Name='WinRM'"
  $profiles = @(Get-NetConnectionProfile -CimSession $session | ForEach-Object {
    [pscustomobject]@{
      interface = $_.InterfaceAlias
      category = [string]$_.NetworkCategory
    }
  })
  $listeners = @(Get-NetTCPConnection -CimSession $session -LocalPort 5985 -State Listen | ForEach-Object {
    [pscustomobject]@{
      localAddress = $_.LocalAddress
      localPort = $_.LocalPort
    }
  })
  $rules = @(Get-NetFirewallRule -CimSession $session -Name 'WINRM-HTTP-In-TCP*')
  $firewallRules = foreach ($rule in $rules) {
    $address = Get-NetFirewallAddressFilter -CimSession $session -AssociatedNetFirewallRule $rule
    $port = Get-NetFirewallPortFilter -CimSession $session -AssociatedNetFirewallRule $rule
    [pscustomobject]@{
      name = $rule.Name
      enabled = [string]$rule.Enabled
      profile = [string]$rule.Profile
      action = [string]$rule.Action
      remoteAddress = @($address.RemoteAddress)
      localPort = @($port.LocalPort)
    }
  }

  [pscustomobject]@{
    target = $Target
    winrmService = [pscustomobject]@{
      state = $service.State
      startMode = $service.StartMode
    }
    networkProfiles = $profiles
    winrmHttpListeners = $listeners
    winrmHttpFirewallRules = @($firewallRules)
  } | ConvertTo-Json -Depth 5 -Compress
} finally {
  Remove-CimSession $session
}
