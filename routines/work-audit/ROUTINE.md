---
name: work-audit
description: Review real company work over 30 to 90 days, rank recurring jobs, and prepare one tested skill per job for supervised hand-off.
routineTitle: Audit recurring work for hand-off
routineDescription: |
  Invoke the work-audit skill for this company. Inspect the actual connected
  calendar, sent mail, property management and accounting sources over the
  last {{lookbackDays}} days. Apply this requested scope: {{auditScope}}.
  Disclose unavailable sources, rank recurring
  work from cited evidence, create one actual company skill per Draft job
  through the authorized company-skill API, and test three real past examples
  before board review. Record returned skill IDs, keys, content snapshots and
  all audit, job, example and run evidence
  in handoff-pipeline. Never fabricate access, records, results or time saved.
  Run mode does not change company or agent permissions or approval controls.
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
triggers:
  - kind: api
    label: Start a work audit
variables:
  - name: lookbackDays
    label: Days of history (30 to 90)
    type: number
    required: true
    defaultValue: 60
  - name: auditScope
    label: Work areas and connected accounts to inspect
    type: text
    required: false
requiresSkills:
  - work-audit
requiresPlugins:
  - handoff-pipeline
---

# Audit recurring work for hand-off

This routine starts on demand. Import the work-audit skill and enable all five Hand-off tools for an agent in the target company. Select that company in the plugin's allowed companies before running.

Set `lookbackDays` to 30 through 90, and use `auditScope` to narrow accounts or work areas when needed. The agent reads actual available sources, records missing coverage, ranks recurring jobs and creates one actual company skill for each Draft job before linking its returned ID, key and content snapshot. Keep records do not require a skill. Every Draft job needs three distinct historical examples and recorded rehearsals before it can qualify for Run.

Review the evidence, skill text and test results on Hand-off. Historical rehearsals and the first five production results require board review. Five consecutive clean production reviews promote the current revision to Run; later production results remain in the log without required review. Scheduling this routine later requires a deliberate schedule configuration. Importing it does not grant source access, activate external writes or relax existing approvals.
