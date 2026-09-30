import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { consumeObservation, observationEvent } from "../../../lib/support-observations.js";
import manifest, { networkTools } from "./manifest.js";
import { observeNetwork, resolveNetworkAccount, uuid, type NetworkConfig } from "./network.js";
import { restartTools, prepareRestart, executeRestart, restartStatus, reconcileRestart } from "./restarts.js";
const plugin = definePlugin({ async setup(ctx) {
  for (const tool of restartTools) ctx.tools.register(tool.name, tool, async (params, run) => {
    try {
      const input = params as Record<string, unknown>;
      return { data: tool.name === "unifi_prepare_restart" ? await prepareRestart(ctx, run, input) : tool.name === "unifi_run_restart" ? await executeRestart(ctx, run, input) : tool.name === "unifi_reconcile_restart" ? await reconcileRestart(ctx, run, input) : await restartStatus(ctx, run, input) };
    } catch (error) { return { error: error instanceof Error ? error.message : "UniFi restart operation failed. Inspect its receipt before any further action." }; }
  });
  for (const tool of networkTools) ctx.tools.register(tool.name, tool, async (params, run) => {
    try {
      if (!run.userId || !run.chatSessionId || run.userPermission !== "support:diagnose" || !uuid.test(run.companyId)) throw new Error("Use an authorized human support conversation");
      return { data: await observeNetwork(ctx, run.companyId, params as Record<string, unknown>) };
    } catch { return { error: "UniFi observation unavailable. Check saved account/site ownership, supported API/key permissions and controller TLS trust; no changes were attempted." }; }
  });
  ctx.events.on(observationEvent, event => consumeObservation(ctx, "unifi-tools", event, async request => {
    const [siteId, deviceId] = request.resourceId.split("/");
    const account = resolveNetworkAccount(await ctx.config.get() as NetworkConfig, request.companyId, request.account, siteId);
    if (!account.supportReadEnabled) throw new Error("Support Desk observations disabled");
    return observeNetwork(ctx, request.companyId, { account: request.account, siteId, deviceId, operation: request.operation, supportBridge: true });
  }));
} });
export default plugin;
runWorker(plugin, import.meta.url);
