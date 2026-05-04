---
name: pbx-call-from-my-extension
description: Originate a click-to-call from the calling user's own 3CX extension to an arbitrary phone number, accepting any common phone format. Anchor "user-aware" use case for the 3cx-tools plugin. Use whenever a user (typically via Clippy or an agent chat) asks the agent to "call <number> from my extension" — the agent identifies who's asking, looks up their extension via the plugin's User → Extension map, normalizes the destination to E.164, and fires pbx_click_to_call so the desk phone rings first then the destination.
---

# PBX Call from My Extension

Round-trips through the `3cx-tools` plugin to originate a call from
**the calling user's** desk extension. The plugin handles number
normalization (any common format → E.164) and applies the company's
outbound dial prefix so the right trunk / caller-ID is presented.

## When to invoke

- A user types into Clippy or an agent chat something like:
  - "Call 555.123.4567 from my extension"
  - "Dial (215) 555-1212 for me"
  - "Call +18005551212"
- The user's identity (email or Paperclip user UUID) is available in
  the conversation context. The agent must capture this — see "How to
  invoke" below.

## Pre-conditions

- `3cx-tools` plugin installed + `ready`.
- `allowMutations: true` on the plugin settings.
- The Service Principal in 3CX admin has the **Call Control API**
  enabled and the calling user's extension is in the Extension(s)
  selector.
- The calling user is in the plugin's **User → extension map** (a
  setting on the plugin's settings page) with their email or Paperclip
  user UUID and their 3CX extension number.
- The calling company is in the plugin's `allowedCompanies` and has a
  `companyRouting` entry. If you want per-LLC outbound trunk
  attribution, set the company's `outboundDialPrefix` (e.g. "9", "8").

## How to invoke

The agent receives the user's request and must:

1. **Identify the caller**. Pull the calling user's email (or UUID) from
   the conversation context. In Clippy / agent-chat the actor's identity
   is available in `$PAPERCLIP_ACTOR_USER_EMAIL` (or
   `$PAPERCLIP_ACTOR_USER_ID`) — exact env var depends on the agent
   harness; if neither is set, ask the user "what's your email?" before
   placing the call rather than guessing.
2. **Capture the destination** verbatim from the user's message. Do NOT
   reformat it — the plugin handles "(717) 577-1023", "555.123.4567",
   "5551234567", "+15551234567", and internal extensions all the same.
3. **Confirm before dialing** if the destination would be expensive,
   international, or could be wrong — repeat back what you're about to
   do: "About to call 555.123.4567 from extension <ext>. Confirm?"
4. **Place the call** by invoking the plugin tool:

```bash
USER_EMAIL="${PAPERCLIP_ACTOR_USER_EMAIL:-${PAPERCLIP_USER_EMAIL:-}}"
TO_NUMBER="<destination as the user typed it>"
# Optional: a stable idempotency key derived from (user, dest, minute) so
# repeated invocations within ~60s don't double-dial.
IDEM_KEY="$(date +%Y%m%dT%H%M)-${USER_EMAIL}-${TO_NUMBER}"

curl -s -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_API_URL/api/plugins/tools/execute" \
  -d "$(jq -n \
    --arg agent "$PAPERCLIP_AGENT_ID" \
    --arg run "$PAPERCLIP_RUN_ID" \
    --arg company "$PAPERCLIP_COMPANY_ID" \
    --arg email "$USER_EMAIL" \
    --arg to "$TO_NUMBER" \
    --arg idem "$IDEM_KEY" \
    '{
      tool: "3cx-tools:pbx_click_to_call",
      parameters: { fromUserEmail: $email, toNumber: $to, idempotencyKey: $idem },
      runContext: { agentId: $agent, runId: $run, companyId: $company }
    }')"
```

5. **Tell the user what's happening.** "Your desk phone is ringing
   now — pick it up and your call will connect to <destination>."

## Failure modes (worth pattern-matching on)

| Plugin error | Action |
|---|---|
| `[EUSER_NOT_MAPPED]` | The user isn't in the plugin's User → extension map. Tell the user: "I don't have your extension on file. Ask the operator to add you to /instance/settings/plugins/3cx-tools." Stop. |
| `[ESCOPE_VIOLATION]` | The mapped extension isn't in the calling company's manual-mode scope. Misconfiguration — escalate. |
| `[E3CX_CC_NOT_ENABLED]` | Service Principal needs Call Control API + the user's extension selected. Operator action. |
| `[E3CX_NO_DEVICE]` | The user has no registered device (no deskphone / softphone logged in to 3CX). Ask them to log in to a phone first. |
| `[ECONCURRENCY_LIMIT]` | Daily click-to-call cap reached for this company. Wait or raise `maxClickToCallPerDay`. |
| `[EDISABLED]` | `allowMutations` is off on the plugin. Operator action. |

## Notes

- This skill is mutation-only — there is no read fallback. If you just
  need to display the user's extension or the queue depth, use the
  read-only tools (`pbx_extension_list`, `pbx_queue_status`) instead.
- The plugin normalizes US/CA 10- and 11-digit numbers to E.164 and
  passes "+" international forms through. Internal extension dialing
  (3-5 digit destinations) is also passed through unchanged so
  ext-to-ext click-to-call works the same way.
- The outbound dial prefix per company (e.g. "9" for one LLC, "8" for
  another) is applied AFTER normalization, so a destination of
  "555.123.4567" with company prefix "9" results in "915551234567"
  being sent to 3CX MakeCall. The trunk 3CX picks via its outbound
  rules determines the caller-ID presented to the destination.
