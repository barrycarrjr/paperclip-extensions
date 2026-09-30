import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { companyHasSupport, IntakeError, type Config } from "./routing.js";
import { ns } from "./interactive-support.js";
import { directoryFields, directoryInstruction, directoryKinds, supportAreas, type DirectoryKind, type DirectoryRecord } from "./directory-schema.js";
import { redactSource, safeLink } from "./source-protection.js";
import { validJobComponent,validJobRoot,validJobTemplate } from "./job-folder-schema.js";
import { resolveRemoteAccess } from "./remote-access.js";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function access(cfg: Config, companyId: string) {
  if (!uuid.test(companyId) || !companyHasSupport(cfg, companyId)) throw new IntakeError(403, "Support is not configured for this company");
}
function clean(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new IntakeError(422, `${label} must contain 1 to ${max} characters`);
  const text = value.trim();
  if (redactSource(text) !== text || /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text)) throw new IntakeError(422, "Keep credentials in Paperclip Secrets; remove access information from this record");
  return text;
}
function kind(value: unknown): DirectoryKind {
  if (!directoryKinds.includes(value as DirectoryKind)) throw new IntakeError(422, "Choose a directory record type");
  return value as DirectoryKind;
}
export function validateDirectory(input: Record<string, unknown>) {
  const recordKind = kind(input.kind); const name = clean(input.name, "Name", 150);
  if (!input.details || typeof input.details !== "object" || Array.isArray(input.details)) throw new IntakeError(422, "Record details must be an object");
  const raw = input.details as Record<string, unknown>; const details: Record<string, string> = {};
  if (Object.keys(raw).some(key => !directoryFields[recordKind].some(field => field.key === key))) throw new IntakeError(422, "Unknown field for this record type");
  for (const field of directoryFields[recordKind]) {
    if (raw[field.key] === undefined || raw[field.key] === "") { if (field.required) throw new IntakeError(422, `${field.label} is required`); continue; }
    const value = clean(raw[field.key], field.label, field.multiline ? 4000 : 255);
    if (field.options && !field.options.includes(value)) throw new IntakeError(422, `Choose a valid ${field.label}`);
    if ((field.link || field.key === "agentId") && !uuid.test(value)) throw new IntakeError(422, `${field.label} must be a saved record ID`);
    if (field.key.toLowerCase().includes("email") && !/^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/.test(value)) throw new IntakeError(422, "Use a single email address");
    if (field.key === "website" && safeLink(value) !== value) throw new IntakeError(422, "Use a public HTTPS support URL without credentials");
    if (field.key === "domain" && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(value)) throw new IntakeError(422, "Use a domain name without a URL or path");
    if (field.key === "pluginKey" && !/^[a-z][a-z0-9-]{0,99}$/.test(value)) throw new IntakeError(422, "Use the plugin's saved key");
    if (field.key === "warrantyEndsOn" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) throw new IntakeError(422, "Use a valid warranty date (YYYY-MM-DD)");
    details[field.key] = value;
  }
  if (recordKind === "file_root" && (!/^[a-z0-9][a-z0-9._-]*$/i.test(details.target!) || !validJobRoot(details.root!) || !validJobTemplate(details.namingTemplate!) || !validJobComponent(details.originalsFolder!))) throw new IntakeError(422,"Use a saved Windows server, an absolute local folder beneath a drive, the three template tokens once each, and a plain original-files subfolder name");
  if (recordKind === "sync_check" && (!/^[a-z0-9][a-z0-9._-]*$/i.test(details.target!) || !validJobRoot(details.sourcePath!) || !validJobRoot(details.backupPath!) || details.sourcePath!.toLowerCase() === details.backupPath!.toLowerCase())) throw new IntakeError(422,"Use a saved Windows host and two distinct absolute local folders beneath a drive");
  return { kind: recordKind, name, details };
}
export async function saveDirectory(ctx: PluginContext, cfg: Config, companyId: string, userId: string, input: Record<string, unknown>) {
  access(cfg, companyId);
  if (!userId) throw new IntakeError(403, "A human operator must review this record");
  const value = validateDirectory(input);
  if (["file_root", "sync_check"].includes(value.kind)) resolveRemoteAccess(cfg,companyId,value.details.target!);
  const id = input.id === undefined ? randomUUID() : input.id;
  if (typeof id !== "string" || !uuid.test(id)) throw new IntakeError(422, "Record ID must be a UUID");
  const expected = input.id === undefined ? 0 : input.expectedVersion;
  if (!Number.isInteger(expected) || (expected as number) < 0 || (input.id !== undefined && (expected as number) < 1)) throw new IntakeError(422, "Use the saved record version before editing");
  for (const field of directoryFields[value.kind].filter(field => field.link && value.details[field.key])) {
    const [linked] = await ctx.db.query<{ kind: string }>(`SELECT kind FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2`, [companyId,value.details[field.key]]);
    if (linked?.kind !== field.link) throw new IntakeError(422, `${field.label} must belong to this company and have the correct record type`);
  }
  if (value.details.agentId) {
    const agent = await ctx.agents.get(value.details.agentId,companyId);
    if (!agent || ["terminated","pending_approval"].includes(agent.status)) throw new IntakeError(422, "Choose an available agent in this company");
  }
  const revision = JSON.stringify([{ version: (expected as number)+1,name: value.name,details: value.details,actorUserId: userId,recordedAt: new Date().toISOString() }]);
  const values = [companyId,id,value.kind,value.name,JSON.stringify(value.details),userId,value.details.vendorId ?? null,value.details.ownerId ?? null,value.details.equipmentId ?? null,value.details.brandId ?? null,revision];
  const statement = expected === 0
    ? `INSERT INTO ${ns(ctx)}.support_directory(company_id,id,kind,name,details,updated_by_user_id,vendor_id,owner_id,equipment_id,brand_id,history) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)`
    : `UPDATE ${ns(ctx)}.support_directory SET name=$4,details=$5::jsonb,updated_by_user_id=$6,vendor_id=$7,owner_id=$8,equipment_id=$9,brand_id=$10,history=history || $11::jsonb,version=version+1,updated_at=now() WHERE company_id=$1 AND id=$2 AND kind=$3 AND version=$12`;
  // The record and its immutable revision snapshots change in one statement.
  const saved = await ctx.db.execute(statement, expected === 0 ? values : [...values,expected]);
  if (saved.rowCount !== 1) throw new IntakeError(409, "Record changed, is missing, or has another type; refresh before editing");
  await ctx.activity.log({ companyId, message: "Reviewed support directory record saved",entityType: "support_directory",entityId: id,metadata: { userId,kind: value.kind,version: (expected as number)+1 } });
  return { id,version: (expected as number)+1,saved: true };
}
export async function listDirectory(ctx: PluginContext, cfg: Config, companyId: string, input: Record<string, unknown> = {}, limit = 200) {
  access(cfg, companyId);
  const selectedKind = input.kind === undefined ? null : kind(input.kind);
  const query = input.query === undefined ? "" : clean(input.query,"Search",200);
  const escaped = query.replace(/[\\%_]/g,char => `\\${char}`);
  const records = await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory
    WHERE company_id=$1 AND ($2::text IS NULL OR kind=$2) AND (name ILIKE $3 OR details::text ILIKE $3) ORDER BY kind,name,id LIMIT $4`, [companyId,selectedKind,`%${escaped}%`,limit+1]);
  return { records: records.slice(0,limit),truncated: records.length > limit,instruction: directoryInstruction };
}
export async function resolveDirectoryRoute(ctx: PluginContext, cfg: Config, companyId: string, input: Record<string, unknown>) {
  access(cfg, companyId);
  if (!supportAreas.includes(input.area as never)) throw new IntakeError(422, "Choose a support area");
  for (const [key,expectedKind] of [["equipmentId","equipment"],["brandId","brand"]] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || !uuid.test(input[key] as string)) throw new IntakeError(422, `Use a saved ${expectedKind} ID`);
      const [record] = await ctx.db.query<{ kind: string }>(`SELECT kind FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2`,[companyId,input[key]]);
      if (record?.kind !== expectedKind) throw new IntakeError(422, `Choose ${expectedKind} in this company`);
    }
  }
  const routes = await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory
    WHERE company_id=$1 AND kind='route' AND details->>'area'=$2 AND (equipment_id IS NULL OR equipment_id=$3::uuid) AND (brand_id IS NULL OR brand_id=$4::uuid) ORDER BY name,id LIMIT 51`,[companyId,input.area,input.equipmentId ?? null,input.brandId ?? null]);
  // No guessed default: specific rules supersede general ones, equal specificity stays ambiguous.
  const specificity = (route: DirectoryRecord) => Number(!!route.details.equipmentId)+Number(!!route.details.brandId);
  const best = Math.max(-1,...routes.map(specificity));
  const matches = routes.filter(route => specificity(route) === best).slice(0,50);
  const ids = [...new Set(matches.flatMap(route => [route.details.ownerId,route.details.vendorId,route.details.equipmentId,route.details.brandId].filter(Boolean)))];
  const related = ids.length ? await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=ANY($2::uuid[])`,[companyId,ids]) : [];
  return { status: routes.length > 50 ? "needs_clarification" : matches.length === 1 ? "matched" : matches.length ? "needs_clarification" : "not_configured",routes: matches,related,instruction: directoryInstruction };
}
export async function saveDirectoryRequest(ctx: PluginContext, cfg: Config, input: PluginApiRequestInput) {
  if (input.actor.actorType !== "user" || !input.actor.userId || input.actor.grantedPermission !== "support:repair") throw new IntakeError(403,"Paperclip must verify your permission to manage support records");
  const body = input.body as Record<string,unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body) || body.companyId !== input.companyId || !input.companyId) throw new IntakeError(403,"Company mismatch");
  if (body.confirmed !== true) throw new IntakeError(422,"Review and confirm the directory record before saving");
  return saveDirectory(ctx,cfg,input.companyId,input.actor.userId,body);
}
export async function directoryHistory(ctx: PluginContext, cfg: Config, companyId: string, recordId: unknown) {
  access(cfg,companyId);
  if (typeof recordId !== "string" || !uuid.test(recordId)) throw new IntakeError(422,"Choose a saved record");
  const [record] = await ctx.db.query<{ history: unknown[] }>(`SELECT history FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2`,[companyId,recordId]);
  if (!record) throw new IntakeError(404,"Record not found in this company");
  return { revisions: record.history };
}
