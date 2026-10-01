import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import plugin from "./worker.js";
import type { Config } from "./routing.js";
import { supportErrorMessage } from "./ui/error-message.js";

const company = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const namespace = "plugin_customer_support_0c69412611";

test("registered toolkit serves setup state without database access and keeps configured records company scoped", async () => {
  const db = new PGlite();
  let cfg: Config = {};
  let reads = 0;
  let failReads = false;
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
  const noOp = () => {};
  const ctx = {
    config: { get: async () => cfg },
    data: { register: (key: string, handler: (params: Record<string, unknown>) => Promise<any>) => handlers.set(key, handler) },
    tools: { register: noOp }, events: { on: noOp }, jobs: { register: noOp },
    state: { get: async () => null },
    db: { namespace, query: async (sql: string, params: unknown[]) => {
      reads++;
      if (failReads) throw new Error("Database unavailable");
      return (await db.query(sql, params)).rows;
    } },
  } as unknown as PluginContext;
  try {
    await plugin.definition.setup(ctx);
    const toolkit = handlers.get("support.toolkit")!;
    assert.ok(toolkit, "test the handler actually registered by the worker");
    const initial = await toolkit({ companyId: company });
    assert.equal(initial.configured, false);
    assert.ok(initial.diagnostics.length && initial.references.length && initial.repairRecipes.length);
    for (const key of ["assets", "printers", "fleet", "devices", "knowledge"]) assert.deepEqual(initial[key], []);
    assert.equal(reads, 0);
    await assert.rejects(toolkit({ companyId: "invalid" }), /Company ID must be a UUID/);
    await assert.rejects(toolkit({}), /Company ID must be a UUID/);
    assert.equal(reads, 0);

    await db.exec(`CREATE SCHEMA ${namespace}`);
    for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    cfg = { discoveryNetworks: [{ id: "office", companyId: company, cidr: "192.0.2.0/24" }] };
    await db.query(`INSERT INTO ${namespace}.support_knowledge(company_id,title,topic,kind,body,created_by_user_id) VALUES ($1,'Example procedure','networking','procedure','Example steps','example-operator')`, [company]);
    const saved = await toolkit({ companyId: company });
    assert.equal(saved.configured, true);
    assert.equal(saved.knowledge.length, 1);
    assert.equal(saved.knowledge[0].title, "Example procedure");
    assert.deepEqual(saved.fleet, []);
    const beforeOther = reads;
    const hidden = await toolkit({ companyId: other });
    assert.equal(hidden.configured, false);
    assert.deepEqual(hidden.knowledge, []);
    assert.equal(reads, beforeOther, "unconfigured companies cannot load another company's records");
    cfg.discoveryNetworks!.push({ id: "other-office", companyId: other, cidr: "198.51.100.0/24" });
    const configuredOther = await toolkit({ companyId: other });
    assert.equal(configuredOther.configured, true);
    assert.deepEqual(configuredOther.knowledge, [], "a configured company cannot load another company's records either");
    failReads = true;
    await assert.rejects(toolkit({ companyId: company }), /Database unavailable/, "real failures must not become empty states");
  } finally { await db.close(); }
});

test("UI renders bridge messages without object dumps or internal error details", () => {
  assert.equal(supportErrorMessage({ code: "HANDLER_ERROR", message: "Support settings need attention", details: { password: "private fixture" } }), "Support settings need attention");
  assert.equal(supportErrorMessage(new Error("Unavailable")), "Unavailable");
  assert.equal(supportErrorMessage("Connection failed"), "Connection failed");
  for (const value of [null, undefined, {}, { message: 5 }, { message: " " }]) {
    assert.ok(!supportErrorMessage(value).includes("[object Object]"));
    assert.match(supportErrorMessage(value), /check the plugin's status/);
  }
});
