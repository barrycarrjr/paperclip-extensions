/**
 * Upgrading an existing install: a filing written under 001 with the old
 * preparer value must come out of 002 as owner, and the old value must be
 * refused afterwards.
 *
 * Runs only when BUSINESS_RECORDS_TEST_DATABASE_URL names a database. Uses its
 * own randomly named schema and drops it at the end.
 */
import { test, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATABASE_URL = process.env.BUSINESS_RECORDS_TEST_DATABASE_URL ?? "";
const MIGRATION_SCHEMA = "plugin_business_records_95a607b2ab";
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

if (!DATABASE_URL) {
  test("migration upgrade", { skip: "BUSINESS_RECORDS_TEST_DATABASE_URL is not set, so the upgrade test was not run." }, () => {});
} else {
  const schema = `br_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

  test("002 turns the old preparer value into owner and refuses it afterwards", async () => {
    await migration("001_init.sql");
    const company = randomUUID();
    const business = randomUUID();
    await pool.query(
      `INSERT INTO ${schema}.businesses (id, company_id, name, relationship) VALUES ($1, $2, 'Upgrade Test LLC', 'owned')`,
      [business, company],
    );
    const insert = (preparer: string | null, periodLabel: string) =>
      pool.query(
        `INSERT INTO ${schema}.business_filings (company_id, business_id, filing, authority, period_label, due_date, preparer)
         VALUES ($1, $2, 'Annual report', 'State', $3, '2026-12-31', $4)`,
        [company, business, periodLabel, preparer],
      );
    await insert("barry", "2024");
    await insert("cpa", "2025");
    await insert(null, "2026");

    await migration("002_owner_preparer.sql");

    const rows = (await pool.query(`SELECT period_label, preparer FROM ${schema}.business_filings ORDER BY period_label`)).rows;
    assert.deepEqual(rows, [
      { period_label: "2024", preparer: "owner" },
      { period_label: "2025", preparer: "cpa" },
      { period_label: "2026", preparer: null },
    ]);
    await assert.rejects(insert("barry", "2027"), /business_filings_preparer_check/);
    await insert("owner", "2028");
  });
}
