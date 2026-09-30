import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError, resolveConnection, type Config, type IncomingMessage } from "./routing.js";

const marker = "[restricted access information]";
/** Conservative deterministic filtering, not a guarantee of detecting unlabeled secrets.
 * The complete source is retained only in encrypted company Secrets. */
export function redactSource(value: string): string {
  let result = value.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, marker);
  result = result.replace(/\b(?:sk-ant-[a-z0-9]+-[\w-]+|sk-[\w-]{16,}|xox[baprs]-[\w-]+|gh[pousr]_[\w]+|AKIA[A-Z0-9]{16}|AIza[\w-]{35}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, marker);
  result = result.replace(/(?:https?|ssh|smb|postgres(?:ql)?):\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi, marker);
  result = result.replace(/https:\/\/hooks\.slack\.com\/services\/[^\s]+/gi, marker);
  result = result.replace(/^.*\b(?:pass(?:word|wd|phrase)?|pwd|api[ _-]?key|access[ _-]?token|auth(?:orization)?|bearer|client[ _-]?secret|private[ _-]?key|recovery[ _-]?key)\b["'*\s]*(?:[:=]|\bis\b|\bBearer\b).*$/gim, marker);
  return result;
}
function safeLink(value?: string) {
  if (!value || redactSource(value) !== value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => /token|pass|secret|key|auth|signature/i.test(key))) return undefined;
    return value;
  } catch { return undefined; }
}
export function sourceStorageKey(message: Pick<IncomingMessage, "companyId" | "connectionId" | "externalAccountId" | "externalRouteId" | "externalConversationId" | "externalMessageId">) {
  return createHash("sha256").update(JSON.stringify(["support-source-v1", message.companyId, message.connectionId,
    message.externalAccountId, message.externalRouteId, message.externalConversationId, message.externalMessageId])).digest("hex");
}
export async function protectSource(ctx: PluginContext, message: IncomingMessage) {
  if (typeof ctx.secrets.store !== "function") throw new IntakeError(503, "Update Paperclip to enable encrypted support intake. This message was not stored.");
  const raw = JSON.stringify({ title: message.title, body: message.body, attachments: message.attachments ?? [],
    authorExternalId: message.authorExternalId ?? null, externalUrl: message.externalUrl ?? null });
  let ref: string;
  try { ref = (await ctx.secrets.store(message.companyId, sourceStorageKey(message), raw)).secretRef; }
  catch { throw new IntakeError(503, "Encrypted source could not be saved. Intake has not advanced; inspect storage before retrying."); }
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ref)) throw new IntakeError(503, "Encrypted storage returned an invalid reference");
  return { secretRef: ref, message: { ...message, title: redactSource(message.title), body: redactSource(message.body),
    authorExternalId: message.authorExternalId ? redactSource(message.authorExternalId) : undefined,
    externalUrl: safeLink(message.externalUrl), attachments: message.attachments?.map(file => ({ ...file,
      id: redactSource(file.id),name: redactSource(file.name),mimeType: file.mimeType ? redactSource(file.mimeType) : undefined,permalink: safeLink(file.permalink) })) } };
}

/** Only a host-authorized repair operator can reveal the original in the dashboard.
 * No agent tool exposes it. References cannot be supplied by callers. */
export async function readProtectedSource(ctx: PluginContext, input: { companyId: string; caseId: string; messageId: string; userId: string }) {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (![input.companyId, input.caseId, input.messageId].every(value => uuid.test(value)) || !input.userId) throw new IntakeError(403, "Authorized support operator required");
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Invalid support namespace");
  const rows = await ctx.db.query<{ protected_source_ref: string }>(`SELECT protected_source_ref FROM ${ctx.db.namespace}.support_messages
    WHERE company_id=$1 AND case_id=$2 AND id=$3 AND source_protection_version=1`, [input.companyId,input.caseId,input.messageId]);
  if (!rows[0]?.protected_source_ref) throw new IntakeError(404, "Protected source not found in this case");
  await ctx.activity.log({ companyId: input.companyId, message: "Restricted support source accessed", entityType: "support_case",
    entityId: input.caseId, metadata: { messageId: input.messageId, userId: input.userId } });
  try { return JSON.parse(await ctx.secrets.resolve(rows[0].protected_source_ref, input.companyId)) as Record<string, unknown>; }
  catch { throw new IntakeError(503, "Restricted source is unavailable"); }
}

