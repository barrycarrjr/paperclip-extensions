import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/** Synthetic, in-memory host substitute. Never connects to an instance. */
export async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE companies (id text PRIMARY KEY, issue_prefix text);
    INSERT INTO companies VALUES ('11111111-1111-4111-8111-111111111111', 'EXA'), ('22222222-2222-4222-8222-222222222222', 'OTHER');
    CREATE TABLE agents (id text PRIMARY KEY, company_id text, name text, role text, status text, created_at timestamptz, last_heartbeat_at timestamptz);
    CREATE TABLE heartbeat_runs (id text PRIMARY KEY, company_id text, agent_id text, started_at timestamptz);
    CREATE TABLE cost_events (company_id text, agent_id text, cost_cents integer, occurred_at timestamptz);
    CREATE TABLE issues (company_id text, assignee_agent_id text, status text, hidden_at timestamptz);
    INSERT INTO agents VALUES
      ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Example idle', 'engineer', 'idle', '2026-01-01Z', NULL),
      ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Example active', 'engineer', 'idle', '2026-01-01Z', '2026-10-17Z'),
      ('aaaaaaaa-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'Example new', 'engineer', 'idle', '2026-10-17Z', NULL),
      ('aaaaaaaa-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', 'Example low use', 'engineer', 'idle', '2026-01-01Z', NULL),
      ('aaaaaaaa-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', 'Example terminated', 'engineer', 'terminated', '2026-01-01Z', NULL),
      ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Example other company', 'engineer', 'idle', '2026-01-01Z', NULL);
    INSERT INTO heartbeat_runs VALUES
      ('run-a1', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', '2026-10-17Z'),
      ('run-a2', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', '2026-10-16Z'),
      ('run-a3', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', '2026-10-15Z'),
      ('run-a4', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', '2026-10-14Z'),
      ('run-a5', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', '2026-08-01Z'),
      ('run-a6', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', '2026-01-01Z'),
      ('run-low', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000004', '2026-10-17Z'),
      ('run-null', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', NULL),
      ('run-foreign', '22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-10-17Z');
    INSERT INTO cost_events VALUES
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 125, '2026-10-17Z'),
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 75, '2026-10-16Z'),
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 999, '2026-08-01Z'),
      ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000001', 9999, '2026-10-17Z'),
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 400, '2026-10-17Z');
    INSERT INTO issues VALUES
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 'todo', NULL),
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 'blocked', NULL),
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 'done', NULL),
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 'cancelled', NULL),
      ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000002', 'todo', '2026-10-17Z'),
      ('22222222-2222-4222-8222-222222222222', 'aaaaaaaa-0000-4000-8000-000000000001', 'todo', NULL);`);
  await db.exec("CREATE SCHEMA plugin_roster_6cd9f5bcfd");
  await db.exec(await readFile(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  let config: Record<string, unknown> = { allowedCompanies: ["11111111-1111-4111-8111-111111111111"] };
  const entries: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const actions = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const ctx = {
    config: { get: async () => config },
    db: { namespace: "plugin_roster_6cd9f5bcfd", execute: async (sql: string, params?: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows ?? 0 }), query: async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows },
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
    actions: { register: (key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => actions.set(key, handler) },
    data: { register: (key: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => handlers.set(key, handler) },
    logger: { warn() {}, error() {}, info() {} },
  } as unknown as PluginContext;
  return { db, ctx, entries, handlers, actions, setConfig: (value: Record<string, unknown>) => { config = value; } };
}
