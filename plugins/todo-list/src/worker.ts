import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";
import { computeSidebarVisibility, type SidebarConfig } from "./sidebar-visibility.js";
import {
  buildClearDone,
  buildDelete,
  buildGetQuery,
  buildInsert,
  buildListQuery,
  buildMarkPromoted,
  buildNextSortOrderQuery,
  buildUpdate,
  findByTitleMatch,
  normalizeTitle,
  parseDueAt,
  rowToApi,
  type SqlStatement,
  type TodoPatch,
  type TodoRow,
} from "./todos.js";

type InstanceConfig = SidebarConfig;

let workerCtx: PluginContext | null = null;

/**
 * The generic "we could not find it" answer.
 *
 * Deliberately identical whether the row does not exist or belongs to somebody
 * else. Distinguishing the two would let anyone with a row id probe for the
 * existence of other people's to-dos.
 */
const NOT_FOUND: PluginApiResponse = {
  status: 404,
  body: { error: "[ETODO_NOT_FOUND] to-do not found" },
};

function query<T>(ctx: PluginContext, stmt: SqlStatement): Promise<T[]> {
  return ctx.db.query<T>(stmt.text, stmt.params);
}

function execute(ctx: PluginContext, stmt: SqlStatement) {
  return ctx.db.execute(stmt.text, stmt.params);
}

/**
 * Work out whose list this request touches.
 *
 * The owner comes from the authenticated actor and from nowhere else. There is
 * no route, body field or query parameter that can name a different user, which
 * is what makes a companyless private list safe to expose over a company-scoped
 * API. Agents get nothing: a to-do list belongs to a person.
 */
function resolveOwner(input: PluginApiRequestInput): string | null {
  if (input.actor.actorType !== "user") return null;
  const userId = input.actor.userId;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

function readBody(input: PluginApiRequestInput): Record<string, unknown> {
  return input.body && typeof input.body === "object"
    ? (input.body as Record<string, unknown>)
    : {};
}

// ---- Route handlers ----

async function handleList(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  userId: string,
): Promise<PluginApiResponse> {
  const includeDoneRaw = Array.isArray(input.query.includeDone)
    ? input.query.includeDone[0]
    : input.query.includeDone;
  const rows = await query<TodoRow>(
    ctx,
    buildListQuery(ctx.db.namespace, userId, { includeDone: includeDoneRaw !== "false" }),
  );
  return { status: 200, body: { todos: rows.map(rowToApi) } };
}

async function handleCreate(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  userId: string,
): Promise<PluginApiResponse> {
  const body = readBody(input);

  const title = normalizeTitle(body.title);
  if (!title.ok) return { status: 400, body: { error: title.error } };

  const dueAt = parseDueAt(body.dueAt);
  if (!dueAt.ok) return { status: 400, body: { error: dueAt.error } };

  const nextRows = await query<{ next: number }>(
    ctx,
    buildNextSortOrderQuery(ctx.db.namespace, userId),
  );
  const sortOrder = Number(nextRows[0]?.next ?? 0);

  // ctx.db.execute takes INSERT/UPDATE/DELETE and does not support RETURNING,
  // while ctx.db.query is SELECT-only. So generate the id here, insert, and
  // read the row back.
  const id = randomUUID();
  await execute(
    ctx,
    buildInsert(ctx.db.namespace, userId, {
      id,
      title: title.value,
      dueAt: dueAt.value ?? null,
      sortOrder,
    }),
  );

  const rows = await query<TodoRow>(ctx, buildGetQuery(ctx.db.namespace, userId, id));
  if (rows.length === 0) {
    return { status: 500, body: { error: "to-do inserted but readback returned no rows" } };
  }
  return { status: 200, body: { todo: rowToApi(rows[0]!) } };
}

async function handleUpdate(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  userId: string,
): Promise<PluginApiResponse> {
  const todoId = input.params.todoId;
  if (!todoId) return { status: 400, body: { error: "Missing todoId" } };

  const body = readBody(input);
  const patch: TodoPatch = {};

  if (body.title !== undefined) {
    const title = normalizeTitle(body.title);
    if (!title.ok) return { status: 400, body: { error: title.error } };
    patch.title = title.value;
  }
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") {
      return { status: 400, body: { error: "done must be a boolean" } };
    }
    patch.done = body.done;
  }
  if (body.dueAt !== undefined) {
    const dueAt = parseDueAt(body.dueAt);
    if (!dueAt.ok) return { status: 400, body: { error: dueAt.error } };
    patch.dueAt = dueAt.value ?? null;
  }
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number" || !Number.isFinite(body.sortOrder)) {
      return { status: 400, body: { error: "sortOrder must be a finite number" } };
    }
    patch.sortOrder = body.sortOrder;
  }

  const stmt = buildUpdate(ctx.db.namespace, userId, todoId, patch);
  if (!stmt) {
    return {
      status: 400,
      body: { error: "Nothing to update. Provide title, done, dueAt and/or sortOrder." },
    };
  }

  const result = await execute(ctx, stmt);
  if (result.rowCount === 0) return NOT_FOUND;

  const rows = await query<TodoRow>(ctx, buildGetQuery(ctx.db.namespace, userId, todoId));
  if (rows.length === 0) {
    return { status: 500, body: { error: "to-do updated but readback returned no rows" } };
  }
  return { status: 200, body: { todo: rowToApi(rows[0]!) } };
}

