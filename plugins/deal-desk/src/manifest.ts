import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

// This file is transpiled on its own (not bundled), so it must not import
// local modules. The enum lists and the calculator input keys below are
// duplicated from src/domain.ts and src/dealInputs.ts; tools.test.ts fails if
// they ever drift apart.

const PLUGIN_ID = "deal-desk";
const PLUGIN_VERSION = "0.1.0";

const DEAL_STAGES = ["screen", "diligence", "offer", "closing", "closed", "passed"];
const DEAL_STRUCTURES = ["asset", "stock", "undecided"];
const PERIOD_SOURCE_KINDS = ["tax_return", "pnl", "bank", "seller_stated", "other"];
const ADJUSTMENT_KINDS = ["owner_comp", "owner_perk", "one_time", "non_cash", "rent_to_owner", "replacement_cost", "other"];
const CLAIMED_BY = ["seller", "agent", "barry", "cpa", "other"];
const ADJUSTMENT_STATUSES = ["unverified", "accepted", "rejected"];
const EARNINGS_BASES = ["reported", "conservative", "seller_claimed", "custom"];

const UUID = { type: "string", description: "UUID." };
const DATE = { type: "string", description: "Date only, YYYY-MM-DD." };
const CENTS = (description: string) => ({ type: "integer", description: `Whole cents. ${description}` });
const RATE = (description: string) => ({ type: "number", description: `Decimal rate, 0.1 means 10 percent. ${description}` });

const MONEY_RULE_TEXT =
  "All money is whole cents (100000000 is $1,000,000.00). A missing required amount is refused with [EINVALID_INPUT] naming the field; nothing is ever defaulted to zero except the few fields the spreadsheet itself defaults.";

const SECRET_RULE_TEXT =
  "Never send passwords, logins, usernames or full tax ids in any field: a field named for a credential, or text written like \"password: ...\", is refused with [ESECRET_NOT_ALLOWED] (use Paperclip's secrets store), and anything shaped like a full EIN or SSN with [ESENSITIVE_ID].";

const INPUTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description:
    "The Acquisition Analyzer's inputs. Required: closingDate, buyerSalaryCents, workingCapitalCents, maintenanceCapexCents, newCapexCents, equityPercent, sellerNotePercent, closingCostPercent, loanTermYears, interestRate, assumedExitMultiple. askingPriceCents defaults to the deal's asking price and annualRevenueCents to the period's revenue. The cash flow is NOT an input here: it comes from earningsBasis. Spreadsheet defaults when left out: ffeCents, inventoryCents, realEstateCents, rentToOwnerCents 0; sdeGrowthRate 0.05, salaryGrowthRate 0.05, maintenanceCapexGrowthRate 0.03, newCapexGrowthRate 0.03, cashReserveRate 0.03, indexReturn 0.10, exitYear 7, newProfitsCents and newCostsCents 0.",
  properties: {
    closingDate: { ...DATE, description: "Target closing date, YYYY-MM-DD. The first date of the IRR." },
    askingPriceCents: CENTS("Asking or offer price. Defaults to the deal's asking price."),
    annualRevenueCents: CENTS("Annual revenue. Defaults to the chosen period's revenue."),
    ffeCents: CENTS("Furniture, fixtures and equipment. Default 0."),
    ffeIncluded: { type: "boolean", description: "Is FF&E included in the asking price? Required when ffeCents is above 0." },
    inventoryCents: CENTS("Inventory. Default 0."),
    inventoryIncluded: { type: "boolean", description: "Is inventory included in the asking price? Required when inventoryCents is above 0." },
    realEstateCents: CENTS("Real estate. Default 0."),
    realEstateIncluded: { type: "boolean", description: "Is the real estate included in the asking price? Required when realEstateCents is above 0." },
    realEstateAcquired: {
      type: "boolean",
      description: "Is the buyer acquiring the real estate? Required when realEstateCents or rentToOwnerCents is above 0. Rent to the owner is added back to lendable cash flow only when true.",
    },
    rentToOwnerCents: CENTS("Yearly rent the business pays to the owner's real estate entity. Default 0."),
    buyerSalaryCents: CENTS("Buyer's minimum yearly salary. Required."),
    workingCapitalCents: CENTS("Working capital requirement (funded by the line of credit). Required."),
    maintenanceCapexCents: CENTS("Yearly capex for maintenance and replacements. Required."),
    newCapexCents: CENTS("Yearly capex for new investments. Required."),
    equityPercent: RATE("Buyer equity as a share of total uses. Required."),
    sellerNotePercent: RATE("Seller note as a share of the total due to the seller. Required."),
    closingCostPercent: RATE("Loan closing costs as a share of the total due to the seller. Required."),
    loanTermYears: { type: "integer", description: "Loan term in whole years, 1 to 30. Required." },
    interestRate: RATE("Yearly loan interest rate. Required."),
    sdeGrowthRate: RATE("Yearly growth of the cash flow from year 2. Default 0.05."),
    salaryGrowthRate: RATE("Yearly growth of the buyer's salary from year 2. Default 0.05."),
    maintenanceCapexGrowthRate: RATE("Growth of maintenance capex, applied from year 1. Default 0.03."),
    newCapexGrowthRate: RATE("Growth of new-investment capex, applied from year 1. Default 0.03."),
    cashReserveRate: RATE("Cash reserve as a share of total operating cash flow. Default 0.03."),
    newProfitsCents: {
      description: "New profits: one whole-cents amount for every year, or a list of 10 (years 1 to 10). Default 0.",
      anyOf: [{ type: "integer" }, { type: "array", items: { type: "integer" }, minItems: 10, maxItems: 10 }],
    },
    newCostsCents: {
      description: "New costs, zero or NEGATIVE as in the spreadsheet: one amount for every year, or a list of 10. Default 0.",
      anyOf: [{ type: "integer" }, { type: "array", items: { type: "integer" }, minItems: 10, maxItems: 10 }],
    },
    exitYear: { type: "integer", description: "Year of the assumed sale, 1 to 10. Default 7." },
    assumedExitMultiple: {
      type: "number",
      description: "Required. The valuation multiple you ASSUME at exit, applied to cash flow before owner salary. An assumption, never a market figure; the spreadsheet starts from the purchase price divided by the cash flow.",
    },
    indexReturn: RATE("Yearly return of the index alternative (equity invested in an index fund instead). Default 0.10."),
    buyerFundsAvailableCents: CENTS("Buyer's liquid funds available for equity. Optional: without it the liquid funds check is reported as not checked."),
  },
};

