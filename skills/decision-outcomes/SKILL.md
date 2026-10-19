---
name: decision-outcomes
description: Prepare company decisions using past outcomes, and record dated evidence of how decisions turned out without changing published records.
---

# Decision outcomes

Use this convention when preparing a decision, recording an approved decision,
or reviewing its result. A decision explains a choice; a separate outcome says
what happened against the criteria recorded when that choice was made. Missing
outcomes mean **not recorded**, never success.

This is a convention, not a technical write guard or a guarantee that an agent
will follow it. Reading past outcomes first is an instruction, visible through
the source-evidence lines, not enforced retrieval. No create-only guard is
provided by this skill or by the pending knowledge-base plugin work (#131).

## Confirm the source and permission

The operator must confirm the company's one authoritative records location,
any existing private convention and its format before setup. Do not assume the
private convention is absent. Reconcile with it through the board; do not create
a second policy or a parallel local copy of a Drive-backed source. Use a shared
company knowledge-base subfolder, outside personal agent memory and below the
top level of a synced memory folder, so sync does not import these as editable
Memories. Preserve the source's existing access and approval requirements.

Follow installed company instructions, core instructions, memory/source-evidence
guidance and applicable tools' rules. This skill does not override the CEO's
memory instructions or para-memory-files. If those require editing an existing
decision, stop that work, report the conflict and seek a board decision. Do not
write new standing rules directly; the existing correction approval process
(#126) remains required. Deploy and select this single skill for the intended
agents (#130/#143); do not import unrelated tooling or global configurations.

Read only authorized records in this company. Broader read access, including HQ
access, is not permission to use another company's records. Resolve restricted
note access and log visibility before running: an issue, comment or run log may
be visible to company colleagues or HQ readers, and tool output can enter logs.
Keeping detail out of comments does not guarantee private logs. The unresolved
knowledge-base/log privacy decision (#131) and OS credential decision (#132)
can block restricted use; reusable templates grant no privacy or security
guarantee and do not resolve either decision.

## Published means final

Before the first publication, finalize every field, body, stable ID, link and
required identity annotation. After publication, never edit content or headers,
rename, move, archive or delete the record, even to stamp a Drive ID or change
status. Keep `status: active`; later records describe corrections and changes.

Use a unique `record_id`, never the reserved `paperclip_id` that binds Memories.
Check both the ID and destination before creation. Use an existing tool's
create-only operation where available; never overwrite on collision. If safe
creation cannot be established, stop the affected write and ask the board.
After a timeout or uncertain result, read and reconcile the destination and ID
before any retry. Pending board approval is not a completed write. This
procedure does not promise exactly-once execution or atomic filesystem writes.

A plain file vault with authorized read/write access can support this now.
In Drive-link mode every document link uses
`[Readable name](relative/path.md) (Drive-ID: exact-file-id)`, and its target
declares the matching `drive_file_id`. The record's own required Drive identity
and all links must also be final before publication. If the installed tools
cannot do that, stop affected creation and ask for an operator-supported staging
or ID-allocation workflow. Do not invent Drive capabilities, publish then patch,
or create a second local source. Any staging must be approved, unpublished,
private and within the same company; do not assume an atomic publish operation.
Identity declarations are not proof of Drive access or file equality.

Correct a factual mistake with a **new record** of the same type whose `corrects`
field contains the earlier `record_id`. A changed choice or changed success
criteria requires a **new decision** whose `supersedes` field names the earlier
decision. Include a body link to each referenced record; header IDs alone are
not document links. Do not change the older record or its inbound links.

## Read past outcomes before preparing a decision

1. Use authorized, available tools to search the confirmed source for similar
   questions, topics and alternatives. A search result, summary or Memories
   listing is discovery, not proof that its underlying record was read.
2. Open relevant original decisions, their original criteria and linked
   outcomes. Search for records referencing their IDs through
   `decision_record`, `corrects` and `supersedes`, including multiple outcomes
   and corrections. Follow relevant links in both directions where the tools
   permit; disclose incomplete search coverage.
3. Resolve chains by explicit IDs and dates, not filename order. Keep a visited
   set and a bound of 100 linked records per chain. Report duplicate IDs,
   cycles, missing targets, conflicting dates, multiple uncorrected endpoints
   or competing replacements to the board rather than guessing which is
   current. Stop affected recommendations and writes until resolved. Preserve
   differing observations from separate review periods instead of treating the
   last filename as the only outcome.
4. Add a short "Past outcomes" paragraph to the decision request: what the
   evidence suggests, its relevance and its limits. Cite only notes actually
   opened. Finish with `Read:` and `Not covered:` under the installed
   source-evidence rules. If no source is configured or available, use
   `Read: None` and explicitly say past outcomes could not be checked. Partial
   access is partial coverage; never claim a successful search or no gaps.

## Record format

These fictional file-vault examples show flat `key: value` frontmatter. Use
single scalar values, not YAML lists, nested objects or block scalars. Quote
text containing punctuation. `name`, `kind: project`, ISO `updated` and
`status: active` follow the knowledge-base header contract. Replace example
dates and IDs with verified values before publication. `updated` is the
publication date and never a promise to edit later. Do not repurpose `agent`,
`paperclip_id` or Drive identity aliases for record metadata.

### Decision example

```markdown
---
name: "Decision: Example trial"
kind: project
updated: 2026-10-19
status: active
description: "Fictional trial decision with criteria set before the result."
record_type: decision
record_id: decision-2026-10-19-example-7f2a
decided_on: 2026-10-19
decided_by: "Example board"
review_by: 2027-01-19
topic: example-trial
---

## Question
Would the example trial reduce the measured wait?

## Options considered
Keep the current process, or approve a limited trial.

## Decision
Approve the limited trial, as recorded in approval example-approval-001.

## Why
The baseline report supports testing this option.

## Success looks like
Median wait below ten minutes over the approved observation period.

## Evidence to check at review
The approved trial report and baseline report in this company's source.

## Where it was decided
Example issue EXAMPLE-123; approval example-approval-001.
```

### Outcome example

```markdown
---
name: "Outcome: Example trial (2027-01-19)"
kind: project
updated: 2027-01-19
status: active
description: "Fictional observation against the original trial criteria."
record_type: outcome
record_id: outcome-2027-01-19-example-39b6
decision_record: decision-2026-10-19-example-7f2a
review_period: 2027-01-19
observed_on: 2027-01-19
verdict: unknown
recorded_by: "Example reviewer"
topic: example-trial
---

Decision: [Decision: Example trial](decision-2026-10-19-example-7f2a.md)

## Measured against
The original criterion was median wait below ten minutes.

## What was observed
This fictional example has no trial report available, so the result is unknown.

## Verdict
Unknown. The original decision is not evidence that the trial worked.

## What this suggests
Ask the board where the approved report can be read. No next date is assumed.

Read: decision-2026-10-19-example-7f2a
Not covered: The actual trial result; this example has no supporting report.
```

Allowed verdicts are `worked`, `partly_worked`, `did_not_work`, `too_early` and
`unknown`. Explain confidence and cite the evidence actually read. If original
criteria were missing, say "not recorded" and explicitly label any approved
retrospective basis. Never invent criteria after seeing the result.

Optional flat fields are `corrects` on a correction, `supersedes` on a new
decision, and `next_review` on a `too_early` or `unknown` outcome only when an
existing source or board decision approves that date. Cite that approval in
the body. Do not invent a next review date or cadence. Omit `review_by` if no
date was approved and flag that omission for the board.

## Review due decisions without duplicate outcomes

Use the observation clock from trusted run context, fixed once for the run,
and the operator's chosen review time zone. If either is missing, ask before
date-dependent work. Record dates as ISO `YYYY-MM-DD` in that zone, or full ISO
timestamps with an explicit offset when needed. Evidence dates come from the
sources; do not guess timestamps. Use the same zone as an approved schedule.

First read existing decisions and outcomes and resolve their chains. An
initial `review_by`, or a resolved nonfinal outcome's approved `next_review`,
is due when it is on or before the observation date. `review_period` records
that approved due date, not the date of a retry. A resolved final outcome
(`worked`, `partly_worked`, `did_not_work`) closes that review. List decisions
without a review date separately; never infer one from file age.

Before writing, reconcile the original decision ID, due period and existing
outcomes. An unchanged period with an existing outcome or pending write needs
no second outcome, including repeated `unknown` or `too_early` observations.
New material evidence can justify a new linked correction, with its basis
explained, rather than an unlinked duplicate. An approved later review period
can receive a separate outcome. Resolve uncertain writes before retrying.

For each due period, open the original criteria and named evidence through
authorized tools. Write a new outcome only when evidence supports the verdict
and the write is authorized. `unknown` and `too_early` are valid evidence
conclusions, not automatic records to emit on every run. If evidence,
permission or a board decision is needed, batch questions on the routine's
own Paperclip issue, using the installed board-question mechanism. Do not
count a proposed or approval-pending outcome as written. Suggest decision
changes or standing rules to the board through existing approval paths.

Respect the existing run budget. A deliberate run consumes normal agent/model
usage; this convention authorizes no additional paid tools, purchases,
external email/Slack/chat messages or decision changes. The review may comment
on its own Paperclip issue and ask batched board questions only. Put evidence
detail in authorized records; issue comments use IDs and verdicts only, or an
allowed minimal reference if the ID is itself sensitive. Include truthful
`Read:` and `Not covered:` lines using those permitted references. Stop
restricted reading until privacy and access are resolved.

Put `Read:` and `Not covered:` immediately before the final `Counts:` line.
Finish the review issue's final comment with the exact footer shape, replacing
each N with the actual nonnegative count:

`Counts: items read N; entries added N; changes proposed N.`

Count distinct records and evidence sources actually opened and read, including
a newly created record if reopened for verification. Count each source once
per run, even when reopened several times. For example, eight existing sources
read plus one newly created outcome read back means items read 9 and entries
added 1. Count only confirmed new published entries and distinct proposals
actually presented. Searches and failed reads are not reads; pending writes
are not entries added. If nothing is due, say so without writing outcomes, use
the real read count and zero added entries and proposals when none were made.
Zero reads must not imply coverage was checked.
