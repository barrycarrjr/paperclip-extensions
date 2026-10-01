import type { PluginContext } from "@paperclipai/plugin-sdk";
import { IntakeError } from "./routing.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const domains = new Set(["unclassified", "software", "it", "equipment", "shipping", "production", "facilities", "general"]);
const kinds = new Set(["unclassified", "question", "incident", "bug", "feature", "task"]);
const statuses = new Set(["new", "triage", "waiting", "resolved"]);
const accessMethods = new Set(["unknown", "winrm", "winrm_https", "wmi_dcom_smb", "ssh", "smb", "rdp", "rmm", "local", "other"]);

export interface CaseReviewInput {
  companyId: string;
  caseId: string;
  actorUserId: string;
  expectedVersion: number;
  serviceDomain: string;
  workKind: string;
  status: string;
  assetRef: string | null;
  targetAddress: string | null;
  accessMethod: string;
  orderRef: string | null;
  vendorRef: string | null;
  resolutionSummary: string | null;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw new IntakeError(422, `${field} is invalid`);
  return value.trim() || null;
}

function validate(input: CaseReviewInput): Required<CaseReviewInput> {
  if (!uuid.test(input.companyId) || !uuid.test(input.caseId)) throw new IntakeError(422, "Company and case IDs must be UUIDs");
  if (!input.actorUserId) throw new IntakeError(403, "Board user required");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new IntakeError(422, "Expected review version is invalid");
  if (!domains.has(input.serviceDomain) || !kinds.has(input.workKind) || !statuses.has(input.status)) {
    throw new IntakeError(422, "Case classification or status is invalid");
  }
  if (input.serviceDomain !== "software" && (input.workKind === "bug" || input.workKind === "feature")) {
    throw new IntakeError(422, "Software bugs and features require the software service domain");
  }
  if (!accessMethods.has(input.accessMethod)) throw new IntakeError(422, "Access method is invalid");
  const normalized = {
    ...input,
    assetRef: optionalText(input.assetRef, "assetRef", 200),
    targetAddress: optionalText(input.targetAddress, "targetAddress", 255),
    orderRef: optionalText(input.orderRef, "orderRef", 200),
    vendorRef: optionalText(input.vendorRef, "vendorRef", 200),
    resolutionSummary: optionalText(input.resolutionSummary, "resolutionSummary", 2000),
  };
  if (normalized.targetAddress && !/^[A-Za-z0-9._:-]+$/.test(normalized.targetAddress)) {
    throw new IntakeError(422, "Target address must be a hostname or IP address");
  }
  if (normalized.status === "resolved" && !normalized.resolutionSummary) {
    throw new IntakeError(422, "A resolution summary is required to resolve a case");
  }
  return normalized;
}

export async function reviewCase(ctx: PluginContext, input: CaseReviewInput): Promise<{ reviewVersion: number }> {
  const value = validate(input);
  if (!/^plugin_[a-z0-9_]+$/.test(ctx.db.namespace)) throw new Error("Plugin database namespace is unavailable");
  const result = await ctx.db.execute(
    `UPDATE ${ctx.db.namespace}.support_cases
     SET service_domain=$4, work_kind=$5, status=$6, asset_ref=$7, order_ref=$8,
         vendor_ref=$9, resolution_summary=$10, reviewed_by_user_id=$11,
         target_address=$12, access_method=$13,
         reviewed_at=now(), review_version=review_version+1, updated_at=now(),
         symptom_outcome=NULL,symptom_evidence=NULL,symptom_basis=NULL,
         symptom_recorded_by_user_id=NULL,symptom_recorded_at=NULL
     WHERE company_id=$1 AND id=$2 AND review_version=$3`,
    [value.companyId, value.caseId, value.expectedVersion, value.serviceDomain, value.workKind,
      value.status, value.assetRef, value.orderRef, value.vendorRef, value.resolutionSummary,
      value.actorUserId, value.targetAddress, value.accessMethod],
  );
  if (result.rowCount !== 1) {
    const rows = await ctx.db.query<{ review_version: number }>(
      `SELECT review_version FROM ${ctx.db.namespace}.support_cases WHERE company_id=$1 AND id=$2`,
      [value.companyId, value.caseId],
    );
    if (!rows[0]) throw new IntakeError(404, "Support case not found in this company");
    throw new IntakeError(409, "Case review changed; refresh before saving");
  }
  await ctx.activity.log({
    companyId: value.companyId,
    message: "Support case reviewed",
    entityType: "support_case",
    entityId: value.caseId,
    metadata: { serviceDomain: value.serviceDomain, workKind: value.workKind, status: value.status },
  });
  return { reviewVersion: value.expectedVersion + 1 };
}
