import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginApiResponse,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { createDealService, type DealService } from "./service.js";
import { createToolHandlers, handleApiRequest, type HandlerDeps, type InstanceConfig } from "./tools.js";
import { DealDeskError } from "./validate.js";

let workerCtx: PluginContext | null = null;

function makeDeps(ctx: PluginContext): HandlerDeps {
  return {
    getConfig: async () => ((await ctx.config.get()) ?? {}) as InstanceConfig,
    logger: ctx.logger,
    getService: (): DealService => {
      if (!ctx.db.namespace) {
        throw new DealDeskError("EINTERNAL", "the plugin database namespace is not ready yet. Try again shortly.");
      }
      return createDealService({ db: ctx.db });
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
        "deal-desk: allowedCompanies is empty, so every tool and route will refuse. Add the HQ company on the plugin settings page.",
      );
    }

    // Tool declarations come from the manifest so the two cannot drift.
    const handlers = createToolHandlers(deps);
    for (const decl of manifest.tools ?? []) {
      const handler = handlers[decl.name];
      if (!handler) {
        ctx.logger.error("deal-desk: manifest declares a tool with no handler", { tool: decl.name });
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
      return { status: 503, body: { error: "deal-desk worker not initialised yet" } };
    }
    return handleApiRequest(makeDeps(workerCtx), input);
  },

  async onHealth() {
    return { status: "ok", message: "deal-desk ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
