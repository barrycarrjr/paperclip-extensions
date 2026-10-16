---
name: work-audit
description: Inspect 30 to 90 days of real company work, rank recurring jobs for delegation, write one reusable skill per job, and rehearse each against three past examples before supervised hand-off. Use for a requested work audit or the work-audit routine with the handoff-pipeline plugin.
---

# Work audit

Turn observed recurring work into evidence-backed job instructions in the selected company's Hand-off page. The plugin stores the audit, job, example and run records. Its Run mode does not change company or agent action permissions; every mutation still follows host approval controls.

Call `handoff_get_pipeline` before resuming an audit or job so work uses the saved stage and current skill revision.

## Inspect actual work

1. Confirm the selected company, audit date range and available connected sources. Use a 30 to 90 day window, defaulting to 60 days unless requested otherwise.
2. Read the actual connected calendar, sent mail, property management records and accounting records that belong to this company. Inspect completed events, outgoing messages, work orders, recurring transactions and reconciliations as available. A connector being installed does not prove an account is connected or readable.
3. Record each source's account, covered dates, stable record references and retrieval result. Record unavailable, denied, incomplete or missing sources explicitly, including which conclusions they prevent. Continue with available evidence; do not imply full coverage.
4. Identify recurring jobs from repeated observed examples. Distinguish observed counts and durations from estimates. Never invent access, source records, quotations, job frequency, time saved or test results. Keep credentials and unnecessary personal data out of stored records.
5. Rank jobs by observed frequency, estimated owner time, repeatability, consequence of error, and how reliably success can be checked. State the evidence and uncertainty behind the ranking. Prefer bounded, verifiable work for the first hand-off; retain judgment-heavy or poorly evidenced jobs for review.

Use `handoff_record_audit` to preserve the coverage, evidence, gaps and ranked findings. Save returned IDs exactly. Do not fabricate an ID when a call fails.

## Write one skill per job

For each selected Draft job, create its own actual company skill through Paperclip's authorized company-skill API rather than combining unrelated jobs. Include the trigger, inputs, permitted company/accounts, exact steps, expected output, checks, exceptions, stop conditions and any required approval before external writes or messages. Link the source evidence and explain assumptions. A job skill must not expand existing permissions. Keep records document work retained by the owner and do not require a skill.

Read the company-skill API result, then pass the returned `companySkillId` and key plus its complete current SKILL.md to `handoff_record_job`, linking its audit ID. Hand-off verifies the ID, company, key and content before saving a Draft job. If skill creation is unavailable or denied, disclose the blocker; do not pretend a job record creates or imports a skill. Recording a job does not start a routine, connect an account or authorize an external action; report any remaining setup steps accurately.

## Test three past examples

For each job, select three distinct real past occurrences from the inspected sources. Save the input, actual historical outcome and source references with `handoff_add_example`. If fewer than three examples are available, say so and leave the job unqualified for hand-off.

Rehearse the current skill separately against each example without repeating historical external writes or sending messages. Compare the produced result with the actual outcome, record discrepancies, and store each run with `handoff_record_run`, including its actual start time, example ID, skill version, mode, output and evidence. Record a pass only after checking the result; failed or unavailable tests remain visible. Fix the skill and retest the current version after material changes.

## Supervised hand-off

Present the ranked jobs, coverage gaps and three-example results in the selected company's Hand-off page for board review. The board reviews historical rehearsals and the first five production results. Five consecutive clean production reviews promote the current skill revision to Run, where later production results stay in the log without required review. Three consecutive rewrites stop new work until the skill is rebuilt and qualified again. Run mode does not bypass company policy, agent permissions or action approval.

During later execution, record the actual outcome, corrections, elapsed time and any observed time saving. Mark estimates as estimates. Stop dependent work when required access or approval is missing, a result cannot be verified, or a job is retired. Preserve evidence and report what remains unresolved; do not silently treat a failed audit or run as completed.
