# Smoke-test the phone-tools plugin by placing a real outbound call (PowerShell).
#
# The default assistant runs a richer scripted test:
#   1. Greets and asks if you can hear it.
#   2. Asks if you'd like to test a feature.
#   3. Branches: it can state the current date/time, do basic math, repeat
#      back a number you give it, or just chat briefly.
#   4. After each answer, asks "anything else?".
#   5. When you say "no" / "I'm done" / "goodbye" — it hangs up via
#      Vapi's end-call function.
#
# Usage:
#   $env:PAPERCLIP_COOKIE = '<cookie>'
#   $env:COMPANY_ID       = '<company-uuid>'
#   $env:AGENT_ID         = '<agent-uuid>'
#   $env:RUN_ID           = '<heartbeat-run-uuid>'
#   $env:TO               = '<e164-number>'
#   .\smoke-outbound.ps1
#
# All five env vars are REQUIRED. The script will not place a call without
# explicit destination, company, agent, run context, and authed session.
#
# How to get the values:
#   PAPERCLIP_COOKIE  Browser DevTools → Application → Cookies → copy the
#                     `paperclip-default.session_token` value, prepend
#                     `paperclip-default.session_token=`.
#   COMPANY_ID        UUID of the company allowed on the plugin account.
#   AGENT_ID          UUID of any agent in that company.
#   RUN_ID            UUID of any past heartbeat run (find via
#                     /api/companies/<id>/heartbeat-runs?limit=5). Required
#                     because Paperclip's tool-exec endpoint validates the
#                     runContext against a real run record.
#   TO                E.164 destination number (e.g. +12025550123).

$ErrorActionPreference = "Stop"

$paperclipUrl    = if ($env:PAPERCLIP_URL) { $env:PAPERCLIP_URL } else { "http://localhost:3100" }
$account         = if ($env:ACCOUNT) { $env:ACCOUNT } else { "main" }
$pollInterval    = if ($env:POLL_INTERVAL) { [int]$env:POLL_INTERVAL } else { 5 }
$pollTimeout     = if ($env:POLL_TIMEOUT) { [int]$env:POLL_TIMEOUT } else { 300 }
$assistantName   = if ($env:ASSISTANT_NAME) { $env:ASSISTANT_NAME } else { "SmokeTest" }

# Format the year as "two thousand twenty-six" rather than "2026" because
# default TTS voices read 4-digit years awkwardly ("thousand 26").
$nowDate    = Get-Date
$nowHuman   = $nowDate.ToString("dddd, MMMM d, yyyy 'at' h:mm tt zzz")

$defaultPrompt = @"
You are the phone-tools v0.1.0 plugin smoke test running over Vapi. Your job is to verify the audio loop and a few conversational features work end-to-end. The current date and time is $nowHuman.

Run this script in order; do not loop:

1. GREET: Hello, identify yourself as the phone-tools smoke test, ask if the recipient can hear you clearly. Wait for confirmation.

2. OFFER: Say something like "Do you have any questions for me, or would you like to demonstrate a feature? I can tell you the current date and time, do some quick math, repeat back a number you say, or just chat briefly. What would you like?"

3. ANSWER any reasonable request. Specifically:
   - "What time is it?" / "What is the date?" → state the current date and time clearly. The current date and time is $nowHuman.
   - Math like "what is 17 plus 24" → answer.
   - "Repeat back this number: <digits>" → repeat the digits cleanly.
   - Any other reasonable question → answer briefly and conversationally.

4. After each answer, ask "Anything else?"

5. END: When they say "no", "I am done", "that is all", "goodbye", or similar — say a brief sign-off like "Great, the smoke test passed. Goodbye!" and END THE CALL using your end-call function. Do NOT keep saying goodbye in a loop — invoke the end-call function.

Keep responses short and natural. If they go silent for more than 15 seconds, end the call. Total call should be under 3 minutes.
"@

$defaultFirst = "Hi, this is the phone-tools v0.1.0 smoke test calling. Can you hear me clearly?"

$assistantPrompt = if ($env:ASSISTANT_PROMPT) { $env:ASSISTANT_PROMPT } else { $defaultPrompt }
$firstMessage    = if ($env:FIRST_MESSAGE) { $env:FIRST_MESSAGE } else { $defaultFirst }

