import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

// This file is transpiled on its own (not bundled), so it must not import
// local modules. The enum lists below are duplicated from src/domain.ts;
// manifest.test.ts fails if the two ever drift apart.

const PLUGIN_ID = "business-records";
const PLUGIN_VERSION = "0.2.0";

const RELATIONSHIPS = ["owned", "prospect", "former", "other"];
const STATUS_FIELDS = ["operating", "legal", "tax_account"];
const STATUS_SOURCE_KINDS = ["document", "external_confirmation", "user_reported", "agent_inference"];
const DOC_TYPES = [
  "articles_of_organization",
  "certificate_of_organization",
  "operating_agreement",
  "bylaws",
  "tax_id_letter",
  "s_corp_election",
  "s_corp_acceptance",
  "state_registration",
  "fictitious_name",
  "license_or_permit",
  "annual_report",
  "insurance_certificate",
  "bank_resolution",
  "tax_return",
  "filing_confirmation",
  "government_notice",
  "extension_confirmation",
  "compliance_review",
  "professional_advice",
  "other",
];
const PREPARERS = ["cpa", "owner", "agent_drafts", "other"];
const FILING_STATUSES = ["upcoming", "in_preparation", "extension_filed", "filed", "accepted", "not_required"];
const NOT_REQUIRED_SOURCE_KINDS = ["document", "professional_advice", "official_guidance"];

const DATE = { type: "string", description: "Date only, YYYY-MM-DD." };
const UUID = { type: "string", description: "UUID." };
const IDEMPOTENCY_KEY = {
  type: "string",
  description:
    "Optional. Safe-retry key. These tools are already idempotent by their natural keys (repeating a call changes nothing), and business_add_document also returns the existing row when the same key is sent again.",
};

const STATUS_SOURCE = {
  type: "object",
  additionalProperties: false,
  description:
    "Where the status comes from. kind document or external_confirmation must carry documentId (a current entry in business_documents for this business). user_reported and agent_inference cannot set proof-only values.",
  properties: {
    kind: { type: "string", enum: STATUS_SOURCE_KINDS },
    documentId: UUID,
    url: { type: "string" },
    note: { type: "string", description: "Short note. Never a full tax id." },
  },
  required: ["kind"],
};

const STATUS_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: "string" },
    asOf: DATE,
    source: STATUS_SOURCE,
  },
  required: ["value", "asOf", "source"],
};

const PROOF_RULE_TEXT =
  "Proof rule, enforced in code: legal status active or dissolved, and tax account status open, final_return_filed or account_closed, can ONLY be set with source {kind: \"document\" or \"external_confirmation\", documentId} pointing at a current document of the same business (add it first with business_add_document). A person saying so, or your own reasoning, can never set these; the call is refused with [EPROOF_REQUIRED]. Ceased is not dissolved. Approved is not filed.";

const SENSITIVE_RULE_TEXT =
  "Never send a full tax id or social security number in any field; only taxIdLast4 (exactly four digits). Text shaped like a full EIN or SSN is refused with [ESENSITIVE_ID].";

