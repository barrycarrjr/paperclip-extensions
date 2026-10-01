import { createHash } from "node:crypto";
import type { PaperclipPluginManifestV1, PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError, companyHasSupport, type Config } from "./routing.js";
import { ns, person } from "./interactive-support.js";
import type { DirectoryRecord } from "./directory-schema.js";
import { redactSource } from "./source-protection.js";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function text(value: unknown, label: string, max: number, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || redactSource(value) !== value) throw new IntakeError(422, `${label} must be reviewed text without credentials, at most ${max} characters`);
  return value.trim();
}
async function equipment(ctx: PluginContext, cfg: Config, run: ToolRunContext, id: unknown) {
  const actor = person(run);
  if (!companyHasSupport(cfg, actor.companyId) || typeof id !== "string" || !uuid.test(id)) throw new IntakeError(403, "Choose equipment in this support company");
  const [record] = await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=$2 AND kind='equipment'`, [actor.companyId, id]);
  if (!record) throw new IntakeError(404, "Equipment not found in this company");
  return { actor, record };
}
export async function recordEquipmentEvent(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  if (run.userPermission !== "support:repair" || !run.userConfirmed) throw new IntakeError(403, "Confirm this exact equipment history entry");
  const { actor, record } = await equipment(ctx, cfg, run, input.equipmentId);
  if (typeof input.eventId !== "string" || !uuid.test(input.eventId) || !["fault", "consumable", "service"].includes(String(input.kind))) throw new IntakeError(422, "Use a unique event UUID and fault, consumable or service kind");
  if (typeof input.occurredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt)) || Date.parse(input.occurredAt) > Date.now() + 300000) throw new IntakeError(422, "Use the actual event date/time, not a future service appointment");
  const occurredAt = new Date(input.occurredAt).toISOString(), code = text(input.code ?? "", "Fault/part/service reference", 100, true), notes = text(input.notes, "Evidence/notes", 4000);
  if (input.caseId !== undefined) {
    if (typeof input.caseId !== "string" || !uuid.test(input.caseId)) throw new IntakeError(422, "Use a support case ID");
    const [supportCase] = await ctx.db.query(`SELECT id FROM ${ns(ctx)}.support_cases WHERE company_id=$1 AND id=$2`, [actor.companyId, input.caseId]);
    if (!supportCase) throw new IntakeError(404, "Case not found in this company");
  }
  const hash = createHash("sha256").update(JSON.stringify([actor.companyId, record.id, input.kind, occurredAt, code, notes, input.caseId ?? null])).digest("hex");
  await ctx.db.execute(`INSERT INTO ${ns(ctx)}.support_equipment_events(id,company_id,equipment_id,kind,occurred_at,code,notes,case_id,content_sha256,recorded_by_user_id) VALUES($1,$2,$3,$4,$5::timestamptz,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [input.eventId, actor.companyId, record.id, input.kind, occurredAt, code, notes, input.caseId ?? null, hash, actor.userId]);
  const [saved] = await ctx.db.query<{ content_sha256: string }>(`SELECT content_sha256 FROM ${ns(ctx)}.support_equipment_events WHERE company_id=$1 AND id=$2`, [actor.companyId, input.eventId]);
  if (saved?.content_sha256 !== hash) throw new IntakeError(409, "Event ID already contains different evidence; add a new correction entry");
  await ctx.activity.log({ companyId: actor.companyId, entityType: "support_equipment", entityId: record.id, message: "Reviewed equipment history recorded", metadata: { userId: actor.userId, eventId: input.eventId, kind: input.kind } });
  return { eventId: input.eventId, recorded: true, instruction: "This records the operator's evidence; it does not prove service occurred or operate equipment. Entries are append-only; record corrections separately. A service appointment belongs in a draft until completed." };
}
export async function equipmentHistory(ctx: PluginContext, cfg: Config, run: ToolRunContext, id: unknown) {
  if (run.userPermission !== "support:diagnose") throw new IntakeError(403, "Diagnostic permission required");
  const { actor, record } = await equipment(ctx, cfg, run, id);
  const events = await ctx.db.query(`SELECT id,kind,occurred_at,code,notes,case_id,recorded_by_user_id FROM ${ns(ctx)}.support_equipment_events WHERE company_id=$1 AND equipment_id=$2 ORDER BY occurred_at DESC,id LIMIT 51`, [actor.companyId, record.id]);
  const recurring = await ctx.db.query(`SELECT code,COUNT(*)::integer AS reports,MAX(occurred_at) AS latest FROM ${ns(ctx)}.support_equipment_events WHERE company_id=$1 AND equipment_id=$2 AND kind='fault' AND code <> '' AND occurred_at >= now()-interval '90 days' GROUP BY code HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC,code LIMIT 20`, [actor.companyId, record.id]);
  const ids = [record.details.vendorId, record.details.ownerId].filter(Boolean);
  const contacts = ids.length ? await ctx.db.query<DirectoryRecord>(`SELECT id,kind,name,details,version,updated_at FROM ${ns(ctx)}.support_directory WHERE company_id=$1 AND id=ANY($2::uuid[])`, [actor.companyId, ids]) : [];
  return { equipment: record, events: events.slice(0, 50), truncated: events.length > 50, recurringFaultCodes: recurring, contacts, instruction: "Recorded reports are evidence, not diagnosis. Repeated fault codes do not prove the same root cause; timestamps and service/consumable entries are operator attestations. Use exact manufacturer/model official guidance and warranty contacts. Do not infer press/finisher controls from Windows printer tools. Physical interventions go to qualified responsible people." };
}
export async function prepareEquipmentService(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  const history = await equipmentHistory(ctx, cfg, run, input.equipmentId);
  const problem = text(input.problem, "Observed problem", 2000);
  const vendor = history.contacts.find(item => item.kind === "vendor");
  if (!vendor || (!vendor.details.email && !vendor.details.phone && !vendor.details.website)) throw new IntakeError(422, "Save the equipment's service vendor and a contact route first");
  return { status: "draft_only", equipmentId: history.equipment.id, equipmentVersion: history.equipment.version, vendorId: vendor.id, vendorVersion: vendor.version, contact: vendor, responsibleOwner: history.contacts.find(item => item.kind === "owner") ?? null,
    draft: { subject: `Service request: ${history.equipment.name}`, body: `Equipment: ${history.equipment.name}\nManufacturer/model: ${history.equipment.details.manufacturer ?? "Unrecorded"} / ${history.equipment.details.model ?? "Unrecorded"}\nSerial: ${history.equipment.details.serial ?? "Unrecorded"}\nObserved problem: ${problem}\nRecent recorded history: ${JSON.stringify(history.events.slice(0, 5))}\nPlease confirm service availability, warranty coverage and next steps.` },
    instruction: "Draft prepared; no vendor was contacted, service booked or cost authorized. Review recipient, evidence and sensitive equipment details before sending through an approved communication tool. Record the actual vendor receipt/reference and completed service separately. Physical repair requires the qualified owner/vendor." };
}
export const equipmentTools: NonNullable<PaperclipPluginManifestV1["tools"]> = [
  { name: "support_equipment_history", displayName: "Inspect equipment faults and service", requiredUserPermission: "support:diagnose", description: "Read this company's saved press/finisher/other equipment history, 90-day repeated fault-code counts, consumables, completed service, warranty and responsible vendor/owner contacts. Metadata and operator reports are not proof of a root cause. No equipment control or physical intervention.", parametersSchema: { type: "object", additionalProperties: false, properties: { equipmentId: { type: "string" } }, required: ["equipmentId"] } },
  { name: "support_record_equipment_event", displayName: "Record equipment evidence", requiredUserPermission: "support:repair", writes: true, requiresUserConfirmation: true, description: "Confirm an exact append-only fault, consumable replacement or completed service record for saved company equipment. Use a fresh event UUID; repeat IDs cannot overwrite/change evidence. Optional case must belong to the company. Do not record future appointments as completed service or claim this operates a machine.", parametersSchema: { type: "object", additionalProperties: false, properties: { equipmentId: { type: "string" }, eventId: { type: "string" }, kind: { type: "string", enum: ["fault", "consumable", "service"] }, occurredAt: { type: "string" }, code: { type: "string" }, notes: { type: "string", maxLength: 4000 }, caseId: { type: "string" } }, required: ["equipmentId", "eventId", "kind", "occurredAt", "notes"] } },
  { name: "support_prepare_equipment_service", displayName: "Prepare a vendor service request", requiredUserPermission: "support:diagnose", description: "Gather this equipment's actual saved vendor/owner, model/serial/warranty and recent recorded faults/service into a reviewable service-call draft. This never sends, books service, approves cost or authorizes a physical intervention. Confirm the vendor and evidence before using a separate approved communication tool.", parametersSchema: { type: "object", additionalProperties: false, properties: { equipmentId: { type: "string" }, problem: { type: "string", maxLength: 2000 } }, required: ["equipmentId", "problem"] } },
];
export function registerEquipmentTools(ctx: PluginContext, getConfig: () => Promise<Config>) {
  for (const tool of equipmentTools) ctx.tools.register(tool.name, tool, async (params, run) => {
    try {
      if (run.userPermission !== tool.requiredUserPermission) throw new IntakeError(403, "Equipment support permission required");
      const input = params as Record<string, unknown>, cfg = await getConfig();
      return { data: tool.name === "support_record_equipment_event" ? await recordEquipmentEvent(ctx, cfg, run, input) : tool.name === "support_equipment_history" ? await equipmentHistory(ctx, cfg, run, input.equipmentId) : await prepareEquipmentService(ctx, cfg, run, input) };
    } catch (error) { return { error: error instanceof IntakeError ? error.message : "Equipment operation failed; inspect history before repeating a record" }; }
  });
}
