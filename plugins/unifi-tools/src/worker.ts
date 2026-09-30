import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { consumeObservation, observationEvent } from "../../../lib/support-observations.js";
import manifest, { networkTools } from "./manifest.js";
import { observeNetwork, resolveNetworkAccount, uuid, type NetworkConfig } from "./network.js";
const plugin = definePlugin({ async setup(ctx) {
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
