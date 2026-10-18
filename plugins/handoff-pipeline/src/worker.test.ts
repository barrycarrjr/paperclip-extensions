import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type {
  PluginApiRequestInput,
  PluginContext,
  ToolResult,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { AUDIT_SOURCES, type PipelineState } from "./contracts.js";
import manifest from "./manifest.js";
import { correctionDeliveryForReceipts, correctionWakeRunsForReceipts, handleApiRequest, plugin, startActivityDeliveryRetryLoop } from "./worker.js";

const namespace = "plugin_handoff_dcdb27ff5a";
const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const reviewer = "44444444-4444-4444-8444-444444444444";
let pg: PGlite;
let allowedCompanies = [companyA, companyB];
let activityFailures = 0;
const activities: unknown[] = [];
const tools = new Map<string, (params: unknown, run: ToolRunContext) => Promise<ToolResult>>();
const dataHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();

const ctx = {
  db: {
    namespace,
    async query<T>(sql: string, params: unknown[] = []) { return (await pg.query<T>(sql, params)).rows; },
    async execute(sql: string, params: unknown[] = []) { return { rowCount: (await pg.query(sql, params)).affectedRows ?? 0 }; },
  },
  config: { async get() { return { allowedCompanies }; } },
  logger: { info() {}, debug() {}, warn() {}, error() {} },
  activity: { async log(entry: unknown) { if (activityFailures-- > 0) throw new Error("Activity offline"); activities.push(entry); } },
  tools: { register(name: string, _declaration: unknown, handler: (params: unknown, run: ToolRunContext) => Promise<ToolResult>) { tools.set(name, handler); } },
  data: { register(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) { dataHandlers.set(name, handler); } },
} as unknown as PluginContext;

function request(
  routeKey: string,
  body: unknown = {},
  options: Partial<PluginApiRequestInput> = {},
): PluginApiRequestInput {
  return {
    routeKey,
    method: routeKey.includes("list") || routeKey.endsWith("summary") ? "GET" : "POST",
    path: "/",
    params: {},
    query: { companyId: companyA },
    body,
    actor: { actorType: "user", actorId: reviewer, userId: reviewer },
    companyId: companyA,
    headers: {},
    ...options,
  };
}

const sources = () => AUDIT_SOURCES.map((source) => ({
  source,
  status: "reviewed" as const,
  evidence: [{ ref: `proof:${source}`, summary: "Observed record" }],
}));

async function stateFrom(response: Awaited<ReturnType<typeof handleApiRequest>>): Promise<PipelineState> {
  assert.ok(response.body && typeof response.body === "object" && "state" in response.body);
  return (response.body as { state: PipelineState }).state;
}

before(async () => {
  pg = new PGlite();
  await pg.exec("CREATE TABLE public.company_skills (id uuid PRIMARY KEY, company_id uuid NOT NULL, key text NOT NULL, markdown text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
  await pg.exec("CREATE TABLE public.agents (id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'idle')");
  await pg.exec("CREATE TABLE public.heartbeat_runs (id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL, status text NOT NULL, started_at timestamptz, finished_at timestamptz, result_json jsonb, context_snapshot jsonb, wakeup_request_id uuid)");
  await pg.exec("CREATE TABLE public.agent_wakeup_requests (id uuid PRIMARY KEY, company_id uuid NOT NULL, agent_id uuid NOT NULL, status text NOT NULL, reason text, requested_by_actor_type text, requested_by_actor_id text, idempotency_key text, run_id uuid, payload jsonb, created_at timestamptz NOT NULL DEFAULT now())");
  await pg.exec("CREATE TABLE public.issues (id uuid PRIMARY KEY, company_id uuid NOT NULL, assignee_agent_id uuid)");
  await pg.exec("CREATE TABLE public.issue_comments (id uuid PRIMARY KEY, company_id uuid NOT NULL, issue_id uuid NOT NULL, author_agent_id uuid, author_user_id text, expected_assignee_agent_id uuid, correction_recipient_agent_ids jsonb, intent text NOT NULL, idempotency_key text, body text NOT NULL)");
  await pg.exec("CREATE TABLE public.approvals (id uuid PRIMARY KEY, company_id uuid NOT NULL, type text NOT NULL, status text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())");
  await pg.query(
    "INSERT INTO public.company_skills (id, company_id, key, markdown) VALUES ($1, $2, $3, $4)",
    ["33333333-3333-4333-8333-333333333333", companyA, `company/${companyA}/monthly-close`, "Prepare the close checklist from cited records."],
  );
  await pg.exec(`CREATE SCHEMA ${namespace}`);
  await pg.exec(await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../migrations/0002_activity_outbox.sql", import.meta.url), "utf8"));
  await plugin.definition.setup(ctx);
});

after(async () => { await pg.close(); });

test("host delivery stays pending while an authoritative mentioned recipient is paused", () => {
  const hostAgentId = "77777777-7777-4777-8777-777777777777";
  const mentionedAgentId = "77777777-7777-4777-8777-777777777778";
  const receipts = [
    { id: "host", agent_id: hostAgentId, idempotency_key: "host", status: "claimed", reason: null },
    { id: "mention", agent_id: mentionedAgentId, idempotency_key: "mention", status: "skipped", reason: "agent_paused" },
  ];
  const hostReceipt = [{ agent_id: hostAgentId, status: "running", started_at: new Date() }];
  assert.deepEqual(correctionDeliveryForReceipts(receipts, hostReceipt), {
    status: "pending",
    pending: [{ agentId: mentionedAgentId, reason: "The host skipped agent delivery (agent_paused)." }],
  });
  assert.deepEqual(correctionDeliveryForReceipts(receipts, [
    ...hostReceipt,
    { agent_id: mentionedAgentId, status: "queued", started_at: null },
  ]), { status: "accepted", pending: [] });
});

test("a stored correction recipient stays pending when no wake receipt exists", () => {
  const hostAgentId = "77777777-7777-4777-8777-777777777701";
  const recipientWithoutReceipt = "77777777-7777-4777-8777-777777777702";
  const receipts = [
    { id: "host", agent_id: hostAgentId, idempotency_key: "host", status: "claimed", reason: null },
  ];
  assert.deepEqual(correctionDeliveryForReceipts(
    receipts,
    [{ agent_id: hostAgentId, status: "running", started_at: new Date() }],
    [hostAgentId, recipientWithoutReceipt],
  ), {
    status: "pending",
    pending: [{
      agentId: recipientWithoutReceipt,
      reason: "The host has not recorded an agent delivery receipt for this correction.",
    }],
  });
});

test("coalesced correction delivery follows the receipt run link", async () => {
  const companyId = "11111111-1111-4111-8111-111111111119";
  const agentId = "77777777-7777-4777-8777-777777777719";
  const receiptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee19";
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa19";
  await pg.query(
    "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, wakeup_request_id) VALUES ($1, $2, $3, 'running', now(), $4)",
    [runId, companyId, agentId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb19"],
  );
  const receipts = [{
    id: receiptId, agent_id: agentId, idempotency_key: "coalesced", status: "coalesced", reason: null, run_id: runId, payload: null,
  }];
  const rows = await correctionWakeRunsForReceipts(ctx, companyId, receipts);
  assert.deepEqual(correctionDeliveryForReceipts(receipts, rows), { status: "accepted", pending: [] });
});

test("deferred correction delivery follows the promoted parent receipt", async () => {
  const companyId = "11111111-1111-4111-8111-111111111118";
  const agentId = "77777777-7777-4777-8777-777777777718";
  const childId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee18";
  const parentId = "dddddddd-dddd-4ddd-8ddd-dddddddddd18";
  const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa18";
  await pg.query(
    "INSERT INTO public.agent_wakeup_requests (id, company_id, agent_id, status, run_id) VALUES ($1, $2, $3, 'claimed', $4)",
    [parentId, companyId, agentId, runId],
  );
  await pg.query(
    "INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, wakeup_request_id) VALUES ($1, $2, $3, 'running', now(), $4)",
    [runId, companyId, agentId, parentId],
  );
  const receipts = [{
    id: childId,
    agent_id: agentId,
    idempotency_key: "deferred",
    status: "coalesced",
    reason: null,
    run_id: null,
    payload: { deferredWakeupRequestId: parentId },
  }];
  const rows = await correctionWakeRunsForReceipts(ctx, companyId, receipts);
  assert.deepEqual(correctionDeliveryForReceipts(receipts, rows), { status: "accepted", pending: [] });
});

test("runtime registers every manifest tool and the fail-closed sidebar feed", async () => {
  assert.deepEqual([...tools.keys()].sort(), (manifest.tools ?? []).map((tool) => tool.name).sort());
  assert.equal((await dataHandlers.get("handoff.sidebar-visible")!({ companyId: companyA }) as { visible: boolean }).visible, true);
  allowedCompanies = [];
  assert.equal((await dataHandlers.get("handoff.sidebar-visible")!({ companyId: companyA }) as { visible: boolean }).visible, false);
  allowedCompanies = [companyA, companyB];
});

test("failed host activity delivery remains durable and retries without duplicates", async () => {
  const eventStart = activities.length;
  activityFailures = 1;
  const created = await handleApiRequest(ctx, request("handoff.create-audit", {
    startAt: "2026-07-01T00:00:00Z", endAt: "2026-07-31T00:00:00Z", sources: sources(),
  }, { companyId: companyB }));
  assert.equal(created.status, 201);
  assert.equal(activities.length, eventStart);

  const stopRetry = startActivityDeliveryRetryLoop(ctx, 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  stopRetry();
  assert.equal(activities.length, eventStart + 1);
  const delivered = activities.at(-1) as { idempotencyKey?: string; metadata?: { eventId?: string } };
  assert.match(delivered.idempotencyKey ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(typeof delivered.metadata?.eventId, "string");
  const stopSecondRetry = startActivityDeliveryRetryLoop(ctx, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  stopSecondRetry();
  assert.equal(activities.length, eventStart + 1);
  await pg.query(`DELETE FROM ${namespace}.activity_outbox WHERE company_id = $1`, [companyB]);
  await pg.query(`DELETE FROM ${namespace}.pipeline_companies WHERE company_id = $1`, [companyB]);
});

test("API denies unassigned companies and isolates assigned company records", async () => {
  allowedCompanies = [companyA];
  assert.equal((await handleApiRequest(ctx, request("handoff.summary", {}, { companyId: companyB }))).status, 403);
  const created = await handleApiRequest(ctx, request("handoff.create-audit", {
    startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-31T00:00:00Z", sources: sources(),
  }));
  assert.equal(created.status, 201);
  allowedCompanies = [companyA, companyB];
  const other = await stateFrom(await handleApiRequest(ctx, request("handoff.summary", {}, { companyId: companyB })));
  assert.equal(other.audits.length, 0);
});

test("API binds route identifiers and attributes immutable reviews to the signed-in person", async () => {
  const initial = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const auditId = initial.audits[0].id;
  const jobState = await stateFrom(await handleApiRequest(ctx, request("handoff.create-job", {
    auditId,
    title: "Monthly close checklist",
    evidenceRefs: ["proof:accounting"],
    occurrencesPerMonth: 1,
    manualMinutes: 180,
    agentMinutes: 30,
    initialDisposition: "draft",
    companySkillId: "33333333-3333-4333-8333-333333333333",
    skillKey: `company/${companyA}/monthly-close`,
    skillContent: "Prepare the close checklist from cited records.",
  })));
  const job = jobState.jobs[0];
  const exampleState = await stateFrom(await handleApiRequest(ctx, request("handoff.add-example", {
    sourceRef: "accounting:close:2026-07", input: "July close records", actualOutcome: "Approved July checklist",
  }, { params: { jobId: job.id } })));
  const example = exampleState.jobs[0].examples[0];
  const runState = await stateFrom(await handleApiRequest(ctx, request("handoff.add-run", {
    idempotencyKey: "july-close-rehearsal",
    revisionId: job.currentRevisionId,
    mode: "historical",
    exampleId: example.id,
    startedAt: job.revisions[0].createdAt,
    originalOutput: "Draft July checklist",
  }, { params: { jobId: job.id } })));
  const run = runState.jobs[0].runs[0];
  const reviewed = await stateFrom(await handleApiRequest(ctx, request("handoff.review-run", {
    verdict: "clean", reviewerId: "attacker-supplied",
  }, { params: { runId: run.id } })));
  assert.equal(reviewed.jobs[0].runs[0].review?.reviewerId, reviewer);
  assert.equal((await handleApiRequest(ctx, request("handoff.review-run", { verdict: "clean" }, {
    params: { runId: run.id }, actor: { actorType: "agent", actorId: "agent", agentId: "agent", userId: null },
  }))).status, 403);
  assert.ok(activities.length >= 4);
});

test("API maps lifecycle failures and unknown routes to stable statuses", async () => {
  const invalid = await handleApiRequest(ctx, request("handoff.create-audit", {
    startAt: "2026-08-01T00:00:00Z", endAt: "2026-08-02T00:00:00Z", sources: sources(),
  }));
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { code: string }).code, "invalid_input");
  const initial = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const unverifiedSkill = await handleApiRequest(ctx, request("handoff.create-job", {
    auditId: initial.audits[0].id,
    title: "Invented skill",
    evidenceRefs: ["proof:calendar"],
    occurrencesPerMonth: 1,
    manualMinutes: 60,
    agentMinutes: 10,
    initialDisposition: "draft",
    companySkillId: "55555555-5555-4555-8555-555555555555",
    skillKey: `company/${companyA}/invented`,
    skillContent: "Invented",
  }));
  assert.equal(unverifiedSkill.status, 404);
  assert.equal((await handleApiRequest(ctx, request("handoff.missing"))).status, 404);
});

test("rebuild preflight validates without writing and the final request requires its version", async () => {
  const before = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const job = before.jobs[0];
  const input = { skillContent: "Improved close checklist.", reason: "Cover exceptions", requestId: "rebuild-preflight-one" };
  const preflight = await handleApiRequest(ctx, request("handoff.preflight-rebuild", input, { params: { jobId: job.id } }));
  assert.equal(preflight.status, 200);
  assert.equal((preflight.body as { version: number }).version, before.version);
  assert.deepEqual(await stateFrom(await handleApiRequest(ctx, request("handoff.summary"))), before);
  const withoutVersion = await handleApiRequest(ctx, request("handoff.rebuild-job", input, { params: { jobId: job.id } }));
  assert.equal(withoutVersion.status, 400);
  await handleApiRequest(ctx, request("handoff.create-audit", { startAt: "2026-06-01T00:00:00Z", endAt: "2026-07-01T00:00:00Z", sources: sources() }));
  const stale = await handleApiRequest(ctx, request("handoff.rebuild-job", { ...input, expectedVersion: before.version }, { params: { jobId: job.id } }));
  assert.equal(stale.status, 409);
});

test("runs and current-revision reviews stop when the linked company skill changes", async () => {
  const state = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const job = state.jobs[0];
  const exampleState = await stateFrom(await handleApiRequest(ctx, request("handoff.add-example", {
    sourceRef: "accounting:close:drift-review", input: "Close records", actualOutcome: "Approved checklist",
  }, { params: { jobId: job.id } })));
  const example = exampleState.jobs[0].examples.at(-1)!;
  const pendingInput = {
    idempotencyKey: "before-skill-drift", revisionId: job.currentRevisionId, mode: "historical",
    exampleId: example.id, startedAt: job.revisions[0].createdAt, originalOutput: "Pending checklist",
  };
  const pendingState = await stateFrom(await handleApiRequest(ctx, request("handoff.add-run", pendingInput, { params: { jobId: job.id } })));
  const pending = pendingState.jobs[0].runs.at(-1)!;
  await pg.query("UPDATE public.company_skills SET markdown = $1, updated_at = now() WHERE id = $2", ["Changed outside Hand-off", job.companySkillId]);
  const exactRetry = await handleApiRequest(ctx, request("handoff.add-run", pendingInput, { params: { jobId: job.id } }));
  assert.equal(exactRetry.status, 200);
  assert.equal((await stateFrom(exactRetry)).jobs[0].runs.filter((run) => run.idempotencyKey === pendingInput.idempotencyKey).length, 1);
  const blockedDetail = await tools.get("handoff_get_pipeline")!({ jobId: job.id }, { agentId: "agent", runId: "drift-read", companyId: companyA });
  assert.match(blockedDetail.error ?? "", /Do not execute/);
  assert.equal((blockedDetail.data as { executionBlocked: boolean }).executionBlocked, true);
  const blockedSummary = await tools.get("handoff_get_pipeline")!({}, { agentId: "agent", runId: "drift-summary", companyId: companyA });
  assert.match(blockedSummary.content ?? "", /Do not execute blocked jobs/);
  assert.equal(((blockedSummary.data as { jobs: { executionBlocked: boolean }[] }).jobs.find((candidate) => candidate.executionBlocked))?.executionBlocked, true);
  const boardSummary = await handleApiRequest(ctx, request("handoff.summary"));
  assert.equal(((boardSummary.body as { skillDrift: unknown[] }).skillDrift).length, 1);
  const afterChange = new Date().toISOString();
  const newExampleState = await stateFrom(await handleApiRequest(ctx, request("handoff.add-example", {
    sourceRef: "accounting:close:drift-run", input: "New close records", actualOutcome: "New approved checklist",
  }, { params: { jobId: job.id } })));
  const newExample = newExampleState.jobs[0].examples.at(-1)!;
  const staleRun = await handleApiRequest(ctx, request("handoff.add-run", {
    idempotencyKey: "after-skill-drift", revisionId: job.currentRevisionId, mode: "historical",
    exampleId: newExample.id, startedAt: afterChange, originalOutput: "Stale checklist",
  }, { params: { jobId: job.id } }));
  assert.equal(staleRun.status, 409);
  assert.match((staleRun.body as { error: string }).error, /skill changed after this revision was verified/i);
  const staleReview = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "clean" }, { params: { runId: pending.id } }));
  assert.equal(staleReview.status, 409);
  assert.match((staleReview.body as { error: string }).error, /rebuild the job/i);
  await pg.query("UPDATE public.company_skills SET markdown = $1, updated_at = now() WHERE id = $2", [job.revisions[0].content, job.companySkillId]);
  const restoredReview = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "clean" }, { params: { runId: pending.id } }));
  assert.equal(restoredReview.status, 200);
  const beforeRebuild = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const rebuiltContent = "Rebuilt close checklist.";
  const rebuildRequestId = "rebuild-after-drift";
  const preflight = await handleApiRequest(ctx, request("handoff.preflight-rebuild", { skillContent: rebuiltContent, reason: "Recover from drift", requestId: rebuildRequestId }, { params: { jobId: job.id } }));
  assert.equal(preflight.status, 200);
  await pg.query("UPDATE public.company_skills SET markdown = $1, updated_at = now() WHERE id = $2", [rebuiltContent, job.companySkillId]);
  const rebuilt = await handleApiRequest(ctx, request("handoff.rebuild-job", { skillContent: rebuiltContent, reason: "Recover from drift", requestId: rebuildRequestId, expectedVersion: beforeRebuild.version }, { params: { jobId: job.id } }));
  assert.equal(rebuilt.status, 200);
  const unprovableOldRun = await handleApiRequest(ctx, request("handoff.add-run", {
    idempotencyKey: "unprovable-old-run", revisionId: job.currentRevisionId, mode: "historical",
    exampleId: newExample.id, startedAt: job.revisions[0].createdAt, originalOutput: "Old revision output",
  }, { params: { jobId: job.id } }));
  assert.equal(unprovableOldRun.status, 409);
});

