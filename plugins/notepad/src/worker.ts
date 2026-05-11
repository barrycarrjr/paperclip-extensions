import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type AgentSessionEvent,
} from "@paperclipai/plugin-sdk";
import { assertCompanyAccess, isCompanyAllowed } from "./companyAccess.js";

interface InstanceConfig {
  allowedCompanies?: string[];
  convertWithCleanup?: boolean;
  cleanupAgentId?: string;
  showInSidebar?: boolean;
}

interface NoteRow {
  id: string;
  company_id: string;
  title: string;
  body: string;
  status: "draft" | "converted" | "archived";
  converted_to_issue_id: string | null;
  converted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ConvertedJoinedRow extends NoteRow {
  issue_title: string | null;
  issue_status: string | null;
}

const CONVERT_TIMEOUT_MS = 60_000;

let workerCtx: PluginContext | null = null;

function tableName(namespace: string): string {
  return `${namespace}.notes`;
}

function rowToApi(row: NoteRow): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    body: row.body,
    status: row.status,
    convertedToIssueId: row.converted_to_issue_id,
    convertedAt: row.converted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function joinedRowToApi(row: ConvertedJoinedRow): Record<string, unknown> {
  return {
    ...rowToApi(row),
    issueTitle: row.issue_title,
    issueStatus: row.issue_status,
  };
}

function deriveTitleAndBody(noteTitle: string, noteBody: string): {
  title: string;
  body: string;
} {
  const t = noteTitle?.trim();
  if (t) return { title: t.slice(0, 80), body: noteBody };
  const firstLine = noteBody.split("\n", 1)[0]?.trim() ?? "";
  return {
    title: (firstLine || "Untitled note").slice(0, 80),
    body: noteBody,
  };
}

function extractJson(raw: string): { title: string; body: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const tries: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) tries.push(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) tries.push(trimmed.slice(start, end + 1));
  for (const candidate of tries) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { title?: unknown }).title === "string" &&
        typeof (parsed as { body?: unknown }).body === "string"
      ) {
        return {
          title: (parsed as { title: string }).title,
          body: (parsed as { body: string }).body,
        };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function buildCleanupPrompt(noteTitle: string, noteBody: string): string {
  return [
    "You are an issue-writing assistant. The user typed a freeform note — possibly just a few words, possibly a rough description.",
    "Your job is to expand and enrich it into a well-formed issue that a developer or team member could act on without guessing.",
    "Reply with ONE JSON object on a single line, no markdown, no commentary, no code fences:",
    `{"title": "<clear, actionable issue title, <=80 chars>", "body": "<expanded issue body in markdown>"}`,
    "For the body:",
    "- Infer reasonable context and intent from what was written",
    "- Add structure where helpful — for example: ## Description, ## Steps to reproduce (if a bug), ## Acceptance criteria (if a feature/task)",
    "- If the note is already detailed, preserve all facts and layer in any missing structure",
    "- Keep the tone professional and actionable",
    "- Do NOT invent specific technical details that weren't implied — expand on what's there, don't fabricate",
    "---",
    `NOTE TITLE: ${noteTitle || "(untitled)"}`,
    "NOTE BODY:",
    noteBody,
  ].join("\n");
}

async function resolveCleanupAgentId(
  ctx: PluginContext,
  config: InstanceConfig,
  companyId: string,
): Promise<string | null> {
  if (config.cleanupAgentId && config.cleanupAgentId.trim().length > 0) {
    return config.cleanupAgentId.trim();
  }

  const cacheKey = {
    scopeKind: "company" as const,
    scopeId: companyId,
    stateKey: "cleanup-agent-id",
  };
  try {
    const cached = await ctx.state.get(cacheKey);
    if (typeof cached === "string" && cached.length > 0) return cached;
  } catch {
    // state read failure — fall through to live lookup
  }

  try {
    const agents = await ctx.agents.list({ companyId, limit: 50 });
    const chatAgent = agents.find(
      (a) => (a as { role?: string }).role === "assistant",
    );
    if (chatAgent) {
      try {
        await ctx.state.set(cacheKey, chatAgent.id);
      } catch {
        // ignore cache write failures
      }
      return chatAgent.id;
    }
  } catch (err) {
    ctx.logger.warn("notepad: agents.list failed during cleanup-agent lookup", {
      companyId,
      error: (err as Error).message,
    });
  }
  return null;
}

async function runCleanupSession(
  ctx: PluginContext,
  agentId: string,
  companyId: string,
  noteTitle: string,
  noteBody: string,
): Promise<{ ok: true; title: string; body: string } | { ok: false; reason: string }> {
  let sessionId: string | null = null;
  try {
    const session = await ctx.agents.sessions.create(agentId, companyId, {
      reason: "notepad convert-to-issue",
    });
    sessionId = session.sessionId;

    let buffer = "";
    let streamError: string | null = null;
    let resolveDone: (() => void) | null = null;
    let rejectDone: ((reason: Error) => void) | null = null;
    const donePromise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const onEvent = (event: AgentSessionEvent) => {
      if (event.eventType === "chunk" && event.stream === "stdout" && event.message) {
        buffer += event.message;
      } else if (event.eventType === "error") {
        streamError = event.message ?? "unknown stream error";
        rejectDone?.(new Error(streamError));
      } else if (event.eventType === "done") {
        resolveDone?.();
      }
    };

    await ctx.agents.sessions.sendMessage(sessionId, companyId, {
      prompt: buildCleanupPrompt(noteTitle, noteBody),
      reason: "notepad convert",
      onEvent,
    });

    const timeoutPromise = new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error("cleanup timed out")),
        CONVERT_TIMEOUT_MS,
      ),
    );

    await Promise.race([donePromise, timeoutPromise]);

    if (streamError) {
      return { ok: false, reason: `agent session error: ${streamError}` };
    }
    if (!buffer.trim()) {
      return { ok: false, reason: "agent returned empty response" };
    }
    const parsed = extractJson(buffer);
    if (!parsed) {
      ctx.logger.warn("notepad: cleanup JSON parse failed", {
        companyId,
        agentId,
        rawHead: buffer.slice(0, 240),
      });
      return { ok: false, reason: "could not parse JSON from agent response" };
    }
    return {
      ok: true,
      title: parsed.title.trim().slice(0, 80) || "Untitled",
      body: parsed.body,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    if (sessionId) {
      try {
        await ctx.agents.sessions.close(sessionId, companyId);
      } catch {
        // ignore close failures
      }
    }
  }
}

