import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/** Synthetic, in-memory host substitute. Never connects to an instance. */
export async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE companies (id text PRIMARY KEY, issue_prefix text);
    INSERT INTO companies VALUES ('company-a', 'EXA'), ('company-b', 'OTHER');
    CREATE TABLE agents (id text PRIMARY KEY, company_id text, name text, role text, status text, created_at timestamptz, last_heartbeat_at timestamptz);
    CREATE TABLE heartbeat_runs (id text PRIMARY KEY, company_id text, agent_id text, started_at timestamptz);
    CREATE TABLE cost_events (company_id text, agent_id text, cost_cents integer, occurred_at timestamptz);
    CREATE TABLE issues (company_id text, assignee_agent_id text, status text, hidden_at timestamptz);
    INSERT INTO agents VALUES
      ('idle-a', 'company-a', 'Example idle', 'engineer', 'idle', '2026-01-01Z', NULL),
      ('active-a', 'company-a', 'Example active', 'engineer', 'idle', '2026-01-01Z', '2026-10-17Z'),
      ('new-a', 'company-a', 'Example new', 'engineer', 'idle', '2026-10-17Z', NULL),
      ('low-a', 'company-a', 'Example low use', 'engineer', 'idle', '2026-01-01Z', NULL),
      ('gone-a', 'company-a', 'Example terminated', 'engineer', 'terminated', '2026-01-01Z', NULL),
      ('other-b', 'company-b', 'Example other company', 'engineer', 'idle', '2026-01-01Z', NULL);
    INSERT INTO heartbeat_runs VALUES
      ('run-a1', 'company-a', 'active-a', '2026-10-17Z'),
      ('run-a2', 'company-a', 'active-a', '2026-10-16Z'),
      ('run-a3', 'company-a', 'active-a', '2026-10-15Z'),
      ('run-a4', 'company-a', 'active-a', '2026-10-14Z'),
      ('run-a5', 'company-a', 'active-a', '2026-08-01Z'),
      ('run-a6', 'company-a', 'active-a', '2026-01-01Z'),
      ('run-low', 'company-a', 'low-a', '2026-10-17Z'),
      ('run-null', 'company-a', 'idle-a', NULL),
      ('run-foreign', 'company-b', 'idle-a', '2026-10-17Z');
    INSERT INTO cost_events VALUES
      ('company-a', 'idle-a', 125, '2026-10-17Z'),
      ('company-a', 'idle-a', 75, '2026-10-16Z'),
      ('company-a', 'idle-a', 999, '2026-08-01Z'),
      ('company-b', 'idle-a', 9999, '2026-10-17Z'),
      ('company-a', 'active-a', 400, '2026-10-17Z');
    INSERT INTO issues VALUES
      ('company-a', 'active-a', 'todo', NULL),
      ('company-a', 'active-a', 'blocked', NULL),
      ('company-a', 'active-a', 'done', NULL),
      ('company-a', 'active-a', 'cancelled', NULL),
      ('company-a', 'active-a', 'todo', '2026-10-17Z'),
      ('company-b', 'idle-a', 'todo', NULL);`);
  let config: Record<string, unknown> = { allowedCompanies: ["company-a"] };
  const entries: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = {
    config: { get: async () => config },
    db: { query: async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows },
    agents: {
      get: async (id: string, companyId: string) => {
        const row = (await db.query<{ id: string; company_id: string; status: string }>("SELECT id, company_id, status FROM agents WHERE id = $1 AND company_id = $2", [id, companyId])).rows[0];
        return row ? { id: row.id, companyId: row.company_id, status: row.status } : null;
      },
      pause: async (id: string, companyId: string) => {
        await db.query("UPDATE agents SET status = 'paused' WHERE id = $1 AND company_id = $2", [id, companyId]);
        return { id, companyId, status: "paused" };
      },
    },
    activity: { log: async (entry: Record<string, unknown>) => { entries.push(entry); } },
    data: { register: (key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => handlers.set(key, handler) },
    logger: { warn() {}, error() {}, info() {} },
  } as unknown as PluginContext;
  return { db, ctx, entries, handlers, setConfig: (value: Record<string, unknown>) => { config = value; } };
}