test("an unchanged SKILL.md remains verified after a later company skill save", async () => {
  const state = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const job = state.jobs[0];
  await pg.query("UPDATE public.company_skills SET updated_at = now() + interval '1 minute' WHERE id = $1", [job.companySkillId]);

  const summary = await handleApiRequest(ctx, request("handoff.summary"));
  assert.equal(((summary.body as { skillDrift: unknown[] }).skillDrift).length, 0);
});

test("recording tools use the caller company and return actual saved identifiers", async () => {
  const result = await tools.get("handoff_record_audit")!({
    startAt: "2026-07-01T00:00:00Z", endAt: "2026-07-31T00:00:00Z", sources: sources(),
  }, {
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    companyId: companyB,
  });
  assert.equal(result.error, undefined);
  const event = (result.data as { event: { detail: { auditId: string } } }).event;
  assert.match(event.detail.auditId, /^[0-9a-f-]{36}$/);
  const state = await stateFrom(await handleApiRequest(ctx, request("handoff.summary", {}, { companyId: companyB })));
  assert.equal(state.audits[0].id, event.detail.auditId);
});

test("read tool returns a compact company summary or one full job", async () => {
  const run = {
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    companyId: companyA,
  };
  const summary = await tools.get("handoff_get_pipeline")!({}, run);
  assert.equal((summary.data as { jobs: unknown[] }).jobs.length, 1);
  const state = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const detail = await tools.get("handoff_get_pipeline")!({ jobId: state.jobs[0].id }, run);
  assert.equal((detail.data as { job: { skillKey: string } }).job.skillKey, `company/${companyA}/monthly-close`);
});

