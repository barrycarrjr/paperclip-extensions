import { createHash } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { companyHasSupport, IntakeError, parseMessage, resolveConnection, type Config, type Connection, type IncomingMessage } from "./routing.js";
import { parseSlackWorkflowPost } from "./slack-workflow.js";
import { pollSlackWorkflows, syncSlackThread, verifySlackWorkspace } from "./slack-poller.js";
import { createReviewedIssue, type ReviewedIssueInput } from "./support-issues.js";
import { reviewCase, type CaseReviewInput } from "./case-review.js";
import { startSupportWork } from "./support-work.js";
import { createEscalationDraft, markEscalationSubmitted, type EscalationDraftInput } from "./support-escalations.js";
import { runRemoteIdentity } from "./remote-identity.js";
import { decideSupportAction, executeSupportAction, listSupportActions, markInterruptedActionUnknown, proposeSupportAction } from "./support-actions.js";
import { registerInteractiveTools } from "./interactive-tools.js";
import { registerOutboundTools } from "./outbound-tools.js";
import { listOutbound,prepareOutbound,sendOutbound,retryNotSent,recordDeliveryReceipt,reconcilePendingDeliveries } from "./support-outbound.js";
import { pinSourceAccount } from "./source-origin.js";
import { getSupportSetup, probeSetupPermission, rememberSetupIdentity } from "./support-setup.js";
import { resolveInteractiveTarget } from "./interactive-support.js";
import { diagnosticChecks } from "./diagnostic-catalog.js";
import { repairRecipes } from "./repair-catalog.js";
import { supportReferences, referenceUrl } from "./support-references.js";
import { resolveRemoteAccess } from "./remote-access.js";
import { listAssets } from "./asset-inventory.js";
import { printerHistory } from "./printer-support.js";

let context: PluginContext | null = null;

interface CaseRow {
  id: string;
  company_id: string;
  connection_id: string;
  source: string;
  external_route_id: string;
  external_conversation_id: string;
  title: string;
  status: string;
  external_url: string | null;
  first_message_at: string;
  last_message_at: string;
  service_domain: string;
  work_kind: string;
  asset_ref: string | null;
  target_address: string | null;
  access_method: string;
  order_ref: string | null;
  vendor_ref: string | null;
  resolution_summary: string | null;
  review_version: number;
}

interface MessageRow {
  id: string;
  author_kind: string;
  body: string;
  occurred_at: string;
  activity_logged_at?: string | null;
  author_external_id?: string | null;
  attachments?: { id: string; name: string; mimeType?: string; permalink?: string }[];
}

interface ThreadRow {
  id: string;
  company_id: string;
  connection_id: string;
  external_route_id: string;
  external_conversation_id: string;
  title: string;
  thread_cursor_ts: string | null;
}

async function config(ctx: PluginContext): Promise<Config> {
  return ((await ctx.config.get()) ?? {}) as Config;
}

function assertCompanyAccess(cfg: Config, companyId: unknown): asserts companyId is string {
  if (typeof companyId !== "string" || !companyHasSupport(cfg, companyId)) {
    throw new IntakeError(403, "Support Desk is not configured for this company");
  }
}

function dbNamespace(ctx: PluginContext): string {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Plugin database namespace is unavailable");
  return ctx.db.namespace;
}

