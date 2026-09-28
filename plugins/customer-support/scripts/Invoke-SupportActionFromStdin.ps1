[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$localScript = $null
$resultExitCode = 1
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -ne 'script' -or
      $request.target -notmatch '^[A-Za-z0-9._-]+$' -or
      $request.companyId -notmatch '^[a-fA-F0-9-]{36}$' -or
      $request.caseReference -notmatch '^[A-Za-z0-9._-]{1,100}$' -or
      $request.userName -notmatch '^[A-Za-z0-9_.-]+\\[A-Za-z0-9_.@$-]+$' -or
      $request.transport -notin @('Auto', 'WinRMHttps', 'WinRMHttp', 'Wmi') -or
      -not ($request.password -is [string]) -or $request.password.Length -eq 0 -or
      -not ($request.scriptBase64 -is [string]) -or $request.scriptBase64.Length -gt 25000) {
    throw 'Invalid remote action request.'
  }
  $scriptBytes = [Convert]::FromBase64String([string]$request.scriptBase64)
  if ($scriptBytes.Length -eq 0 -or $scriptBytes.Length -gt 16384) { throw 'Invalid reviewed script size.' }
  $localScript = Join-Path ([System.IO.Path]::GetTempPath()) ('paperclip-reviewed-' + [guid]::NewGuid().ToString('N') + '.ps1')
  [System.IO.File]::WriteAllBytes($localScript, $scriptBytes)
  $securePassword = ConvertTo-SecureString -String $request.password -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential([string]$request.userName, $securePassword)
  $args = @{
    Target = [string]$request.target
    ScriptPath = $localScript
    Company = [string]$request.companyId
    CaseReference = [string]$request.caseReference
    ExpectedIdentity = [string]$request.userName
    Credential = $credential
    Transport = [string]$request.transport
    TimeoutSeconds = 90
  }
  if ($request.allowProcessExecutionPolicyBypass -eq $true) { $args.AllowProcessExecutionPolicyBypass = $true }
  $request.password = $null
  $request.scriptBase64 = $null
  & (Join-Path $PSScriptRoot 'Invoke-SupportRemoteScript.ps1') @args
  $resultExitCode = $LASTEXITCODE
} catch {
  [pscustomobject]@{ status = 'unknown'; error = 'Remote action could not start or complete.' } | ConvertTo-Json -Compress
} finally {
  if ($localScript -and (Test-Path -LiteralPath $localScript -PathType Leaf)) {
    Remove-Item -LiteralPath $localScript -Force -ErrorAction SilentlyContinue
  }
}
exit $resultExitCode
