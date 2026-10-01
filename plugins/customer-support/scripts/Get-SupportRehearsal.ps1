$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if ($root -notmatch '^[a-zA-Z]:\\' -or -not (Test-Path -LiteralPath $root -PathType Container)) { throw 'A local Windows temporary directory is required' }
if ((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'A redirected temporary directory is not supported' }
$id = [string]$SupportOptions.rehearsalId
$file = Join-Path $root ('paperclip-support-rehearsal-' + $id + '.txt')
$exists = Test-Path -LiteralPath $file -PathType Leaf
$redirected = $false; $matches = $false
if ($exists) {
  $item = Get-Item -LiteralPath $file
  $redirected = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if (-not $redirected -and $item.Length -le 200) { $matches = [IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) -ceq ('Paperclip support write rehearsal ' + $id) }
}
@{ rehearsalId = $id; exists = [bool]$exists; redirected = $redirected; markerMatches = $matches; sampledAtUtc = [DateTime]::UtcNow.ToString('o'); note = 'Read-only exact marker inspection; no path or file contents returned, and nothing was changed.' } | ConvertTo-Json -Compress