test("production runs bind host provenance and reviews verify counts and correction comments", async () => {
  const skillId = "66666666-6666-4666-8666-666666666666";
  const agentId = "77777777-7777-4777-8777-777777777777";
  const mentionedAgentId = "77777777-7777-4777-8777-777777777778";
  const issueId = "88888888-8888-4888-8888-888888888888";
  await pg.query("INSERT INTO public.agents (id, company_id, name) VALUES ($1, $2, 'OriginalAgent'), ($3, $2, 'PausedReviewer')", [agentId, companyA, mentionedAgentId]);
  await pg.query("INSERT INTO public.company_skills (id, company_id, key, markdown) VALUES ($1, $2, $3, $4)", [skillId, companyA, `company/${companyA}/verified-job`, "Process the assigned issue from cited records."]);
  await pg.query("INSERT INTO public.issues (id, company_id, assignee_agent_id) VALUES ($1, $2, $3)", [issueId, companyA, agentId]);
  const initial = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const created = await stateFrom(await handleApiRequest(ctx, request("handoff.create-job", {
    auditId: initial.audits[0].id, title: "Verified production job", evidenceRefs: ["proof:accounting"],
    occurrencesPerMonth: 2, manualMinutes: 60, agentMinutes: 10, initialDisposition: "draft",
    companySkillId: skillId, skillKey: `company/${companyA}/verified-job`, skillContent: "Process the assigned issue from cited records.",
  })));
  const job = created.jobs.find((candidate) => candidate.companySkillId === skillId)!;
  for (let index = 0; index < 3; index++) {
    const exampleState = await stateFrom(await handleApiRequest(ctx, request("handoff.add-example", {
      sourceRef: `verified-example:${index}`, input: `Input ${index}`, actualOutcome: `Outcome ${index}`,
    }, { params: { jobId: job.id } })));
    const example = exampleState.jobs.find((candidate) => candidate.id === job.id)!.examples.at(-1)!;
    const runState = await stateFrom(await handleApiRequest(ctx, request("handoff.add-run", {
      idempotencyKey: `verified-example-run:${index}`, revisionId: job.currentRevisionId, mode: "historical",
      exampleId: example.id, startedAt: job.revisions[0].createdAt, originalOutput: `Historical output ${index}`,
    }, { params: { jobId: job.id } })));
    const historicalRun = runState.jobs.find((candidate) => candidate.id === job.id)!.runs.at(-1)!;
    assert.equal((await handleApiRequest(ctx, request("handoff.review-run", { verdict: "clean" }, { params: { runId: historicalRun.id } }))).status, 200);
  }

  const hostRunId = "99999999-9999-4999-8999-999999999999";
  const startedAt = new Date().toISOString();
  await pg.query("INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, result_json, context_snapshot) VALUES ($1, $2, $3, 'running', $4, $5, $6)", [hostRunId, companyA, agentId, startedAt, { runCounts: { itemsRead: 2, entriesAdded: 1, changesProposed: 0 }, runCountsReporting: { status: "reported" }, summary: "Processed assigned records." }, { issueId }]);
  const recorded = await tools.get("handoff_record_run")!({
    jobId: job.id, idempotencyKey: "caller-supplied", revisionId: job.currentRevisionId, mode: "production",
    sourceRef: "production:one", startedAt: "2000-01-01T00:00:00Z", originalOutput: "Production output",
  }, { agentId, runId: hostRunId, companyId: companyA });
  assert.equal(recorded.error, undefined);
  const productionRun = (recorded.data as { job: { runs: PipelineState["jobs"][number]["runs"] } }).job.runs.at(-1)!;
  assert.equal(productionRun.idempotencyKey, `host-run:${hostRunId}`);
  assert.equal(productionRun.startedAt, new Date(startedAt).toISOString());
  assert.equal(productionRun.hostAgentId, agentId);
  assert.equal(productionRun.sourceIssueId, issueId);
  await pg.query("UPDATE public.issues SET assignee_agent_id = NULL WHERE id = $1", [issueId]);
  const exactRetry = await tools.get("handoff_record_run")!({
    jobId: job.id, idempotencyKey: "different-caller-key", revisionId: job.currentRevisionId, mode: "production",
    sourceRef: "production:one", startedAt: "1999-01-01T00:00:00Z", originalOutput: "Production output",
  }, { agentId, runId: hostRunId, companyId: companyA });
  assert.equal(exactRetry.error, undefined);
  assert.equal((exactRetry.data as { job: { runs: unknown[] } }).job.runs.length, 4);
  await pg.query("UPDATE public.issues SET assignee_agent_id = $1 WHERE id = $2", [agentId, issueId]);
  const manualProduction = await handleApiRequest(ctx, request("handoff.add-run", {
    idempotencyKey: "manual-production", revisionId: job.currentRevisionId, mode: "production", sourceRef: "manual",
    startedAt, originalOutput: "Manual production output",
  }, { params: { jobId: job.id } }));
  assert.equal(manualProduction.status, 422);
  assert.equal((await handleApiRequest(ctx, request("handoff.review-run", { verdict: "clean" }, { params: { runId: productionRun.id } }))).status, 422);
  await pg.query("UPDATE public.heartbeat_runs SET status = 'succeeded', finished_at = now() WHERE id = $1", [hostRunId]);
  assert.equal((await handleApiRequest(ctx, request("handoff.review-run", { verdict: "clean" }, { params: { runId: productionRun.id } }))).status, 200);

  const rewrittenHostRunId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await pg.query("INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, finished_at, result_json, context_snapshot) VALUES ($1, $2, $3, 'failed', now(), now(), $4, $5)", [rewrittenHostRunId, companyA, agentId, { summary: "Output needed correction." }, { issueId }]);
  const rewrittenRecord = await tools.get("handoff_record_run")!({
    jobId: job.id, revisionId: job.currentRevisionId, mode: "production", sourceRef: "production:two", originalOutput: "Incorrect output",
  }, { agentId, runId: rewrittenHostRunId, companyId: companyA });
  const rewrittenRun = (rewrittenRecord.data as { job: { runs: PipelineState["jobs"][number]["runs"] } }).job.runs.at(-1)!;
  const rewriteReason = "Wrong total [@PausedReviewer](agent://77777777-7777-4777-8777-777777777778)";
  const missingCounts = await handleApiRequest(ctx, request("handoff.prepare-rewrite", { revisedOutput: "Correct output", reason: rewriteReason }, { params: { runId: rewrittenRun.id } }));
  assert.equal(missingCounts.status, 422);
  await pg.query("UPDATE public.heartbeat_runs SET result_json = $1 WHERE id = $2", [{ runCounts: { itemsRead: 2, entriesAdded: 0, changesProposed: 1 }, runCountsReporting: { status: "reported" }, summary: "Output needed correction." }, rewrittenHostRunId]);
  const prepared = await handleApiRequest(ctx, request("handoff.prepare-rewrite", { revisedOutput: "Correct output", reason: rewriteReason }, { params: { runId: rewrittenRun.id } }));
  assert.equal(prepared.status, 200);
  const missingCorrection = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "rewritten", revisedOutput: "Correct output", reason: rewriteReason, correctionCommentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { params: { runId: rewrittenRun.id } }));
  assert.equal(missingCorrection.status, 409);
  const commentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await pg.query("INSERT INTO public.issue_comments (id, company_id, issue_id, author_user_id, intent, body) VALUES ($1, $2, $3, $4, 'correction', $5)", [commentId, companyA, issueId, reviewer, "Stale correction text"]);
  const staleCorrection = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "rewritten", revisedOutput: "Correct output", reason: rewriteReason, correctionCommentId: commentId }, { params: { runId: rewrittenRun.id } }));
  assert.equal(staleCorrection.status, 409);
  await pg.query("UPDATE public.issue_comments SET idempotency_key = $1, body = $2 WHERE id = $3", [`handoff.review:${rewrittenRun.id}`, "Hand-off review correction from C:\\Users\\redacted", commentId]);
  const wrongTarget = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "rewritten", revisedOutput: "Correct output", reason: rewriteReason, correctionCommentId: commentId }, { params: { runId: rewrittenRun.id } }));
  assert.equal(wrongTarget.status, 409);
  await pg.query("UPDATE public.issue_comments SET expected_assignee_agent_id = $1 WHERE id = $2", [agentId, commentId]);
  const wrongBody = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "rewritten", revisedOutput: "Correct output", reason: rewriteReason, correctionCommentId: commentId }, { params: { runId: rewrittenRun.id } }));
  assert.equal(wrongBody.status, 409);
  await pg.query("UPDATE public.issue_comments SET body = $1 WHERE id = $2", [`Hand-off review correction for run ${rewrittenRun.id}\n\n${rewriteReason}\n\nCorrected output:\nCorrect output`, commentId]);
  await pg.query("UPDATE public.issues SET assignee_agent_id = NULL WHERE id = $1", [issueId]);
  const missingHostReceipt = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "rewritten", revisedOutput: "Correct output", reason: rewriteReason, correctionCommentId: commentId }, { params: { runId: rewrittenRun.id } }));
  assert.equal(missingHostReceipt.status, 409);
  const pendingDelivery = { status: "pending", pending: [{ agentId: mentionedAgentId, reason: "Agent is paused by its budget." }] };
  const deferredAgentId = "77777777-7777-4777-8777-777777777779";
  await pg.query(
    "UPDATE public.issue_comments SET correction_recipient_agent_ids = $1 WHERE id = $2",
    [[agentId, mentionedAgentId, deferredAgentId], commentId],
  );
  const hostDeliveryReceiptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0";
  const mentionedSkippedReceiptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
  await pg.query(
    `INSERT INTO public.agent_wakeup_requests
       (id, company_id, agent_id, status, reason, requested_by_actor_type, requested_by_actor_id, idempotency_key)
     VALUES ($1, $2, $3, 'claimed', NULL, 'user', $4, $5),
            ($6, $2, $7, 'skipped', 'agent_paused', 'user', $4, $8)`,
    [
      hostDeliveryReceiptId, companyA, agentId, reviewer, `issue-comment:${commentId}:assignee:${agentId}`,
      mentionedSkippedReceiptId, mentionedAgentId, `issue-comment:${commentId}:mention:${mentionedAgentId}`,
    ],
  );
  const hostDeliveryRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  await pg.query("INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, context_snapshot, wakeup_request_id) VALUES ($1, $2, $3, 'running', now(), $4, $5)", [hostDeliveryRunId, companyA, agentId, { issueId, wakeCommentId: commentId }, hostDeliveryReceiptId]);
  const rewrittenReview = await handleApiRequest(ctx, request("handoff.review-run", { verdict: "rewritten", revisedOutput: "Correct output", reason: rewriteReason, correctionCommentId: commentId, correctionDelivery: { status: "accepted", pending: [] } }, { params: { runId: rewrittenRun.id } }));
  assert.equal(rewrittenReview.status, 200);
  const approvalId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await pg.query("INSERT INTO public.approvals (id, company_id, type, status, payload) VALUES ($1, $2, 'instruction_change', 'pending', $3)", [approvalId, companyA, { sourceCommentId: commentId, targetAgentId: agentId }]);
  const hydrated = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const hydratedRuns = hydrated.jobs.find((candidate) => candidate.id === job.id)!.runs;
  assert.deepEqual(hydratedRuns.find((run) => run.id === productionRun.id)?.runCounts, { itemsRead: 2, entriesAdded: 1, changesProposed: 0 });
  assert.equal(hydratedRuns.find((run) => run.id === rewrittenRun.id)?.review?.instructionChangeApproval?.id, approvalId);
  const savedRun = hydratedRuns.find((run) => run.id === rewrittenRun.id)!;
  assert.equal(savedRun.correctionDelivery?.pending[0]?.agentId, mentionedAgentId);
  assert.match(savedRun.correctionDelivery?.pending[0]?.reason ?? "", /skipped agent delivery \(agent_paused\)/i);
  assert.equal(savedRun.correctionDelivery?.status, "pending");
  assert.deepEqual(savedRun.correctionDelivery?.pending.map((entry) => entry.agentId), [mentionedAgentId, deferredAgentId]);
  assert.match(savedRun.correctionDelivery?.pending[1]?.reason ?? "", /has not recorded an agent delivery receipt/i);
  const reviewedSnapshot = structuredClone(savedRun.review);
  const update = { correctionCommentId: commentId, delivery: pendingDelivery };
  const options = { params: { runId: rewrittenRun.id } };
  assert.equal((await handleApiRequest(ctx, request("handoff.record-correction-delivery", update, { ...options, actor: { actorType: "agent", actorId: agentId, agentId } }))).status, 403);
  assert.equal((await handleApiRequest(ctx, request("handoff.record-correction-delivery", update, { ...options, actor: { actorType: "user", actorId: "another-human", userId: "another-human" } }))).status, 400);
  assert.equal((await handleApiRequest(ctx, request("handoff.record-correction-delivery", update, { ...options, companyId: companyB }))).status, 404);
  assert.equal((await handleApiRequest(ctx, request("handoff.record-correction-delivery", { ...update, correctionCommentId: "another-comment" }, options))).status, 400);
  await pg.query("UPDATE public.agents SET name = 'RenamedReviewer' WHERE id = $1", [mentionedAgentId]);
  await pg.query(
    "INSERT INTO public.agents (id, company_id, name) VALUES ($1, $2, 'PausedReviewer')",
    ["77777777-7777-4777-8777-777777777780", companyA],
  );
  await pg.query("UPDATE public.issue_comments SET body = 'Stored correction body redacted after delivery' WHERE id = $1", [commentId]);
  const stillPendingAfterRenameAndRedaction = await stateFrom(await handleApiRequest(ctx, request("handoff.record-correction-delivery", update, options)));
  assert.deepEqual(
    stillPendingAfterRenameAndRedaction.jobs.find((candidate) => candidate.id === job.id)!.runs.find((run) => run.id === rewrittenRun.id)!.correctionDelivery?.pending.map((entry) => entry.agentId),
    [mentionedAgentId, deferredAgentId],
  );
  const mentionedRetryReceiptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
  const deliveryRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
  await pg.query(
    `INSERT INTO public.agent_wakeup_requests
       (id, company_id, agent_id, status, requested_by_actor_type, requested_by_actor_id, idempotency_key, run_id)
     VALUES ($1, $2, $3, 'coalesced', 'user', $4, $5, $6)`,
    [mentionedRetryReceiptId, companyA, mentionedAgentId, reviewer, `issue-comment:${commentId}:mention:${mentionedAgentId}`, deliveryRunId],
  );
  await pg.query("INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, context_snapshot, wakeup_request_id) VALUES ($1, $2, $3, 'running', now(), $4, $5)", [deliveryRunId, companyA, mentionedAgentId, { issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] }, mentionedSkippedReceiptId]);

  const deferredChildReceiptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3";
  const deferredParentReceiptId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4";
  const deferredDeliveryRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
  await pg.query(
    `INSERT INTO public.agent_wakeup_requests
       (id, company_id, agent_id, status, requested_by_actor_type, requested_by_actor_id, idempotency_key, payload)
     VALUES ($1, $2, $3, 'coalesced', 'user', $4, $5, $6),
            ($7, $2, $3, 'claimed', 'system', NULL, NULL, NULL)`,
    [
      deferredChildReceiptId, companyA, deferredAgentId, reviewer,
      `issue-comment:${commentId}:mention:${deferredAgentId}`,
      { deferredWakeupRequestId: deferredParentReceiptId }, deferredParentReceiptId,
    ],
  );
  await pg.query("UPDATE public.agent_wakeup_requests SET run_id = $1 WHERE id = $2", [deferredDeliveryRunId, deferredParentReceiptId]);
  await pg.query("INSERT INTO public.heartbeat_runs (id, company_id, agent_id, status, started_at, context_snapshot, wakeup_request_id) VALUES ($1, $2, $3, 'running', now(), $4, $5)", [deferredDeliveryRunId, companyA, deferredAgentId, { issueId, wakeCommentId: commentId, wakeCommentIds: [commentId] }, deferredParentReceiptId]);
  const delivered = await stateFrom(await handleApiRequest(ctx, request("handoff.record-correction-delivery", update, options)));
  const exactDeliveryRetry = await stateFrom(await handleApiRequest(ctx, request("handoff.record-correction-delivery", update, options)));
  assert.equal(exactDeliveryRetry.version, delivered.version);
  const reloaded = await stateFrom(await handleApiRequest(ctx, request("handoff.summary")));
  const acceptedRun = reloaded.jobs.find((candidate) => candidate.id === job.id)!.runs.find((run) => run.id === rewrittenRun.id)!;
  assert.equal(acceptedRun.correctionDelivery?.status, "accepted");
  assert.deepEqual(acceptedRun.review, reviewedSnapshot);
  assert.equal(reloaded.jobs.find((candidate) => candidate.id === job.id)!.rewrittenStreak, hydrated.jobs.find((candidate) => candidate.id === job.id)!.rewrittenStreak);
});