if (-not $env:PAPERCLIP_COOKIE) {
    Write-Error "Set PAPERCLIP_COOKIE — copy from a logged-in Paperclip browser session."
    exit 2
}
if (-not $env:COMPANY_ID) {
    Write-Error "Set COMPANY_ID to a company UUID allowed on the plugin account."
    exit 2
}
if (-not $env:AGENT_ID) {
    Write-Error "Set AGENT_ID to an agent UUID belonging to that company."
    exit 2
}
if (-not $env:RUN_ID) {
    Write-Error "Set RUN_ID to a heartbeat-run UUID for that agent."
    exit 2
}
if (-not $env:TO) {
    Write-Error "Set TO to the E.164 destination number (e.g. `$env:TO = '+12025550123')."
    exit 2
}

$companyId   = $env:COMPANY_ID
$agentId     = $env:AGENT_ID
$runId       = $env:RUN_ID
$destination = $env:TO

$headers = @{
    "Cookie"       = $env:PAPERCLIP_COOKIE
    "Content-Type" = "application/json"
    "Origin"       = $paperclipUrl
    "Referer"      = "$paperclipUrl/"
}

Write-Host "-> Placing test call to $destination from account '$account'"
Write-Host "   company:  $companyId"
Write-Host "   agent:    $agentId"
Write-Host "   run:      $runId"
Write-Host "   current:  $nowHuman"
Write-Host ""

$startBody = @{
    tool         = "phone-tools:phone_call_make"
    runContext   = @{ companyId = $companyId; agentId = $agentId; runId = $runId }
    parameters   = @{
        account = $account
        to      = $destination
        assistant = @{
            name         = $assistantName
            systemPrompt = $assistantPrompt
            firstMessage = $firstMessage
        }
        metadata = @{ purpose = "smoke-test" }
    }
} | ConvertTo-Json -Depth 8

$startResp = Invoke-RestMethod -Method Post -Uri "$paperclipUrl/api/plugins/tools/execute" `
    -Headers $headers -Body $startBody

Write-Host "-> Start response:"
$startResp | ConvertTo-Json -Depth 8 | Write-Host

$callId = $null
$inner = $startResp.result
if ($inner -and $inner.data) { $callId = $inner.data.callId }
if (-not $callId -and $startResp.data) { $callId = $startResp.data.callId }
if (-not $callId -and $startResp.callId) { $callId = $startResp.callId }

if (-not $callId) {
    Write-Error "No callId in response."
    exit 3
}

Write-Host ""
Write-Host "-> callId = $callId"
Write-Host "-> Polling status every ${pollInterval}s (timeout ${pollTimeout}s). Phone should be ringing now."
Write-Host ""

$elapsed = 0
$finalStatus = $null
while ($elapsed -lt $pollTimeout) {
    $statusBody = @{
        tool       = "phone-tools:phone_call_status"
        runContext = @{ companyId = $companyId; agentId = $agentId; runId = $runId }
        parameters = @{ account = $account; callId = $callId }
    } | ConvertTo-Json -Depth 5

    $statusResp = Invoke-RestMethod -Method Post -Uri "$paperclipUrl/api/plugins/tools/execute" `
        -Headers $headers -Body $statusBody

    $status = $null
    if ($statusResp.result -and $statusResp.result.data) { $status = $statusResp.result.data.status }
    if (-not $status -and $statusResp.data) { $status = $statusResp.data.status }
    if (-not $status -and $statusResp.status) { $status = $statusResp.status }

    $statusDisplay = if ($status) { $status } else { "unknown" }
    "  [{0,4}s] status: {1}" -f $elapsed, $statusDisplay | Write-Host

    if ($status -in @("ended", "failed", "no-answer", "busy", "canceled")) {
        $finalStatus = $status
        $statusResp | ConvertTo-Json -Depth 8 | Write-Host
        break
    }

    Start-Sleep -Seconds $pollInterval
    $elapsed += $pollInterval
}

if (-not $finalStatus) {
    Write-Warning "Timed out after ${pollTimeout}s. Last status: $status. Re-poll later with phone_call_status."
    exit 4
}

Write-Host ""
Write-Host "-> Call finished with status: $finalStatus"

if ($finalStatus -eq "ended") {
    Write-Host "-> Fetching transcript..."
    $transcriptBody = @{
        tool       = "phone-tools:phone_call_transcript"
        runContext = @{ companyId = $companyId; agentId = $agentId; runId = $runId }
        parameters = @{ account = $account; callId = $callId; format = "plain" }
    } | ConvertTo-Json -Depth 5

    $transcriptResp = Invoke-RestMethod -Method Post -Uri "$paperclipUrl/api/plugins/tools/execute" `
        -Headers $headers -Body $transcriptBody
    $transcriptResp | ConvertTo-Json -Depth 8 | Write-Host
}

Write-Host ""
Write-Host "OK Smoke test complete. callId = $callId"
