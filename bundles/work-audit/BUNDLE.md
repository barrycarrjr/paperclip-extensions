---
name: work-audit
displayName: Work audit pack
description: Import the work-audit skill and on-demand routine for evidence-backed, supervised hand-off of recurring company work.
icon: clipboard-check
category: automation
requiresPlugins:
  - handoff-pipeline
optionalPlugins:
  - google-workspace
  - email-tools
  - business-records
includes:
  routines:
    - work-audit
  skills:
    - work-audit
---

# Work audit pack

1. Install Hand-off Pipeline and select the companies permitted to use it. An empty allowed companies list denies access.
2. Import this pack, assign the work-audit routine to an agent in the target company, and enable all five Hand-off tools.
3. Connect and authorize the actual calendar, sent mail, property management and accounting sources you want inspected. Optional plugins above are examples, not a guarantee that a source is connected.
4. Start the on-demand routine with 30 to 90 days of history. The agent creates one real company skill per Draft job through the authorized company-skill API. Review coverage gaps, ranked jobs, linked skills and three past-example rehearsals on Hand-off.

The pack imports the audit instructions and a routine template. Its import does not create source connections, generate job skills, start a schedule or authorize messages and external changes. Creating Draft jobs during an audit requires successful company-skill creation first; Keep records do not require a skill. Company and agent action permissions and host approval controls continue to apply in Draft and Run.
