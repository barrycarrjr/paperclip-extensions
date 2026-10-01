import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { consumeObservation, observationEvent, type ObservationRequest } from "../../../lib/support-observations.js";
import { getResolvedAccount, getEngineFor } from "./engines/registry.js";
import type { InstanceConfig, ThreeCxEngine } from "./engines/types.js";
export function supportPbxAccount(cfg: InstanceConfig, companyId: string, accountKey: string) {
  const matches = (cfg.accounts ?? []).filter(item => item.key.toLowerCase() === accountKey.toLowerCase());
  if (matches.length !== 1 || !matches[0]!.supportReadEnabled || !matches[0]!.allowedCompanies?.includes(companyId)) throw new Error("Exact PBX company/account not opted in");
  return matches[0]!;
}
export async function readPbxOverview(engine: ThreeCxEngine, scope: Parameters<ThreeCxEngine["listQueues"]>[0]) {
  const reads = await Promise.allSettled([engine.listQueues(scope), engine.listExtensions(scope), engine.listAgents(scope)]);
  return { scope: scope.mode, queues: reads[0].status === "fulfilled" ? { status: "available", samples: reads[0].value.slice(0, 50).map(item => ({ id: item.id, name: item.name, extension: item.extension, agentsOn: item.agentsOn, depth: item.depth, longestWaitSec: item.longestWaitSec })), truncated: reads[0].value.length > 50 } : { status: "unavailable" },
    extensions: reads[1].status === "fulfilled" ? { status: "available", samples: reads[1].value.slice(0, 50).map(item => ({ number: item.number, displayName: item.displayName, type: item.type })), truncated: reads[1].value.length > 50 } : { status: "unavailable" },
    presence: reads[2].status === "fulfilled" ? { status: "available", samples: reads[2].value.slice(0, 50).map(item => ({ extension: item.extension, presence: item.presence, inCall: item.inCall })), truncated: reads[2].value.length > 50 } : { status: "unavailable" },
    componentsNotTested: ["voicemail", "inbound/outbound routing correctness", "desk-phone provisioning", "softphone authentication", "SBC", "PBX host or hypervisor", "AI phone assistant"], limitations: "PBX company-scoped queue/extension/presence observations only, not proof a phone/SBC/host is healthy. SBC and hypervisor are separate components. No calls, configuration changes or recording/transcript access." };
}
export async function readPbxObservation(ctx: PluginContext, request: ObservationRequest) {
  supportPbxAccount(await ctx.config.get() as InstanceConfig, request.companyId, request.account);
  const run = { companyId: request.companyId, agentId: "", runId: request.requestId, projectId: "" } as ToolRunContext;
  const resolved = await getResolvedAccount(ctx, run, "support-observation", request.account);
  const result = await readPbxOverview(getEngineFor(request.companyId, resolved.accountKey), resolved.scope);
  supportPbxAccount(await ctx.config.get() as InstanceConfig, request.companyId, request.account);
  return result;
}
export function registerPbxObservations(ctx: PluginContext) {
  ctx.events.on(observationEvent, event => consumeObservation(ctx, "3cx-tools", event, request => readPbxObservation(ctx, request)));
}