// ─── Route handlers ───────────────────────────────────────────────────

async function handleListNotes(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const status = (Array.isArray(input.query.status) ? input.query.status[0] : input.query.status) ?? "draft";
  const allowed = ["draft", "converted", "archived"];
  if (!allowed.includes(status)) {
    return { status: 400, body: { error: `Unknown status filter: ${status}` } };
  }
  if (status === "converted") {
    const rows = await ctx.db.query<ConvertedJoinedRow>(
      `SELECT n.*, i.title AS issue_title, i.status AS issue_status
         FROM ${tableName(ctx.db.namespace)} n
         LEFT JOIN public.issues i ON i.id = n.converted_to_issue_id
         WHERE n.company_id = $1 AND n.status = 'converted'
         ORDER BY n.updated_at DESC
         LIMIT 500`,
      [input.companyId],
    );
    return { status: 200, body: { notes: rows.map(joinedRowToApi) } };
  }
  const rows = await ctx.db.query<NoteRow>(
    `SELECT * FROM ${tableName(ctx.db.namespace)}
       WHERE company_id = $1 AND status = $2
       ORDER BY updated_at DESC
       LIMIT 500`,
    [input.companyId, status],
  );
  return { status: 200, body: { notes: rows.map(rowToApi) } };
}

async function handleCreateNote(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as {
    title?: unknown;
    body?: unknown;
  };
  const title = typeof body.title === "string" ? body.title : "";
  const noteBody = typeof body.body === "string" ? body.body : "";
  const id = randomUUID();
  // ctx.db.execute is INSERT/UPDATE/DELETE (no RETURNING); ctx.db.query is
  // SELECT-only. So we generate the id client-side, INSERT, then SELECT.
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace)} (id, company_id, title, body)
       VALUES ($1, $2, $3, $4)`,
    [id, input.companyId, title, noteBody],
  );
  const rows = await ctx.db.query<NoteRow>(
    `SELECT * FROM ${tableName(ctx.db.namespace)} WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) {
    return { status: 500, body: { error: "Note inserted but readback returned no rows" } };
  }
  return { status: 200, body: { note: rowToApi(rows[0]!) } };
}

