import { createHash } from "node:crypto";
import type { PaperclipPluginManifestV1, PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError, companyHasSupport, type Config } from "./routing.js";
import { ns, person } from "./interactive-support.js";
import { verifySlackWorkspace } from "./slack-poller.js";

type Policy = NonNullable<Config["dailySummaries"]>[number];
export function summaryPolicy(cfg: Config, companyId: string) {
  const policies = (cfg.dailySummaries ?? []).filter(item => item.companyId === companyId);
  if (policies.length !== 1) throw new IntakeError(422, "Save exactly one daily summary policy for this company");
  const policy = policies[0]!;
  if (!/^[CG][A-Z0-9]{8,}$/.test(policy.channelId) || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(policy.sendAt) || typeof policy.enabled !== "boolean" || (policy.timezone !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(policy.timezone))) throw new IntakeError(422, "Choose a Slack channel ID, IANA timezone and HH:MM send time");
  try { new Intl.DateTimeFormat("en", { timeZone: policy.timezone }).format(); } catch { throw new IntakeError(422, "Unknown summary timezone"); }
  const connections = (cfg.connections ?? []).filter(item => item.id === policy.connectionId);
  const connection = connections[0];
  if (connections.length !== 1 || !connection || connection.source !== "slack" || !connection.allowedCompanies.includes(companyId) || !connection.routes.some(route => route.companyId === companyId) || !connection.botTokenRef) throw new IntakeError(403, "Summary requires this company's saved Slack intake connection and bot Secret");
  return { policy, connection, hash: createHash("sha256").update(JSON.stringify([policy, connection.externalAccountId, connection.botTokenRef, connection.allowedCompanies, connection.routes])).digest("hex") };
}
export function summaryClock(policy: Policy, now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: policy.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const value = (key: string) => parts.find(part => part.type === key)!.value;
  const localDate = `${value("year")}-${value("month")}-${value("day")}`;
  const reportDay = new Date(Date.parse(`${localDate}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return { reportDay, due: policy.enabled && `${value("hour")}:${value("minute")}` >= policy.sendAt };
}
export async function previewSummary(ctx: PluginContext, cfg: Config, companyId: string, now = new Date()) {
  if (!companyHasSupport(cfg, companyId)) throw new IntakeError(403, "Support is not configured for this company");
  const resolved = summaryPolicy(cfg, companyId), clock = summaryClock(resolved.policy, now);
  const params = [companyId, resolved.policy.timezone, clock.reportDay];
  const [cases] = await ctx.db.query<{ opened: number; open_now: number }>(`SELECT COUNT(*) FILTER(WHERE (created_at AT TIME ZONE $2)::date=$3::date)::integer AS opened,COUNT(*) FILTER(WHERE status <> 'resolved')::integer AS open_now FROM ${ns(ctx)}.support_cases WHERE company_id=$1`, params);
  const actions = await ctx.db.query<{ status: string; count: number }>(`SELECT status,COUNT(*)::integer AS count FROM ${ns(ctx)}.support_actions WHERE company_id=$1 AND (updated_at AT TIME ZONE $2)::date=$3::date GROUP BY status`, params);
  const [outcomes] = await ctx.db.query<{ count: number }>(`SELECT COUNT(*)::integer AS count FROM ${ns(ctx)}.support_cases WHERE company_id=$1 AND symptom_outcome='resolved' AND (symptom_recorded_at AT TIME ZONE $2)::date=$3::date`, params);
  const counts = Object.fromEntries(actions.map(item => [item.status, item.count]));
  const body = `Support summary for ${clock.reportDay} (${resolved.policy.timezone})\nNew cases: ${cases?.opened ?? 0}\nOpen cases now: ${cases?.open_now ?? 0}\nConfirmed resolved symptoms: ${outcomes?.count ?? 0}\nActions last updated on that day: verified ${counts.verified ?? 0}; awaiting approval ${(counts.proposed ?? 0) + (counts.approved ?? 0)}; failed ${(counts.repair_failed ?? 0) + (counts.verification_failed ?? 0)}; uncertain ${(counts.unknown ?? 0) + (counts.running ?? 0)}.\nCounts only. Verified commands do not prove the reported symptom is resolved. This is a current database snapshot, not a historical end-of-day backlog.`;
  return { ...resolved, ...clock, body };
}
/** Saved opt-in authorizes aggregate reporting only. A unique daily claim precedes delivery. */
export async function sendDailySummary(ctx: PluginContext, getConfig: () => Promise<Config>, companyId: string, now = new Date()) {
  const summary = await previewSummary(ctx, await getConfig(), companyId, now);
  if (!summary.due) return { status: "not_due" };
  const [existing] = await ctx.db.query<{ status: string; external_reference: string | null }>(`SELECT status,external_reference FROM ${ns(ctx)}.support_daily_summaries WHERE company_id=$1 AND report_day=$2::date`, [companyId, summary.reportDay]);
  if (existing) return existing;
  const token = await ctx.secrets.resolve(summary.connection.botTokenRef!);
  await verifySlackWorkspace(summary.connection.externalAccountId, { token, fetch: (url, init) => ctx.http.fetch(url, init) });
  const fresh = summaryPolicy(await getConfig(), companyId);
  if (fresh.hash !== summary.hash || !fresh.policy.enabled) throw new IntakeError(409, "Summary configuration changed before sending");
  const claimed = await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_daily_summaries(company_id,report_day,timezone,config_sha256,connection_id,channel_id,body) VALUES($1,$2::date,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [companyId, summary.reportDay, summary.policy.timezone, summary.hash, summary.connection.id, summary.policy.channelId, summary.body]);
  if (claimed.rowCount !== 1) return { status: "already_claimed" };
  let status = "unknown", reference: string | null = null;
  try {
    const response = await ctx.http.fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel: summary.policy.channelId, text: summary.body, unfurl_links: false, unfurl_media: false }) });
    const result = await response.json() as { ok?: boolean; channel?: string; ts?: string; error?: string };
    if (response.ok && result.ok === true && result.channel === summary.policy.channelId && /^\d{10,11}\.\d{1,6}$/.test(result.ts ?? "")) { status = "sent"; reference = `${result.channel}:${result.ts}`; }
    else if (response.ok && result.ok === false && ["missing_scope", "not_in_channel", "channel_not_found", "invalid_auth", "token_revoked", "account_inactive", "restricted_action"].includes(result.error ?? "")) status = "not_sent";
  } catch { /* Unknown receipt is retained and never automatically replayed. */ }
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_daily_summaries SET status=$3,external_reference=$4,updated_at=now() WHERE company_id=$1 AND report_day=$2::date AND status='pending'`, [companyId, summary.reportDay, status, reference]);
  await ctx.activity.log({ companyId, message: `Aggregate daily support summary ${status}`, entityType: "support_summary", entityId: summary.reportDay, metadata: { status, reference } });
  return { status, reference };
}
export async function runDailySummaries(ctx: PluginContext, getConfig: () => Promise<Config>) {
  await ctx.db.execute(`UPDATE ${ns(ctx)}.support_daily_summaries SET status='unknown',updated_at=now() WHERE status='pending' AND started_at < now()-interval '10 minutes'`);
  for (const policy of (await getConfig()).dailySummaries ?? []) {
    if (!policy.enabled) continue;
    try { await sendDailySummary(ctx, getConfig, policy.companyId); }
    catch { await ctx.activity.log({ companyId: policy.companyId, message: "Daily support summary needs configuration review", entityType: "support_summary", metadata: { delivered: false } }); }
  }
}
export const dailySummaryTools: NonNullable<PaperclipPluginManifestV1["tools"]> = [{ name: "support_preview_daily_summary", displayName: "Preview daily support summary", requiredUserPermission: "support:diagnose",
  description: "Preview yesterday's company-scoped aggregate support counts using its saved daily summary timezone/channel policy. Does not send. Includes current open backlog, confirmed symptom outcomes and latest action states; no requester text, computer names, staff names or credentials. Saved enabled schedule permits one daily Slack delivery; unknown deliveries never auto-retry.", parametersSchema: { type: "object", additionalProperties: false, properties: {} } }];
export function registerDailySummaryTools(ctx: PluginContext, getConfig: () => Promise<Config>) {
  ctx.tools.register(dailySummaryTools[0]!.name, dailySummaryTools[0]!, async (_params, run) => {
    try {
      const actor = person(run); if (run.userPermission !== "support:diagnose") throw new IntakeError(403, "Diagnostic permission required");
      const preview = await previewSummary(ctx, await getConfig(), actor.companyId);
      const deliveries = await ctx.db.query(`SELECT report_day,status,external_reference,started_at FROM ${ns(ctx)}.support_daily_summaries WHERE company_id=$1 ORDER BY report_day DESC LIMIT 7`, [actor.companyId]);
      return { data: { reportDay: preview.reportDay, timezone: preview.policy.timezone, channelId: preview.policy.channelId, enabled: preview.policy.enabled, body: preview.body, recentDeliveries: deliveries } };
    } catch (error) { return { error: error instanceof IntakeError ? error.message : "Summary preview failed" }; }
  });
}
