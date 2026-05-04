# 3cx-tools live PBX validation - PowerShell
#
# Run this on the host with network reach to your 3CX PBX. It mirrors
# what each plugin tool does internally and prints PASS / FAIL / SKIP
# per probe so you can see end-to-end which paths work and which need
# adjustment before agents start calling them.
#
# What it does NOT do by default:
#   - Place a real outbound call (test #11 is a guarded prompt;
#     uncomment if you want to dial a number).
#   - Touch the Paperclip server. This script is independent of the
#     plugin worker - it is a direct probe against your 3CX install
#     using the same OAuth flow the plugin uses.
#
# Prereqs:
#   - Service Principal exists in 3CX admin with:
#       * "Enable Configuration API" checked
#       * Department = a real department (not "System Wide" - that
#         locks Role to User and yields 403 on collection reads)
#       * Role = System Owner (or highest read role available)
#   - You have copied the latest "Generate API Key" value.
#
# Usage:
#   $env:XAPI_3CX_CLIENT_SECRET = '<your-rotated-secret>'
#   powershell -ExecutionPolicy Bypass -File live-test.ps1 `
#     -Pbx 'https://your-pbx-fqdn' -ClientId '<your-client-id>' `
#     -FromExt '<your-test-extension>' -MobileE164 '+15551234567'

param(
  [Parameter(Mandatory = $true)]
  [string]$Pbx,
  [Parameter(Mandatory = $true)]
  [string]$ClientId,
  [string]$ClientSecret = $null,            # set -ClientSecret OR env XAPI_3CX_CLIENT_SECRET
  [string]$MobileE164   = '+15551234567',   # destination for the optional outbound test
  [string]$FromExt      = '',               # internal ext to ring first for click-to-call test
  [int]$ExpectedQueueA  = 0,                # optional - sanity check this queue exists
  [int]$ExpectedQueueB  = 0
)

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $ClientSecret) { $ClientSecret = $env:XAPI_3CX_CLIENT_SECRET }
if (-not $ClientSecret) {
  Write-Host 'ERROR: No client_secret. Pass -ClientSecret or set $env:XAPI_3CX_CLIENT_SECRET' -ForegroundColor Red
  exit 1
}

$script:passes = 0
$script:fails  = 0
$script:skips  = 0

function Pass($msg) { Write-Host "  PASS  $msg" -ForegroundColor Green; $script:passes++ }
function Fail($msg, $detail) {
  Write-Host "  FAIL  $msg" -ForegroundColor Red
  if ($detail) { Write-Host "        $detail" -ForegroundColor DarkGray }
  $script:fails++
}
function Skip($msg) { Write-Host "  SKIP  $msg" -ForegroundColor Yellow; $script:skips++ }
function Section($n) { Write-Host ''; Write-Host "-- $n ----" -ForegroundColor Cyan }

function Try-Get {
  param($url, $headers)
  try {
    return @{ ok = $true; data = (Invoke-RestMethod -Uri $url -Headers $headers) }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    $body = ''
    if ($_.Exception.Response) {
      try {
        $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $sr.ReadToEnd()
      } catch {}
    }
    return @{ ok = $false; status = $code; body = $body; message = $_.Exception.Message }
  }
}

function Try-Post {
  param($url, $headers, $body)
  try {
    return @{ ok = $true; data = (Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 5) -ContentType 'application/json') }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    $b = ''
    if ($_.Exception.Response) {
      try {
        $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $b = $sr.ReadToEnd()
      } catch {}
    }
    return @{ ok = $false; status = $code; body = $b; message = $_.Exception.Message }
  }
}

