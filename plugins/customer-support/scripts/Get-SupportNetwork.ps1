$ErrorActionPreference = 'Stop'
if (-not (Get-Command Get-NetIPConfiguration -ErrorAction SilentlyContinue)) { @{ supported = $false; missing = 'NetTCPIP module' } | ConvertTo-Json -Compress; return }
$configuration = @(Get-NetIPConfiguration | Select-Object -First 12 | ForEach-Object {
  [pscustomobject]@{ interface = $_.InterfaceAlias; index = $_.InterfaceIndex; ipv4 = @($_.IPv4Address.IPAddress); gateway = @($_.IPv4DefaultGateway.NextHop); dns = @($_.DNSServer.ServerAddresses) }
})
$result = @{
  configuration = $configuration
  adapters = @(Get-NetAdapter | Select-Object -First 16 Name, Status, LinkSpeed)
  routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -First 12 InterfaceIndex, NextHop, RouteMetric)
  firewallProfiles = @(Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction)
}
if ($SupportOptions.testTarget) {
  $name = [string]$SupportOptions.testTarget
  $result.dns = @(Resolve-DnsName -Name $name -DnsOnly -ErrorAction SilentlyContinue | Select-Object -First 12 Name, Type, IPAddress)
  if ($SupportOptions.port) {
    $test = Test-NetConnection -ComputerName $name -Port ([int]$SupportOptions.port) -WarningAction SilentlyContinue
    $result.portTest = @{ target = $name; port = [int]$SupportOptions.port; reachable = $test.TcpTestSucceeded; remoteAddress = [string]$test.RemoteAddress }
  }
}
$result | ConvertTo-Json -Depth 6 -Compress