async function storeMessage(ctx: PluginContext, message: IncomingMessage, connection: Connection): Promise<{ caseId: string; created: boolean }> {
  const ns = dbNamespace(ctx);

  await ctx.db.execute(
    `INSERT INTO ${ns}.support_cases
      (company_id, connection_id, source, external_route_id, external_conversation_id, title, external_url, first_message_at, last_message_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (company_id, connection_id, external_route_id, external_conversation_id) DO NOTHING`,
    [message.companyId, connection.id, connection.source, message.externalRouteId,
      message.externalConversationId, message.title, message.externalUrl ?? null, message.occurredAt],
  );
  const cases = await ctx.db.query<CaseRow>(
    `SELECT id, company_id, connection_id, source, external_route_id, external_conversation_id,
            title, status, external_url, first_message_at, last_message_at
     FROM ${ns}.support_cases
     WHERE company_id=$1 AND connection_id=$2 AND external_route_id=$3 AND external_conversation_id=$4`,
    [message.companyId, connection.id, message.externalRouteId, message.externalConversationId],
  );
  const supportCase = cases[0];
  if (!supportCase) throw new Error("Support case was not found after insertion");
  await pinSourceAccount(ctx,message.companyId,supportCase.id,message.externalAccountId);
  const inserted = await ctx.db.execute(
    `INSERT INTO ${ns}.support_messages
      (company_id, case_id, connection_id, external_route_id, external_conversation_id, external_message_id, author_kind, body, occurred_at, author_external_id, attachments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (company_id, connection_id, external_route_id, external_conversation_id, external_message_id) DO NOTHING`,
    [message.companyId, supportCase.id, connection.id, message.externalRouteId, message.externalConversationId,
      message.externalMessageId, message.authorKind, message.body, message.occurredAt,
      message.authorExternalId ?? null, JSON.stringify(message.attachments ?? [])],
  );
  if (inserted.rowCount > 0) {
    await ctx.db.execute(
      `UPDATE ${ns}.support_cases
       SET last_message_at=GREATEST(last_message_at,$2::timestamptz), updated_at=now()
       WHERE company_id=$1 AND id=$3`,
      [message.companyId, message.occurredAt, supportCase.id],
    );
  }
  const recorded = await ctx.db.query<MessageRow>(
    `SELECT id, author_kind, body, occurred_at, activity_logged_at FROM ${ns}.support_messages
     WHERE company_id=$1 AND connection_id=$2 AND external_route_id=$3
       AND external_conversation_id=$4 AND external_message_id=$5`,
    [message.companyId, connection.id, message.externalRouteId, message.externalConversationId, message.externalMessageId],
  );
  if (!recorded[0]) throw new Error("Support message was not found after insertion");
  if (!recorded[0].activity_logged_at) {
    await ctx.activity.log({
      companyId: message.companyId,
      message: `Support message received from ${connection.source}`,
      entityType: "support_case",
      entityId: supportCase.id,
      metadata: { connectionId: connection.id, externalRouteId: message.externalRouteId },
    });
    await ctx.db.execute(
      `UPDATE ${ns}.support_messages SET activity_logged_at=now() WHERE company_id=$1 AND id=$2`,
      [message.companyId, recorded[0].id],
    );
  }
  return { caseId: supportCase.id, created: inserted.rowCount > 0 };
}

async function syncStoredThread(ctx: PluginContext, connection: Connection, token: string, thread: ThreadRow, verifyWorkspace: boolean): Promise<number> {
  if (verifyWorkspace) {
    await verifySlackWorkspace(connection.externalAccountId, { token, fetch: (url, init) => ctx.http.fetch(url, init) });
  }
  // The account is pinned before fetching the thread, including legacy cases
  // with no new replies. Polling callers already verified the workspace.
  await pinSourceAccount(ctx,thread.company_id,thread.id,connection.externalAccountId);
  const result = await syncSlackThread(connection, {
    companyId: thread.company_id,
    externalRouteId: thread.external_route_id,
    parentTs: thread.external_conversation_id,
    title: thread.title,
    cursorTs: thread.thread_cursor_ts,
  }, {
    token,
    fetch: (url, init) => ctx.http.fetch(url, init),
    ingest: async (message) => {
      const current = resolveConnection(await config(ctx), message);
      await storeMessage(ctx, message, current);
    },
  });
  await ctx.db.execute(
    `UPDATE ${dbNamespace(ctx)}.support_cases
     SET thread_cursor_ts=CASE WHEN thread_cursor_ts IS NULL OR thread_cursor_ts::numeric < $3::numeric
       THEN $3::text ELSE thread_cursor_ts END, thread_checked_at=now()
     WHERE company_id=$1 AND id=$2`,
    [thread.company_id, thread.id, result.cursorTs],
  );
  return result.ingested;
}