async function handleGetNote(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const noteId = input.params.noteId;
  if (!noteId) return { status: 400, body: { error: "Missing noteId" } };
  const rows = await ctx.db.query<NoteRow>(
    `SELECT * FROM ${tableName(ctx.db.namespace)}
       WHERE id = $1 AND company_id = $2`,
    [noteId, input.companyId],
  );
  if (rows.length === 0) {
    return { status: 404, body: { error: "[ENOTE_NOT_FOUND] note not found" } };
  }
  return { status: 200, body: { note: rowToApi(rows[0]!) } };
}

async function handleUpdateNote(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const noteId = input.params.noteId;
  if (!noteId) return { status: 400, body: { error: "Missing noteId" } };
  const body = (input.body && typeof input.body === "object" ? input.body : {}) as {
    title?: unknown;
    body?: unknown;
  };
  const setClauses: string[] = [];
  const params: unknown[] = [];
  if (typeof body.title === "string") {
    params.push(body.title);
    setClauses.push(`title = $${params.length}`);
  }
  if (typeof body.body === "string") {
    params.push(body.body);
    setClauses.push(`body = $${params.length}`);
  }
  if (setClauses.length === 0) {
    return { status: 400, body: { error: "Nothing to update — provide title and/or body" } };
  }
  setClauses.push(`updated_at = now()`);
  params.push(noteId);
  params.push(input.companyId);
  // execute = INSERT/UPDATE/DELETE; no RETURNING. Update first, then SELECT.
  const result = await ctx.db.execute(
    `UPDATE ${tableName(ctx.db.namespace)}
       SET ${setClauses.join(", ")}
       WHERE id = $${params.length - 1}
         AND company_id = $${params.length}
         AND status = 'draft'`,
    params,
  );
  if (result.rowCount === 0) {
    return {
      status: 404,
      body: { error: "[ENOTE_NOT_FOUND] note not found, belongs to another company, or is no longer in draft status" },
    };
  }
  const rows = await ctx.db.query<NoteRow>(
    `SELECT * FROM ${tableName(ctx.db.namespace)} WHERE id = $1 AND company_id = $2`,
    [noteId, input.companyId],
  );
  if (rows.length === 0) {
    return { status: 500, body: { error: "Note updated but readback returned no rows" } };
  }
  return { status: 200, body: { note: rowToApi(rows[0]!) } };
}

async function handleDeleteNote(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const noteId = input.params.noteId;
  if (!noteId) return { status: 400, body: { error: "Missing noteId" } };
  const result = await ctx.db.execute(
    `DELETE FROM ${tableName(ctx.db.namespace)}
       WHERE id = $1 AND company_id = $2`,
    [noteId, input.companyId],
  );
  if (result.rowCount === 0) {
    return { status: 404, body: { error: "[ENOTE_NOT_FOUND] note not found" } };
  }
  return { status: 200, body: { ok: true } };
}

