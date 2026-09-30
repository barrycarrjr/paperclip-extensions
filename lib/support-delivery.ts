import { createHash } from "node:crypto";

export const deliveryEvent = "plugin.customer-support.delivery-requested" as const;
export type DeliveryProvider = "slack-tools" | "email-tools";
export interface DeliveryRequest {
  version: 1;
  deliveryId: string;
  companyId: string;
  caseId: string;
  provider: DeliveryProvider;
  account: string;
  kind: "slack_reply" | "vendor_email";
  destination: { workspaceId?: string; channelId?: string; threadTs?: string; to?: string; subject?: string };
  body: string;
  contentSha256: string;
  approvedByUserId: string;
  expiresAt: string;
}
export interface DeliveryReceipt {
  version: 1; deliveryId: string; companyId: string; contentSha256: string;
  status: "sent" | "not_sent" | "unknown";
  reference: string | null;
  code: "accepted" | "preflight_failed" | "delivery_uncertain";
}
export interface BridgeEvent { eventType: string; actorType?: string; actorId?: string; companyId: string; payload: unknown }
export interface BridgePort {
  db: { namespace: string; query<T>(sql: string, params?: unknown[]): Promise<T[]>; execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> };
  events: { emit(name: string, companyId: string, payload: unknown): Promise<void> };
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
interface DeliveryAccount { key?: string; allowedCompanies?: string[]; supportChannels?: string[]; supportRecipients?: string[] }
export function selectSupportAccount<T extends DeliveryAccount>(provider: DeliveryProvider,enabled: boolean,accounts: T[],request: DeliveryRequest): T {
  if (!enabled || request.provider !== provider) throw new Error("Support sending is disabled");
  const matches = accounts.filter(account => account.key?.toLowerCase() === request.account.toLowerCase());
  const account = matches[0];
  if (matches.length !== 1 || !account || !(account.allowedCompanies?.includes("*") || account.allowedCompanies?.includes(request.companyId))) throw new Error("Support account is not uniquely allowed for this company");
  const allowed = provider === "slack-tools" ? account.supportChannels?.includes(request.destination.channelId!)
    : account.supportRecipients?.some(address => address.toLowerCase() === request.destination.to?.toLowerCase());
  if (!allowed) throw new Error("Support destination is not enabled");
  return account;
}
export function deliveryHash(value: Pick<DeliveryRequest, "companyId" | "caseId" | "provider" | "account" | "kind" | "destination" | "body">) {
  const d = value.destination;
  return createHash("sha256").update(JSON.stringify([value.companyId,value.caseId,value.provider,value.account,value.kind,
    d.workspaceId ?? null,d.channelId ?? null,d.threadTs ?? null,d.to ?? null,d.subject ?? null,value.body])).digest("hex");
}
export function containsCredential(value: string) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S+|\bxox[baprs]-[a-z0-9-]+/i.test(value);
}
export function parseDeliveryRequest(event: BridgeEvent, provider: DeliveryProvider): DeliveryRequest | null {
  if (event.eventType !== deliveryEvent || event.actorType !== "plugin" || event.actorId !== "customer-support") return null;
  const p = event.payload as Partial<DeliveryRequest> | null;
  if (!p || p.version !== 1 || p.provider !== provider || p.companyId !== event.companyId || !uuid.test(p.companyId ?? "") ||
      !uuid.test(p.deliveryId ?? "") || !uuid.test(p.caseId ?? "") || typeof p.account !== "string" || !p.account || p.account.length > 120 ||
      typeof p.body !== "string" || !p.body.trim() || p.body.length > 10000 || typeof p.approvedByUserId !== "string" || !p.approvedByUserId ||
      !p.destination || typeof p.destination !== "object" || Array.isArray(p.destination) ||
      typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt)) || containsCredential(p.body)) return null;
  const d = p.destination;
  if (provider === "slack-tools") {
    if (p.kind !== "slack_reply" || !/^T[A-Z0-9]{8,}$/.test(d.workspaceId ?? "") || !/^[CG][A-Z0-9]{8,}$/.test(d.channelId ?? "") ||
        !/^\d{10,11}\.\d{1,6}$/.test(d.threadTs ?? "") || d.to !== undefined || d.subject !== undefined) return null;
  } else if (p.kind !== "vendor_email" || typeof d.to !== "string" || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(d.to) ||
      typeof d.subject !== "string" || !d.subject.trim() || d.subject.length > 300 || /[\r\n]/.test(d.subject) || containsCredential(d.subject) ||
      d.workspaceId !== undefined || d.channelId !== undefined || d.threadTs !== undefined) return null;
  if (deliveryHash(p as DeliveryRequest) !== p.contentSha256) return null;
  return p as DeliveryRequest;
}

/** One external attempt per id. A lost reply or worker restart never replays it. */
export async function consumeDelivery(port: BridgePort, provider: DeliveryProvider, event: BridgeEvent,
  prepare: (request: DeliveryRequest) => Promise<() => Promise<string>>) {
  const request = parseDeliveryRequest(event, provider);
  if (!request) return;
  const ns = port.db.namespace;
  if (!/^plugin_[a-z0-9_]+$/.test(ns)) throw new Error("Invalid delivery namespace");
  const claimed = await port.db.execute(`INSERT INTO ${ns}.support_delivery_receipts(company_id,delivery_id,content_sha256)
    VALUES($1,$2,$3) ON CONFLICT(company_id,delivery_id) DO NOTHING`, [request.companyId,request.deliveryId,request.contentSha256]);
  if (claimed.rowCount === 0) {
    const rows = await port.db.query<{ content_sha256: string; status: string; reference: string | null; code: DeliveryReceipt["code"] }>(
      `SELECT content_sha256,status,reference,code FROM ${ns}.support_delivery_receipts WHERE company_id=$1 AND delivery_id=$2`, [request.companyId,request.deliveryId]);
    const row = rows[0];
    if (!row || row.content_sha256 !== request.contentSha256) return;
    await port.events.emit("support-delivery-receipt",request.companyId, { version: 1,deliveryId: request.deliveryId,companyId: request.companyId,
      contentSha256: request.contentSha256,status: row.status === "sending" ? "unknown" : row.status,
      reference: row.reference,code: row.status === "sending" ? "delivery_uncertain" : row.code });
    return;
  }
  let started = false;
  let receipt: DeliveryReceipt;
  try {
    if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("Expired delivery");
    const send = await prepare(request);
    if (Date.parse(request.expiresAt) <= Date.now()) throw new Error("Approval expired during preflight");
    started = true;
    const reference = await send();
    if (typeof reference !== "string" || !reference || reference.length > 500 || /[\r\n]/.test(reference)) throw new Error("Invalid receipt");
    receipt = { version: 1,deliveryId: request.deliveryId,companyId: request.companyId,contentSha256: request.contentSha256,status: "sent",reference,code: "accepted" };
  } catch {
    receipt = { version: 1,deliveryId: request.deliveryId,companyId: request.companyId,contentSha256: request.contentSha256,
      status: started ? "unknown" : "not_sent",reference: null,code: started ? "delivery_uncertain" : "preflight_failed" };
  }
  // Only metadata is stored by the connector; content belongs to Support Desk.
  await port.db.execute(`UPDATE ${ns}.support_delivery_receipts SET status=$3,reference=$4,code=$5,updated_at=now()
    WHERE company_id=$1 AND delivery_id=$2 AND status='sending'`, [request.companyId,request.deliveryId,receipt.status,receipt.reference,receipt.code]);
  await port.events.emit("support-delivery-receipt",request.companyId,receipt);
}
