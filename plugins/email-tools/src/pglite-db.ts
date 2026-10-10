/**
 * Test support only: a real Postgres (PGlite) behind the plugin's ctx.db
 * shape, with every email-tools migration applied.
 *
 * It also refuses what the host refuses, so SQL that passes here does not
 * fail the first time it meets the real host: one statement per call, SELECT
 * only through query, no DDL through execute, every parameter referenced, and
 * no array parameters (the host binds through drizzle, which spreads an array
 * into a parenthesised list that Postgres reads as a row).
 */
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginDatabaseClient } from "@paperclipai/plugin-sdk";

export const NAMESPACE = "plugin_email_tools_7cbee3fdf3";

function assertHostWouldRun(kind: "query" | "execute", sql: string, params: unknown[]): void {
  const withoutComments = sql.replace(/--.*$/gm, "");
  const normalized = withoutComments
    .replace(/'([^']|'')*'/g, "''")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (normalized.replace(/;\s*$/, "").includes(";")) {
    throw new Error("host would refuse: one statement per call");
  }
  if (kind === "query") {
    if (!/^(select|with) /.test(normalized)) {
      throw new Error("host would refuse: ctx.db.query only allows SELECT");
    }
    if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized)) {
      throw new Error("host would refuse: ctx.db.query cannot contain mutation keywords");
    }
  } else {
    if (!/^(insert into|update|delete from)\b/.test(normalized)) {
      throw new Error("host would refuse: ctx.db.execute only allows INSERT, UPDATE, or DELETE");
    }
    if (/\b(alter|create|drop|truncate)\b/.test(normalized)) {
      throw new Error("host would refuse: ctx.db.execute cannot contain DDL keywords");
    }
  }
  if (params.some((p) => Array.isArray(p))) {
    throw new Error("host would mangle: an array parameter is bound as a row, pass JSON text");
  }
  const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  for (let i = 1; i <= params.length; i++) {
    if (!used.has(i)) throw new Error(`host would refuse: parameter $${i} is never referenced`);
  }
}

export async function openPluginDb(): Promise<{
  pg: PGlite;
  db: PluginDatabaseClient;
  /** Every statement run through db, in order, for tests that count them. */
  statements: string[];
  /** Make statements matching this fail, as a database outage would; null stops it. */
  failWhen: (pattern: RegExp | null) => void;
}> {
  const pg = new PGlite();
  await pg.exec(`CREATE SCHEMA ${NAMESPACE}`);
  const dir = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) {
    await pg.exec(await readFile(new URL(name, dir), "utf8"));
  }
  const statements: string[] = [];
  let failing: RegExp | null = null;
  const run = (sql: string) => {
    statements.push(sql);
    if (failing?.test(sql)) throw new Error("simulated database failure");
  };
  const db: PluginDatabaseClient = {
    namespace: NAMESPACE,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      assertHostWouldRun("query", sql, params);
      run(sql);
      return (await pg.query<T>(sql, params)).rows;
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      assertHostWouldRun("execute", sql, params);
      run(sql);
      return { rowCount: (await pg.query(sql, params)).affectedRows ?? 0 };
    },
  };
  return { pg, db, statements, failWhen: (pattern) => (failing = pattern) };
}