async function handleDelete(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  userId: string,
): Promise<PluginApiResponse> {
  const todoId = input.params.todoId;
  if (!todoId) return { status: 400, body: { error: "Missing todoId" } };

  const result = await execute(ctx, buildDelete(ctx.db.namespace, userId, todoId));
  if (result.rowCount === 0) return NOT_FOUND;
  return { status: 200, body: { ok: true } };
}

async function handleClearDone(
  ctx: PluginContext,
  _input: PluginApiRequestInput,
  userId: string,
): Promise<PluginApiResponse> {
  const result = await execute(ctx, buildClearDone(ctx.db.namespace, userId));
  return { status: 200, body: { deleted: result.rowCount ?? 0 } };
}

async function handlePromote(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  userId: string,
): Promise<PluginApiResponse> {
  const todoId = input.params.todoId;
  if (!todoId) return { status: 400, body: { error: "Missing todoId" } };

  const rows = await query<TodoRow>(ctx, buildGetQuery(ctx.db.namespace, userId, todoId));
  if (rows.length === 0) return NOT_FOUND;
  const todo = rows[0]!;

  // Promoting twice would leave two issues and only one recorded link, so hand
  // back the existing one instead.
  if (todo.promoted_issue_id) {
    return {
      status: 200,
      body: {
        issueId: todo.promoted_issue_id,
        alreadyPromoted: true,
        warning:
          "[ETODO_ALREADY_PROMOTED] this to-do has already been promoted; returning the existing issue",
      },
    };
  }

  // The issue lands in whichever company the operator is currently looking at.
  // The to-do itself has no company, so this is the only sensible source, and it
  // means the choice is made by where they are standing when they click.
  //
  // No LLM cleanup pass here, unlike the Notepad plugin's convert action. A
  // to-do is already one line, so there is nothing to expand, and skipping it
  // keeps this plugin free of any model or adapter dependency.
  const issue = await ctx.issues.create({
    companyId: input.companyId,
    title: todo.title,
    actor: { actorUserId: userId },
  });

  await execute(ctx, buildMarkPromoted(ctx.db.namespace, userId, todoId, issue.id));

  return {
    status: 200,
    body: { issueId: issue.id, alreadyPromoted: false, warning: null },
  };
}

// ---- Plugin definition ----

/**
 * Work out whose list a TOOL call touches.
 *
 * `runContext.userId` is populated by the host from the authenticated session
 * (a Clippy turn, or a board user invoking a tool directly) and is stripped
 * from anything a caller supplies, so it cannot be spoofed. An ordinary agent
 * run has no person behind it and gets null.
 *
 * Read through a local cast because the published SDK's `ToolRunContext` type
 * predates the field. Drop the cast once the plugin depends on an SDK that
 * declares it.
 */
