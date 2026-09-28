import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const namespace = "plugin_customer_support_0c69412611";

test("migration applies and cases and messages remain distinct across routes and companies", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA ${namespace}`);
    const migration = await readFile(new URL("../migrations/001_init.sql", import.meta.url), "utf8");
    await db.exec(migration);
    const issueMigration = await readFile(new URL("../migrations/002_issue_links.sql", import.meta.url), "utf8");
    await db.exec(issueMigration);
    const threadMigration = await readFile(new URL("../migrations/003_thread_context.sql", import.meta.url), "utf8");
    await db.exec(threadMigration);
    const reviewMigration = await readFile(new URL("../migrations/004_case_review.sql", import.meta.url), "utf8");
    await db.exec(reviewMigration);
    const nonsoftwareMigration = await readFile(new URL("../migrations/005_nonsoftware_work.sql", import.meta.url), "utf8");
    await db.exec(nonsoftwareMigration);
    const assigneeMigration = await readFile(new URL("../migrations/006_issue_assignee.sql", import.meta.url), "utf8");
    await db.exec(assigneeMigration);
    const escalationMigration = await readFile(new URL("../migrations/007_software_escalation.sql", import.meta.url), "utf8");
    await db.exec(escalationMigration);
    const targetMigration = await readFile(new URL("../migrations/008_target_access.sql", import.meta.url), "utf8");
    await db.exec(targetMigration);
    const connectionMigration = await readFile(new URL("../migrations/009_connection_methods.sql", import.meta.url), "utf8");
    await db.exec(connectionMigration);
    await db.exec(await readFile(new URL("../migrations/010_email_source.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../migrations/011_support_actions.sql", import.meta.url), "utf8"));
    const companyA = "11111111-1111-4111-8111-111111111111";
    const companyB = "22222222-2222-4222-8222-222222222222";
    const insertCase = `INSERT INTO ${namespace}.support_cases
      (company_id, connection_id, source, external_route_id, external_conversation_id, title, first_message_at, last_message_at)
      VALUES ($1,'example-workspace','slack',$2,'thread-1','Help needed',now(),now())
      ON CONFLICT (company_id, connection_id, external_route_id, external_conversation_id) DO NOTHING`;
    await db.query(insertCase, [companyA, "C-ALPHA"]);
    await db.query(insertCase, [companyA, "C-ALPHA"]);
    await db.query(insertCase, [companyA, "C-OTHER"]);
    await db.query(insertCase, [companyB, "C-BETA"]);
    await db.query(
      `UPDATE ${namespace}.support_cases SET access_method='wmi_dcom_smb' WHERE company_id=$1 AND external_route_id='C-ALPHA'`,
      [companyA],
    );
    const cases = await db.query<{ company_id: string; external_route_id: string }>(
      `SELECT company_id, external_route_id FROM ${namespace}.support_cases`,
    );
    assert.equal(cases.rows.length, 3);
    assert.equal(cases.rows.filter((row) => row.company_id === companyA).length, 2);
    assert.equal(cases.rows.filter((row) => row.company_id === companyB).length, 1);
    const caseId = await db.query<{ id: string }>(
      `SELECT id FROM ${namespace}.support_cases WHERE company_id=$1 AND external_route_id='C-ALPHA'`, [companyA],
    );
    const insertMessage = `INSERT INTO ${namespace}.support_messages
      (company_id, case_id, connection_id, external_route_id, external_conversation_id,
       external_message_id, author_kind, body, occurred_at)
      VALUES ($1,$2,'example-workspace','C-ALPHA','thread-1','message-1','customer','Help',now())
      ON CONFLICT (company_id, connection_id, external_route_id, external_conversation_id, external_message_id) DO NOTHING`;
    await db.query(insertMessage, [companyA, caseId.rows[0]!.id]);
    await db.query(insertMessage, [companyA, caseId.rows[0]!.id]);
    const messages = await db.query<{ id: string }>(`SELECT id FROM ${namespace}.support_messages WHERE company_id=$1`, [companyA]);
    assert.equal(messages.rows.length, 1);
    const context = await db.query<{ attachments: unknown; thread_cursor_ts: string | null; service_domain: string; review_version: number }>(
      `SELECT m.attachments, c.thread_cursor_ts, c.service_domain, c.review_version FROM ${namespace}.support_messages m
       JOIN ${namespace}.support_cases c ON c.id=m.case_id WHERE m.company_id=$1`, [companyA],
    );
    assert.deepEqual(context.rows[0]?.attachments, []);
    assert.equal(context.rows[0]?.thread_cursor_ts, null);
    assert.equal(context.rows[0]?.service_domain, "unclassified");
    assert.equal(context.rows[0]?.review_version, 0);
    const eligibleThreads = await db.query<{ id: string }>(
      `SELECT id FROM ${namespace}.support_cases
       WHERE connection_id=$1 AND source='slack' AND external_route_id = ANY($2::text[])
         AND company_id = ANY($3::uuid[])
       ORDER BY thread_checked_at ASC NULLS FIRST, last_message_at DESC LIMIT 1`,
      ["example-workspace", ["C-ALPHA"], [companyA]],
    );
    assert.equal(eligibleThreads.rows.length, 1);
    const threadCursor = "1700000200.000300";
    await db.query(
      `UPDATE ${namespace}.support_cases
       SET thread_cursor_ts=CASE WHEN thread_cursor_ts IS NULL OR thread_cursor_ts::numeric < $3::numeric
         THEN $3::text ELSE thread_cursor_ts END, thread_checked_at=now()
       WHERE company_id=$1 AND id=$2`,
      [companyA, caseId.rows[0]!.id, threadCursor],
    );
    const savedCursor = await db.query<{ thread_cursor_ts: string }>(
      `SELECT thread_cursor_ts FROM ${namespace}.support_cases WHERE id=$1`, [caseId.rows[0]!.id],
    );
    assert.equal(savedCursor.rows[0]?.thread_cursor_ts, threadCursor);
    const fileRefs = [{ id: "F-IMAGE", name: "screen.png", mimeType: "image/png" }];
    await db.query(
      `INSERT INTO ${namespace}.support_messages
       (company_id, case_id, connection_id, external_route_id, external_conversation_id,
        external_message_id, author_kind, body, occurred_at, author_external_id, attachments)
       VALUES ($1,$2,'example-workspace','C-ALPHA','thread-1','reply-2','staff','Screen attached',now(),
         'U-STAFF',$3::jsonb)`,
      [companyA, caseId.rows[0]!.id, JSON.stringify(fileRefs)],
    );
    const storedFiles = await db.query<{ attachments: unknown; author_external_id: string }>(
      `SELECT attachments, author_external_id FROM ${namespace}.support_messages
       WHERE company_id=$1 AND external_message_id='reply-2'`, [companyA],
    );
    assert.deepEqual(storedFiles.rows[0]?.attachments, fileRefs);
    assert.equal(storedFiles.rows[0]?.author_external_id, "U-STAFF");
    const insertLink = `INSERT INTO ${namespace}.support_issue_links
      (company_id, case_id, project_id, issue_kind, title, evidence)
      VALUES ($1,$2,$3,'bug','Checkout error','Confirmed reproduction')
      ON CONFLICT (company_id, case_id) DO NOTHING`;
    const projectId = "33333333-3333-4333-8333-333333333333";
    assert.equal((await db.query(insertLink, [companyA, caseId.rows[0]!.id, projectId])).affectedRows, 1);
    assert.equal((await db.query(insertLink, [companyA, caseId.rows[0]!.id, projectId])).affectedRows, 0);
    const links = await db.query(`SELECT id FROM ${namespace}.support_issue_links WHERE company_id=$1`, [companyA]);
    assert.equal(links.rows.length, 1);
  } finally {
    await db.close();
  }
});
