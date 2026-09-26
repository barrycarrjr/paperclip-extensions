import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { createRecordsService, type IssueLookup, type RecordsService } from "./service.js";
import { computeSidebarVisibility, type InstanceConfig } from "./sidebar-visibility.js";
import { createToolHandlers, handleApiRequest, type HandlerDeps } from "./tools.js";
import { RecordsError } from "./validate.js";

let workerCtx: PluginContext | null = null;

function toDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Issue existence check through the host. ctx.issues.get returns null for an
 * issue in another company, which is exactly the "does this issue belong to
 * the calling company" question the plugin needs answered.
 */
function makeIssueLookup(ctx: PluginContext): IssueLookup {
  return async (issueId, companyId) => {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue || issue.companyId !== companyId) return null;
    return {
      id: issue.id,
      title: issue.title,
      status: String(issue.status),
      identifier: issue.identifier ?? null,
      dueDate: toDateOnly((issue as { dueDate?: unknown }).dueDate),
    };
  };
}

function makeDeps(ctx: PluginContext): HandlerDeps {
  return {
    getConfig: async () => ((await ctx.config.get()) ?? {}) as InstanceConfig,
    logger: ctx.logger,
    getService: (): RecordsService => {
      if (!ctx.db.namespace) {
        throw new RecordsError("EINTERNAL", "the plugin database namespace is not ready yet. Try again shortly.");
      }
      return createRecordsService({ db: ctx.db, getIssue: makeIssueLookup(ctx) });
    },
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    workerCtx = ctx;
    const deps = makeDeps(ctx);

    const config = await deps.getConfig();
    if (!config.allowedCompanies || config.allowedCompanies.length === 0) {
      ctx.logger.warn(
        "business-records: allowedCompanies is empty, so every tool and route will refuse. Add the HQ company on the plugin settings page.",
      );
    }

    ctx.data.register("business-records.sidebar-visible", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : null;
      return computeSidebarVisibility(companyId, await deps.getConfig());
    });

    // Tool declarations come from the manifest so the two cannot drift.
    const handlers = createToolHandlers(deps);
    for (const decl of manifest.tools ?? []) {
      const handler = handlers[decl.name];
      if (!handler) {
        ctx.logger.error("business-records: manifest declares a tool with no handler", { tool: decl.name });
        continue;
      }
      ctx.tools.register(
        decl.name,
        { displayName: decl.displayName, description: decl.description, parametersSchema: decl.parametersSchema },
        handler,
      );
    }
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (!workerCtx) {
      return { status: 503, body: { error: "business-records worker not initialised yet" } };
    }
    return handleApiRequest(makeDeps(workerCtx), input);
  },

  async onHealth() {
    return { status: "ok", message: "business-records ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
