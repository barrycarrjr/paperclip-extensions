# Deal Desk (deal-desk plugin)

The numbers for buying a business, kept by the Mergers & Acquisitions agent in
HQ: the target's reported earnings period by period and source by source, the
add-back schedule (what the seller says should be added back to earnings, and
whether anyone has proved it), and the Acquisition Analyzer 2.0 spreadsheet's
calculator, run as saved scenarios that are never edited.

The point of the plugin is the few rules it enforces in code rather than
trusting to a prompt:

- An add-back cannot be **accepted** without an evidence document. A seller's
  word leaves it **unverified**, and unverified add-backs never count in
  conservative earnings.
- Conservative SDE and seller-claimed SDE are always worked out together, and a
  **seller-claimed** scenario cannot be saved until a **conservative** one
  exists for the same deal, so the seller's number never appears on its own.
- The exit multiple is an **assumption** and is labelled as one everywhere; a
  note about comparable sales is stored but never changes a number.
- Money is whole cents, and a missing figure is refused, never taken as zero.
- Passwords, logins, usernames and full tax ids are refused outright.
- Everything is scoped to the calling company, and the plugin is meant to be
  switched on for the HQ company only.

SDE (seller's discretionary earnings) is the business's profit plus what it
pays the owner, plus agreed add-backs: the figure a small-business buyer and
lender work from. EBITDA (earnings before interest, taxes, depreciation and
amortization) is a different figure and is kept separate.

The target itself is a business record in the business-records plugin
(relationship `prospect`), and the seller's documents are indexed there. Deal
Desk refers to both by id.

## What it registers

- 9 agent tools (listed below).
- 2 read-only board API routes, so a page can be added later. There is no
  page and no sidebar entry in v1.
- Its own database namespace with five tables: `deals`, `earnings_periods`,
  `earnings_adjustments`, `scenarios`, `deal_history`.

## Setup

Nothing external to wire up: no API keys, no OAuth. About 2 minutes.

1. Install the plugin (Plugin Manager, or `paperclipai plugin install --local <path>`
   after `pnpm build`).
2. In the plugin settings, under **Allowed companies**, tick the **HQ company
   only**. Any other company is refused by every tool and route with
   `[ECOMPANY_NOT_ALLOWED]`. An empty list refuses everyone.
3. Give the Mergers & Acquisitions agent (in HQ) the Deal Desk tools and the
   Business Records tools.

### Smoke test

1. In HQ, ask the agent to open a deal for a prospect business record. It calls
   `deal_upsert` with the record's `businessId`.
2. Ask it to add the 2025 tax return figures and a seller add-back, then to
   accept the add-back "because the seller said so". The call must come back
   `[EEVIDENCE_REQUIRED]`.
3. Ask it to run a seller-claimed scenario first. It must come back
   `[ECONSERVATIVE_FIRST]`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| Allowed companies (`allowedCompanies`) | required | Company ids allowed to use the plugin. Intended: HQ only. `["*"]` allows every company (not recommended). |

## The rules, in plain words

**1. Evidence before acceptance.** Every add-back starts `unverified`.
`deal_adjustment_set_status` to `accepted` needs `evidenceDocumentId`, the id of
the Business Records document that proves it (an invoice, a bank statement, a
payroll record). The id already on the add-back is used when the call leaves it
out. Without one the call is refused with `[EEVIDENCE_REQUIRED]`, and the
database refuses an accepted row without evidence as well. Rejecting needs a
note saying why (`[ENOTE_REQUIRED]`). Changing the amount, kind, description
or evidence of an accepted or rejected add-back puts it back to `unverified`,
so an acceptance never carries over to figures nobody checked.

**2. The earnings basis is always stated.** Every scenario names one:

- `reported`: net income plus owner compensation, no add-backs.
- `conservative`: plus the **accepted** add-backs only.
- `seller_claimed`: plus every add-back that is **not rejected** (accepted and
  unverified).
- `custom`: a cash flow figure you give (`cashFlowCents`), with a `basisNote`
  explaining it (`[ENOTE_REQUIRED]` without one).

`seller_claimed` is refused with `[ECONSERVATIVE_FIRST]` until a `conservative`
scenario exists for the same deal. `reported` and `custom` are always allowed.

**3. Assumed, never market.** The exit multiple is an input called
`assumedExitMultiple`, returned under that name, and written as the "assumed
exit multiple ... an assumption, not a market figure" in every tool result.
`comparablesNote` is stored with the scenario and shown with it, and never
changes a number.

**4. Money is whole cents, and nothing is zero by default.** A missing
required amount is refused with `[EINVALID_INPUT]` naming the field. Only the
fields the spreadsheet itself defaults may be left out, and they take the
spreadsheet's values:

| Input | Default when left out |
|---|---|
| `ffeCents`, `inventoryCents`, `realEstateCents`, `rentToOwnerCents` | 0 |
| `ffeIncluded`, `inventoryIncluded` | true (only while the amount is 0) |
| `realEstateIncluded`, `realEstateAcquired` | false (only while the amounts are 0) |
| `sdeGrowthRate`, `salaryGrowthRate` | 0.05 |
| `maintenanceCapexGrowthRate`, `newCapexGrowthRate`, `cashReserveRate` | 0.03 |
| `indexReturn` | 0.10 |
| `exitYear` | 7 |
| `newProfitsCents`, `newCostsCents` | 0 every year |

Once an FF&E, inventory or real estate amount is given, its included (and for
real estate, acquired) flag is required, because the flag changes what is due
to the seller. The same goes for `realEstateAcquired` when `rentToOwnerCents`
is given. Every scenario result lists the defaults it used.

**5. No credentials, no full tax ids.** Any field whose name contains
password, login or username, at any depth, and any text written like a
credential (`password: ...`, `login=...`, `username: ...`) is refused with
`[ESECRET_NOT_ALLOWED]`: keep credentials in Paperclip's secrets store and
refer to them by name. Prose that only mentions one ("the seller will hand over
the logins at closing") is fine. Anything shaped like a full EIN or SSN is
refused with `[ESENSITIVE_ID]`, with exactly the same patterns as
business-records (`123-45-6789`, `123 45 6789`, `12-3456789`, nine digits
standing alone; phone numbers, ZIP+4 codes, dates and amounts are not refused).
Refusals name the field, never the value.

**6. Company isolation.** Every tool and route checks the allow-list first and
returns `[ECOMPANY_NOT_ALLOWED]` with no data for any other company. Every
query also filters on the calling company, so a deal id from another company
behaves exactly like one that does not exist (`[EDEAL_NOT_FOUND]`).

**Other keys.** One deal per business per company; one earnings period per
deal, label and source (a tax return and a P&L for the same year sit side by
side); one add-back per deal, period and description, ignoring letter case
(`[EDUPLICATE_ADJUSTMENT]`, checked by the service first and by a unique index
in the database). Scenarios are insert-only: the plugin has no statement that
updates or deletes one. History is append-only.

## The calculator

`src/calculator.ts` reproduces the Acquisition Analyzer 2.0 spreadsheet
(Summary, Loan and Projections sheets) formula for formula. Its test feeds in
the spreadsheet's own sample deal and compares every Summary, Loan and
Projections figure with Excel's cached value, to the cent for money and to
0.000001 for rates.

**Inputs** are the spreadsheet's input cells: closing date, asking price,
revenue, cash flow (from the earnings basis), FF&E, inventory and real estate
with their flags, rent to the owner's real estate entity, buyer's minimum
salary, working capital, maintenance and new capex, equity, seller note and
closing cost percentages, loan term and rate, growth, capex growth and reserve
rates, new profits and new costs by year, exit year, assumed exit multiple,
index return, and (optionally) the buyer's liquid funds.

**Outputs** (all saved with the scenario):

- Multiples: price to cash flow, price to revenue, assumed exit multiple.
- Sources and uses: equity (a share of total uses), seller note (a share of
  the total due to the seller), term loan (whatever is left, never below 0),
  line of credit (the working capital), and the uses they pay for.
- Lender analysis, yearly and monthly: lendable cash flow (cash flow minus the
  buyer's salary minus capex, plus rent to the owner only when the real estate
  is acquired), debt service (Excel's PMT on term loan plus line of credit),
  net cash flow and DSCR (debt service coverage ratio: lendable cash flow over
  debt service; lenders want at least 1.25).
- The loan amortization schedule and the balance at each year end.
- The ten-year projection: operating, investing and financing cash flows, the
  exit sale and loan payoff in the exit year only, cash flow to equity,
  valuation (assumed multiple times total operating cash flow before the
  owner's salary), loan balance, net worth, equity IRR by year (Excel's XIRR,
  days over 365, Newton's method), the same equity in an index fund, and net
  worth against that index.
- The four formula checks: sources equal uses, funding is 100 percent, buyer
  has enough liquid funds (not checked when funds are not given), DSCR at
  least 1.25 (not checked when there is no debt).
- Notes explaining any spreadsheet convention that affects that scenario.

**Spreadsheet quirks reproduced on purpose**, so the numbers match the sheet
Barry already uses:

- **Debt payments continue past payoff.** Projections row 23 repeats the
  yearly debt service in every year to year 10 whatever the loan term, so for
  a loan shorter than ten years, cash flow to equity after payoff is understated
  by the debt service. The loan balance itself is 0 after payoff.
- **The seller note has no payments.** Only the term loan and line of credit
  are in debt service; the sheet treats the seller note as on standby.
- **Years after the exit keep going.** Operating cash flows and debt payments
  continue after the exit year as if the business were kept, and the IRR for
  those years includes them. Use the IRR at the exit year.
- **Growth starts in year 2 for cash flow and salary, year 1 for capex.** Year
  1 cash flow and salary are the base figures; capex lines are already grown
  once in year 1.
- **Cash reserves are a share of total operating cash flow**, not of cash flow
  after capex.
- **Real estate included in the asking price adds nothing to uses even when
  acquired**, but acquiring it still adds the rent back to lendable cash flow
  (the sheet's IFS order).
- **The funding percentage uses the equity input**, not equity over total
  sources, so when sources exceed uses both the sources-equal-uses and the
  100 percent checks fail.

**Where the plugin differs from the sheet**, deliberately:

- The IRR of the acquisition column is `null`, where the sheet shows 0 (XIRR
  of a single cash flow is an error that the sheet hides as 0). Any XIRR with
  no answer is `null`.
- After payoff the sheet's loan balance lookup finds no row and returns an
  empty cell; the plugin uses 0.
- The sheet's year 1 loan payoff formula has a typo (`HLOOKUP(-$D$27, ...)`)
  that silently drops the sale when the exit year is 1. The plugin computes
  year 1 exits like every other year.
- Loan terms are whole years from 1 to 30 (the sheet's schedule has 360 rows).
- The liquid funds check needs `buyerFundsAvailableCents`; without it the
  check is reported as not checked rather than failed.

## Earnings normalization

For each earnings period `deal_normalize` (and every scenario on a period
basis) works out:

- **Reported SDE**: reported net income plus owner compensation.
- **Conservative SDE**: plus accepted add-backs only.
- **Seller-claimed SDE**: plus every add-back not rejected. The difference
  between the two is what rests on unverified claims.
- **Owner replacement cost** (add-backs of kind `replacement_cost`, the yearly
  cost of hiring someone to do the owner's job): never part of SDE, listed on
  its own line and deducted to give **SDE after owner replacement** for both
  figures. A replacement cost that is not rejected is deducted from both,
  because a deduction can only lower a figure and it is the buyer's own
  estimate. It must be a positive amount.
- **EBITDA**: reported net income plus interest plus depreciation, without
  owner compensation, kept separate. Taxes are not added back (there is no
  tax field). Not computed when interest or depreciation is missing.

Every line is itemised, with unverified add-backs marked. Interest and
depreciation are not added to SDE automatically; record them as add-backs
(kind `non_cash`, with evidence) if they should count.

## Tools

Every example below is a call as the host sends it. `runContext.companyId` must
be in **Allowed companies**. Dates are `YYYY-MM-DD`. Money is whole cents
(`100000000` is $1,000,000.00), and in tool text it is written as dollars with
commas. Every tool returns a short readable `content` and structured `data`.

### deal_upsert

Create the deal for a target business, or update one. Found by `dealId`, or by
`businessId` (the target's id in Business Records; one deal per business per
company). Creating needs `businessId` and `name`. Deal Desk cannot see
Business Records, so it stores `businessId` as given: pass the id
`business_list` returned. Only the fields sent change; a repeat call changes
nothing and writes no history. `businessId` of an existing deal cannot change.

```http
POST /api/plugins/tools/execute
{
  "tool": "deal-desk.deal_upsert",
  "params": {
    "businessId": "<business-records id>",
    "name": "Acquired Company LLC",
    "stage": "screen",
    "structure": "asset",
    "askingPriceCents": 100000000,
    "acquiringEntity": "New LLC to be formed"
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" }
}
```

### deal_list

Deals in this company, most recently worked on first. Filter by `stage` (one
or a list).

```json
{ "tool": "deal-desk.deal_list",
  "params": { "stage": ["screen", "diligence"] },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### deal_get

One deal: the record, every period, every add-back with status and evidence,
a summary of every scenario, and the latest 50 history rows (newest first).

```json
{ "tool": "deal-desk.deal_get",
  "params": { "dealId": "<uuid>" },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### deal_period_upsert

One period's reported figures from one source (`tax_return`, `pnl`, `bank`,
`seller_stated`, `other`), found by deal, `periodLabel` and `sourceKind`.
Adding needs `periodStart`, `periodEnd`, `revenueCents`, `netIncomeCents`,
`ownerCompCents`. `depreciationCents` and `interestCents` feed EBITDA only.
`documentId` is the Business Records document the figures came from.

```json
{ "tool": "deal-desk.deal_period_upsert",
  "params": {
    "dealId": "<uuid>",
    "periodLabel": "2025",
    "sourceKind": "tax_return",
    "periodStart": "2025-01-01",
    "periodEnd": "2025-12-31",
    "revenueCents": 150000000,
    "netIncomeCents": 25000000,
    "ownerCompCents": 10000000,
    "depreciationCents": 1800000,
    "interestCents": 400000,
    "documentId": "<business-records document id>"
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### deal_adjustment_upsert

Add a line to a period's add-back schedule, or update one by `adjustmentId`.
Adding needs `dealId`, `periodLabel` (a period already on the deal, else
`[EPERIOD_NOT_FOUND]`), `description`, `amountCents` (negative for a
deduction), `kind` (`owner_comp`, `owner_perk`, `one_time`, `non_cash`,
`rent_to_owner`, `replacement_cost`, `other`) and `claimedBy` (`seller`,
`agent`, `owner`, `cpa`, `other`). New add-backs are always `unverified`;
status is never set here. The period of an existing add-back cannot change.

```json
{ "tool": "deal-desk.deal_adjustment_upsert",
  "params": {
    "dealId": "<uuid>",
    "periodLabel": "2025",
    "description": "Owner's vehicle lease",
    "amountCents": 1200000,
    "kind": "owner_perk",
    "claimedBy": "seller",
    "note": "Listed on the seller's add-back sheet"
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### deal_adjustment_set_status

Move an add-back to `accepted`, `rejected` or `unverified`. `accepted` needs
evidence (`[EEVIDENCE_REQUIRED]`); `rejected` needs a `note`
(`[ENOTE_REQUIRED]`). Setting the same status, evidence and note again changes
nothing.

```json
{ "tool": "deal-desk.deal_adjustment_set_status",
  "params": {
    "adjustmentId": "<uuid>",
    "status": "accepted",
    "evidenceDocumentId": "<business-records document id of the lease>",
    "note": "Lease is in the owner's name, paid by the business"
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### deal_normalize

Both SDE figures for every period (or one `periodLabel` / `sourceKind`), with
every line, unverified ones marked, owner replacement cost and EBITDA on their
own lines.

```json
{ "tool": "deal-desk.deal_normalize",
  "params": { "dealId": "<uuid>", "periodLabel": "2025" },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### deal_scenario_run

Run the calculator and save the scenario. `earningsBasis` picks the cash flow
from `periodLabel` (plus `sourceKind` when the period has several sources);
`custom` takes `cashFlowCents` and `basisNote` instead. `askingPriceCents`
defaults to the deal's asking price and `annualRevenueCents` to the period's
revenue. `idempotencyKey`, when sent again for the same deal, returns the
scenario already saved. The result has every output in `data` and, in
`content`, the key lines plus a year-by-year table.

```json
{ "tool": "deal-desk.deal_scenario_run",
  "params": {
    "dealId": "<uuid>",
    "name": "Base case, conservative",
    "earningsBasis": "conservative",
    "periodLabel": "2025",
    "sourceKind": "tax_return",
    "comparablesNote": "No comparable sales gathered yet",
    "idempotencyKey": "base-case-1",
    "inputs": {
      "closingDate": "2026-12-31",
      "ffeCents": 10000000, "ffeIncluded": true,
      "inventoryCents": 5000000, "inventoryIncluded": true,
      "buyerSalaryCents": 7500000,
      "workingCapitalCents": 10000000,
      "maintenanceCapexCents": 2500000,
      "newCapexCents": 500000,
      "equityPercent": 0.1,
      "sellerNotePercent": 0.1,
      "closingCostPercent": 0.05,
      "loanTermYears": 10,
      "interestRate": 0.1,
      "assumedExitMultiple": 2.5,
      "buyerFundsAvailableCents": 35000000
    }
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

A custom scenario:

```json
{ "tool": "deal-desk.deal_scenario_run",
  "params": {
    "dealId": "<uuid>",
    "name": "Two-year average",
    "earningsBasis": "custom",
    "cashFlowCents": 33000000,
    "basisNote": "Average of 2024 and 2025 conservative SDE",
    "inputs": { "annualRevenueCents": 150000000, "closingDate": "2026-12-31", "...": "the other required inputs as above" }
  },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

### deal_scenario_compare

Two to ten saved scenarios side by side (they may come from different deals in
the company): basis, cash flow used, asking price, multiples, assumed exit
multiple, equity, debt service, net cash flow, DSCR, IRR at the exit year, net
worth at exit and the checks.

```json
{ "tool": "deal-desk.deal_scenario_compare",
  "params": { "scenarioIds": ["<uuid>", "<uuid>"] },
  "runContext": { "agentId": "...", "runId": "...", "companyId": "<HQ company id>" } }
```

## API routes (board auth, read-only)

Both take `?companyId=` and are refused with 403 `[ECOMPANY_NOT_ALLOWED]` for
companies outside the allow-list.

| Route | Returns |
|---|---|
| `GET /api/plugins/deal-desk/api/deals?stage=` | `{ deals }` |
| `GET /api/plugins/deal-desk/api/deals/:dealId` | `{ deal, periods, adjustments, scenarios (summaries), history (latest 200, newest first) }` |

## Error codes

| Code | Meaning |
|---|---|
| `[ECOMPANY_NOT_ALLOWED]` | The calling company is not in Allowed companies (or the list is empty). No data is returned. |
| `[EINVALID_INPUT]` | A field is missing or malformed (money not in whole cents, a required input left out, unknown enum value, not a UUID, an included flag missing, and so on). The message names the field. |
| `[EEVIDENCE_REQUIRED]` | Accepting an add-back without an evidence document id. |
| `[ENOTE_REQUIRED]` | Rejecting an add-back without a note, or a custom scenario without `basisNote`. |
| `[ECONSERVATIVE_FIRST]` | A seller-claimed scenario before any conservative scenario exists for the deal. |
| `[EDUPLICATE_ADJUSTMENT]` | An add-back with that description (any letter case) already exists for the period. The message gives its id. |
| `[ESECRET_NOT_ALLOWED]` | A field named for, or text written like, a password, login or username. |
| `[ESENSITIVE_ID]` | A field contains something shaped like a full tax id or SSN. |
| `[EDEAL_NOT_FOUND]` | No deal with that id in the calling company (including ids that belong to another company). |
| `[EPERIOD_NOT_FOUND]` | No earnings period with that label (and source) on the deal. |
| `[EADJUSTMENT_NOT_FOUND]` | No add-back with that id in the calling company. |
| `[ESCENARIO_NOT_FOUND]` | One of the scenario ids is not a scenario in the calling company. |
| `[ECONFLICT]` | The record changed while the call was running. Read it again and retry. |
| `[EINTERNAL]` | Unexpected failure. The message carries no field values. |

## Known limits

- **Business Records ids are not checked.** Plugins cannot read each other's
  tables, so `businessId`, `documentId` and `evidenceDocumentId` are checked to
  be UUIDs, not to exist. The agent must pass real ids from Business Records;
  the evidence rule proves an id was cited, not what the document says.
- **An unverified deduction is left out of conservative SDE.** Conservative SDE
  counts accepted add-backs only, in either direction. Replacement costs are
  the exception (see above). Accept a deduction, with evidence, to count it.
- **No transactions.** The host runs each plugin statement on its own. A write
  and its history row are two statements; add-back status updates carry the
  status they read in their WHERE clause, so a concurrent change is reported
  as `[ECONFLICT]` rather than recorded wrongly.
- **One currency per deal, no conversion.** Amounts are stored in the deal's
  currency as given.
- **No delete anywhere, no page.** v1 has neither.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs the unit tests with no database, including the calculator
parity test against the spreadsheet. The Postgres tests in
`src/service.pg.test.ts` run only when `DEAL_DESK_TEST_DATABASE_URL` is set;
they create a randomly named schema from `migrations/001_init.sql`, run the
real service against it (checking every statement against a copy of the
host's SQL rules), and drop the schema at the end.

```sh
DEAL_DESK_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/db pnpm test
```

The plugin resolves `@paperclipai/plugin-sdk` from the vendored tarball in
`vendor/sdk/` through `pnpm.overrides`.

## Recent changes

- **0.1.1** (2026-09-26) The claimedBy value for the buyer is now `owner`
  instead of a personal name. Migration `002_owner_claimed_by.sql` converts
  any stored add-backs and swaps the check, so existing installs upgrade in
  place.

- **0.1.0** (2026-09-26) First release. Deals, earnings periods by source, the
  add-back schedule with evidence, conservative and seller-claimed SDE with
  EBITDA and owner replacement cost kept apart, the Acquisition Analyzer 2.0
  calculator (matched to the spreadsheet's sample deal to the cent) saved as
  insert-only scenarios, scenario comparison, append-only history, 9 agent
  tools and 2 read-only board routes. Evidence, conservative-first, assumed
  multiple, required money, credential, tax id and company isolation rules
  enforced in code.
