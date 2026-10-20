import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

// The host loads this file separately, so schemas stay self-contained.
const ID = { type: "string", minLength: 1 };
const NONNEGATIVE = { type: "number", minimum: 0 };
const SOURCE_COVERAGE = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", enum: ["calendar", "sent_mail", "property_management", "accounting"] },
    status: { type: "string", enum: ["reviewed", "no_data", "unavailable"] },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { ref: ID, summary: ID },
        required: ["ref", "summary"],
      },
    },
    reason: { type: "string", description: "Explain no_data or unavailable coverage and its effect on the audit." },
  },
  required: ["source", "status", "evidence"],
};
const PERMISSIONS = "Mutations obey host approval controls. Run mode does not change company or agent action permissions.";

const SETUP_INSTRUCTIONS = `# Set up Hand-off

1. Open Configuration and select the companies allowed to use Hand-off. An empty list denies every company. Records stay isolated within their company.
2. Enable the five Hand-off tools and the authorized company-skill API for an agent in the selected company. Import the work-audit skill and, optionally, its on-demand routine or bundle from the template library.
3. Authorize the actual connected calendar, sent mail, property management and accounting sources that agent may read. Hand-off does not connect those sources itself.
4. Start a work audit covering 30 to 90 days. Create a real company skill before recording each Draft job. Keep records do not require a skill. Review coverage gaps, ranked jobs, linked skills and three real historical examples per Draft job on the Hand-off page.
5. Review historical rehearsals and the first five production results. Five consecutive clean production reviews promote the current revision to Run. Three consecutive rewrites block new work until the skill is rebuilt and qualified again. ${PERMISSIONS}

No external credentials are stored by Hand-off. Evidence should use stable source references and only the information needed for review.`;

const route = (
  routeKey: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
): NonNullable<PaperclipPluginManifestV1["apiRoutes"]>[number] => ({
  routeKey,
  method,
  path,
  auth: "board",
  capability: "api.routes.register",
  companyResolution: { from: "query", key: "companyId" },
});

