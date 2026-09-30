$ErrorActionPreference = 'Stop'
$commands = @('node','npm','pnpm','python','py','git','pwsh','codex','claude','uv','docker')
$tools = @($commands | ForEach-Object {
  $command = Get-Command $_ -ErrorAction SilentlyContinue | Select-Object -First 1
  [pscustomobject]@{ name=$_; available=[bool]$command; commandType=if($command){[string]$command.CommandType}else{$null}; fileVersion=if($command){[string]$command.Version}else{$null} }
})
$pathChecks = @()
foreach ($scope in @('Machine','User')) {
  $entries = @([Environment]::GetEnvironmentVariable('Path',$scope) -split ';' | Where-Object { $_.Trim() } | Select-Object -First 100)
  $missing=0; $duplicates=0; $seen=@{}
  foreach ($entry in $entries) {
    $expanded=[Environment]::ExpandEnvironmentVariables($entry.Trim())
    if (-not (Test-Path -LiteralPath $expanded -PathType Container -ErrorAction SilentlyContinue)) { $missing++ }
    $key=$expanded.ToLowerInvariant(); if ($seen.ContainsKey($key)) { $duplicates++ }; $seen[$key]=$true
  }
  $pathChecks += [pscustomobject]@{ scope=$scope; inspected=$entries.Count; missingDirectories=$missing; duplicateDirectories=$duplicates; limit=100 }
}
$modules=@(Get-Module -ListAvailable Microsoft.PowerShell.Management,ScheduledTasks | Select-Object -First 10 Name,Version)
@{ observedAtUtc=[DateTime]::UtcNow.ToString('o'); accountContext='Remote support account, not necessarily the affected staff user'; tools=$tools; pathChecks=$pathChecks; modules=$modules; limitations='No environment secret values, executable paths, MCP configuration contents, prompts or skill documents are returned. Command metadata does not prove CLI authentication or an MCP handshake. Check saved specialist connections and explicit sync-check profiles; user-specific setup needs the correct user context. No installation or changes run.' } | ConvertTo-Json -Depth 6 -Compress
