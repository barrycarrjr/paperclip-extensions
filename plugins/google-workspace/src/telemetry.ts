import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";

export async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  accountKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.telemetry.track(`google-workspace.${tool}`, {
      account: accountKey,
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // telemetry failures should never break tool calls
  }
}