const SETUP_INSTRUCTIONS = `# Setup, Deal Desk

Nothing external to wire up: no API keys, no OAuth. Reckon on **about 2 minutes**.

## 1. Allow the HQ company only

In **Configuration, Allowed companies**, tick the HQ company and nothing else.

Deal Desk holds what the portfolio might pay for a business and what that
business earns. Only the HQ company (where the Mergers & Acquisitions agent
lives) should be able to read or change it. Every other company gets
\`[ECOMPANY_NOT_ALLOWED]\` from every tool and route.

Portfolio-wide (\`['*']\`) works technically but is not recommended.

## 2. Enable the tools for the agent

Give the Mergers & Acquisitions agent (in HQ) the Deal Desk tools and the
Business Records tools. Deal Desk refers to the business record and its
documents by id; it enforces its own rules and does not need the agent to be
trusted to follow them.

---

## Smoke test

1. In HQ, ask the agent to create a deal for a prospect business record (it
   calls \`deal_upsert\` with the record's businessId).
2. Ask it to add a period and a seller add-back, then to accept the add-back
   without a document. The call must be refused with \`[EEVIDENCE_REQUIRED]\`.
3. Ask it to run a seller_claimed scenario first. It must be refused with
   \`[ECONSERVATIVE_FIRST]\`.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Deal Desk",
  description:
    "The numbers for buying a business: earnings periods side by side by source, an add-back schedule where nothing counts as proven without an evidence document, conservative and seller-claimed SDE always shown together, and the Acquisition Analyzer calculator (sources and uses, debt service, DSCR, ten-year projection, equity IRR) saved as scenarios that are never edited. Intended for the HQ company only.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation"],
  setupInstructions: SETUP_INSTRUCTIONS,
  capabilities: [
    "instance.settings.register",
    "api.routes.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  database: {
    namespaceSlug: "deal_desk",
    migrationsDir: "migrations",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["allowedCompanies"],
    properties: {
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description:
          "Which companies can read and change deals. Tick the HQ company only: deals hold what the portfolio might pay and what the target earns. Every other company is refused by every tool and route. Empty = unusable (fail-safe deny).",
        items: { type: "string", format: "company-id" },
      },
    },
    required: ["allowedCompanies"],
  },
  apiRoutes: [
    {
      routeKey: "deals.list",
      method: "GET",
      path: "/deals",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "deals.get",
      method: "GET",
      path: "/deals/:dealId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  tools: [
    {
      name: "deal_upsert",
      displayName: "Create or update a deal",
      description: `Create the deal for a target business, or update one. Find it by dealId, or by businessId (the business-records id of the target; one deal per business per company). Creating needs businessId and name. Deal Desk cannot see Business Records, so it stores businessId as given: pass the id business_list returned, never a made-up one. stage: screen, diligence, offer, closing, closed, passed. Only the fields you send change; a repeat call changes nothing. Stage changes are written to history. ${MONEY_RULE_TEXT} ${SECRET_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dealId: { ...UUID, description: "The deal id, to update a known deal." },
          businessId: { ...UUID, description: "The target's id in Business Records. Required to create." },
          name: { type: "string", description: "The target's name, for display. Required to create." },
          stage: { type: "string", enum: DEAL_STAGES },
          structure: { type: "string", enum: DEAL_STRUCTURES },
          acquiringEntity: { type: "string", description: "Note on which entity would buy (for example a new LLC to be formed)." },
          askingPriceCents: CENTS("The seller's asking price."),
          currency: { type: "string", description: "Three-letter currency code. Default USD." },
          notes: { type: "string" },
        },
      },
    },
    {
      name: "deal_list",
      displayName: "List deals",
      description: "List the deals in this company, most recently worked on first. Filter by stage (one or a list). Use this to find a deal id.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          stage: {
            anyOf: [
              { type: "string", enum: DEAL_STAGES },
              { type: "array", items: { type: "string", enum: DEAL_STAGES } },
            ],
          },
        },
      },
    },
    {
      name: "deal_get",
      displayName: "Get a deal",
      description:
        "Read one deal: the record, every earnings period (by source), every add-back with its status and evidence, a summary of every saved scenario (basis, cash flow, DSCR, IRR at exit), and the latest history.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: { dealId: UUID },
        required: ["dealId"],
      },
    },
    {
      name: "deal_period_upsert",
      displayName: "Add or update an earnings period",
      description: `Record one period's reported figures from one source: tax_return, pnl, bank, seller_stated or other. One row per deal, periodLabel and sourceKind, so a tax return and a P&L for the same year sit side by side and their difference is visible; calling again with the same three updates that row. Adding needs periodStart, periodEnd, revenueCents, netIncomeCents and ownerCompCents. Copy figures from the document exactly and pass documentId (the Business Records document id they came from); never estimate a figure. interestCents and depreciationCents feed EBITDA only; they are not added to SDE unless you record them as add-backs. ${MONEY_RULE_TEXT} ${SECRET_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dealId: UUID,
          periodLabel: { type: "string", description: "For example 2025, or TTM 2026-06." },
          sourceKind: { type: "string", enum: PERIOD_SOURCE_KINDS },
          periodStart: DATE,
          periodEnd: DATE,
          revenueCents: CENTS("Revenue for the period."),
          netIncomeCents: CENTS("Reported net income (negative for a loss)."),
          ownerCompCents: CENTS("Owner compensation paid in the period."),
          depreciationCents: CENTS("Depreciation and amortization, for EBITDA."),
          interestCents: CENTS("Interest expense, for EBITDA."),
          documentId: { ...UUID, description: "The Business Records document the figures came from." },
          notes: { type: "string" },
        },
        required: ["dealId", "periodLabel", "sourceKind"],
      },
    },
    {
      name: "deal_adjustment_upsert",
      displayName: "Add or update an add-back",
      description: `Add one line to a period's add-back schedule, or update one by adjustmentId. Adding needs dealId, periodLabel (a period already on the deal), description, amountCents (negative for a deduction), kind (owner_comp, owner_perk, one_time, non_cash, rent_to_owner, replacement_cost, other) and claimedBy (seller, agent, barry, cpa, other). New add-backs are always unverified: they count in seller-claimed SDE, never in conservative SDE, until accepted with deal_adjustment_set_status. The same description twice for one period is refused with [EDUPLICATE_ADJUSTMENT], so nothing is counted twice. replacement_cost is the yearly cost of replacing the owner: a positive amount that is deducted, never added. Changing the amount, kind, description or evidence of an accepted or rejected add-back puts it back to unverified. ${MONEY_RULE_TEXT} ${SECRET_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          adjustmentId: { ...UUID, description: "To update a known add-back." },
          dealId: UUID,
          periodLabel: { type: "string" },
          description: { type: "string", description: "What the add-back is, for example \"Owner's vehicle lease\"." },
          amountCents: CENTS("Positive adds to earnings, negative deducts."),
          kind: { type: "string", enum: ADJUSTMENT_KINDS },
          claimedBy: { type: "string", enum: CLAIMED_BY },
          evidenceDocumentId: { ...UUID, description: "The Business Records document that supports it, when there is one." },
          note: { type: "string" },
        },
      },
    },
    {
      name: "deal_adjustment_set_status",
      displayName: "Accept or reject an add-back",
      description:
        "Move an add-back to accepted, rejected or unverified. Rules, enforced in code: accepted needs evidenceDocumentId (the Business Records document that proves it; the one already on the add-back is used when you leave it out), else [EEVIDENCE_REQUIRED]. A seller saying so is never evidence. rejected needs a note saying why, else [ENOTE_REQUIRED]. Deal Desk cannot see Business Records, so it checks that the evidence id is a UUID, not what the document says: cite the right document. Writes history.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          adjustmentId: UUID,
          status: { type: "string", enum: ADJUSTMENT_STATUSES },
          evidenceDocumentId: UUID,
          note: { type: "string", description: "Why. Required when rejecting." },
        },
        required: ["adjustmentId", "status"],
      },
    },
    {
      name: "deal_normalize",
      displayName: "Normalize earnings",
      description:
        "Show a deal's normalized earnings for every period (or one periodLabel / sourceKind): conservative SDE (reported net income plus owner comp plus ACCEPTED add-backs) and seller-claimed SDE (plus every add-back not rejected) side by side, every line itemised with unverified ones marked, owner replacement cost on its own line with SDE after owner replacement, and EBITDA (net income plus interest plus depreciation, no owner comp) kept separate. Always quote both SDE figures together.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dealId: UUID,
          periodLabel: { type: "string" },
          sourceKind: { type: "string", enum: PERIOD_SOURCE_KINDS },
        },
        required: ["dealId"],
      },
    },
    {
      name: "deal_scenario_run",
      displayName: "Run and save a deal scenario",
      description: `Run the Acquisition Analyzer calculator and save the result as a scenario that is never edited (cite it by id). earningsBasis is required: reported (net income plus owner comp), conservative (accepted add-backs only), seller_claimed (every add-back not rejected) or custom. The first three take the cash flow from periodLabel (plus sourceKind when that period has several sources). Rules, enforced in code: seller_claimed is refused with [ECONSERVATIVE_FIRST] until a conservative scenario exists for the deal; custom needs cashFlowCents and a basisNote explaining the figure. assumedExitMultiple is an ASSUMPTION and is reported as the assumed exit multiple, never as a market figure; comparablesNote is stored with the scenario and never changes a number. Returns every output (sources and uses, lender analysis, DSCR, loan schedule, ten-year projection with equity IRR, index comparison, the four formula checks) plus a readable table. ${MONEY_RULE_TEXT} ${SECRET_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          dealId: UUID,
          name: { type: "string", description: "Short name, for example \"Base case, conservative\"." },
          earningsBasis: { type: "string", enum: EARNINGS_BASES },
          periodLabel: { type: "string", description: "The earnings period whose SDE is used. Required unless earningsBasis is custom." },
          sourceKind: { type: "string", enum: PERIOD_SOURCE_KINDS },
          cashFlowCents: CENTS("Only with earningsBasis custom: the yearly cash flow figure."),
          basisNote: { type: "string", description: "Required with custom: where the cash flow figure comes from." },
          comparablesNote: { type: "string", description: "Comparable sales or multiples you looked at. Stored only; never changes the numbers." },
          inputs: INPUTS_SCHEMA,
          idempotencyKey: { type: "string", description: "Optional. Sending the same key again for this deal returns the scenario already saved instead of saving a second one." },
        },
        required: ["dealId", "name", "earningsBasis", "inputs"],
      },
    },
    {
      name: "deal_scenario_compare",
      displayName: "Compare deal scenarios",
      description:
        "Put 2 to 10 saved scenarios side by side: earnings basis, cash flow used, asking price, price multiples, assumed exit multiple, buyer equity, debt service, net cash flow, DSCR, equity IRR at the exit year, net worth at exit and the checks. Scenarios can come from different deals in this company.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          scenarioIds: { type: "array", items: UUID, minItems: 2, maxItems: 10 },
        },
        required: ["scenarioIds"],
      },
    },
  ],
};

export default manifest;
