/**
 * Upgrading an existing install: a row written under 001 with the old
 * claimed_by value must come out of 002 as owner, and the old value must be
 * refused afterwards.
 *
 * Runs only when DEAL_DESK_TEST_DATABASE_URL names a database. Uses its own
 * randomly named schema and drops it at the end.
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATABASE_URL = process.env.DEAL_DESK_TEST_DATABASE_URL ?? "";
const MIGRATION_SCHEMA = "plugin_deal_desk_bf83b73d01";
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

if (!DATABASE_URL) {
  test("migration upgrade", { skip: "DEAL_DESK_TEST_DATABASE_URL is not set, so the upgrade test was not run." }, () => {});
} else {
  const schema = `dd_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;
  const migration = async (file: string) =>
    pool.query((await readFile(join(MIGRATIONS_DIR, file), "utf8")).split(MIGRATION_SCHEMA).join(schema));

  before(async () => {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: DATABASE_URL, max: 1 });
    await pool.query(`CREATE SCHEMA ${schema}`);
  });

  after(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  test("002 turns the old claimed_by value into owner and refuses it afterwards", async () => {
    await migration("001_init.sql");
    const company = randomUUID();
    const deal = randomUUID();
    await pool.query(`INSERT INTO ${schema}.deals (id, company_id, business_id, name) VALUES ($1, $2, $3, 'Upgrade test')`, [
      deal,
      company,
      randomUUID(),
    ]);
    const insert = (claimedBy: string, description: string) =>
      pool.query(
        `INSERT INTO ${schema}.earnings_adjustments (company_id, deal_id, period_label, description, amount_cents, kind, claimed_by)
         VALUES ($1, $2, '2025', $3, 100, 'other', $4)`,
        [company, deal, description, claimedBy],
      );
    await insert("barry", "written before the rename");
    await insert("seller", "left alone");

    await migration("002_owner_claimed_by.sql");

    const rows = (await pool.query(`SELECT description, claimed_by FROM ${schema}.earnings_adjustments ORDER BY description`)).rows;
    assert.deepEqual(rows, [
      { description: "left alone", claimed_by: "seller" },
      { description: "written before the rename", claimed_by: "owner" },
    ]);
    await assert.rejects(insert("barry", "after the rename"), /earnings_adjustments_claimed_by_check/);
    await insert("owner", "owner is accepted");
  });
}
