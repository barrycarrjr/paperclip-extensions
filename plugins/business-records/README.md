# Business Records

One record per business in the portfolio, kept by the Corporate Operations
agent in HQ: its three statuses (operating, legal, tax account) each with an
as-of date and a source, its standing documents with renewal dates, its tax
filing calendar with proof of filing, the issues that are its cases, and an
append-only history of every change.

The point of the plugin is the few rules it enforces in code rather than
trusting to a prompt:

- A business cannot be recorded as legally **active** or **dissolved**, or its
  tax account as **open**, **final return filed** or **account closed**, unless
  a document on file for that same business proves it.
- A filing cannot be marked **filed**, **accepted** or **extension filed**
  without a proof document on file, and cannot be marked **not required**
  without a written reason and a professional or official source.
- Only the last four digits of a tax id are ever stored. Anything shaped like a
  full EIN or SSN is refused.
- Everything is scoped to the calling company, and the plugin is meant to be
  switched on for the HQ company only.

The files themselves are not stored by the plugin. They stay in Paperclip as
attachments on an issue (normally the business's standing "records" issue);
the plugin keeps an index that points at them.

## What it registers

- 11 agent tools (listed below).
- A **Corporate Operations** sidebar entry and page
  (`/:companyPrefix/corporate-operations`), shown only in allowed companies.
- 3 read-only board API routes for the page.
- Its own database namespace with five tables: `businesses`,
  `business_documents`, `business_filings`, `business_issue_links`,
  `business_history`.

## Setup

Nothing external to wire up: no API keys, no OAuth. About 2 minutes.

1. Install the plugin (Plugin Manager, or `paperclipai plugin install --local <path>`
   after `pnpm build`).
2. In the plugin settings, under **Allowed companies**, tick the **HQ company
   only**. These records cover every business in the portfolio. Any other
   company is refused by every tool and route with `[ECOMPANY_NOT_ALLOWED]` and
   does not see the sidebar entry. An empty list refuses everyone.
3. Leave **Show in sidebar** on unless you want the page reachable only by URL.
4. Enable the Business Records tools for the Corporate Operations agent.

### Smoke test

1. In HQ, ask the agent to create "Example Widgets LLC" with relationship
   `prospect`. It calls `business_upsert`.
2. Open **Corporate Operations** in the sidebar and find it. Reload; it is still there.
3. Ask the agent to mark it dissolved "because I said so". The call must come
   back `[EPROOF_REQUIRED]`, and the history must show no change.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| Allowed companies (`allowedCompanies`) | required | Company ids allowed to use the plugin. Intended: HQ only. `["*"]` allows every company (not recommended). |
| Show in sidebar (`showInSidebar`) | `true` | Whether the Corporate Operations entry appears in allowed companies. |

## The rules, in plain words

**Statuses.** Each business has three independent statuses:

- operating: `not_yet_operating`, `operating`, `ceased`, `unknown`
- legal: `not_yet_formed`, `formation_filed`, `active`, `dissolution_filed`, `dissolved`, `unknown`
- tax account: `not_yet_registered`, `open`, `final_return_filed`, `account_closed`, `unknown`

Every status change needs an as-of date and a source. The source kind is one
of `document`, `external_confirmation`, `user_reported`, `agent_inference`.

These five values need proof: legal `active` and `dissolved`, tax account
`open`, `final_return_filed` and `account_closed`. They can only be set with a
source of kind `document` or `external_confirmation` whose `documentId` is a
document on file for the **same business**, in the same company, that has
**not been replaced** by a newer version. Anything else is refused with
`[EPROOF_REQUIRED]`. Formation counts as done when the state approval or the
tax id letter is on file, not when the application was sent. Ceased operating
is not dissolved, and neither `ceased` nor `dissolution_filed` needs proof.

Every successful status change writes exactly one history row. Setting the
same value, date and source again changes nothing and writes nothing.

**Filings.** One row per filing per period, identified by business, filing
name, authority and period label (names compared ignoring letter case). The
database has a unique index on that key, so rolling the calendar forward twice
can never create a duplicate.

- `filed`, `accepted`, `extension_filed` need `proofDocumentId` (a current
  document of the same business), else `[EPROOF_REQUIRED]`.
- `extension_filed` also needs `extendedDueDate`, later than the original due
  date. The original due date is kept; the extended one becomes the effective
  due date.
- `not_required` needs a non-empty `reason` and a `source` of kind `document`,
  `professional_advice` or `official_guidance`, with either a `documentId`
  (same rules as proof) or an `https://` url. `user_reported` and
  `agent_inference` are refused with `[EREASON_SOURCE_REQUIRED]`. A reason
  that only says there was no revenue is refused too: zero revenue is never on
  its own a reason.
- When moving to `filed` or `accepted`, `nextPeriod` puts the next period's row
  on the calendar (same filing, authority and preparer). Repeating the call
  never creates a second one.
- A filing is "open" until it is `filed`, `accepted` or `not_required`, and
  "overdue" when it is open and its effective due date has passed.

**Sensitive ids.** `taxIdLast4` must be exactly four digits. Every free-text
field (names, trading names, contacts, notes, titles, issuing bodies,
attachment references, reasons, source notes and urls, filing names) is checked
for these shapes and refused with `[ESENSITIVE_ID]`:

| Shape | Example |
|---|---|
| SSN with dashes | `123-45-6789` |
| SSN with spaces | `123 45 6789` |
| EIN with a dash | `12-3456789` |
| Nine digits standing alone | `123456789` |

Separators must be consistent, so phone numbers (`215-555-0123`), dates,
ZIP+4 postcodes (`19103-1234`), amounts with thousands separators and longer
or shorter digit runs are not refused. The refusal names the field, never the
value, and the plugin never logs field values.

**Issues.** Documents, links and filing tracking issues must point at an issue
that exists in the calling company, checked with `ctx.issues.get`. Missing, or
in another company, gives `[EISSUE_NOT_FOUND]`.

**Company isolation.** Every tool and route checks the allow-list first and
returns `[ECOMPANY_NOT_ALLOWED]` with no data for any other company. Every
query also filters on the calling company, so a business id from another
company behaves exactly like one that does not exist (`[EBUSINESS_NOT_FOUND]`).

**Idempotency.** Every mutation tool accepts an optional `idempotencyKey`.
The tools are idempotent by their natural keys anyway: `business_upsert`
matches by id or by name (ignoring case) within the company and only writes
fields that actually changed; filings match by their period key; links by
business and issue. `business_add_document` returns the existing entry when
the same attachment is added again as the same type on the same issue, when
the same `idempotencyKey` is sent again, or (with no attachment reference)
when the same issue, type, title and document date are sent again.

## Tools

Every example below is a call as the host sends it. `runContext.companyId` must
be in **Allowed companies**. Dates are `YYYY-MM-DD`.

### business_list

Lists businesses with their three statuses. Filters: `relationship`
(`owned`, `prospect`, `former`, `other`), `query` (matches names and trading names).

```http
POST /api/plugins/tools/execute
{
  "tool": "business-records.business_list",
  "params": { "relationship": "owned", "query": "widgets" },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" }
}
```

### business_get

One business: record, statuses with as-of dates and sources, linked issues
(with title, status and due date), current documents, open filings.

```json
{ "tool": "business-records.business_get",
  "params": { "businessId": "<uuid>" },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_upsert

Create, or update by `id` or by `name`. Only the fields sent change.
`relationship` is required when creating. New businesses start with every
status `unknown` unless `statuses` is sent (only when creating; each is
checked by the proof rule). To rename, send `id` and the new `name`.

```json
{ "tool": "business-records.business_upsert",
  "params": {
    "name": "Example Widgets LLC",
    "relationship": "owned",
    "legalForm": "LLC",
    "formationState": "Example State",
    "taxClassification": "partnership",
    "taxClassificationEffective": "2026-01-01",
    "contacts": [{ "role": "cpa", "name": "Pat Example", "email": "pat@example.com" }],
    "taxIdLast4": "0000",
    "statuses": {
      "legal": { "value": "not_yet_formed", "asOf": "2026-09-26", "source": { "kind": "user_reported" } }
    }
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_set_status

`field` is `operating`, `legal` or `tax_account`.

```json
{ "tool": "business-records.business_set_status",
  "params": {
    "businessId": "<uuid>",
    "field": "legal",
    "value": "active",
    "asOf": "2026-02-01",
    "source": { "kind": "document", "documentId": "<uuid of the certificate in business_documents>" }
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_link_issue

Links an issue in this company to a business with a short role slug such as
`case:notice`, `case:formation`, `case:wind-down`, `records`, `filing`.
Linking again with another role changes the role.

```json
{ "tool": "business-records.business_link_issue",
  "params": { "businessId": "<uuid>", "issueId": "<issue uuid>", "role": "case:notice" },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_history

Newest first. `since` (ISO timestamp) answers "what changed since last review";
leave out `businessId` for every business in the company. `limit` defaults to
100, max 500.

```json
{ "tool": "business-records.business_history",
  "params": { "since": "2026-09-01T00:00:00Z" },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_add_document

Upload the file to an issue in this company first, then index it here.
`replacesDocumentId` files a newer version: the old entry drops out of the
current list and can no longer be cited as proof, but stays in history.

Document types: `articles_of_organization`, `certificate_of_organization`,
`operating_agreement`, `bylaws`, `tax_id_letter`, `s_corp_election`,
`s_corp_acceptance`, `state_registration`, `fictitious_name`,
`license_or_permit`, `annual_report`, `insurance_certificate`,
`bank_resolution`, `tax_return`, `filing_confirmation`, `government_notice`,
`extension_confirmation`, `compliance_review`, `professional_advice`, `other`.

```json
{ "tool": "business-records.business_add_document",
  "params": {
    "businessId": "<uuid>",
    "docType": "certificate_of_organization",
    "title": "Certificate of organization",
    "issuingBody": "Example State Department of State",
    "documentDate": "2026-02-01",
    "issueId": "<records issue uuid>",
    "attachmentRef": "certificate.pdf"
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_list_documents

Current documents, newest first. Filters: `businessId`, `docType`,
`includeReplaced`, and `renewalWithinDays` N, which returns documents whose
renewal date is on or before today plus N days, **including ones that have
already lapsed**, soonest first.

```json
{ "tool": "business-records.business_list_documents",
  "params": { "renewalWithinDays": 60 },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_filing_upsert

Adds a filing row (status `upcoming`) or updates one found by `filingId` or by
its key (business, filing, authority, period label). Updatable: `periodStart`,
`periodEnd`, `dueDate`, `preparer` (`cpa`, `barry`, `agent_drafts`, `other`),
`issueId`, `notes`. The key itself cannot change. Changes to an existing
filing are written to history as `business_updated` rows with field
`filing.<name>`.

```json
{ "tool": "business-records.business_filing_upsert",
  "params": {
    "businessId": "<uuid>",
    "filing": "Federal S corporation return (Form 1120-S)",
    "authority": "IRS",
    "periodLabel": "2026",
    "periodStart": "2026-01-01",
    "periodEnd": "2026-12-31",
    "dueDate": "2027-03-15",
    "preparer": "cpa",
    "notes": "Due date per the IRS instructions for Form 1120-S."
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### business_filing_set_status

```json
{ "tool": "business-records.business_filing_set_status",
  "params": {
    "filingId": "<uuid>",
    "status": "filed",
    "proofDocumentId": "<uuid of the e-file confirmation>",
    "asOf": "2027-03-10",
    "nextPeriod": { "periodLabel": "2027", "periodStart": "2027-01-01", "periodEnd": "2027-12-31", "dueDate": "2028-03-15" }
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

Not required:

```json
{ "params": {
    "filingId": "<uuid>",
    "status": "not_required",
    "reason": "Receipts below the city filing threshold for the year",
    "source": { "kind": "official_guidance", "url": "https://example.gov/threshold-rule" }
} }
```

### business_list_filings

Next due first (the extended due date counts once an extension is on file).
Filters: `businessId`, `status` (one or a list), `dueWithinDays` N (open
filings due from today to N days out), `overdueWithoutProof` (open filings
already past due). Both together return filings matching either: the weekly
"needs attention" check.

```json
{ "tool": "business-records.business_list_filings",
  "params": { "dueWithinDays": 30, "overdueWithoutProof": true },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

## API routes (board auth, read-only)

All take `?companyId=` and are refused with 403 `[ECOMPANY_NOT_ALLOWED]` for
companies outside the allow-list.

| Route | Returns |
|---|---|
| `GET /api/plugins/business-records/api/businesses?q=` | `{ businesses }` |
| `GET /api/plugins/business-records/api/businesses/:businessId` | `{ business, history, documents, filings, links, today }` (history newest first, current documents, all filings) |
| `GET /api/plugins/business-records/api/overview` | `{ today, overdueFilings, filingsDueSoon (30 days), documentsRenewingSoon (60 days, including lapsed) }` across every business in the company |

## The page

**Needs attention** at the top (overdue filings in red, filings due in 30
days, renewals in 60 days), a searchable business list, and for the selected
business: statuses with as-of dates and sources, documents (newest first,
renewal within 60 days highlighted, lapsed in red), filings (next due first,
overdue in red, each with its proof document or "No proof on file"), linked
cases (links to the issue), and the history. API errors show in a banner at
the top. The page is read-only; changes go through the agent tools.

## Error codes

| Code | Meaning |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | The calling company is not in Allowed companies (or the list is empty). No data is returned. |
| `[EINVALID_INPUT]` | A field is missing or malformed (bad date, unknown enum value, not a UUID, statuses sent to `business_upsert` for an existing business, and so on). The message names the field. |
| `[ESENSITIVE_ID]` | A field contains something shaped like a full tax id or SSN, or `taxIdLast4` is not exactly four digits. |
| `[EPROOF_REQUIRED]` | A proof-only status or a filed/accepted/extension status was sent without a current document of the same business. |
| `[EREASON_SOURCE_REQUIRED]` | `not_required` without a reason, with a zero-revenue-only reason, or without an acceptable source. |
| `[EISSUE_NOT_FOUND]` | The issue does not exist in the calling company. |
| `[EBUSINESS_NOT_FOUND]` | No business with that id in the calling company (including ids that belong to another company). |
| `[EBUSINESS_NAME_TAKEN]` | Renaming to a name another business in the company already has. |
| `[EFILING_NOT_FOUND]` | No filing with that id in the calling company. |
| `[EDOCUMENT_NOT_FOUND]` | `replacesDocumentId` is not a document of this business, or a document-kind source for a non-proof status points at nothing. |
| `[EDOCUMENT_ALREADY_REPLACED]` | The document to replace has already been replaced. |
| `[ECONFLICT]` | The record changed while the call was running. Read it again and retry. |
| `[EINTERNAL]` | Unexpected failure. The message carries no field values. |

## Known limits

- **Attachment references are not verified.** The host gives plugins no
  attachment API, so `attachmentRef` is stored as given. The plugin checks the
  issue exists in the calling company, but not that the file is on it.
- **The proof rule checks that a document exists, not what it says.** Any
  current document of the same business counts; the plugin does not check the
  document type against the status (for example that `dissolved` cites a
  dissolution certificate). The agent's skill is responsible for citing the
  right one.
- **No transactions.** The host runs each plugin statement on its own. The
  write and its history row are two statements; status and filing updates
  carry the value they read in their WHERE clause, so a concurrent change is
  reported as `[ECONFLICT]` rather than recorded with a wrong old value.
  Duplicate detection for documents without an attachment reference is a read
  before the insert, not a database constraint.
- **Linked company ids are not checked** against the companies table; they are
  validated as UUIDs only.
- **Read-only page.** v1 has no editing in the UI and no delete anywhere.
- **"Today"** is the worker process's local date.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs the unit tests with no database. The Postgres tests in
`src/service.pg.test.ts` run only when `BUSINESS_RECORDS_TEST_DATABASE_URL` is
set; they create a randomly named schema from `migrations/001_init.sql`, run the
real service against it (checking every statement against a copy of the host's
SQL rules), and drop the schema at the end.

```sh
BUSINESS_RECORDS_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db pnpm test
```

The plugin resolves `@paperclipai/plugin-sdk` from the vendored tarball in
`vendor/sdk/` through `pnpm.overrides`.

## Recent changes

- **0.1.0** (2026-09-26) First release. Businesses with three sourced
  statuses, documents with replacement and renewal dates, filings with proof
  and period roll-forward, issue links, append-only history, the Corporate
  Operations page, and 11 agent tools. Proof, reason, sensitive-id, issue and
  company isolation rules enforced in code.
