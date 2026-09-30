import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { IntakeError, type Config } from "./routing.js";
import { discoverDevices } from "./network-discovery.js";
import { ns, person, openInteractiveCase, diagnoseInteractiveCase } from "./interactive-support.js";
import { resolveRemoteAccess } from "./remote-access.js";
import { evaluateHealth } from "./health-evaluation.js";

interface Fleet { id: string; company_id: string; user_id: string; chat_session_id: string; network_id: string; status: string; discovery_at: string }
interface Item { id: string; discovered_address: string; target_address: string | null; status: string; reason: string | null; case_id: string | null; asset_id: string | null; result: unknown }
function actor(run: ToolRunContext) {
  if (run.userPermission !== "support:diagnose") throw new IntakeError(403, "Paperclip must verify your investigate permission");
  return person(run);
}
async function ownedFleet(ctx: PluginContext, run: ToolRunContext, id: unknown) {
  const owner = actor(run);
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new IntakeError(422, "fleetId must be a UUID");
  const [fleet] = await ctx.db.query<Fleet>(`SELECT * FROM ${ns(ctx)}.support_fleet_checks WHERE company_id=$1 AND id=$2 AND user_id=$3 AND chat_session_id=$4`, [owner.companyId, id, owner.userId, owner.chatSessionId]);
  if (!fleet) throw new IntakeError(404, "No fleet check for this person and conversation");
  return fleet;
}
async function progress(ctx: PluginContext, run: ToolRunContext, fleetId: string) {
  const fleet = await ownedFleet(ctx, run, fleetId);
  const items = await ctx.db.query<Item>(`SELECT id,discovered_address,target_address,status,reason,case_id,asset_id,result FROM ${ns(ctx)}.support_fleet_items WHERE company_id=$1 AND fleet_id=$2 ORDER BY ordinal`, [fleet.company_id, fleet.id]);
  const counts = Object.fromEntries(["pending", "running", "succeeded", "failed", "skipped", "interrupted"].map(status => [status, items.filter(item => item.status === status).length]));
  const summaries = items.map(item => {
    const saved = item.result as { evaluation?: unknown; diagnostic?: { result?: { findings?: { sampledAtUtc?: unknown } } } } | null;
    return { ...item, result: saved ? { evaluation: saved.evaluation, sampledAtUtc: saved.diagnostic?.result?.findings?.sampledAtUtc ?? null } : null };
  });
  return { fleetId: fleet.id, status: fleet.status, discoveryAt: fleet.discovery_at, counts, items: summaries,
    distinctAuthenticatedAssets: new Set(items.filter(item => item.status === "succeeded" && item.asset_id).map(item => item.asset_id)).size,
    next: fleet.status === "planning" ? "The discovery results are being saved. Inspect progress again; if initialization was interrupted, stop this check before starting another."
      : fleet.status === "active" && counts.pending ? "Report current findings and progress, then call support_continue_fleet_check to investigate the next permitted computer. Do not stop with just discovery when asked to check for issues." : "Summarize actual findings, unavailable/failed/skipped devices and observation dates. Open a recorded case for deeper diagnosis or a confirmed repair; this check authorizes no fixes.",
    instruction: "Every succeeded item is a bounded Windows health snapshot, not proof of complete health. Skipped devices have not been assessed. Use support_get_case for full findings. Asset counts group recorded identities; conflicting identities may represent clones or renamed computers and need review. Permission and saved target access are rechecked on every continuation. Repairs need their existing authorization. Job progress is durable; commands only run during explicit tool calls, never unattended between steps." };
}
async function finish(ctx: PluginContext, companyId: string, fleetId: string) {
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_checks SET status='completed',updated_at=now() WHERE company_id=$1 AND id=$2 AND status='active'
    AND NOT EXISTS(SELECT 1 FROM ${ns(ctx)}.support_fleet_items WHERE company_id=$1 AND fleet_id=$2 AND status IN ('pending','running'))`, [companyId, fleetId]);
}
export async function startFleetCheck(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>, discover = discoverDevices) {
  const owner = actor(run);
  const limit = input.maxDevices ?? 10;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new IntakeError(422, "maxDevices must be from 1 to 20");
  if (input.targets !== undefined && (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 20 || input.targets.some(target => typeof target !== "string"))) throw new IntakeError(422, "targets must name 1 to 20 discovered full hostnames or addresses");
  const [active] = await ctx.db.query<{ id: string }>(`SELECT id FROM ${ns(ctx)}.support_fleet_checks WHERE company_id=$1 AND user_id=$2 AND chat_session_id=$3 AND status IN ('planning','active') ORDER BY created_at DESC LIMIT 1`, [owner.companyId, owner.userId, owner.chatSessionId]);
  if (active) return progress(ctx, run, active.id);
  const scan = await discover(ctx, cfg, run, { networkId: input.networkId });
  if (!("devices" in scan)) return scan;
  const targets = input.targets as string[] | undefined;
  if (targets?.some(target => !scan.devices.some(device => device.remoteTarget === target))) throw new IntakeError(422, "Select a permitted target returned by the current discovery; use the full name");
  const fleet = { id: randomUUID() };
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_fleet_checks(id,company_id,user_id,chat_session_id,network_id,discovery_at,status)
    VALUES($1,$2,$3,$4,$5,$6,'planning')`, [fleet.id, owner.companyId, owner.userId, owner.chatSessionId, scan.networkId, scan.completedAt]);
  let selected = 0;
  for (const [ordinal, device] of scan.devices.entries()) {
    let reason: string | null = !device.remoteTarget ? "No matching saved remote access and forward-verified name. Discovery only; device health was not assessed." : null;
    if (!reason && !device.openPorts.some(item => [135, 445, 5985, 5986].includes(item.port))) reason = "No Windows management service was observed. Direct device/vendor checks are required.";
    if (!reason && targets && !targets.includes(device.remoteTarget!)) reason = "Not selected for this check.";
    if (!reason && selected >= limit) reason = "Batch limit reached; start a later check with explicit targets for remaining devices.";
    if (!reason) selected++;
    await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_fleet_items(company_id,fleet_id,ordinal,discovered_address,target_address,status,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [owner.companyId, fleet.id, ordinal, device.address, device.remoteTarget, reason ? "skipped" : "pending", reason]);
  }
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_checks SET status='active',updated_at=now() WHERE company_id=$1 AND id=$2 AND status='planning'`, [owner.companyId, fleet.id]);
  // A stop may arrive while discovery rows are still being saved. Include rows
  // inserted after the stop so a cancelled job cannot retain pending work.
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_items SET status='skipped',reason='Stopped by the person before this device was checked.',completed_at=now()
    WHERE company_id=$1 AND fleet_id=$2 AND status='pending'
    AND EXISTS(SELECT 1 FROM ${ns(ctx)}.support_fleet_checks WHERE company_id=$1 AND id=$2 AND status='cancelled')`, [owner.companyId, fleet.id]);
  await finish(ctx, owner.companyId, fleet.id);
  await ctx.activity.log({ companyId: owner.companyId, message: "Fleet health check planned", entityType: "support_fleet", entityId: fleet.id, metadata: { userId: owner.userId, selected, discovered: scan.devices.length, discoveryStatus: scan.status } });
  return progress(ctx, run, fleet.id);
}
export async function continueFleetCheck(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>, diagnose = diagnoseInteractiveCase) {
  const fleet = await ownedFleet(ctx, run, input.fleetId);
  if (fleet.status !== "active") return progress(ctx, run, fleet.id);
  // An interrupted diagnostic is not called successful or silently replayed after worker loss.
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_items SET status='interrupted',reason='The previous diagnostic did not return. Review its case before starting a new check.',completed_at=now()
    WHERE company_id=$1 AND fleet_id=$2 AND status='running' AND started_at < now()-interval '8 minutes'`, [fleet.company_id, fleet.id]);
  const [item] = await ctx.db.query<Item>(`SELECT id,target_address,status FROM ${ns(ctx)}.support_fleet_items WHERE company_id=$1 AND fleet_id=$2 AND status='pending' ORDER BY ordinal LIMIT 1`, [fleet.company_id, fleet.id]);
  if (!item) { await finish(ctx, fleet.company_id, fleet.id); return progress(ctx, run, fleet.id); }
  const claimed = await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_items SET status='running',started_at=now() WHERE company_id=$1 AND fleet_id=$2 AND id=$3 AND status='pending'
    AND EXISTS(SELECT 1 FROM ${ns(ctx)}.support_fleet_checks WHERE company_id=$1 AND id=$2 AND status='active')
    AND NOT EXISTS(SELECT 1 FROM ${ns(ctx)}.support_fleet_items WHERE company_id=$1 AND fleet_id=$2 AND status='running')`, [fleet.company_id, fleet.id, item.id]);
  if (!claimed.rowCount) return progress(ctx, run, fleet.id);
  try {
    resolveRemoteAccess(cfg, fleet.company_id, item.target_address!);
    const opened = await openInteractiveCase(ctx, cfg, run, { target: item.target_address, summary: "Fleet health assessment" });
    await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_items SET case_id=$4 WHERE company_id=$1 AND fleet_id=$2 AND id=$3 AND status='running'`, [fleet.company_id, fleet.id, item.id, opened.caseId]);
    if ((await ownedFleet(ctx, run, fleet.id)).status !== "active") throw new IntakeError(409, "Fleet check was stopped before diagnostic execution");
    const diagnostic = await diagnose(ctx, cfg, run, { caseId: opened.caseId, check: "health" });
    const result = diagnostic.result as { findings: Record<string, unknown>; asset?: { assetId: string; identityConflict: boolean } };
    const evaluation = evaluateHealth(result.findings);
    await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_items SET status='succeeded',asset_id=$4,result=$5::jsonb,completed_at=now()
      WHERE company_id=$1 AND fleet_id=$2 AND id=$3 AND status='running'`, [fleet.company_id, fleet.id, item.id, result.asset?.assetId ?? null, JSON.stringify({ diagnostic, evaluation })]);
  } catch (error) {
    const failure = error instanceof IntakeError ? error.message : "The saved-access diagnostic did not complete. No health findings can be inferred; review the linked case and plugin logs.";
    ctx.logger?.warn("Fleet health diagnostic failed", { fleetId: fleet.id, itemId: item.id,
      failureType: error instanceof Error ? error.name : "unknown", status: error instanceof IntakeError ? error.status : null,
      code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null,
      reason: error instanceof IntakeError ? failure : "Internal plugin failure; raw error/output omitted." });
    await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_items SET status='failed',reason=$4,completed_at=now()
      WHERE company_id=$1 AND fleet_id=$2 AND id=$3 AND status='running'`, [fleet.company_id, fleet.id, item.id, failure]);
  }
  await finish(ctx, fleet.company_id, fleet.id);
  await ctx.activity.log({ companyId: fleet.company_id, message: "Fleet health step completed", entityType: "support_fleet", entityId: fleet.id, metadata: { userId: fleet.user_id, itemId: item.id } });
  return progress(ctx, run, fleet.id);
}
export async function getFleetCheck(ctx: PluginContext, _cfg: Config, run: ToolRunContext, input: Record<string, unknown>) { const fleet = await ownedFleet(ctx, run, input.fleetId); return progress(ctx, run, fleet.id); }
export async function stopFleetCheck(ctx: PluginContext, _cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  const fleet = await ownedFleet(ctx, run, input.fleetId);
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_checks SET status='cancelled',updated_at=now() WHERE company_id=$1 AND id=$2 AND status IN ('planning','active')`, [fleet.company_id, fleet.id]);
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_fleet_items SET status='skipped',reason='Stopped by the person before this device was checked.',completed_at=now() WHERE company_id=$1 AND fleet_id=$2 AND status='pending'`, [fleet.company_id, fleet.id]);
  await ctx.activity.log({ companyId: fleet.company_id, message: "Fleet health check stopped", entityType: "support_fleet", entityId: fleet.id, metadata: { userId: fleet.user_id } });
  return { ...await progress(ctx, run, fleet.id), instruction: "No subsequent device will be started. A diagnostic already running may still finish; stopping this job cannot reliably interrupt a remote process." };
}