const manifest: PaperclipPluginManifestV1 = {
  id: "handoff-pipeline",
  apiVersion: 1,
  version: "0.1.3",
  displayName: "Hand-off",
  description: `Company-scoped work audits, one skill per recurring job, historical example tests and supervised run review. ${PERMISSIONS}`,
  author: "Barry Carr & Tony Allard",
  categories: ["ui", "automation"],
  setupInstructions: SETUP_INSTRUCTIONS,
  capabilities: [
    "instance.settings.register",
    "api.routes.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "agent.tools.register",
    "activity.log.write",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui/" },
  database: { namespaceSlug: "handoff", migrationsDir: "migrations", coreReadTables: ["company_skills", "heartbeat_runs", "agent_wakeup_requests", "issues", "issue_comments", "agents", "approvals"] },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["allowedCompanies"],
    properties: {
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description: "Companies permitted to read and change their own Hand-off records. Empty or missing denies access. Allowing several companies does not permit cross-company reads or writes.",
        default: [],
        items: { type: "string", format: "company-id" },
      },
    },
    required: ["allowedCompanies"],
  },
  apiRoutes: [
    route("handoff.summary", "GET", "/summary"),
    route("handoff.list-audits", "GET", "/audits"),
    route("handoff.create-audit", "POST", "/audits"),
    route("handoff.list-jobs", "GET", "/jobs"),
    route("handoff.create-job", "POST", "/jobs"),
    route("handoff.update-job", "PATCH", "/jobs/:jobId"),
    route("handoff.list-review", "GET", "/review"),
    route("handoff.list-runs", "GET", "/runs"),
    route("handoff.add-example", "POST", "/jobs/:jobId/examples"),
    route("handoff.add-run", "POST", "/jobs/:jobId/runs"),
    route("handoff.prepare-rewrite", "POST", "/runs/:runId/review/prepare"),
    route("handoff.review-run", "POST", "/runs/:runId/review"),
    route("handoff.record-correction-delivery", "POST", "/runs/:runId/correction-delivery"),
    route("handoff.preflight-rebuild", "POST", "/jobs/:jobId/rebuild/preflight"),
    route("handoff.rebuild-job", "POST", "/jobs/:jobId/rebuild"),
    route("handoff.retire-job", "POST", "/jobs/:jobId/retire"),
  ],
  tools: [
    {
      name: "handoff_get_pipeline",
      displayName: "Read the hand-off pipeline",
      description: "Read this company's current audits and ranked job stages, or fetch one job with its exact skill revision, examples, runs and review state. Use this before resuming work so results attach to the current revision.",
      writes: false,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: { ...ID, description: "Optional job ID. Omit for a compact pipeline summary; provide it for full job history." },
        },
      },
    },
    {
      name: "handoff_record_audit",
      displayName: "Record a work audit",
      description: `Record a 30 to 90 day audit of actual connected company work, including inspected source references, unavailable sources, evidence and ranked recurring jobs. Never invent source access, observations or time savings. ${PERMISSIONS}`,
      writes: true,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          startAt: { type: "string", format: "date-time", description: "Start of the actual 30 to 90 day history window, as an ISO timestamp." },
          endAt: { type: "string", format: "date-time", description: "End of the inspected history window, as an ISO timestamp." },
          sources: { type: "array", minItems: 4, maxItems: 4, items: SOURCE_COVERAGE, description: "Exactly one coverage record for each source. Cite inspected evidence; disclose unavailable or empty sources with a reason." },
        },
        required: ["startAt", "endAt", "sources"],
      },
    },
    {
      name: "handoff_record_job",
      displayName: "Record a recurring job skill",
      description: `Record one recurring job linked to an audit and real source evidence. For Draft, first create its actual company skill through the authorized company-skill API, then pass the returned companySkillId and skillKey plus the complete current SKILL.md. Hand-off verifies all three against the company skill. Keep records do not need a skill. Frequency and time figures are estimates grounded in cited records, never observed savings. This tool does not create or import a skill, schedule execution or grant source access. ${PERMISSIONS}`,
      writes: true,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          auditId: ID,
          title: { type: "string", minLength: 1, description: "One recurring job, not a collection of unrelated tasks." },
          evidenceRefs: { type: "array", minItems: 1, items: ID, description: "Actual source references supporting the recurrence and ranking." },
          occurrencesPerMonth: { ...NONNEGATIVE, description: "Estimated monthly frequency supported by the audit evidence." },
          manualMinutes: { ...NONNEGATIVE, description: "Estimated manual minutes per occurrence, not claimed observed savings." },
          agentMinutes: { ...NONNEGATIVE, description: "Estimated agent and supervision minutes per occurrence." },
          initialDisposition: { type: "string", enum: ["keep", "draft"] },
          companySkillId: { ...ID, description: "Returned ID of the actual company skill. Required for Draft." },
          skillKey: { ...ID, description: "Returned key of the actual company skill. Required for Draft." },
          skillContent: { ...ID, description: "Complete content snapshot of that company skill. Required for Draft." },
          routineId: { ...ID, description: "Optional existing routine linked to this job. Recording it does not create or start a routine." },
        },
        required: ["auditId", "title", "evidenceRefs", "occurrencesPerMonth", "manualMinutes", "agentMinutes", "initialDisposition"],
        allOf: [{
          if: { properties: { initialDisposition: { const: "draft" } }, required: ["initialDisposition"] },
          then: { required: ["companySkillId", "skillKey", "skillContent"] },
        }],
      },
    },
    {
      name: "handoff_add_example",
      displayName: "Record a past job example",
      description: `Record one distinct real historical example with source references, original inputs and actual outcome. Each job needs three examples and verified rehearsals of its current skill before hand-off. Never fabricate examples or repeat historic external writes during testing. ${PERMISSIONS}`,
      writes: true,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: ID,
          sourceRef: { ...ID, description: "Stable reference to this distinct real historical occurrence." },
          input: { ...ID, description: "The original input, limited to information needed to rehearse the job." },
          actualOutcome: { ...ID, description: "What actually happened historically, for comparison with the rehearsal." },
        },
        required: ["jobId", "sourceRef", "input", "actualOutcome"],
      },
    },
    {
      name: "handoff_record_run",
      displayName: "Record a job run result",
      description: `Record an actual historical rehearsal or production execution, identifying its skill version, source example, output, checks and result. Production provenance, agent identity and start time come from the current host run and cannot be supplied by the caller. Draft results require human review. Production results started after promotion to Run remain in the log without required review. Distinguish observed time from estimates; retain failed results. This logs work and never executes an external action. ${PERMISSIONS}`,
      writes: true,
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          jobId: ID,
          idempotencyKey: { ...ID, description: "Stable unique key for a historical rehearsal. Production uses the current host run ID." },
          revisionId: { ...ID, description: "The actual skill revision used for this result." },
          mode: { type: "string", enum: ["historical", "production"] },
          startedAt: { type: "string", format: "date-time", description: "When a historical rehearsal actually started. Production uses the host run start time. Record outstanding results before rebuilding; retirement does not erase the verified revision." },
          originalOutput: { ...ID, description: "Unedited actual output and verification evidence. Do not claim a pass without checking it; board review records the verdict." },
          exampleId: { ...ID, description: "Required for historical mode. Use a real saved example from this job." },
          sourceRef: { ...ID, description: "Required for production mode. Stable evidence reference for the actual occurrence." },
          actualMinutes: { ...NONNEGATIVE, description: "Observed execution and review minutes, if measured. Omit estimates." },
        },
        required: ["jobId", "revisionId", "mode", "originalOutput"],
        allOf: [
          { if: { properties: { mode: { const: "historical" } }, required: ["mode"] }, then: { required: ["exampleId", "idempotencyKey", "startedAt"] } },
          { if: { properties: { mode: { const: "production" } }, required: ["mode"] }, then: { required: ["sourceRef"] } },
        ],
      },
    },
  ],
  ui: {
    slots: [
      { type: "sidebar", id: "handoff-sidebar", displayName: "Hand-off", exportName: "HandOffSidebarItem" },
      { type: "page", id: "handoff-page", displayName: "Hand-off", exportName: "HandOffPage", routePath: "hand-off" },
    ],
  },
};

export default manifest;
