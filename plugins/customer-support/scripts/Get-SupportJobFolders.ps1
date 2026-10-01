# SUPPORT_JOB_FOLDER_GUARD
$samples = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction Stop | Select-Object -First 513)
$rows = @(); $visited = 0
foreach ($item in ($samples | Select-Object -First 512)) {
  $visited++
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
  if ($SupportOptions.query -and $item.Name.IndexOf([string]$SupportOptions.query,[StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
  if ($SupportOptions.dateToken -and -not $item.Name.Contains([string]$SupportOptions.dateToken)) { continue }
  $path = Get-CheckedJobPath $item.Name
  $originals = Join-Path $path ([string]$SupportOptions.originalsFolder)
  $originalsItem = Get-Item -LiteralPath $originals -ErrorAction SilentlyContinue
  $originalsOkay = $originalsItem -and $originalsItem.PSIsContainer -and -not ($originalsItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
  $rows += [pscustomobject]@{ name=$item.Name; modifiedAtUtc=$item.LastWriteTimeUtc.ToString('o'); namingMismatch=($item.Name -notmatch [string]$SupportOptions.namePattern); originalsMissing=(-not $originalsOkay); olderThanThreshold=($item.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-[int]$SupportOptions.staleDays)) }
  if ($rows.Count -ge 50) { break }
}
@{ observedAtUtc=[DateTime]::UtcNow.ToString('o'); folders=$rows; visited=$visited; partial=($samples.Count -gt 512 -or $rows.Count -ge 50); limitations='Immediate folders only; no document contents. Age is a directory timestamp, not proof a job is pending or abandoned. Naming/subfolder flags require staff review. No move or deletion.' } | ConvertTo-Json -Depth 6 -Compress
