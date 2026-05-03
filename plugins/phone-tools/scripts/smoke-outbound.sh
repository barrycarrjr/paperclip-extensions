#!/usr/bin/env bash
# Smoke-test the phone-tools plugin by placing a real outbound call.
#
# The default assistant runs a richer scripted test:
#   1. Greets and asks if you can hear it.
#   2. Asks if you'd like to test a feature.
#   3. Branches: it can state the current date/time, do basic math, repeat
#      back a number you give it, or just chat briefly.
#   4. After each answer, asks "anything else?".
#   5. When you say "no" / "I'm done" / "that's all" — says goodbye and
#      hangs up via Vapi's end-call function.
#
# Usage:
#   PAPERCLIP_COOKIE='<cookie>' \
#   COMPANY_ID='<company-uuid>' \
#   AGENT_ID='<agent-uuid>' \
#   RUN_ID='<heartbeat-run-uuid>' \
#   TO='<e164-number>' \
#   ./smoke-outbound.sh
#
# All five env vars are REQUIRED. The script will not place a call without
# explicit destination, company, agent, run context, and authed session.
#
# How to get the values:
#   PAPERCLIP_COOKIE  Open Paperclip in your browser, sign in. F12 →
#                     Application → Cookies → http://<paperclip-host>:3100
#                     → copy the value of `paperclip-default.session_token`
#                     and prepend `paperclip-default.session_token=`.
#   COMPANY_ID        UUID of the company that has access to the plugin
#                     account (find at /api/companies in your browser).
#   AGENT_ID          UUID of any agent in that company (CEO is fine).
#                     Find at /api/companies/<id>/agents.
#   RUN_ID            UUID of any past heartbeat run for that agent. Find
#                     at /api/companies/<id>/heartbeat-runs?limit=5 — pick
#                     the most recent. Paperclip's tool-exec endpoint
#                     requires the runContext to reference a real past run.
#   TO                E.164 destination number (e.g. +12025550123).
#
# Optional env vars:
#   PAPERCLIP_URL     defaults to http://localhost:3100
#   ACCOUNT           plugin account key, defaults to "main"
#   POLL_INTERVAL     seconds between status polls (default 5)
#   POLL_TIMEOUT      max seconds to poll (default 300)
#   ASSISTANT_NAME    default "SmokeTest"
#   ASSISTANT_PROMPT  override the assistant's system prompt entirely
#   FIRST_MESSAGE     override the assistant's first spoken line

set -euo pipefail

PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"
ACCOUNT="${ACCOUNT:-main}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
POLL_TIMEOUT="${POLL_TIMEOUT:-300}"
ASSISTANT_NAME="${ASSISTANT_NAME:-SmokeTest}"

# The current date/time gets baked into the system prompt so the assistant
# can recite it on demand without a tool call. Format: "Sunday, May 3, 2026
# at 1:47 PM Eastern Time" (locale-aware, falls back gracefully on systems
# without the long format).
NOW_HUMAN="$(date '+%A, %B %-d, %Y at %-I:%M %p %Z' 2>/dev/null || date)"

DEFAULT_PROMPT="You are the phone-tools v0.1.0 plugin smoke test running over Vapi. Your job is to verify the audio loop and a few conversational features work end-to-end. The current date and time is ${NOW_HUMAN}.

Run this script in order; do not loop:

1. GREET: Hello, identify yourself as the phone-tools smoke test, ask if the recipient can hear you clearly. Wait for confirmation.

2. OFFER: Say something like 'Do you have any questions for me, or would you like to demonstrate a feature? I can tell you the current date and time, do some quick math, repeat back a number you say, or just chat briefly. What would you like?'

3. ANSWER any reasonable request. Specifically:
   - 'What time is it?' / 'What's the date?' → state the current date and time clearly. The current date and time is ${NOW_HUMAN}.
   - Math like 'what's 17 plus 24' → answer.
   - 'Repeat back this number: <digits>' → repeat the digits cleanly.
   - Any other reasonable question → answer briefly and conversationally.

4. After each answer, ask 'Anything else?'

5. END: When they say 'no', 'I'm done', 'that's all', 'goodbye', or similar — say a brief sign-off like 'Great, the smoke test passed. Goodbye!' and END THE CALL using your end-call function. Do not keep saying goodbye in a loop — invoke the end-call function.

Keep responses short and natural. If they go silent for more than 15 seconds, end the call. Total call should be under 3 minutes."

DEFAULT_FIRST="Hi, this is the phone-tools v0.1.0 smoke test calling. Can you hear me clearly?"

ASSISTANT_PROMPT="${ASSISTANT_PROMPT:-$DEFAULT_PROMPT}"
FIRST_MESSAGE="${FIRST_MESSAGE:-$DEFAULT_FIRST}"

# Export everything python subprocesses below need to read via os.environ.
export PAPERCLIP_URL ACCOUNT ASSISTANT_NAME ASSISTANT_PROMPT FIRST_MESSAGE
export COMPANY_ID AGENT_ID RUN_ID TO

if [ -z "${PAPERCLIP_COOKIE:-}" ]; then
  echo "ERROR: set PAPERCLIP_COOKIE — copy from Paperclip browser session." >&2
  exit 2
fi
if [ -z "${COMPANY_ID:-}" ]; then
  echo "ERROR: set COMPANY_ID to a company UUID allowed on the plugin account." >&2
  exit 2
fi
if [ -z "${AGENT_ID:-}" ]; then
  echo "ERROR: set AGENT_ID to an agent UUID belonging to that company." >&2
  exit 2