async function ingest(ctx: PluginContext, input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const message = input.routeKey === "slack.workflow.ingest"
    ? parseSlackWorkflowPost(input.body)
    : parseMessage(input.body);
  if (input.companyId !== message.companyId) throw new IntakeError(403, "Company mismatch");
  const connection = resolveConnection(await config(ctx), message);
  if (input.routeKey === "slack.workflow.ingest" && connection.source !== "slack") {
    throw new IntakeError(422, "Workflow intake requires a Slack connection");
  }
  if (input.actor.actorType === "agent" && (!connection.ingestAgentId || input.actor.agentId !== connection.ingestAgentId)) {
    throw new IntakeError(403, "Agent is not authorized for this support connection");
  }
  const result = await storeMessage(ctx, message, connection);
  return { status: result.created ? 201 : 200, body: result };
}

const plugin = definePlugin({
  async setup(ctx) {
    context = ctx;
    registerInteractiveTools(ctx, () => config(ctx));
    registerOutboundTools(ctx, () => config(ctx));
    for (const provider of ["slack-tools","email-tools"]) ctx.events.on(`plugin.${provider}.support-delivery-receipt`,event => recordDeliveryReceipt(ctx,event));
    ctx.jobs.register("reconcile-support-deliveries",() => reconcilePendingDeliveries(ctx));
    const proposeTool = manifest.tools?.find((tool) => tool.name === "support_propose_repair");
    if (!proposeTool) throw new Error("Support repair tool declaration is missing");
    ctx.tools.register("support_propose_repair", proposeTool, async (params, runCtx) => {
      const body = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
      try {
        const cfg = await config(ctx);
        assertCompanyAccess(cfg, runCtx.companyId);
        const result = await proposeSupportAction(ctx, cfg, {
          companyId: runCtx.companyId, caseId: body.caseId as string,
          actorUserId: `agent:${runCtx.agentId}`, expectedReviewVersion: body.expectedReviewVersion as number,
          script: body.script, verificationScript: body.verificationScript,
          expectedEffect: body.expectedEffect, recoveryNotes: body.recoveryNotes,
        });
        return { content: "Repair proposal created for board review. It has not been executed.",
          data: { actionId: result.id, status: result.status, scriptSha256: result.script_sha256 } };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "Repair proposal failed" };
      }
    });
    ctx.jobs.register("poll-slack-workflows", async () => {
      const cfg = await config(ctx);
      for (const connection of cfg.connections ?? []) {
        if (connection.source !== "slack" || connection.pollingEnabled !== true) continue;
        if (!connection.botTokenRef) throw new Error(`Slack connection ${connection.id} has no bot token secret reference`);
        const token = await ctx.secrets.resolve(connection.botTokenRef);
        if (!token) throw new Error(`Slack connection ${connection.id} bot token did not resolve`);
        const namespace = `slack_${createHash("sha256").update(`${connection.id}:${connection.externalAccountId}`).digest("hex").slice(0, 20)}`;
        const count = await pollSlackWorkflows(connection, {
          token,
          fetch: (url, init) => ctx.http.fetch(url, init),
          getCursor: async (channelId) => {
            const value = await ctx.state.get({ scopeKind: "instance", namespace, stateKey: channelId });
            return typeof value === "string" ? value : null;
          },
          setCursor: (channelId, timestamp) => ctx.state.set({ scopeKind: "instance", namespace, stateKey: channelId }, timestamp),
          ingest: async (message) => {
            const current = resolveConnection(await config(ctx), message);
            await storeMessage(ctx, message, current);
          },
        });
        const routeKeys = connection.routes.map((route) => route.externalRouteId);
        if (routeKeys.length > 0 && connection.allowedCompanies.length > 0) {
          const threads = await ctx.db.query<ThreadRow>(
            `SELECT id, company_id, connection_id, external_route_id, external_conversation_id, title, thread_cursor_ts
             FROM ${dbNamespace(ctx)}.support_cases
             WHERE connection_id=$1 AND source='slack' AND external_route_id = ANY($2::text[])
               AND company_id = ANY($3::uuid[])
             ORDER BY thread_checked_at ASC NULLS FIRST, last_message_at DESC LIMIT 1`,
            [connection.id, routeKeys, connection.allowedCompanies],
          );
          const thread = threads[0];
          if (thread) {
            const messages = await syncStoredThread(ctx, connection, token, thread, false);
            ctx.logger.info("support Slack thread synced", { connectionId: connection.id, caseId: thread.id, messages });
          }
        }
        ctx.logger.info("support Slack poll completed", { connectionId: connection.id, ingested: count });
      }
    });
    ctx.data.register("support.sidebar", async (params) => ({
      visible: typeof params.companyId === "string" && /^[0-9a-f-]{36}$/i.test(params.companyId),
    }));
    ctx.data.register("support.setup", async (params) => {
      return getSupportSetup(ctx, await config(ctx), params.companyId);
    });
    ctx.data.register("support.cases", async (params) => {
      const cfg = await config(ctx);
      if (!companyHasSupport(cfg, typeof params.companyId === "string" ? params.companyId : null)) return [];
      const status = params.status ?? "all";
      if (typeof status !== "string" || !["all", "new", "triage", "waiting", "resolved"].includes(status)) {
        throw new IntakeError(422, "Invalid case status filter");
      }
      const whereStatus = status === "all" ? "" : " AND status=$2";
      return ctx.db.query<CaseRow>(
        `SELECT id, company_id, connection_id, source, external_route_id, external_conversation_id,
                title, status, service_domain, work_kind, external_url, first_message_at, last_message_at
         FROM ${dbNamespace(ctx)}.support_cases WHERE company_id=$1${whereStatus}
         ORDER BY last_message_at DESC LIMIT 100`,
        status === "all" ? [params.companyId] : [params.companyId, status],
      );
    });
    ctx.data.register("support.overview", async (params) => {
      const cfg = await config(ctx);
      if (!companyHasSupport(cfg, typeof params.companyId === "string" ? params.companyId : null)) return [];
      return ctx.db.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count FROM ${dbNamespace(ctx)}.support_cases
         WHERE company_id=$1 GROUP BY status`,
        [params.companyId],
      );
    });
    ctx.data.register("support.toolkit", async (params) => {
      const cfg = await config(ctx);
      assertCompanyAccess(cfg, params.companyId);
      const devices = await ctx.db.query<{ target_address: string; snapshot: unknown; last_seen_at: string }>(
        `SELECT target_address,snapshot,last_seen_at FROM ${dbNamespace(ctx)}.support_devices WHERE company_id=$1 ORDER BY last_seen_at DESC LIMIT 50`, [params.companyId]);
      const knowledge = await ctx.db.query(`SELECT id,title,topic,kind,body,created_at FROM ${dbNamespace(ctx)}.support_knowledge WHERE company_id=$1 ORDER BY created_at DESC LIMIT 20`, [params.companyId]);
      return { diagnostics: diagnosticChecks, repairRecipes, references: supportReferences.map(item => ({ id: item.id, title: item.title, topic: item.topic, url: referenceUrl(item) })),
        assets: await listAssets(ctx, cfg, params.companyId as string),
        printers: await printerHistory(ctx, cfg, params.companyId as string),
        fleet: await ctx.db.query(`SELECT f.id,f.status,f.created_at,
          count(*) FILTER (WHERE i.status='succeeded')::int AS assessed,
          count(*) FILTER (WHERE i.status='pending')::int AS pending,
          count(*) FILTER (WHERE i.status IN ('failed','interrupted'))::int AS unavailable,
          count(*) FILTER (WHERE i.status='skipped')::int AS skipped,
          count(*) FILTER (WHERE i.result->'evaluation'->>'needsAttention'='true')::int AS attention
          FROM ${dbNamespace(ctx)}.support_fleet_checks f LEFT JOIN ${dbNamespace(ctx)}.support_fleet_items i ON i.company_id=f.company_id AND i.fleet_id=f.id
          WHERE f.company_id=$1 GROUP BY f.id ORDER BY f.created_at DESC LIMIT 10`, [params.companyId]),
        devices: devices.filter(item => { try { resolveRemoteAccess(cfg, params.companyId as string, item.target_address); return true; } catch { return false; } }), knowledge };
    });
    ctx.data.register("support.softwareRoutes", async (params) => {
      const cfg = await config(ctx);
      if (!companyHasSupport(cfg, typeof params.companyId === "string" ? params.companyId : null)) return [];
      const routes = (cfg.softwareRoutes ?? []).filter((route) => route.reportingCompanyId === params.companyId);
      return routes.map((route) => ({
        id: route.id, productName: route.productName, destinationKind: route.destinationKind,
        destination: route.destination,
      }));
    });
    ctx.data.register("support.agents", async (params) => {
      const cfg = await config(ctx);
      if (!companyHasSupport(cfg, typeof params.companyId === "string" ? params.companyId : null)) return [];
      const agents = await ctx.agents.list({ companyId: params.companyId as string, limit: 200 });
      return agents.map((agent) => ({ id: agent.id, name: agent.name, status: agent.status }));
    });
    ctx.data.register("support.case", async (params) => {
      const cfg = await config(ctx);
      assertCompanyAccess(cfg, params.companyId);
      if (typeof params.caseId !== "string") throw new IntakeError(422, "caseId is required");
      const cases = await ctx.db.query<CaseRow>(
        `SELECT id, company_id, connection_id, source, external_route_id, external_conversation_id,
                title, status, service_domain, work_kind, asset_ref, target_address, access_method, order_ref, vendor_ref,
                  resolution_summary, symptom_outcome,symptom_evidence,symptom_basis,symptom_recorded_at,
                  review_version, external_url, first_message_at, last_message_at
         FROM ${dbNamespace(ctx)}.support_cases WHERE company_id=$1 AND id=$2`,
        [params.companyId, params.caseId],
      );
      if (!cases[0]) return null;
      const messages = await ctx.db.query<MessageRow>(
        `SELECT id, author_kind, author_external_id, body, attachments, occurred_at FROM ${dbNamespace(ctx)}.support_messages
         WHERE company_id=$1 AND case_id=$2 ORDER BY occurred_at ASC LIMIT 500`,
        [params.companyId, params.caseId],
      );
      const links = await ctx.db.query<{ issue_id: string; issue_kind: string }>(
        `SELECT issue_id, issue_kind FROM ${dbNamespace(ctx)}.support_issue_links
         WHERE company_id=$1 AND case_id=$2 AND issue_id IS NOT NULL`,
        [params.companyId, params.caseId],
      );
      const linked = links[0]?.issue_id ? await ctx.issues.get(links[0].issue_id, params.companyId) : null;
      const escalations = await ctx.db.query<{ id: string; route_id: string; product_name: string;
        destination_kind: string; destination: string; title: string; evidence: string; status: string; external_ticket_ref: string | null }>(
        `SELECT id, route_id, product_name, destination_kind, destination, title, evidence,
                status, external_ticket_ref FROM ${dbNamespace(ctx)}.support_escalations
         WHERE company_id=$1 AND case_id=$2`, [params.companyId, params.caseId],
      );
      const actions = await listSupportActions(ctx, params.companyId as string, params.caseId);
      const diagnostics = await ctx.db.query(`SELECT check_kind,result,created_at FROM ${dbNamespace(ctx)}.support_diagnostics WHERE company_id=$1 AND case_id=$2 ORDER BY created_at DESC LIMIT 20`, [params.companyId, params.caseId]);
      const outbound = await listOutbound(ctx,params.companyId as string,params.caseId);
      return { supportCase: cases[0], messages, actions, diagnostics, outbound, linkedIssue: linked ? {
        id: linked.id, identifier: linked.identifier, title: linked.title, status: linked.status,
        assigneeAgentId: linked.assigneeAgentId, kind: links[0]!.issue_kind,
      } : null, escalation: escalations[0] ?? null };
    });
  },
  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!context) return { status: 503, body: { error: "Support Desk is starting" } };
    if (!input.routeKey.startsWith("setup.permission.") && !input.routeKey.startsWith("cases.outbound.") && input.routeKey !== "messages.ingest" && input.routeKey !== "slack.workflow.ingest" &&
        input.routeKey !== "remote.identity.setup" &&
        input.routeKey !== "cases.issue.create" && input.routeKey !== "cases.review" &&
        input.routeKey !== "cases.sync" && input.routeKey !== "cases.remote.identity" && input.routeKey !== "cases.work.start" &&
        input.routeKey !== "cases.actions.propose" && input.routeKey !== "cases.actions.decide" && input.routeKey !== "cases.actions.execute" && input.routeKey !== "cases.actions.reconcile" &&
        input.routeKey !== "cases.escalation.create" && input.routeKey !== "cases.escalation.submitted") {
      return { status: 404, body: { error: "Unknown route" } };
    }
    try {
      if (input.routeKey.startsWith("setup.permission.")) return probeSetupPermission(input);
      if (["cases.outbound.draft","cases.outbound.send","cases.outbound.retry"].includes(input.routeKey)) {
        if (input.actor.actorType !== "user" || !input.actor.userId || input.actor.grantedPermission !== "support:respond") throw new IntakeError(403,"A person with support reply permission is required");
        const cfg = await config(context);
        assertCompanyAccess(cfg,input.companyId);
        const body = input.body as Record<string,unknown> | null;
        if (!body || body.companyId !== input.companyId) throw new IntakeError(403,"Company mismatch");
        const scope = { companyId: input.companyId,caseId: input.params.caseId,actorUserId: input.actor.userId };
        const result = input.routeKey === "cases.outbound.draft" ? await prepareOutbound(context,cfg,{ ...scope,kind: body.kind,routeId: body.routeId,body: body.body,subject: body.subject,expectedReviewVersion: body.expectedReviewVersion })
          : input.routeKey === "cases.outbound.retry" ? await retryNotSent(context,{ ...scope,deliveryId: body.deliveryId })
          : await sendOutbound(context,cfg,{ ...scope,deliveryId: body.deliveryId,contentSha256: body.contentSha256 });
        return { status: 200,body: result };
      }
      if (input.routeKey === "remote.identity.setup") {
        if (input.actor.grantedPermission !== "support:diagnose") throw new IntakeError(403, "Paperclip must verify your diagnostic permission");
        if (input.actor.actorType !== "user" || !input.actor.userId) throw new IntakeError(403, "Board user required");
        const body = input.body && typeof input.body === "object" && !Array.isArray(input.body)
          ? input.body as Record<string, unknown> : {};
        if (body.companyId !== input.companyId || typeof body.target !== "string" || !body.target.trim()) {
          throw new IntakeError(422, "Company and computer target are required");
        }
        const cfg = await config(context);
        const target = resolveInteractiveTarget(cfg, input.companyId, body.target);
        await context.activity.log({
          companyId: input.companyId, message: "Remote setup identity diagnostic requested",
          entityType: "company", entityId: input.companyId,
          metadata: { target, actorUserId: input.actor.userId },
        });
        let identityPassed = false;
        try {
          const result = await runRemoteIdentity(context, cfg, {
            companyId: input.companyId, caseReference: "SETUP-TEST", target,
          });
          identityPassed = true;
          await rememberSetupIdentity(context, cfg, input.companyId, target, result);
          await context.activity.log({
            companyId: input.companyId, message: "Remote setup identity diagnostic succeeded",
            entityType: "company", entityId: input.companyId,
            metadata: { target, actorUserId: input.actor.userId, runId: result.runId },
          });
          return { status: 200, body: result };
        } catch (error) {
          // Invalid targets have no profile to record. Never replace the
          // original diagnostic error with a settings-history failure.
          if (!identityPassed) {
            try { await rememberSetupIdentity(context, cfg, input.companyId, target, null); } catch { /* Diagnostic error reported below. */ }
          }
          await context.activity.log({
            companyId: input.companyId, message: "Remote setup identity diagnostic failed",
            entityType: "company", entityId: input.companyId,
            metadata: { target, actorUserId: input.actor.userId },
          });
          throw error;
        }
      }
      if (input.routeKey === "cases.issue.create" || input.routeKey === "cases.review" ||
          input.routeKey === "cases.sync" || input.routeKey === "cases.remote.identity" || input.routeKey === "cases.work.start" ||
          input.routeKey === "cases.actions.propose" || input.routeKey === "cases.actions.decide" || input.routeKey === "cases.actions.execute" || input.routeKey === "cases.actions.reconcile" ||
          input.routeKey === "cases.escalation.create" || input.routeKey === "cases.escalation.submitted") {
        if (input.actor.actorType !== "user" || !input.actor.userId) throw new IntakeError(403, "Board user required");
        const cfg = await config(context);
        assertCompanyAccess(cfg, input.companyId);
        const body = input.body && typeof input.body === "object" && !Array.isArray(input.body)
          ? input.body as Record<string, unknown> : {};
        if (body.companyId !== input.companyId) throw new IntakeError(403, "Company mismatch");
        const permission = manifest.apiRoutes?.find((route) => route.routeKey === input.routeKey)?.requiredUserPermission;
        if (permission && input.actor.grantedPermission !== permission) throw new IntakeError(403, "Paperclip must verify your support permission; update the host if needed");
        if (input.routeKey === "cases.actions.propose") {
          const result = await proposeSupportAction(context, cfg, {
            companyId: input.companyId, caseId: input.params.caseId, actorUserId: input.actor.userId,
            expectedReviewVersion: body.expectedReviewVersion as number, script: body.script,
            verificationScript: body.verificationScript, expectedEffect: body.expectedEffect,
            recoveryNotes: body.recoveryNotes,
          });
          return { status: 201, body: result };
        }
        if (input.routeKey === "cases.actions.decide") {
          const result = await decideSupportAction(context, {
            companyId: input.companyId, caseId: input.params.caseId, actionId: input.params.actionId,
            actorUserId: input.actor.userId, decision: body.decision as "approved" | "rejected",
          });
          return { status: 200, body: result };
        }
        if (input.routeKey === "cases.actions.execute") {
          const result = await executeSupportAction(context, cfg, {
            companyId: input.companyId, caseId: input.params.caseId, actionId: input.params.actionId,
            actorUserId: input.actor.userId,
          });
          return { status: 200, body: result };
        }
        if (input.routeKey === "cases.actions.reconcile") {
          const result = await markInterruptedActionUnknown(context, {
            companyId: input.companyId, caseId: input.params.caseId, actionId: input.params.actionId,
            actorUserId: input.actor.userId,
          });
          return { status: 200, body: result };
        }
        if (input.routeKey === "cases.remote.identity") {
          const rows = await context.db.query<Pick<CaseRow, "id" | "target_address" | "service_domain" | "review_version">>(
            `SELECT id, target_address, service_domain, review_version FROM ${dbNamespace(context)}.support_cases WHERE company_id=$1 AND id=$2`,
            [input.companyId, input.params.caseId],
          );
          const supportCase = rows[0];
          if (!supportCase) throw new IntakeError(404, "Support case not found in this company");
          if (!supportCase.target_address || !["it", "equipment"].includes(supportCase.service_domain)) {
            throw new IntakeError(422, "Review an IT or equipment target before testing access");
          }
          if (body.expectedReviewVersion !== supportCase.review_version) {
            throw new IntakeError(409, "Case review changed; refresh before testing access");
          }
          await context.activity.log({
            companyId: input.companyId,
            message: "Remote identity diagnostic requested",
            entityType: "support_case",
            entityId: supportCase.id,
            metadata: { target: supportCase.target_address, actorUserId: input.actor.userId },
          });
          try {
            const result = await runRemoteIdentity(context, cfg, {
              companyId: input.companyId,
              caseReference: supportCase.id,
              target: supportCase.target_address,
            });
            await context.activity.log({
              companyId: input.companyId,
              message: "Remote identity diagnostic succeeded",
              entityType: "support_case",
              entityId: supportCase.id,
              metadata: { target: supportCase.target_address, actorUserId: input.actor.userId, runId: result.runId },
            });
            return { status: 200, body: result };
          } catch (error) {
            await context.activity.log({
              companyId: input.companyId,
              message: "Remote identity diagnostic failed",
              entityType: "support_case",
              entityId: supportCase.id,
              metadata: { target: supportCase.target_address, actorUserId: input.actor.userId },
            });
            throw error;
          }
        }
        if (input.routeKey === "cases.escalation.create") {
          const result = await createEscalationDraft(context, {
            companyId: input.companyId, caseId: input.params.caseId, routeId: body.routeId,
            title: body.title, evidence: body.evidence, actorUserId: input.actor.userId,
          } as EscalationDraftInput, cfg);
          return { status: result.created ? 201 : 200, body: result };
        }
        if (input.routeKey === "cases.escalation.submitted") {
          const result = await markEscalationSubmitted(context, {
            companyId: input.companyId, caseId: input.params.caseId,
            externalTicketRef: body.externalTicketRef as string, actorUserId: input.actor.userId,
          });
          return { status: 200, body: result };
        }
        if (input.routeKey === "cases.work.start") {
          const result = await startSupportWork(context, {
            companyId: input.companyId, caseId: input.params.caseId, actorUserId: input.actor.userId,
          });
          return { status: 200, body: result };
        }
        if (input.routeKey === "cases.sync") {
          const rows = await context.db.query<ThreadRow>(
            `SELECT id, company_id, connection_id, external_route_id, external_conversation_id, title, thread_cursor_ts
             FROM ${dbNamespace(context)}.support_cases WHERE company_id=$1 AND id=$2 AND source='slack'`,
            [input.companyId, input.params.caseId],
          );
          const thread = rows[0];
          if (!thread) throw new IntakeError(404, "Slack support case not found in this company");
          const matches = (cfg.connections ?? []).filter((item) => item.id === thread.connection_id && item.source === "slack");
          if (matches.length !== 1) throw new IntakeError(409, "Slack connection is not configured uniquely");
          const connection = matches[0]!;
          if (!connection.botTokenRef) throw new IntakeError(422, "Slack bot token secret is not configured");
          const token = await context.secrets.resolve(connection.botTokenRef);
          if (!token) throw new IntakeError(422, "Slack bot token secret did not resolve");
          const messages = await syncStoredThread(context, connection, token, thread, true);
          return { status: 200, body: { messages } };
        }
        if (input.routeKey === "cases.review") {
          const result = await reviewCase(context, {
            companyId: input.companyId,
            caseId: input.params.caseId,
            actorUserId: input.actor.userId,
            expectedVersion: body.expectedVersion,
            serviceDomain: body.serviceDomain,
            workKind: body.workKind,
            status: body.status,
            assetRef: body.assetRef,
            targetAddress: body.targetAddress,
            accessMethod: body.accessMethod,
            orderRef: body.orderRef,
            vendorRef: body.vendorRef,
            resolutionSummary: body.resolutionSummary,
          } as CaseReviewInput);
          return { status: 200, body: result };
        }
        const result = await createReviewedIssue(context, {
          companyId: input.companyId,
          caseId: input.params.caseId,
          projectId: body.projectId ?? null,
          assigneeAgentId: body.assigneeAgentId ?? null,
          kind: body.kind,
          title: body.title,
          evidence: body.evidence,
          actorUserId: input.actor.userId,
        } as ReviewedIssueInput);
        return { status: result.created ? 201 : 200, body: result };
      }
      return await ingest(context, input);
    } catch (error) {
      if (error instanceof IntakeError) return { status: error.status, body: { error: error.message } };
      context.logger.error("customer-support intake failed", { error: String(error) });
      return { status: 500, body: { error: "Support intake failed" } };
    }
  },
  async onHealth() {
    return { status: "ok", message: "customer-support ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
