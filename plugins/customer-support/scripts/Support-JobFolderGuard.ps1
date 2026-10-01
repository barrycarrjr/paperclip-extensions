$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath([string]$SupportOptions.root)
if ($root -notmatch '^[a-zA-Z]:\\.' -or $root.TrimEnd('\') -ne [string]$SupportOptions.root) { throw 'Expected an exact local job root' }
$current = Get-Item -LiteralPath $root -ErrorAction Stop
if (-not $current.PSIsContainer) { throw 'Job root is not a directory' }
while ($current) {
  if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected folders are not allowed' }
  $current = $current.Parent
}
$rootPrefix = $root.TrimEnd('\') + '\'
function Get-CheckedJobPath([string]$name) {
  $path = [IO.Path]::GetFullPath((Join-Path $root $name))
  if (-not $path.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetDirectoryName($path) -ne $root) { throw 'Folder escapes its reviewed root' }
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Existing job is not an ordinary directory' }
  }
  return $path
}
