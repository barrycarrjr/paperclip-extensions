[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.operation -ne 'identity' -or
      $request.target -notmatch '^[A-Za-z0-9._-]+$' -or
      $request.companyId -notmatch '^[a-fA-F0-9-]{36}$' -or
      $request.caseReference -notmatch '^[A-Za-z0-9._-]{1,100}$' -or
      $request.userName -notmatch '^[A-Za-z0-9_.-]+\\[A-Za-z0-9_.@$-]+$' -or
      $request.transport -notin @('Auto', 'WinRMHttps', 'WinRMHttp', 'Wmi') -or
      -not ($request.password -is [string]) -or $request.password.Length -eq 0) {
    throw 'Invalid identity request.'
  }
  $securePassword = ConvertTo-SecureString -String $request.password -AsPlainText -Force
  $credential = New-Object System.Management.Automation.PSCredential([string]$request.userName, $securePassword)
  $args = @{
    Target = [string]$request.target
    ScriptPath = (Join-Path $PSScriptRoot 'Get-SupportIdentity.ps1')
    Company = [string]$request.companyId
    CaseReference = [string]$request.caseReference
    ExpectedIdentity = [string]$request.userName
    Credential = $credential
    Transport = [string]$request.transport
    TimeoutSeconds = 60
  }
  if ($request.allowProcessExecutionPolicyBypass -eq $true) {
    $args.AllowProcessExecutionPolicyBypass = $true
  }
  $request.password = $null
  & (Join-Path $PSScriptRoot 'Invoke-SupportRemoteScript.ps1') @args
  exit $LASTEXITCODE
} catch {
  [pscustomobject]@{ status = 'failed'; error = 'Identity diagnostic could not start or complete.' } | ConvertTo-Json -Compress
  exit 1
}
