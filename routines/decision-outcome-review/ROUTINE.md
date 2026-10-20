---
name: decision-outcome-review
description: Review due company decisions against their original criteria and publish separate dated outcomes when authorized evidence supports them.
routineTitle: Check how past decisions turned out
routineDescription: |
  Use the selected decision-outcomes skill in this company. Records source:
  {{recordsLocation}}. Review time zone: {{reviewTimezone}}.
  1. If the decision-outcomes skill is not available in this run, stop before
     reading or writing records and ask the board to select it. Confirm this
     is the operator-approved single source and existing format.
     Confirm authorization, privacy, readable criteria/evidence and safe new
     record creation before affected work. Do not read restricted notes until
     access and run-log visibility are resolved. Follow installed company,
     core, memory and source-evidence rules; report policy conflicts.
  2. Fix the observation clock from trusted run context in the chosen time zone.
     Read existing decisions and outcomes, resolve correction/supersession
     chains, and find approved due periods. Report missing dates and ambiguous
     chains rather than guessing. Use explicit IDs and dates, not filename order.
  3. Read original success criteria and actual evidence for each due period.
     Reconcile existing outcomes, pending approvals and uncertain writes first.
     Do not duplicate an unchanged period, including unknown/too_early results.
     Publish only authorized, evidence-supported new outcomes; never edit,
     rename, move, archive or delete a published record, including its header
     or Drive identity. If identities cannot be final before publication, stop
     affected creation and ask for an operator-supported staging workflow.
  4. Batch necessary board questions on this issue. Do not invent evidence,
     criteria, verdicts or next dates. Suggest decision changes through existing
     approvals. Respect the existing run budget; a run uses normal model usage.
     No additional paid tools, purchases, external email/Slack/chat messages or
     decision changes are authorized. Comments on this issue and board questions
     are allowed. Pending approval is not a completed write; never retry blindly.
  5. Keep evidence detail in authorized records. Comments carry only permitted
     record references and verdicts, with truthful Read: and Not covered: lines
     for notes actually opened. Use a minimal allowed reference when an ID is
     sensitive; never promise tool output stays out of logs.
  6. If nothing is due, say so and write no outcome. Put Read: and Not covered:
     immediately before the final Counts: line. Finish the final issue comment
     with Counts: items read N; entries added N; changes proposed N.
     Replace N with distinct records and evidence sources actually opened and
     read, confirmed entries created and proposals actually presented. Count a
     newly created record if reopened for verification, each source once per
     run. Eight existing sources read plus one new outcome read back means
     items read 9 and entries added 1. Failed reads and pending writes do not
     count. Use zeros where nothing was read, added or proposed, without claiming
     unavailable coverage was checked.
priority: medium
concurrencyPolicy: coalesce_if_active
catchUpPolicy: skip_missed
triggers:
  - kind: api
    label: Check decision outcomes now
variables:
  - name: recordsLocation
    label: Approved records subfolder in this company's knowledge base
    type: text
    required: true
  - name: reviewTimezone
    label: Operator-approved IANA review time zone (also used by any later schedule)
    type: text
    required: true
requiresSkills:
  - decision-outcomes
---

# Check how past decisions turned out

1. Confirm the company's one records source and existing private convention
   with the operator. Do not read live or restricted records as part of import.
2. Import this routine and the decision-outcomes skill, or use their bundle.
   Deploy the skill once to the chosen company and select that same procedure
   in the Skills tab for the existing review agent and decision-preparing agents.
   `requiresSkills` is library metadata; core may ignore it. It does not assign
   the skill or an agent. Verify the selection; reuse the deployed copy.
3. Deploy the routine. With no `defaultAssigneeRole` it starts **paused**, with
   no assignee and an API trigger only. Import/deployment starts no schedule
   and wakes nobody. Inspect the paused state before activation.
4. Choose an existing agent, confirm authorized source access and safe creation,
   and supply `recordsLocation` and `reviewTimezone`. No default company, agent,
   location, time zone or schedule is chosen by this template. Resolve any
   conflicting installed policy or restricted-source privacy first.
5. Activate and run only by deliberate operator choice. Each firing uses normal
   agent/model budget and can produce the routine's ordinary notification or
   reporting retry. Add a schedule only through explicit operator configuration,
   using the same time zone and approved cadence. Keep `coalesce_if_active` and
   `skip_missed`; these reduce repeated routine issues, not duplicate file writes.

Immutability and reading past outcomes are instructions, not technical guards.
No company is configured by this template. The companion core checker change
for exact `record_type: decision` and `record_type: outcome` is required to
remove stale/orphan advice that contradicts immutable records. It is not merged
as part of these templates today; confirm it is installed before use. Other
header, link, gap and Drive checks remain applicable. Do not edit a published
record to silence a finding. The pending #131 knowledge-base and saved-log
privacy decision and #132 credential decision may block restricted use; neither
is resolved here. Agent behavior and actual deployment are not proven by import.

To stop future runs, pause the deployed routine. Removing library templates
does not remove deployed copies. Preserve all published decision and outcome
records during rollback.
