import { randomUUID } from "node:crypto";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import type { RoutingDestination } from "./types.js";

type Db = Pick<PluginDatabaseClient, "query" | "execute">;
export const ROUTES = "plugin_email_tools_7cbee3fdf3.email_routing";
const RATE = "plugin_email_tools_7cbee3fdf3.email_routing_rate";
export interface RouteActor { actorAgentId?: string; actorRunId?: string; actorUserId?: string }
export interface RouteRow {
  id: string; mailbox_key: string; message_key: string; source_company_id: string; mailbox_binding: string;
  folder: string; uid: number; uid_validity: string; message_id: string | null;
  status: "claimed" | "routed" | "waiting" | "dismissed" | "handled";
  claim_token: string | null; claimed_at: string | Date | null; attempt_started: boolean;
  destination: RoutingDestination | null; actor: RouteActor; sender: string; subject: string;
  received_at: string; candidate_keys: string[]; note: string; issue_id: string | null;
  issue_identifier: string | null; handoff_origin_id: string | null;
  wake_state: string; wake_attempt: number; audit_state: string; last_error: string | null;
  handled_by_user_id: string | null; handled_at: string | Date | null;
  followups_checked_by_user_id: string | null; followups_checked_at: string | Date | null;
}

export class RoutingStore {
  constructor(readonly db: Db) {}
  async find(mailbox: string, key: string): Promise<RouteRow | undefined> {
    return (await this.db.query<RouteRow>(`SELECT * FROM ${ROUTES} WHERE mailbox_key=$1 AND message_key=$2 LIMIT 1`, [mailbox, key]))[0];
  }
  async findAccount(binding: string, key: string): Promise<RouteRow | undefined> {
    return (await this.db.query<RouteRow>(`SELECT * FROM ${ROUTES} WHERE mailbox_binding=$1 AND message_key=$2 LIMIT 1`, [binding, key]))[0];
  }
  async get(id: string, company: string, mailbox: string): Promise<RouteRow | undefined> {
    return (await this.db.query<RouteRow>(`SELECT * FROM ${ROUTES} WHERE id=$1 AND source_company_id=$2 AND mailbox_key=$3 LIMIT 1`, [id, company, mailbox]))[0];
  }
  async insert(input: Omit<RouteRow, "id" | "claim_token" | "claimed_at" | "attempt_started" | "issue_id" | "issue_identifier" | "handoff_origin_id" | "wake_state" | "wake_attempt" | "audit_state" | "last_error" | "handled_by_user_id" | "handled_at" | "followups_checked_by_user_id" | "followups_checked_at">): Promise<RouteRow> {
    await this.db.execute(`INSERT INTO ${ROUTES}
      (id,mailbox_key,message_key,source_company_id,mailbox_binding,folder,uid,uid_validity,message_id,status,destination,actor,sender,subject,received_at,candidate_keys,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16::jsonb,$17)
      ON CONFLICT DO NOTHING`, [randomUUID(), input.mailbox_key, input.message_key,
      input.source_company_id, input.mailbox_binding, input.folder, input.uid, input.uid_validity, input.message_id,
      input.status, JSON.stringify(input.destination), JSON.stringify(input.actor), input.sender, input.subject,
      input.received_at, JSON.stringify(input.candidate_keys), input.note]);
    const row = await this.find(input.mailbox_key, input.message_key);
    if (!row) throw new Error("[EROUTE_SOURCE_CHANGED] This account/message identity is already recorded under another mailbox key. Restore its original key or reconcile manually.");
    return row;
  }
  /** Only pre-call claims can change target. A started attempt is permanently bound to its destination. */
  async claim(row: RouteRow, destination: RoutingDestination, actor: RouteActor, kind: "create" | "recover" = "create"): Promise<string | null> {
    const token = randomUUID();
    const { rowCount } = await this.db.execute(`UPDATE ${ROUTES} SET status='claimed', claim_token=$2,
      claimed_at=now(), updated_at=now(), destination=CASE WHEN attempt_started THEN destination ELSE $3::jsonb END,
      actor=CASE WHEN attempt_started THEN actor ELSE $4::jsonb END
      WHERE id=$1 AND status IN ('waiting','claimed') AND (status='waiting' OR claimed_at IS NULL OR claimed_at < now()-interval '2 minutes')
      AND ${kind === "create" ? "NOT attempt_started" : "attempt_started AND destination=$3::jsonb"}`, [row.id, token, JSON.stringify(destination), JSON.stringify(actor)]);
    return rowCount ? token : null;
  }
  async start(id: string, token: string): Promise<boolean> {
    return !!(await this.db.execute(`UPDATE ${ROUTES} SET attempt_started=true,updated_at=now()
      WHERE id=$1 AND status='claimed' AND claim_token=$2 AND NOT attempt_started`, [id, token])).rowCount;
  }
  async waiting(id: string, token: string, note: string): Promise<void> {
    await this.db.execute(`UPDATE ${ROUTES} SET status='waiting',claim_token=NULL,claimed_at=NULL,note=$3,last_error=$3,updated_at=now()
      WHERE id=$1 AND status='claimed' AND claim_token=$2`, [id, token, note.slice(0, 300)]);
  }
  /** Only the exact legacy origin rejection proves that the host did not start a write. */
  async legacyRefused(id: string, token: string, note: string): Promise<void> {
    await this.db.execute(`UPDATE ${ROUTES} SET status='waiting',attempt_started=false,
      claim_token=NULL,claimed_at=NULL,note=$3,last_error=$3,updated_at=now()
      WHERE id=$1 AND status='claimed' AND claim_token=$2`, [id, token, note]);
  }
  async routed(id: string, token: string, issue: { id: string; identifier: string; originId: string }): Promise<void> {
    await this.db.execute(`UPDATE ${ROUTES} SET status=CASE WHEN status='handled' THEN 'handled' ELSE 'routed' END,issue_id=$3,issue_identifier=$4,handoff_origin_id=$5,
      claim_token=NULL,claimed_at=NULL,last_error=NULL,updated_at=now()
      WHERE id=$1 AND ((claim_token=$2 AND status='claimed') OR status='handled') AND attempt_started`, [id, token, issue.id, issue.identifier, issue.originId]);
  }
  async closeManually(row: RouteRow, userId: string): Promise<boolean> {
    // Keep identity, attempted destination, actor and claim token. A call already in flight may
    // still report its issue, but can never reopen this item or request follow-up effects.
    return !!(await this.db.execute(`UPDATE ${ROUTES} SET status='handled',handled_by_user_id=$2,
      handled_at=now(),updated_at=now() WHERE id=$1 AND status IN ('waiting','claimed')`, [row.id, userId])).rowCount;
  }
  async dismiss(row: RouteRow): Promise<boolean> {
    return !!(await this.db.execute(`UPDATE ${ROUTES} SET status='dismissed',updated_at=now()
      WHERE id=$1 AND status='waiting' AND NOT attempt_started`, [row.id])).rowCount;
  }
  async checkFollowups(row: RouteRow, userId: string): Promise<void> {
    // This records an operator decision, not delivery or audit success. Keep all facts.
    // Existing claimed callbacks can record their result; no later claim can start.
    await this.db.execute(`UPDATE ${ROUTES} SET followups_checked_by_user_id=$4,
      followups_checked_at=now(),updated_at=now()
      WHERE id=$1 AND source_company_id=$2 AND mailbox_key=$3 AND status='routed'
      AND followups_checked_at IS NULL`, [row.id, row.source_company_id, row.mailbox_key, userId]);
  }
  async reserve(mailbox: string): Promise<boolean> {
    // date_trunc is outside the host SQL allowlist. The trusted worker supplies its UTC hour.
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    return !!(await this.db.execute(`INSERT INTO ${RATE} (mailbox_key,hour_start,reservations) VALUES ($1,$2::timestamptz,1)
      ON CONFLICT (mailbox_key) DO UPDATE SET hour_start=$2::timestamptz,
      reservations=CASE WHEN ${RATE}.hour_start < $2::timestamptz THEN 1 ELSE ${RATE}.reservations+1 END
      WHERE ${RATE}.hour_start < $2::timestamptz OR (${RATE}.hour_start=$2::timestamptz AND ${RATE}.reservations < 25)`, [mailbox, hour])).rowCount;
  }
  async effect(id: string, kind: "wake" | "audit", from: string[], to: string): Promise<boolean> {
    return !!(await this.db.execute(`UPDATE ${ROUTES} SET ${kind}_state=$2,updated_at=now()
      WHERE id=$1 AND status='routed' ${to === "unknown" ? "AND followups_checked_at IS NULL" : ""}
      AND ${kind}_state IN (SELECT jsonb_array_elements_text($3::jsonb))`, [id, to, JSON.stringify(from)])).rowCount;
  }
  async claimWake(row: RouteRow): Promise<boolean> {
    return !!(await this.db.execute(`UPDATE ${ROUTES} SET wake_state='requested_unknown',wake_attempt=wake_attempt+1,updated_at=now()
      WHERE id=$1 AND status='routed' AND followups_checked_at IS NULL AND wake_state=$2 AND wake_attempt=$3`, [row.id, row.wake_state, row.wake_attempt])).rowCount;
  }
  async finishWake(id: string, attempt: number, state: string): Promise<void> {
    await this.db.execute(`UPDATE ${ROUTES} SET wake_state=$3,updated_at=now()
      WHERE id=$1 AND status='routed' AND wake_state='requested_unknown' AND wake_attempt=$2`, [id, attempt, state]);
  }
  async followupError(id: string, error: string | null): Promise<void> {
    await this.db.execute(`UPDATE ${ROUTES} SET last_error=$2,updated_at=now() WHERE id=$1 AND status='routed' AND followups_checked_at IS NULL`, [id, error]);
  }
  async list(company: string, mailbox: string, offset = 0) {
    const rows = await this.db.query<RouteRow>(`SELECT * FROM ${ROUTES} WHERE source_company_id=$1 AND mailbox_key=$2
      ORDER BY CASE WHEN status IN ('waiting','claimed') OR (status='routed' AND followups_checked_at IS NULL AND (wake_state IN ('pending','requested_unknown') OR audit_state='pending')) THEN 0 ELSE 1 END,updated_at DESC,id LIMIT 26 OFFSET $3`, [company, mailbox, offset]);
    const [count] = await this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${ROUTES}
      WHERE source_company_id=$1 AND mailbox_key=$2 AND status IN ('waiting','claimed')`, [company, mailbox]);
    const [followups] = await this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${ROUTES}
      WHERE source_company_id=$1 AND mailbox_key=$2 AND status='routed' AND followups_checked_at IS NULL AND (wake_state IN ('pending','requested_unknown') OR audit_state='pending')`, [company, mailbox]);
    return { rows: rows.slice(0, 25), hasMore: rows.length > 25, total: count.total, followups: followups.total };
  }
  async mailboxes(company: string, offset = 0) {
    return this.db.query<{ mailbox_key: string }>(`SELECT DISTINCT mailbox_key FROM ${ROUTES}
      WHERE source_company_id=$1 AND (status IN ('waiting','claimed') OR (status='routed' AND followups_checked_at IS NULL AND (wake_state IN ('pending','requested_unknown','requested_or_duplicate_verify') OR audit_state IN ('pending','unknown')))) ORDER BY mailbox_key LIMIT 101 OFFSET $2`, [company, offset]);
  }
}
