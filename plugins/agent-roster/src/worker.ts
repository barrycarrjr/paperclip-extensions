import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { allowed, bridgeCompany, handleApiRequest, readCompanyPrefix, readRoster, RosterError } from "./service.js";

let context: PluginContext | null = null;
export const plugin = definePlugin({
  async setup(ctx) {
    context = ctx;
    ctx.data.register("roster.visible", async (params) => {
      try { const companyId = await bridgeCompany(ctx, params); return { visible: true, companyId }; }
      catch (error) { if (error instanceof RosterError && error.status === 403) return { visible: false }; throw error; }
    });
    ctx.data.register("roster.list", async (params) => readRoster(ctx, await bridgeCompany(ctx, params)));
    ctx.data.register("roster.widget", async (params) => {
      const scope = params.hostScope as { companyId?: unknown } | undefined;
      if (typeof scope?.companyId !== "string" || !await allowed(ctx, scope.companyId)) return { visible: false };
      const companyId = await bridgeCompany(ctx, params);
      const { idleCount, idleCostCents30 } = await readRoster(ctx, companyId);
      // The companion core supplies a route prefix. Keep this scoped lookup
      // for older hosts, which supply only the verified company ID.
      const companyPrefix = idleCount > 0 ? await readCompanyPrefix(ctx, companyId) : null;
      return { visible: idleCount > 0, companyId, companyPrefix, idleCount, idleCostCents30 };
    });
  },
  async onApiRequest(input) {
    return context ? handleApiRequest(context, input) : { status: 503, body: { error: "Agent roster worker is not ready." } };
  },
  async onShutdown() { context = null; },
  async onHealth() { return { status: "ok", message: "Agent roster ready" }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
