import {
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { tasks as tasksApi } from "@googleapis/tasks";
import {
  ensureMutationsAllowed,
  getGoogleAccount,
  type InstanceConfig,
  wrapGoogleError,
} from "../googleAuth.js";
import { TASKS_TOOLS } from "../schemas.js";
import { track } from "../telemetry.js";
import { getCached, putCached } from "../idempotency.js";

function findSchema(name: string) {
  const s = TASKS_TOOLS.find((t) => t.name === name);
  if (!s) throw new Error(`tasks schema missing: ${name}`);
  return s;
}

export function registerTasksTools(ctx: PluginContext): void {
  // ---- gtasks_list_lists ----
  {
    const schema = findSchema("gtasks_list_lists");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as { account?: string };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gtasks_list_lists", p.account);
          const tasks = tasksApi({ version: "v1", auth: resolved.oauth2Client });
          const res = await tasks.tasklists.list({ maxResults: 100 });
          const lists = (res.data.items ?? []).map((l) => ({
            id: l.id,
            title: l.title,
            updated: l.updated,
          }));
          await track(ctx, runCtx, "gtasks_list_lists", resolved.accountKey, {
            count: lists.length,
          });
          return {
            content: `Found ${lists.length} task list(s).`,
            data: { lists },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gtasks_list_tasks ----
  {
    const schema = findSchema("gtasks_list_tasks");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          listId?: string;
          showCompleted?: boolean;
          showHidden?: boolean;
          dueMin?: string;
          dueMax?: string;
          maxResults?: number;
          pageToken?: string;
        };
        if (!p.listId) return { error: "[EINVALID_INPUT] `listId` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gtasks_list_tasks", p.account);
          const tasks = tasksApi({ version: "v1", auth: resolved.oauth2Client });
          const res = await tasks.tasks.list({
            tasklist: p.listId,
            showCompleted: !!p.showCompleted,
            showHidden: !!p.showHidden,
            dueMin: p.dueMin,
            dueMax: p.dueMax,
            maxResults: p.maxResults ?? 100,
            pageToken: p.pageToken,
          });
          const items = (res.data.items ?? []).map((t) => ({
            id: t.id,
            title: t.title,
            notes: t.notes,
            status: t.status,
            due: t.due,
            completed: t.completed,
            updated: t.updated,
            parent: t.parent,
            position: t.position,
          }));
          await track(ctx, runCtx, "gtasks_list_tasks", resolved.accountKey, {
            count: items.length,
          });
          return {
            content: `Found ${items.length} task(s) in list ${p.listId}.`,
            data: { tasks: items, nextPageToken: res.data.nextPageToken ?? null },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gtasks_create_task (mutation) ----
  {
    const schema = findSchema("gtasks_create_task");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          listId?: string;
          title?: string;
          notes?: string;
          due?: string;
          parent?: string;
          previous?: string;
          idempotencyKey?: string;
        };
        if (!p.listId) return { error: "[EINVALID_INPUT] `listId` is required" };
        if (!p.title) return { error: "[EINVALID_INPUT] `title` is required" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gtasks_create_task");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gtasks_create_task", p.account);
          const cached = getCached(runCtx.companyId, "gtasks_create_task", p.idempotencyKey);
          if (cached) return cached;

          const tasks = tasksApi({ version: "v1", auth: resolved.oauth2Client });
          const res = await tasks.tasks.insert({
            tasklist: p.listId,
            parent: p.parent,
            previous: p.previous,
            requestBody: { title: p.title, notes: p.notes, due: p.due },
          });
          await track(ctx, runCtx, "gtasks_create_task", resolved.accountKey);
          const out: ToolResult = {
            content: `Task created: ${res.data.title ?? p.title} (id ${res.data.id}).`,
            data: { task: res.data },
          };
          putCached(runCtx.companyId, "gtasks_create_task", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gtasks_update_task (mutation) ----
  {
    const schema = findSchema("gtasks_update_task");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          listId?: string;
          taskId?: string;
          patch?: Record<string, unknown>;
          idempotencyKey?: string;
        };
        if (!p.listId) return { error: "[EINVALID_INPUT] `listId` is required" };
        if (!p.taskId) return { error: "[EINVALID_INPUT] `taskId` is required" };
        if (!p.patch || typeof p.patch !== "object") {
          return { error: "[EINVALID_INPUT] `patch` is required" };
        }

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gtasks_update_task");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gtasks_update_task", p.account);
          const cached = getCached(runCtx.companyId, "gtasks_update_task", p.idempotencyKey);
          if (cached) return cached;

          const tasks = tasksApi({ version: "v1", auth: resolved.oauth2Client });
          const res = await tasks.tasks.patch({
            tasklist: p.listId,
            task: p.taskId,
            requestBody: p.patch,
          });
          await track(ctx, runCtx, "gtasks_update_task", resolved.accountKey);
          const out: ToolResult = {
            content: `Task ${p.taskId} updated.`,
            data: { task: res.data },
          };
          putCached(runCtx.companyId, "gtasks_update_task", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gtasks_complete_task (mutation) ----
  {
    const schema = findSchema("gtasks_complete_task");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          listId?: string;
          taskId?: string;
          idempotencyKey?: string;
        };
        if (!p.listId) return { error: "[EINVALID_INPUT] `listId` is required" };
        if (!p.taskId) return { error: "[EINVALID_INPUT] `taskId` is required" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gtasks_complete_task");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gtasks_complete_task", p.account);
          const cached = getCached(runCtx.companyId, "gtasks_complete_task", p.idempotencyKey);
          if (cached) return cached;

          const tasks = tasksApi({ version: "v1", auth: resolved.oauth2Client });
          const res = await tasks.tasks.patch({
            tasklist: p.listId,
            task: p.taskId,
            requestBody: { status: "completed" },
          });
          await track(ctx, runCtx, "gtasks_complete_task", resolved.accountKey);
          const out: ToolResult = {
            content: `Task ${p.taskId} marked complete.`,
            data: { task: res.data },
          };
          putCached(runCtx.companyId, "gtasks_complete_task", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gtasks_delete_task (mutation) ----
  {
    const schema = findSchema("gtasks_delete_task");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          listId?: string;
          taskId?: string;
          idempotencyKey?: string;
        };
        if (!p.listId) return { error: "[EINVALID_INPUT] `listId` is required" };
        if (!p.taskId) return { error: "[EINVALID_INPUT] `taskId` is required" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gtasks_delete_task");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gtasks_delete_task", p.account);
          const cached = getCached(runCtx.companyId, "gtasks_delete_task", p.idempotencyKey);
          if (cached) return cached;

          const tasks = tasksApi({ version: "v1", auth: resolved.oauth2Client });
          await tasks.tasks.delete({ tasklist: p.listId, task: p.taskId });
          await track(ctx, runCtx, "gtasks_delete_task", resolved.accountKey);
          const out: ToolResult = {
            content: `Task ${p.taskId} deleted.`,
            data: { deleted: true, taskId: p.taskId },
          };
          putCached(runCtx.companyId, "gtasks_delete_task", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }
}