fi
if [ -z "${RUN_ID:-}" ]; then
  echo "ERROR: set RUN_ID to a heartbeat-run UUID belonging to that agent. Find one via /api/companies/<id>/heartbeat-runs?limit=5." >&2
  exit 2
fi
if [ -z "${TO:-}" ]; then
  echo "ERROR: set TO to the E.164 destination number (e.g. TO=+12025550123)." >&2
  exit 2
fi

echo "→ Placing test call to $TO from account '$ACCOUNT'"
echo "  company:  $COMPANY_ID"
echo "  agent:    $AGENT_ID"
echo "  run:      $RUN_ID"
echo "  current:  $NOW_HUMAN"
echo

# Build the JSON body via python so multi-line prompt content is escaped
# correctly for JSON without double-quoting headaches in bash heredocs.
REQ_BODY=$(python -c "
import json, os
print(json.dumps({
  'tool': 'phone-tools:phone_call_make',
  'runContext': {
    'companyId': os.environ['COMPANY_ID'],
    'agentId': os.environ['AGENT_ID'],
    'runId': os.environ['RUN_ID'],
  },
  'parameters': {
    'account': os.environ.get('ACCOUNT', 'main'),
    'to': os.environ['TO'],
    'assistant': {
      'name': os.environ['ASSISTANT_NAME'],
      'systemPrompt': os.environ['ASSISTANT_PROMPT'],
      'firstMessage': os.environ['FIRST_MESSAGE'],
    },
    'metadata': { 'purpose': 'smoke-test' },
  },
}))
")

start_response=$(
  curl -sS -X POST "$PAPERCLIP_URL/api/plugins/tools/execute" \
    -H "Content-Type: application/json" \
    -H "Cookie: $PAPERCLIP_COOKIE" \
    -H "Origin: $PAPERCLIP_URL" \
    -H "Referer: $PAPERCLIP_URL/" \
    -d "$REQ_BODY"
)

echo "→ Start response:"
echo "$start_response" | python -m json.tool 2>/dev/null || echo "$start_response"

call_id=$(
  echo "$start_response" | python -c "
import json, sys
try:
  d = json.load(sys.stdin)
  r = d.get('result') or d
  print((r.get('data') or {}).get('callId') or r.get('callId') or '', end='')
except Exception:
  pass
"
)

if [ -z "$call_id" ]; then
  echo "ERROR: no callId in response — see above." >&2
  exit 3
fi

echo
echo "→ callId = $call_id"
echo "→ Polling status every ${POLL_INTERVAL}s (timeout ${POLL_TIMEOUT}s). Phone should be ringing now."
echo

# Export so child python subprocesses below can read it via os.environ.
export CALL_ID="$call_id"

build_status_body() {
  python -c "
import json, os
print(json.dumps({
  'tool': 'phone-tools:phone_call_status',
  'runContext': {
    'companyId': os.environ['COMPANY_ID'],
    'agentId': os.environ['AGENT_ID'],
    'runId': os.environ['RUN_ID'],
  },
  'parameters': { 'account': os.environ.get('ACCOUNT', 'main'), 'callId': os.environ['CALL_ID'] },
}))
"
}

elapsed=0
final_status=""
while [ "$elapsed" -lt "$POLL_TIMEOUT" ]; do
  status_resp=$(
    CALL_ID="$call_id" curl -sS -X POST "$PAPERCLIP_URL/api/plugins/tools/execute" \
      -H "Content-Type: application/json" \
      -H "Cookie: $PAPERCLIP_COOKIE" \
      -H "Origin: $PAPERCLIP_URL" \
      -d "$(CALL_ID=$call_id build_status_body)"
  )
  status=$(echo "$status_resp" | python -c "
import json, sys
try:
  d = json.load(sys.stdin)
  r = d.get('result') or {}
  print((r.get('data') or {}).get('status') or 'unknown', end='')
except Exception:
  print('?', end='')
")
  printf "  [%4ds] status: %s\n" "$elapsed" "${status:-unknown}"

  case "$status" in
    ended|failed|no-answer|busy|canceled)
      final_status="$status"
      echo "$status_resp" | python -m json.tool 2>/dev/null || echo "$status_resp"
      break
      ;;
  esac

  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done

if [ -z "$final_status" ]; then
  echo "→ Timed out after ${POLL_TIMEOUT}s. Last status: ${status:-unknown}." >&2
  echo "→ Re-poll later with phone_call_status using callId=$call_id." >&2
  exit 4
fi

echo
echo "→ Call finished with status: $final_status"

if [ "$final_status" = "ended" ]; then
  echo "→ Fetching transcript..."
  transcript_resp=$(
    CALL_ID="$call_id" curl -sS -X POST "$PAPERCLIP_URL/api/plugins/tools/execute" \
      -H "Content-Type: application/json" \
      -H "Cookie: $PAPERCLIP_COOKIE" \
      -H "Origin: $PAPERCLIP_URL" \
      -d "$(python -c "
import json, os
print(json.dumps({
  'tool': 'phone-tools:phone_call_transcript',
  'runContext': {
    'companyId': os.environ['COMPANY_ID'],
    'agentId': os.environ['AGENT_ID'],
    'runId': os.environ['RUN_ID'],
  },
  'parameters': { 'account': os.environ.get('ACCOUNT', 'main'), 'callId': os.environ['CALL_ID'], 'format': 'plain' },
}))
")"
  )
  echo "$transcript_resp" | python -m json.tool 2>/dev/null || echo "$transcript_resp"
fi

echo
echo "✓ Smoke test complete. callId = $call_id"