function resolveToolOwner(runCtx: ToolRunContext): string | null {
  const userId = (runCtx as ToolRunContext & { userId?: string | null }).userId;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

const NO_OWNER_ERROR =
  "[ETODO_NO_OWNER] To-dos are personal, so this only works when a signed-in person is asking. An agent run has nobody behind it and cannot read or change anyone's list.";

/**
 * Shared preamble for every tool: confirm the plugin is switched on for this
 * company, then work out whose list it is. Company and owner are separate
 * questions and both have to be answered.
 */
async function toolPreflight(
  ctx: PluginContext,
  toolName: string,
  runCtx: ToolRunContext,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const config = (await ctx.config.get()) as InstanceConfig;
  try {
    assertCompanyAccess(ctx, {
      route: toolName,
      allowedCompanies: config.allowedCompanies,
      companyId: runCtx.companyId,
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const userId = resolveToolOwner(runCtx);
  if (!userId) return { ok: false, error: NO_OWNER_ERROR };
  return { ok: true, userId };
}

/** Render an ambiguous match back to the model so it can ask rather than guess. */
function ambiguityError(match: string, candidates: { title: string }[]): string {
  const list = candidates.map((c) => `"${c.title}"`).join(", ");
  return `[ETODO_AMBIGUOUS] "${match}" matches ${candidates.length} to-dos: ${list}. Ask which one they meant and call again with a fragment that picks out just that one.`;
}

const plugin = definePlugin({
  async setup(ctx) {
    workerCtx = ctx;

    ctx.data.register("todo-list.sidebar-visible", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      const config = (await ctx.config.get()) as InstanceConfig;
      return computeSidebarVisibility(companyId, config);
    });

    // ---- Agent tools ----

    ctx.tools.register(
      "todo_add",
      {
        displayName: "Add a to-do",
        description:
          "Add an item to the operator's private personal to-do list. Not the issue tracker: personal reminders only.",
        parametersSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            dueAt: { type: "string" },
          },
          required: ["title"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const pre = await toolPreflight(ctx, "todo_add", runCtx);
        if (!pre.ok) return { error: pre.error };

        const p = (params ?? {}) as { title?: unknown; dueAt?: unknown };
        const title = normalizeTitle(p.title);
        if (!title.ok) return { error: `[EINVALID_INPUT] ${title.error}` };
        const dueAt = parseDueAt(p.dueAt);
        if (!dueAt.ok) return { error: `[EINVALID_INPUT] ${dueAt.error}` };

        const nextRows = await query<{ next: number }>(
          ctx,
          buildNextSortOrderQuery(ctx.db.namespace, pre.userId),
        );
        const id = randomUUID();
        await execute(
          ctx,
          buildInsert(ctx.db.namespace, pre.userId, {
            id,
            title: title.value,
            dueAt: dueAt.value ?? null,
            sortOrder: Number(nextRows[0]?.next ?? 0),
          }),
        );
        return {
          content: `Added "${title.value}" to your to-do list.`,
          data: { id, title: title.value, dueAt: dueAt.value ?? null },
        };
      },
    );

    ctx.tools.register(
      "todo_list",
      {
        displayName: "List to-dos",
        description: "Read back the operator's own private to-do list, in their chosen order.",
        parametersSchema: {
          type: "object",
          additionalProperties: false,
          properties: { includeDone: { type: "boolean" } },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const pre = await toolPreflight(ctx, "todo_list", runCtx);
        if (!pre.ok) return { error: pre.error };

        const includeDone = (params as { includeDone?: unknown } | undefined)?.includeDone === true;
        const rows = await query<TodoRow>(
          ctx,
          buildListQuery(ctx.db.namespace, pre.userId, { includeDone }),
        );
        const todos = rows.map(rowToApi);
        if (todos.length === 0) {
          return {
            content: includeDone ? "Your to-do list is empty." : "Nothing outstanding on your to-do list.",
            data: { todos: [] },
          };
        }
        const lines = todos.map((t) => {
          const box = t.done ? "[x]" : "[ ]";
          const due = t.dueAt ? ` (due ${t.dueAt.slice(0, 10)})` : "";
          return `${box} ${t.title}${due}`;
        });
        return { content: lines.join("\n"), data: { todos } };
      },
    );

    ctx.tools.register(
      "todo_complete",
      {
        displayName: "Tick off a to-do",
        description:
          "Mark one of the operator's to-dos as done, or put it back. Fails without changing anything when the fragment matches more than one.",
        parametersSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            match: { type: "string" },
            done: { type: "boolean" },
          },
          required: ["match"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const pre = await toolPreflight(ctx, "todo_complete", runCtx);
        if (!pre.ok) return { error: pre.error };

        const p = (params ?? {}) as { match?: unknown; done?: unknown };
        if (typeof p.match !== "string" || !p.match.trim()) {
          return { error: "[EINVALID_INPUT] `match` is required" };
        }
        const done = p.done !== false;

        const rows = await query<TodoRow>(ctx, buildListQuery(ctx.db.namespace, pre.userId));
        const found = findByTitleMatch(rows.map(rowToApi), p.match);
        if (found.kind === "none") {
          return { error: `[ETODO_NOT_FOUND] Nothing on your list matches "${p.match}".` };
        }
        if (found.kind === "many") {
          return { error: ambiguityError(p.match, found.candidates) };
        }

        await execute(
          ctx,
          buildUpdate(ctx.db.namespace, pre.userId, found.todo.id, { done })!,
        );
        return {
          content: done
            ? `Ticked off "${found.todo.title}".`
            : `Put "${found.todo.title}" back on your list.`,
          data: { id: found.todo.id, title: found.todo.title, done },
        };
      },
    );

    ctx.tools.register(
      "todo_remove",
      {
        displayName: "Delete a to-do",
        description:
          "Permanently delete one of the operator's to-dos. Prefer todo_complete when they have simply finished it.",
        parametersSchema: {
          type: "object",
          additionalProperties: false,
          properties: { match: { type: "string" } },
          required: ["match"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const pre = await toolPreflight(ctx, "todo_remove", runCtx);
        if (!pre.ok) return { error: pre.error };

        const p = (params ?? {}) as { match?: unknown };
        if (typeof p.match !== "string" || !p.match.trim()) {
          return { error: "[EINVALID_INPUT] `match` is required" };
        }

        const rows = await query<TodoRow>(ctx, buildListQuery(ctx.db.namespace, pre.userId));
        const found = findByTitleMatch(rows.map(rowToApi), p.match);
        if (found.kind === "none") {
          return { error: `[ETODO_NOT_FOUND] Nothing on your list matches "${p.match}".` };
        }
        if (found.kind === "many") {
          return { error: ambiguityError(p.match, found.candidates) };
        }

        await execute(ctx, buildDelete(ctx.db.namespace, pre.userId, found.todo.id));
        return {
          content: `Deleted "${found.todo.title}".`,
          data: { id: found.todo.id, title: found.todo.title },
        };
      },
    );
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!workerCtx) {
      return { status: 503, body: { error: "todo-list worker not initialised yet" } };
    }
    const ctx = workerCtx;

    // Gate 1: is the plugin switched on for the company being viewed?
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

    // Gate 2: whose list is this? Everything past here is scoped to that owner
    // and nothing else. See the header comment in src/todos.ts.
    const userId = resolveOwner(input);
    if (!userId) {
      return {
        status: 403,
        body: {
          error:
            "[ETODO_NO_OWNER] To-dos belong to a person. This endpoint needs a signed-in board user.",
        },
      };
    }

    switch (input.routeKey) {
      case "todos.list":
        return handleList(ctx, input, userId);
      case "todos.create":
        return handleCreate(ctx, input, userId);
      case "todos.update":
        return handleUpdate(ctx, input, userId);
      case "todos.delete":
        return handleDelete(ctx, input, userId);
      case "todos.clear-done":
        return handleClearDone(ctx, input, userId);
      case "todos.promote":
        return handlePromote(ctx, input, userId);
      default:
        return {
          status: 404,
          body: { error: `Unknown plugin route: ${input.routeKey}` },
        };
    }
  },

  async onHealth() {
    return { status: "ok", message: "todo-list ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
