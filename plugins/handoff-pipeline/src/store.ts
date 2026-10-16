import type { CommandMeta, PipelineCommand, PipelineEvent, PipelineState } from "./contracts.js";
import { applyCommand, createState, PipelineError } from "./lifecycle.js";

export interface PipelineDatabase {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
}
export interface SqlStatement { sql: string; params: unknown[] }
function table(namespace: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(namespace)) throw new PipelineError("invalid_input", "Unsafe database namespace");
  return `${namespace}.pipeline_companies`;
}
function outboxTable(namespace: string): string {
  table(namespace);
  return `${namespace}.activity_outbox`;
}
export function selectStateSql(namespace: string, companyId: string): SqlStatement {
  return { sql: `SELECT version, state FROM ${table(namespace)} WHERE company_id = $1`, params: [companyId] };
}
export function insertStateSql(namespace: string, state: PipelineState): SqlStatement {
  const event = state.events.at(-1)!;
  return {
    sql: `WITH saved AS (INSERT INTO ${table(namespace)} (company_id, version, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id) DO NOTHING RETURNING company_id) INSERT INTO ${outboxTable(namespace)} (company_id, event_id, event) SELECT company_id, $4, $5::jsonb FROM saved ON CONFLICT (company_id, event_id) DO NOTHING`,
    params: [state.companyId, state.version, JSON.stringify(state), event.id, JSON.stringify(event)],
  };
}
export function updateStateSql(namespace: string, state: PipelineState, expectedVersion: number): SqlStatement {
  const event = state.events.at(-1)!;
  return {
    sql: `WITH saved AS (UPDATE ${table(namespace)} SET version = $2, state = $3::jsonb, updated_at = now() WHERE company_id = $1 AND version = $4 RETURNING company_id) INSERT INTO ${outboxTable(namespace)} (company_id, event_id, event) SELECT company_id, $5, $6::jsonb FROM saved ON CONFLICT (company_id, event_id) DO NOTHING`,
    params: [state.companyId, state.version, JSON.stringify(state), expectedVersion, event.id, JSON.stringify(event)],
  };
}

/** One atomic company aggregate prevents partial reviews, streaks, or event writes. */
export class PipelineStore {
  constructor(private readonly db: PipelineDatabase, private readonly maxAttempts = 8) {}
  async read(companyId: string): Promise<PipelineState> {
    const empty = createState(companyId);
    const statement = selectStateSql(this.db.namespace, companyId);
    const rows = await this.db.query<{ version: number; state: PipelineState | string }>(statement.sql, statement.params);
    if (!rows.length) return empty;
    const state: PipelineState = typeof rows[0].state === "string" ? JSON.parse(rows[0].state) : rows[0].state;
    if (state.companyId !== companyId || state.version !== Number(rows[0].version)) throw new PipelineError("conflict", "Stored company state is inconsistent");
    return state;
  }
  async pendingActivities(companyId?: string): Promise<PipelineEvent[]> {
    const sql = companyId
      ? `SELECT event FROM ${outboxTable(this.db.namespace)} WHERE company_id = $1 ORDER BY created_at, event_id LIMIT 100`
      : `SELECT event FROM ${outboxTable(this.db.namespace)} ORDER BY created_at, event_id LIMIT 100`;
    const rows = await this.db.query<{ event: PipelineEvent | string }>(sql, companyId ? [companyId] : []);
    return rows.map(({ event }) => typeof event === "string" ? JSON.parse(event) as PipelineEvent : event);
  }
  async acknowledgeActivity(companyId: string, eventId: string): Promise<void> {
    await this.db.execute(
      `DELETE FROM ${outboxTable(this.db.namespace)} WHERE company_id = $1 AND event_id = $2`,
      [companyId, eventId],
    );
  }
  async dispatch(companyId: string, command: PipelineCommand, meta: CommandMeta, expectedVersion?: number): Promise<PipelineState> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const before = await this.read(companyId);
      if (expectedVersion !== undefined && before.version !== expectedVersion) throw new PipelineError("conflict", "Pipeline changed after rebuild preflight; review the latest job before saving the skill");
      const after = applyCommand(before, command, meta);
      if (after === before) return before;
      const statement = before.version === 0 ? insertStateSql(this.db.namespace, after) : updateStateSql(this.db.namespace, after, before.version);
      const result = await this.db.execute(statement.sql, statement.params);
      if (result.rowCount === 1) return after;
    }
    throw new PipelineError("conflict", "Company changed concurrently; retry the request");
  }
}
