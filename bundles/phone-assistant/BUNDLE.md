---
name: phone-assistant
displayName: Phone Assistant pack
description: One-click setup for a fully-equipped phone agent. Imports the phone-assistant agent, all phone-* skills, and the recurring daily-report + queue-watchdog routines. Requires the phone-tools plugin (and 3cx-tools if you're using on-prem 3CX as the PBX).
icon: phone
category: phone
requiresPlugins:
  - phone-tools
optionalPlugins:
  - 3cx-tools
  - slack-tools
includes:
  agents:
    - phone-assistant
  routines:
    - pbx-daily-call-report
  skills:
    - phone-lead-qualification
    - phone-no-show-recovery
    - phone-after-hours-escalation
    - phone-appointment-booker
    - phone-confirmation-call
    - phone-customer-satisfaction
    - phone-followup-after-quote
    - phone-quote-request
    - phone-renewal-confirmation
    - phone-vendor-status-check
    - pbx-call-from-my-extension
    - pbx-daily-call-report
    - pbx-queue-watchdog
---

# Phone Assistant pack

Everything you need to run a phone agent for one company in a single
install. Designed to take a company from "no phone automation" to "real
agent answering calls and reporting back at end of day" in under five
minutes.

## What you get

- **One agent** (`phone-assistant`) with the operator role, pre-configured
  permissions, and a starting monthly budget cap.
- **13 skills** covering the full inbound + outbound phone surface: lead
  qualification, no-show recovery, appointment booking + confirmation,
  CSAT follow-ups, vendor status checks, after-hours escalation, queue
  watchdog, daily reporting, and extension-to-extension calls.
- **One routine** (`pbx-daily-call-report`) wired to fire at end-of-business-day.

## After installing

1. Confirm the `phone-tools` plugin is installed and `ready` for the
   target companies. If you're on on-prem 3CX, install `3cx-tools` too.
2. Configure the PBX / VAPI workspace under the plugin's settings and add
   the target companies to `allowedCompanies`.
3. Open the agent template, review the system prompt, then deploy to the
   companies you want phone coverage for.
4. Open each routine template, set per-company variables (queue name,
   timezone, target channel), and deploy.

## Notes

- This bundle is intentionally generous on suggested skills — most
  operators delete the ones they don't need before deploying.
- Importing a bundle **does not** auto-deploy anything. It creates the
  templates at the portfolio level. You decide which companies get them.
