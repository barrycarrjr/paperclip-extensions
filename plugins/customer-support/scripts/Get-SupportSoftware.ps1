$ErrorActionPreference = 'Stop'
$paths = @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
$all = @(Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object DisplayName | Sort-Object DisplayName -Unique)
@{ total = $all.Count; truncated = ($all.Count -gt 80); applications = @($all | Select-Object -First 80 DisplayName, DisplayVersion, Publisher); note = 'Machine installs only. Does not query Win32_Product or trigger MSI consistency checks.' } | ConvertTo-Json -Depth 4 -Compress
