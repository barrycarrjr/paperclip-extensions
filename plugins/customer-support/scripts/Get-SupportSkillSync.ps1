$ErrorActionPreference = 'Stop'
function Get-Manifest([string]$folder) {
  $root = [IO.Path]::GetFullPath($folder)
  if ($root -ne $folder -or $root -notmatch '^[a-zA-Z]:\\.') { throw 'Expected an exact local folder' }
  $parent = Get-Item -LiteralPath $root -ErrorAction Stop
  if (-not $parent.PSIsContainer) { throw 'Expected a folder' }
  while ($parent) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected folders are not allowed' }
    $parent = $parent.Parent
  }
  $queue = New-Object 'System.Collections.Generic.Queue[string]'
  $queue.Enqueue($root)
  $files = @{}; $visited=0; $skipped=0; $partial=$false; $newest=$null
  while ($queue.Count -gt 0 -and $visited -lt 512) {
    $directory=$queue.Dequeue()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop | Select-Object -First 513)) {
      $visited++
      if ($visited -gt 512) { $partial=$true; break }
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $skipped++; $partial=$true; continue }
      if ($item.PSIsContainer) { $queue.Enqueue($item.FullName); continue }
      if ($item.Extension -ne '.md') { continue }
      if ($item.Length -gt 262144) { $skipped++; $partial=$true; continue }
      $relative=$item.FullName.Substring($root.Length+1)
      $files[$relative]=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
      if (-not $newest -or $item.LastWriteTimeUtc -gt $newest) { $newest=$item.LastWriteTimeUtc }
    }
  }
  if ($queue.Count -gt 0) { $partial=$true }
  return @{ files=$files; partial=$partial; skipped=$skipped; inspected=$visited; newestWriteUtc=if($newest){$newest.ToString('o')}else{$null} }
}
$source=Get-Manifest ([string]$SupportOptions.sourcePath)
$backup=Get-Manifest ([string]$SupportOptions.backupPath)
$missing=0; $different=0; $matching=0; $extra=0
foreach ($key in $source.files.Keys) {
  if (-not $backup.files.ContainsKey($key)) { $missing++ }
  elseif ($source.files[$key] -ne $backup.files[$key]) { $different++ }
  else { $matching++ }
}
foreach ($key in $backup.files.Keys) { if (-not $source.files.ContainsKey($key)) { $extra++ } }
$partial=($source.partial -or $backup.partial)
$status=if($partial){'partial'}elseif($source.files.Count -eq 0){'no_source_skills'}elseif($missing -or $different){'local_copy_differs'}else{'local_copy_matches'}
@{ observedAtUtc=[DateTime]::UtcNow.ToString('o'); status=$status; sourceFiles=$source.files.Count; backupFiles=$backup.files.Count; matching=$matching; missing=$missing; different=$different; extraBackupFiles=$extra; sourceNewestWriteUtc=$source.newestWriteUtc; backupNewestWriteUtc=$backup.newestWriteUtc; partial=$partial; skipped=($source.skipped+$backup.skipped); cloudUploadVerified=$false; restoreVerified=$false; limitations='Local Markdown file comparison only, at most 512 entries per folder and 256 KiB per file. Hashes, names and contents are not returned. Redirected entries are skipped; redirected roots fail. Identical copies and file timestamps do not prove cloud upload, freshness of execution or a successful restore. Verify cloud objects through the configured provider and perform a separate reviewed restore rehearsal.' } | ConvertTo-Json -Depth 4 -Compress
