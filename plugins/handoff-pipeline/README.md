# Hand-off Pipeline

Hand-off turns a review of actual company work into individual job skills, historical example tests and supervised run records. Each company's audits, jobs, examples and results remain isolated. The plugin records evidence and supervision choices; an agent performs any underlying work through its existing authorized tools.

> **Install + setup walkthrough** lives in-app: open the plugin's settings page in Paperclip and follow the **Setup** tab. This README is an overview of capabilities and a reference for tool and route shapes.

## Recent changes

- **v0.1.1** - Adds the company-scoped Hand-off workflow, durable correction contracts, skill verification, run history, and work-audit templates.

- **0.1.0**: Initial company-scoped Hand-off page, audit and job records, one skill per job, historical examples, run logging and board review, with work-audit skill, routine and bundle templates.

## Set up

1. Install the plugin, then select its **Allowed companies**. Empty or missing configuration denies access. Every record belongs to one company even when multiple companies are allowed.
2. Enable the five Hand-off tools and the authorized company-skill API for an agent in the target company. Import `work-audit` from the template library as a skill, on-demand routine or bundle.
3. Connect and authorize the real calendar, sent mail, property management and accounting sources the audit should inspect. This plugin does not provide those connections.
4. Open **Hand-off** in that company's sidebar, or visit `/:companyPrefix/hand-off`, to review audits, jobs, tests and runs.

The work-audit procedure examines 30 to 90 days of actual records and discloses missing sources. It ranks recurring work, creates a separate real company skill for each Draft job through the authorized company-skill API, and records the returned skill ID, key and complete SKILL.md. The plugin verifies that snapshot against the company skill before accepting it. Keep records document retained work without requiring a skill. Draft jobs rehearse the current skill against three distinct past examples before qualifying for Run. Missing access or evidence remains visible rather than being filled with invented results.

## Supervision and permissions

Board operators review historical rehearsals and the first five production results. Each production result is bound to the current host heartbeat run, its assigned issue, invoking agent and host start time. Every production review requires a finished host run with valid reported counts, and a clean review also requires a succeeded run. A rewritten production review reserves the review, posts an idempotent board correction on the source issue, verifies that its stored body matches the prepared correction after host redaction, then stores that comment reference permanently. An interrupted save can safely retry the same correction. Once its correction comment is stored, human review can finish even when an agent pause, termination, pending hire approval or budget hold prevents invocation. Delivery status is saved with the run separately from its immutable review. Pending warnings and Retry correction delivery remain available after reload, including in the Run log. The original reviewer can retry using the same comment and wake keys. The authenticated company-scoped route reads the immutable recipient set stored on the correction, then checks each recipient's host wake receipts and linked heartbeat runs instead of reconstructing recipients from mutable comment text or agent names or accepting a browser-reported status. Legacy corrections without a stored set continue to use their immutable wake receipts. This does not resume an agent or bypass a hold, and an unexpected queue failure leaves delivery pending. The run log shows any matching instruction change approval status. Five consecutive clean production reviews promote that skill revision to Run, where later production results stay in the run log without entering required review. A late run that started before promotion returns the job to Draft. Promotion resumes only after every required production review on the current revision is complete in execution order and the five-clean streak still holds. Three consecutive rewrites in review order block new work until the skill is rebuilt and qualified again. Board operators also manage skill revisions, rebuilds and retirement. Agents record audits, new job skills, examples and actual run outcomes through their tools. They do not obtain board-only review, rebuild or retirement controls through those tools.

Run mode does not change company or agent action permissions. Mutations obey host approval controls. Recording a job does not import its skill, schedule it, send a message or authorize an external change. Historical rehearsals must not repeat past external writes. Time-saving estimates are distinct from observed results.

## Agent tools

The four recording tools are declared as writes so the host can apply its mutation controls. The pipeline reader is read-only. The host supplies the authenticated company context; agents cannot choose another company in tool arguments.

| Tool | Purpose |
| --- | --- |
| `handoff_get_pipeline` | Read ranked stages, current revisions and pending work before resuming, or load one full job history. |
| `handoff_record_audit` | Preserve the inspected history, available and unavailable sources, evidence and ranked recurring work. |
| `handoff_record_job` | Record one recurring job, linking Draft jobs to a real company skill, content snapshot and audit. |
| `handoff_add_example` | Preserve one real historical input, expected outcome and supporting source references for a job. |
| `handoff_record_run` | Log a rehearsal or actual execution with its current skill version, checks, outcome and time evidence. |

Use the tool's returned IDs to link records. Historical run records use the supplied execution start time. Production runs use the host heartbeat run ID, agent, issue and start time, so callers cannot claim another run's provenance. The board cannot add production runs manually. Record outstanding results before rebuilding because the old live skill can no longer be verified afterward. Source references should identify real records without copying credentials or unnecessary personal data. Tool parameter schemas in `src/manifest.ts` describe the required fields.

## Board API

Routes are under `/api/plugins/handoff-pipeline/api`. Every route requires board authentication and an authorized `companyId` query parameter. Record IDs are also checked within that company.

| Route key | Method and local path |
| --- | --- |
| `handoff.summary` | `GET /summary` |
| `handoff.list-audits` | `GET /audits` |
| `handoff.create-audit` | `POST /audits` |
| `handoff.list-jobs` | `GET /jobs` |
| `handoff.create-job` | `POST /jobs` |
| `handoff.update-job` | `PATCH /jobs/:jobId` |
| `handoff.list-review` | `GET /review` |
| `handoff.list-runs` | `GET /runs` |
| `handoff.add-example` | `POST /jobs/:jobId/examples` |
| `handoff.add-run` | `POST /jobs/:jobId/runs` |
| `handoff.prepare-rewrite` | `POST /runs/:runId/review/prepare` |
| `handoff.review-run` | `POST /runs/:runId/review` |
| `handoff.record-correction-delivery` | `POST /runs/:runId/correction-delivery` |
| `handoff.preflight-rebuild` | `POST /jobs/:jobId/rebuild/preflight` |
| `handoff.rebuild-job` | `POST /jobs/:jobId/rebuild` |
| `handoff.retire-job` | `POST /jobs/:jobId/retire` |

The UI exports `HandOffSidebarItem` and `HandOffPage`. Its data handlers are registered separately from these HTTP routes and apply the same company checks.

## Storage and build

The host applies migrations from `migrations/` into the plugin-owned database namespace with slug `handoff`. The manifest grants read-only access to company skills, heartbeat runs, wakeup receipts, issues, issue comments and approvals. These reads verify skill content, production provenance, correction comments and instruction change approval status within the selected company. No source account credentials are required by this plugin.

From `plugins/handoff-pipeline/`:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

The build checks the vendored SDK and bundles the worker, manifest and UI with Node and esbuild. Build and clean scripts work on Windows without shell file commands. Install or reinstall the built plugin through the host before checking its running page; building alone does not update an installed copy.

## Included templates

- `skills/work-audit/SKILL.md`: evidence gathering, ranking, individual job skills, three past-example rehearsals and supervised hand-off.
- `routines/work-audit/ROUTINE.md`: an on-demand audit with a 60-day default history window and optional source scope.
- `bundles/work-audit/BUNDLE.md`: imports the skill and routine together; requires this plugin.

Importing templates does not create source connections, generate job skills, start recurring schedules or broaden action permissions. During an audit, creating a Draft job requires successfully creating its real company skill first. Review any remaining setup after the audit.

\n