const SETUP_INSTRUCTIONS = `# Setup, Corporate Operations

Nothing external to wire up: no API keys, no OAuth. Reckon on **about 2 minutes**.

## 1. Allow the HQ company only

In **Configuration, Allowed companies**, tick the HQ company and nothing else.

Business records hold tax id last-four digits, legal and tax status, government
notices and filing history for every business in the portfolio. Only the HQ
company (where the Corporate Operations agent lives) should be able to read or
change them. Every other company gets \`[ECOMPANY_NOT_ALLOWED]\` from every tool
and route, and does not see the sidebar entry.

Portfolio-wide (\`['*']\`) works technically but is not recommended.

## 2. (Optional) Hide the sidebar entry

**Show in sidebar** is on by default. Turn it off to keep the page reachable at
\`/:companyPrefix/corporate-operations\` with no nav link.

## 3. Enable the tools for the agent

Give the Corporate Operations agent (in HQ) the Business Records tools. The
tools enforce the proof rules themselves; the agent does not need to be
trusted to follow them.

---

## Smoke test

1. In HQ, ask the agent to create a business named "Example Widgets LLC" with
   relationship "prospect" (it calls \`business_upsert\`).
2. Open **Corporate Operations** in the sidebar. The business should be listed.
3. Reload the page. It should still be there.
4. Ask the agent to mark it legally dissolved because you said so. The call
   must be refused with \`[EPROOF_REQUIRED]\`.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Corporate Operations",
  description:
    "A record per business: three statuses (operating, legal, tax account) each with its as-of date and source, the standing documents with renewal dates, the tax filing calendar with proof of filing, linked case issues, and an append-only history. The rules that matter are enforced in code: a business cannot be marked dissolved, active or closed, and a filing cannot be marked filed, without a document on file that proves it. Intended for the HQ company only.",
  author: "Barry Carr & Tony Allard",
  categories: ["ui", "automation"],
  setupInstructions: SETUP_INSTRUCTIONS,
  capabilities: [
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
    "api.routes.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "issues.read",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  database: {
    namespaceSlug: "business_records",
    migrationsDir: "migrations",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["allowedCompanies", "showInSidebar"],
    properties: {
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description:
          "Which companies can read and change business records. Tick the HQ company only: these records cover every business in the portfolio and include tax id last-four digits and closure status. Every other company is refused by every tool and route. Empty = unusable (fail-safe deny).",
        items: { type: "string", format: "company-id" },
      },
      showInSidebar: {
        type: "boolean",
        default: true,
        title: "Show in sidebar",
        description:
          "Whether the Corporate Operations entry appears in the sidebar of allowed companies. Off = the page is still reachable at /:companyPrefix/corporate-operations but there is no nav link.",
      },
    },
    required: ["allowedCompanies"],
  },
  apiRoutes: [
    {
      routeKey: "businesses.list",
      method: "GET",
      path: "/businesses",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "businesses.get",
      method: "GET",
      path: "/businesses/:businessId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "overview",
      method: "GET",
      path: "/overview",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    // Page edits. Each runs the same service operation as the matching tool.
    ...(
      [
        ["businesses.create", "POST", "/businesses"],
        ["businesses.update", "PATCH", "/businesses/:businessId"],
        ["businesses.status", "POST", "/businesses/:businessId/status"],
        ["businesses.link", "POST", "/businesses/:businessId/links"],
        ["documents.create", "POST", "/documents"],
        ["documents.update", "PATCH", "/documents/:documentId"],
        ["documents.remove", "POST", "/documents/:documentId/remove"],
        ["filings.create", "POST", "/filings"],
        ["filings.update", "PATCH", "/filings/:filingId"],
        ["filings.status", "POST", "/filings/:filingId/status"],
      ] as const
    ).map(([routeKey, method, path]) => ({
      routeKey,
      method,
      path,
      auth: "board" as const,
      capability: "api.routes.register" as const,
      companyResolution: { from: "query" as const, key: "companyId" },
    })),
  ],
  tools: [
    {
      name: "business_list",
      displayName: "List businesses",
      description:
        "List the businesses on record in this company, with their three statuses. Filter by relationship (owned, prospect, former, other) and by text (matches the name and other trading names). Use this to find a business id before any other call.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          relationship: { type: "string", enum: RELATIONSHIPS },
          query: { type: "string", description: "Text to search in names and trading names." },
        },
      },
    },
    {
      name: "business_get",
      displayName: "Get a business",
      description:
        "Read one business: its record, each status with its as-of date and source, linked issues, current documents (replaced ones left out) and open filings (not yet filed, accepted or marked not required).",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: { businessId: UUID },
        required: ["businessId"],
      },
    },
    {
      name: "business_upsert",
      displayName: "Create or update a business",
      description:
        `Create a business, or update one found by id or by name (case-insensitive, within this company). Only the fields you send change; repeating the same call changes nothing and writes no history. relationship is required when creating. New businesses start with every status unknown unless you pass statuses (each {value, asOf, source}); on an existing business, statuses are changed only through business_set_status. To rename a business, pass its id and the new name. ${SENSITIVE_RULE_TEXT} ${PROOF_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { ...UUID, description: "The business id, to update a known business (and to rename it)." },
          name: { type: "string", description: "Legal name. Used to find the business when id is not given." },
          otherNames: { type: "array", items: { type: "string" }, description: "Trading names (DBAs). Replaces the list." },
          relationship: { type: "string", enum: RELATIONSHIPS },
          legalForm: { type: "string", description: "For example LLC, S corporation, sole proprietorship." },
          formationState: { type: "string" },
          registrationStates: { type: "array", items: { type: "string" }, description: "Other states it is registered in. Replaces the list." },
          taxClassification: { type: "string", description: "Federal tax classification, for example partnership or S corporation." },
          taxClassificationEffective: DATE,
          linkedCompanyIds: { type: "array", items: UUID, description: "Paperclip company ids that correspond to this business." },
          contacts: {
            type: "array",
            description: "Professional contacts (accountant, lawyer, registered agent). Replaces the list.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                role: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
                phone: { type: "string" },
                notes: { type: "string" },
              },
              required: ["role"],
            },
          },
          notes: { type: "string" },
          taxIdLast4: { type: "string", description: "Exactly the last four digits of the tax id, for example \"0000\". Never the full number." },
          statuses: {
            type: "object",
            additionalProperties: false,
            description: "Only when creating. Each status is checked by the same proof rule as business_set_status.",
            properties: {
              operating: STATUS_INPUT,
              legal: STATUS_INPUT,
              tax_account: STATUS_INPUT,
            },
          },
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      },
    },
    {
      name: "business_set_status",
      displayName: "Set a business status",
      description:
        `Change one of a business's three statuses. field: operating (not_yet_operating, operating, ceased, unknown), legal (not_yet_formed, formation_filed, active, dissolution_filed, dissolved, unknown) or tax_account (not_yet_registered, open, final_return_filed, account_closed, unknown). asOf is the date the status became true, not today's date unless it is. Writes one history row. ${PROOF_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          businessId: UUID,
          field: { type: "string", enum: STATUS_FIELDS },
          value: { type: "string" },
          asOf: DATE,
          source: STATUS_SOURCE,
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        required: ["businessId", "field", "value", "asOf", "source"],
      },
    },
    {
      name: "business_link_issue",
      displayName: "Link an issue to a business",
      description:
        "Link an issue in this company to a business so the business page lists it. role is a short slug: case:notice, case:formation, case:wind-down, records (the standing records issue that holds its documents), filing, or similar. Linking again with a different role changes the role. The issue must exist in this company, else [EISSUE_NOT_FOUND].",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          businessId: UUID,
          issueId: UUID,
          role: { type: "string" },
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        required: ["businessId", "issueId", "role"],
      },
    },
    {
      name: "business_history",
      displayName: "Business history",
      description:
        "Read the append-only history, newest first: status changes, filing status changes, documents added and replaced, record edits. Pass since (an ISO timestamp such as the time of the last review) to answer 'what changed since last time'. Leave businessId out to see every business in this company.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          businessId: UUID,
          since: { type: "string", description: "ISO 8601 timestamp. Only entries after it." },
          limit: { type: "number", description: "Default 100, max 500." },
        },
      },
    },
    {
      name: "business_add_document",
      displayName: "Add a business document",
      description:
        `Index a document in a business's document list. Upload the file itself to an issue in this company first (normally the business's records issue); issueId is that issue, and attachmentRef the attachment id or file name. The plugin cannot see attachments, so it records attachmentRef as given. Adding the same attachment again as the same type returns the existing entry. To file a newer version, pass replacesDocumentId: the old entry drops out of the current list but stays in history. A replaced document can no longer be cited as proof. ${SENSITIVE_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          businessId: UUID,
          docType: { type: "string", enum: DOC_TYPES },
          title: { type: "string" },
          issuingBody: { type: "string", description: "For example IRS, the state department of revenue, the city." },
          documentDate: DATE,
          renewalDate: { ...DATE, description: "Renewal or expiry date, YYYY-MM-DD. Leave out when there is none." },
          issueId: { ...UUID, description: "The issue in this company that holds the file as an attachment." },
          attachmentRef: { type: "string", description: "Attachment id or file name on that issue." },
          replacesDocumentId: UUID,
          notes: { type: "string" },
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        required: ["businessId", "docType", "title", "issueId"],
      },
    },
    {
      name: "business_list_documents",
      displayName: "List business documents",
      description:
        "List current documents (replaced versions left out unless includeReplaced is true), newest first. Filter by businessId and docType. renewalWithinDays N returns only documents whose renewal date is within the next N days, including ones whose renewal date has already passed, soonest first.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          businessId: UUID,
          docType: { type: "string", enum: DOC_TYPES },
          renewalWithinDays: { type: "number" },
          includeReplaced: { type: "boolean" },
        },
      },
    },
    {
      name: "business_filing_upsert",
      displayName: "Create or update a filing",
      description:
        `Add a filing to a business's calendar, one row per filing per period, or update one. A filing is identified by business, filing name, authority and periodLabel (for example "Federal S corporation return (Form 1120-S)", "IRS", "2026"); calling again with the same four finds the same row, so it can never be duplicated. New rows start as upcoming; change status only with business_filing_set_status. Cite the source of each due date in notes, and do not guess a due date you could not confirm. issueId, when given, must be an issue in this company. ${SENSITIVE_RULE_TEXT}`,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          filingId: { ...UUID, description: "To update a known filing." },
          businessId: UUID,
          filing: { type: "string" },
          authority: { type: "string", description: "IRS, a state agency, a city, or internal." },
          periodLabel: { type: "string", description: "For example 2026, 2026-Q3." },
          periodStart: DATE,
          periodEnd: DATE,
          dueDate: DATE,
          preparer: { type: "string", enum: PREPARERS },
          issueId: UUID,
          notes: { type: "string" },
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      },
    },
    {
      name: "business_filing_set_status",
      displayName: "Set a filing status",
      description:
        "Move a filing to upcoming, in_preparation, extension_filed, filed, accepted or not_required. Rules, enforced in code: filed, accepted and extension_filed need proofDocumentId (the confirmation, acceptance or extension confirmation, added first with business_add_document), else [EPROOF_REQUIRED]. extension_filed also needs extendedDueDate later than the original due date. not_required needs a written reason and a source of kind document, professional_advice or official_guidance with either documentId or an https:// url, else [EREASON_SOURCE_REQUIRED]; zero revenue is never on its own a reason. When marking filed or accepted, pass nextPeriod {periodLabel, periodStart, periodEnd, dueDate} to put the next period on the calendar; repeating the call never creates a second one. Writes one history row per change.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          filingId: UUID,
          status: { type: "string", enum: FILING_STATUSES },
          proofDocumentId: UUID,
          extendedDueDate: DATE,
          reason: { type: "string" },
          source: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: NOT_REQUIRED_SOURCE_KINDS },
              documentId: UUID,
              url: { type: "string", description: "https:// link to the official guidance." },
              note: { type: "string" },
            },
            required: ["kind"],
          },
          asOf: { ...DATE, description: "Date the status became true (for example the filing date). Optional." },
          nextPeriod: {
            type: "object",
            additionalProperties: false,
            properties: {
              periodLabel: { type: "string" },
              periodStart: DATE,
              periodEnd: DATE,
              dueDate: DATE,
            },
            required: ["periodLabel", "dueDate"],
          },
          idempotencyKey: IDEMPOTENCY_KEY,
        },
        required: ["filingId", "status"],
      },
    },
    {
      name: "business_list_filings",
      displayName: "List filings",
      description:
        "List filings, next due first (the extended due date counts when an extension is on file). Filters: businessId, status (one or a list), dueWithinDays N (open filings due from today to N days out), overdueWithoutProof true (open filings already past due, meaning no proof of filing is on file). Passing both dueWithinDays and overdueWithoutProof returns filings matching either, which is the weekly 'needs attention' check.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          businessId: UUID,
          status: {
            anyOf: [
              { type: "string", enum: FILING_STATUSES },
              { type: "array", items: { type: "string", enum: FILING_STATUSES } },
            ],
          },
          dueWithinDays: { type: "number" },
          overdueWithoutProof: { type: "boolean" },
        },
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "business-records-sidebar",
        displayName: "Corporate Operations",
        exportName: "CorporateOperationsSidebarItem",
      },
      {
        type: "page",
        id: "business-records-page",
        displayName: "Corporate Operations",
        exportName: "CorporateOperationsPage",
        routePath: "corporate-operations",
      },
    ],
  },
};

export default manifest;
