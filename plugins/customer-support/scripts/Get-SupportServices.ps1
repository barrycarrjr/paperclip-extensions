$ErrorActionPreference = 'Stop'
@{ stoppedAutomaticServices = @(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" | Select-Object -First 50 @{n='name';e={$_.Name}}, @{n='state';e={$_.State}}, @{n='exitCode';e={$_.ExitCode}}) } | ConvertTo-Json -Depth 4 -Compress