async function handleConvertNote(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const noteId = input.params.noteId;
  if (!noteId) return { status: 400, body: { error: "Missing noteId" } };

  const config = (await ctx.config.get()) as InstanceConfig;
  const requestedCleanupRaw = Array.isArray(input.query.cleanup)
    ? input.query.cleanup[0]
    : input.query.cleanup;
  const requestedCleanup =
    requestedCleanupRaw === undefined
      ? config.convertWithCleanup !== false
      : requestedCleanupRaw !== "false";

  const noteRows = await ctx.db.query<NoteRow>(
    `SELECT * FROM ${tableName(ctx.db.namespace)}
       WHERE id = $1 AND company_id = $2`,
    [noteId, input.companyId],
  );
  if (noteRows.length === 0) {
    return { status: 404, body: { error: "[ENOTE_NOT_FOUND] note not found" } };
  }
  const note = noteRows[0]!;

  if (note.status === "converted" && note.converted_to_issue_id) {
    return {
      status: 200,
      body: {
        issueId: note.converted_to_issue_id,
        title: note.title,
        body: note.body,
        cleanupUsed: false,
        warning: "[ENOTE_ALREADY_CONVERTED] note has already been converted; returning existing issueId",
      },
    };
  }
  if (!note.body.trim()) {
    return { status: 400, body: { error: "Cannot convert an empty note" } };
  }

  let cleanupUsed = false;
  let warning: string | null = null;
  let title: string;
  let issueDescription: string;

  if (requestedCleanup) {
    const cleanupAgentId = await resolveCleanupAgentId(ctx, config, input.companyId);
    if (!cleanupAgentId) {
      warning = "[ECONVERT_FAILED_LLM] no cleanup agent available — issue created with raw text";
      const fallback = deriveTitleAndBody(note.title, note.body);
      title = fallback.title;
      issueDescription = fallback.body;
    } else {
      const result = await runCleanupSession(
        ctx,
        cleanupAgentId,
        input.companyId,
        note.title,
        note.body,
      );
      if (result.ok) {
        cleanupUsed = true;
        title = result.title;
        issueDescription = result.body;
      } else {
        warning = `[ECONVERT_FAILED_LLM] AI cleanup failed (${result.reason}) — issue created with raw text`;
        const fallback = deriveTitleAndBody(note.title, note.body);
        title = fallback.title;
        issueDescription = fallback.body;
      }
    }
  } else {
    const fallback = deriveTitleAndBody(note.title, note.body);
    title = fallback.title;
    issueDescription = fallback.body;
  }

  const operatorUserId = input.actor.actorType === "user" ? input.actor.userId ?? null : null;

  const issue = await ctx.issues.create({
    companyId: input.companyId,
    title,
    description: issueDescription,
    actor: operatorUserId ? { actorUserId: operatorUserId } : undefined,
  });

  await ctx.db.execute(
    `UPDATE ${tableName(ctx.db.namespace)}
       SET status = 'converted',
           converted_to_issue_id = $1,
           converted_at = now(),
           updated_at = now()
       WHERE id = $2 AND company_id = $3`,
    [issue.id, noteId, input.companyId],
  );

  return {
    status: 200,
    body: {
      issueId: issue.id,
      title,
      body: issueDescription,
      cleanupUsed,
      warning,
    },
  };
}

// ─── Plugin definition ─────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    workerCtx = ctx;

    ctx.data.register("notepad.sidebar-visible", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const config = (await ctx.config.get()) as InstanceConfig;
      const allowed = config.allowedCompanies ?? [];
      const showInSidebar = config.showInSidebar !== false;
      if (!companyId) return { visible: false, reason: "no companyId" };
      if (!showInSidebar) return { visible: false, reason: "showInSidebar=false" };
      const visible = isCompanyAllowed(allowed, companyId);
      return {
        visible,
        reason: visible ? "ok" : "company not in allowedCompanies",
      };
    });
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!workerCtx) {
      return { status: 503, body: { error: "notepad worker not initialised yet" } };
    }
    const ctx = workerCtx;
    const config = (await ctx.config.get()) as InstanceConfig;
    try {
      assertCompanyAccess(ctx, {
        route: input.routeKey,
        allowedCompanies: config.allowedCompanies,
        companyId: input.companyId,
      });
    } catch (err) {
      return { status: 403, body: { error: (err as Error).message } };
    }

    switch (input.routeKey) {
      case "notes.list":
        return handleListNotes(ctx, input);
      case "notes.create":
        return handleCreateNote(ctx, input);
      case "notes.get":
        return handleGetNote(ctx, input);
      case "notes.update":
        return handleUpdateNote(ctx, input);
      case "notes.delete":
        return handleDeleteNote(ctx, input);
      case "notes.convert":
        return handleConvertNote(ctx, input);
      default:
        return {
          status: 404,
          body: { error: `Unknown plugin route: ${input.routeKey}` },
        };
    }
  },

  async onConfigChanged(_newConfig: Record<string, unknown>): Promise<void> {
    workerCtx?.logger?.info?.("notepad: config changed — cleanup-agent state will refresh on next convert if cache miss");
  },

  async onHealth() {
    return { status: "ok", message: "notepad ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