# 0. OAuth
Section 'OAuth'
$tokenBody = @{ client_id = $ClientId; client_secret = $ClientSecret; grant_type = 'client_credentials' }
try {
  $tokenResp = Invoke-RestMethod -Method Post -Uri "$Pbx/connect/token" `
    -Body $tokenBody -ContentType 'application/x-www-form-urlencoded'
  $token = $tokenResp.access_token
  Pass "Token issued (length $($token.Length))"
} catch {
  Fail 'OAuth /connect/token' $_.Exception.Message
  Write-Host 'Cannot continue without a valid token - exiting' -ForegroundColor Red
  exit 1
}
$headers = @{ Authorization = "Bearer $token" }

# 1. /xapi/v1/Defs (lowest priv health check)
Section '1. Health probe - /xapi/v1/Defs'
$r = Try-Get "$Pbx/xapi/v1/Defs?`$select=Id" $headers
if ($r.ok) { Pass 'Defs returned 200' } else { Fail 'Defs probe' "status=$($r.status) body=$($r.body)" }

# 2. /xapi/v1/Queues (read tool: pbx_queue_list)
Section '2. pbx_queue_list - /xapi/v1/Queues'
$r = Try-Get "$Pbx/xapi/v1/Queues" $headers
if ($r.ok) {
  $count = $r.data.value.Count
  Pass "$count queue(s) returned"
  $r.data.value | ForEach-Object {
    Write-Host "        ext=$($_.Number) id=$($_.Id) name='$($_.Name)'"
  }
  if ($ExpectedQueueA -gt 0 -and $ExpectedQueueB -gt 0) {
    $a = $r.data.value | Where-Object { $_.Number -eq $ExpectedQueueA }
    $b = $r.data.value | Where-Object { $_.Number -eq $ExpectedQueueB }
    if ($a -and $b) { Pass 'Both expected queues exist (plugin will filter per company)' }
    else { Fail 'Queue presence' "A found=$([bool]$a) B found=$([bool]$b)" }
  } else {
    Skip 'Per-LLC queue presence check (pass -ExpectedQueueA / -ExpectedQueueB to enable)'
  }
} else { Fail 'Queues GET' "status=$($r.status)" }

# 3. /xapi/v1/Users (read tool: pbx_extension_list, pbx_agent_status)
Section '3. pbx_extension_list - /xapi/v1/Users'
$r = Try-Get "$Pbx/xapi/v1/Users?`$top=100" $headers
if ($r.ok) { Pass "$($r.data.value.Count) extension(s) returned" }
else { Fail 'Users GET' "status=$($r.status)" }

# 4. /xapi/v1/Trunks (read tool: pbx_did_list)
# Note: bare /Trunks returns DidNumbers inline (primitive string[]).
# $expand=DidNumbers is rejected with 400 — DidNumbers is not a nav property.
Section '4. pbx_did_list - /xapi/v1/Trunks'
$r = Try-Get "$Pbx/xapi/v1/Trunks" $headers
if ($r.ok) {
  $totalDids = ($r.data.value | ForEach-Object { $_.DidNumbers.Count } | Measure-Object -Sum).Sum
  Pass "$($r.data.value.Count) trunk(s), $totalDids DID(s) total"
  $r.data.value | Where-Object { $_.DidNumbers.Count -gt 0 } | ForEach-Object {
    $name = if ($_.Gateway) { $_.Gateway.Name } else { $_.Number }
    Write-Host ("        {0,-40}  {1} DID(s)" -f $name, $_.DidNumbers.Count)
  }
} else { Fail 'Trunks GET' "status=$($r.status)" }

# 5. /xapi/v1/ActiveCalls (read tool: pbx_active_calls)
Section '5. pbx_active_calls - /xapi/v1/ActiveCalls'
$r = Try-Get "$Pbx/xapi/v1/ActiveCalls" $headers
if ($r.ok) {
  Pass "$($r.data.value.Count) active call(s) right now"
  if ($r.data.value.Count -gt 0) {
    Write-Host '        Sample call shape:' -ForegroundColor DarkGray
    $r.data.value[0] | Format-List | Out-String | ForEach-Object {
      $_.Split("`n") | Where-Object { $_ -match '\S' } | Select-Object -First 8 | ForEach-Object {
        Write-Host "        $_" -ForegroundColor DarkGray
      }
    }
  }
} else {
  if ($r.status -eq 404) {
    Fail 'ActiveCalls path' '404 - endpoint not found on this 3CX install. Plugin will need a different path.'
  } else {
    Fail 'ActiveCalls GET' "status=$($r.status) body=$($r.body)"
  }
}

# 6. /xapi/v1/CallHistoryView (read tool: pbx_call_history)
Section '6. pbx_call_history - /xapi/v1/CallHistoryView'
$today = (Get-Date).ToString('yyyy-MM-dd')
$path  = "/xapi/v1/CallHistoryView?`$filter=date(SegmentStartTime) ge $today&`$top=5&`$orderby=SegmentStartTime desc"
$r = Try-Get "$Pbx$path" $headers
if ($r.ok) {
  Pass "$($r.data.value.Count) call(s) today (showing first 5)"
  $r.data.value | Select-Object -First 5 | ForEach-Object {
    Write-Host "        $($_.SegmentStartTime)  src=$($_.SrcDn) dst=$($_.DstDn)  ($([int]$_.CallTime)s)"
  }
} else {
  Fail 'CallHistoryView GET' "status=$($r.status) body=$($r.body)"
}

# 7. /xapi/v1/ParkedCalls (XAPI does NOT expose this on v20)
Section '7. pbx_parked_calls - XAPI gap'
$r = Try-Get "$Pbx/xapi/v1/ParkedCalls" $headers
if ($r.ok) {
  Pass "ParkedCalls path WORKS unexpectedly - file an issue, plugin should use this"
  Write-Host "        $($r.data.value.Count) parked"
} else {
  Skip "ParkedCalls returned $($r.status) (expected - XAPI has CallParkingSettings but no live parked-call list; v0.2 will read via Call Control API)"
}

# 8. Today stats report
Section '8. pbx_today_stats - /xapi/v1/ReportCallSummaryByDayData'
$path = "/xapi/v1/ReportCallSummaryByDayData?startDt=$today&endDt=$today"
$r = Try-Get "$Pbx$path" $headers
if ($r.ok) {
  Pass 'Report endpoint accessible'
} else {
  Skip "Report endpoint returned $($r.status) - plugin falls back to deriving stats from CallHistoryView"
}

# 9. Call Control API readiness
Section "9. Call Control API readiness - /callcontrol/<ext>/devices"
if (-not $FromExt) {
  Skip 'Pass -FromExt to probe Call Control API readiness'
} else {
  $r = Try-Get "$Pbx/callcontrol/$FromExt/devices" $headers
  if ($r.ok) {
    Pass "Call Control API accessible for ext $FromExt - $(@($r.data).Count) device(s)"
    $r.data | ForEach-Object {
      Write-Host "        device_id=$($_.device_id)  ua=$($_.user_agent)"
    }
  } else {
    if ($r.status -eq 403) {
      Skip "Call Control API returned 403 - 'Enable access to the 3CX Call Control API' is OFF on the Service Principal, or ext $FromExt isn't in its Extension(s) selector. Reads work without it."
    } else {
      Fail 'Call Control devices GET' "status=$($r.status) body=$($r.body)"
    }
  }
}

# 10. Hangup path - XAPI Pbx.DropCall (smoke shape only, no real call to drop)
Section '10. pbx_hangup_call - /xapi/v1/ActiveCalls(<Id>)/Pbx.DropCall'
$r = Try-Post "$Pbx/xapi/v1/ActiveCalls('SMOKE-TEST-NONEXISTENT')/Pbx.DropCall" $headers @{}
if ($r.status -eq 404 -or $r.status -eq 400) {
  Pass 'Pbx.DropCall path resolves (got expected 4xx for a fake callId, not 403)'
} elseif ($r.ok) {
  Pass 'Pbx.DropCall accepted the call (unusual for a fake id, but path is reachable)'
} else {
  Fail 'Pbx.DropCall path probe' "status=$($r.status) body=$($r.body)"
}

# 11. (OPTIONAL) Real outbound test - UNCOMMENT TO USE
Section "11. (OPTIONAL) Real click-to-call from ext $FromExt to $MobileE164"
Skip 'This test is commented out by default. Uncomment in the script to actually dial.'
# To enable, remove the # from the next block:
#
# if (-not $FromExt) {
#   Skip 'Pass -FromExt to enable the outbound test'
# } else {
#   $r = Try-Get "$Pbx/callcontrol/$FromExt/devices" $headers
#   if ($r.ok -and (@($r.data).Count -gt 0)) {
#     # Prefer a hard-phone over the 3CX Mobile Client / WebClient so the
#     # call rings the physical handset rather than a phone app.
#     $hard = @($r.data | Where-Object {
#       $ua = ($_.user_agent + '').ToLower()
#       $id = ($_.device_id + '').ToLower()
#       -not ($ua -match 'mobile client|webclient|web client|3cx softphone' -or $id -like '*@127.0.0.1*')
#     })
#     $chosen = if ($hard.Count -gt 0) { $hard[0] } else { $r.data[0] }
#     $deviceId = $chosen.device_id
#     Write-Host "        Using device_id=$deviceId  ua=$($chosen.user_agent)" -ForegroundColor DarkGray
#     # device_id is a full SIP URI (sip:100@host:port); URL-encode for the path
#     $encId = [System.Uri]::EscapeDataString($deviceId)
#     $body = @{ destination = $MobileE164 }
#     $r = Try-Post "$Pbx/callcontrol/$FromExt/devices/$encId/makecall" $headers $body
#     if ($r.ok) { Pass 'MakeCall accepted - watch your desk phone ring first, then your cell' }
#     else { Fail 'MakeCall' "status=$($r.status) body=$($r.body)" }
#   } else {
#     Fail 'No device on ext to MakeCall from' '(see test #9)'
#   }
# }

# Summary
Section 'Summary'
Write-Host "  PASS: $script:passes"
Write-Host "  FAIL: $script:fails"
Write-Host "  SKIP: $script:skips"
if ($script:fails -gt 0) { exit 1 }