/** Bounded encrypted backfill. Legacy rows remain hidden from normal case views until protected.
 * Only pinned source accounts still mapped to the same company can be migrated. */
export async function protectLegacySources(ctx: PluginContext, cfg: Config) {
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Invalid support namespace");
  const scopes: { companyId: string; connectionId: string; accountId: string; routeId: string }[] = [];
  for (const connection of cfg.connections ?? []) for (const route of connection.routes ?? []) {
    try { resolveConnection(cfg,{ companyId: route.companyId,connectionId: connection.id,externalAccountId: connection.externalAccountId,externalRouteId: route.externalRouteId } as IncomingMessage); }
    catch { continue; }
    scopes.push({ companyId: route.companyId,connectionId: connection.id,accountId: connection.externalAccountId,routeId: route.externalRouteId });
  }
  const rows = await ctx.db.query<{ id: string; case_id: string; company_id: string; connection_id: string;
    external_route_id: string; external_conversation_id: string; external_message_id: string; title: string; body: string;
    author_kind: IncomingMessage["authorKind"]; occurred_at: string; author_external_id: string | null;
    attachments: IncomingMessage["attachments"]; external_url: string | null; source_account_id: string }>(
    `SELECT m.*,c.title,c.external_url,c.source_account_id FROM ${ctx.db.namespace}.support_messages m
     JOIN ${ctx.db.namespace}.support_cases c ON c.company_id=m.company_id AND c.id=m.case_id
     WHERE m.source_protection_version=0 AND c.source_account_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM jsonb_array_elements($1::jsonb) s WHERE s->>'companyId'=m.company_id::text
         AND s->>'connectionId'=c.connection_id AND s->>'accountId'=c.source_account_id AND s->>'routeId'=c.external_route_id)
     ORDER BY m.occurred_at LIMIT 20`,[JSON.stringify(scopes)]);
  let migrated = 0;
  for (const row of rows) {
    const message: IncomingMessage = { companyId: row.company_id, connectionId: row.connection_id,
      externalAccountId: row.source_account_id, externalRouteId: row.external_route_id,
      externalConversationId: row.external_conversation_id, externalMessageId: row.external_message_id,
      title: row.title, body: row.body, authorKind: row.author_kind, occurredAt: row.occurred_at,
      authorExternalId: row.author_external_id ?? undefined, externalUrl: row.external_url ?? undefined, attachments: row.attachments };
    try { resolveConnection(cfg, message); } catch { continue; }
    const protectedSource = await protectSource(ctx, message);
    const safe = protectedSource.message;
    const changed = await ctx.db.execute(`UPDATE ${ctx.db.namespace}.support_messages
      SET body=$4,author_external_id=$5,attachments=$6::jsonb,protected_source_ref=$7,source_protection_version=1
      WHERE company_id=$1 AND case_id=$2 AND id=$3 AND source_protection_version=0`,
      [row.company_id,row.case_id,row.id,safe.body,safe.authorExternalId ?? null,JSON.stringify(safe.attachments ?? []),protectedSource.secretRef]);
    await ctx.db.execute(`UPDATE ${ctx.db.namespace}.support_cases SET title=$4,external_url=$5
      WHERE company_id=$1 AND id=$2 AND title=$3`, [row.company_id,row.case_id,row.title,safe.title,safe.externalUrl ?? null]);
    migrated += changed.rowCount;
  }
  return { migrated, limitation: "Legacy derived notes, issues and old backups require separate privacy review; this migrates source messages only." };
}
