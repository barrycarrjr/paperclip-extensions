---
name: support-triage
displayName: Support Triage pack
description: One-click setup for a triage agent on the company's support inbox. Imports the support-triage agent, the email-triage / helpscout-triage / support-day-report / email-send skills, and the morning support-numbers routine. Requires the help-scout plugin.
icon: mail
category: support
requiresPlugins:
  - help-scout
optionalPlugins:
  - email-tools
  - slack-tools
includes:
  agents:
    - support-triage
  routines:
    - support-day-report
  skills:
    - helpscout-triage
    - email-triage
    - support-day-report
    - email-send
---

# Support Triage pack

Drop a triage agent on the support inbox without manually wiring up the
five different skills + the morning report routine.

## After installing

1. Make sure the `help-scout` plugin is installed and connected to the
   right mailbox (or use the generic `email-tools` plugin if you're not
   on Help Scout).
2. For each target company, open the agent template and review the system
   prompt + guardrails (the "never auto-send" rule is non-negotiable).
3. Deploy to companies. The morning report routine needs the Help Scout
   `mailboxId` and the Slack `defaultDmTarget` set before it fires.
