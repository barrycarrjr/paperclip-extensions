import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { parsePrinterResponse, printerRequest, readPrinterAttributes } from "./printer-ipp.js";
import { printerEndpoint, checkPrinter, printerHistory } from "./printer-support.js";
import { buildRepairRecipe, prepareRepair } from "./repair-catalog.js";
import { openInteractiveCase } from "./interactive-support.js";
import type { Config } from "./routing.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompany = "22222222-2222-4222-8222-222222222222";
const run: ToolRunContext = { companyId, userId: "operator", chatSessionId: "chat", agentId: "", runId: "turn", userPermission: "support:diagnose" };
const cfg: Config = { discoveryNetworks: [{ companyId, id: "office", cidr: "192.0.2.0/24" }], remoteAccessProfiles: [{ companyId, id: "windows", credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333", scopes: [{ kind: "dns_suffix", value: "office.example.local", transport: "Wmi" }] }] };
function attr(tag: number, name: string, raw: string | number | boolean) {
  const key = Buffer.from(name); const value = typeof raw === "number" ? Buffer.alloc(4) : typeof raw === "boolean" ? Buffer.from([+raw]) : Buffer.from(raw);
  if (typeof raw === "number") value.writeInt32BE(raw);
  const header = Buffer.alloc(3); header[0] = tag; header.writeUInt16BE(key.length, 1); const length = Buffer.alloc(2); length.writeUInt16BE(value.length);
  return Buffer.concat([header, key, length, value]);
}
function response(id: number, items: Buffer[] = [attr(0x23, "printer-state", 5), attr(0x44, "printer-state-reasons", "media-jam-error"), attr(0x44, "", "toner-low-warning"), attr(0x22, "printer-is-accepting-jobs", false), attr(0x21, "queued-job-count", 2)]) {
  const header = Buffer.alloc(9); header[0] = 1; header[1] = 1; header.writeInt32BE(id, 4); header[8] = 4;
  return Buffer.concat([header, ...items, Buffer.from([3])]);
}
function memoryContext() {
  const state = new Map<string, unknown>(); let logged = 0;
  const key = (value: unknown) => JSON.stringify(value);
  return { ctx: { state: { get: async (value: unknown) => state.get(key(value)) ?? null, set: async (value: unknown, data: unknown) => { state.set(key(value), data); } }, activity: { log: async () => { logged++; } } } as unknown as PluginContext, logged: () => logged };
}
test("IPP encodes only Get-Printer-Attributes and parses bounded metadata without jobs or extra attributes", () => {
  const request = printerRequest({ address: "192.0.2.10", port: 631, path: "/ipp/print", tls: false }, 42);
  assert.equal(request.readUInt16BE(2), 11); assert.equal(request.readInt32BE(4), 42); assert.ok(request.includes(Buffer.from("ipp://192.0.2.10:631/ipp/print")));
  const parsed = parsePrinterResponse(response(42, [attr(0x23, "printer-state", 5), attr(0x44, "printer-state-reasons", "media-jam-error"), attr(0x44, "", "toner-low-warning"), attr(0x42, "job-name", "private document"), attr(0x42, "printer-name", "Printer\nname")]), 42);
  assert.deepEqual(parsed.attributes["printer-state-reasons"], ["media-jam-error", "toner-low-warning"]); assert.equal(parsed.attributes["job-name"], undefined); assert.deepEqual(parsed.attributes["printer-name"], ["Printer name"]);
  assert.throws(() => parsePrinterResponse(response(43), 42)); assert.throws(() => parsePrinterResponse(response(42).subarray(0, -2), 42));
  assert.throws(() => parsePrinterResponse(response(42, [attr(0x44, "", "unbound")]), 42));
  assert.throws(() => parsePrinterResponse(response(42, [attr(0x22, "printer-is-accepting-jobs", "wrong")]), 42));
  assert.throws(() => parsePrinterResponse(response(42, Array.from({ length: 65 }, (_, i) => attr(0x44, i ? "" : "printer-state-reasons", "none"))), 42));
});
test("real HTTP exchange binds request IDs and rejects redirects, non-IPP, oversized and stalled responses", async () => {
  let mode = "ok"; let redirects = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", data => chunks.push(data)); req.on("end", () => {
      const data = Buffer.concat(chunks); assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, undefined); assert.equal(data.readUInt16BE(2), 11);
      if (mode === "stall") return;
      if (mode === "redirect") { redirects++; res.writeHead(302, { location: "http://127.0.0.1/other" }); return res.end(); }
      res.setHeader("content-type", mode === "html" ? "text/html" : "application/ipp");
      res.end(mode === "large" ? Buffer.alloc(128 * 1024 + 1) : response(mode === "wrong-id" ? 1 : data.readInt32BE(4)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
  const endpoint = { address: "127.0.0.1", port, path: "/ipp/print", tls: false };
  try {
    assert.deepEqual((await readPrinterAttributes(endpoint)).attributes["printer-state"], [5]);
    for (const rejected of ["redirect", "html", "large", "wrong-id", "stall"]) { mode = rejected; await assert.rejects(readPrinterAttributes(endpoint, 100)); }
    assert.equal(redirects, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("printer scope rejects another company, unsafe addresses, ambiguous networks, arbitrary URLs and credentials", () => {
  assert.equal(printerEndpoint(cfg, companyId, { address: "192.0.2.10" }).endpoint.path, "/ipp/print");
  for (const input of [{ address: "192.0.3.10" }, { address: "127.0.0.1" }, { address: "192.0.2.0" }, { address: "192.0.2.010" }, { address: "printer.example.com" }, { address: "192.0.2.10", port: 9100 }, { address: "192.0.2.10", port: 443 }, { address: "192.0.2.10", tls: "yes" }, { address: "192.0.2.10", path: "http://example.com" }, { address: "192.0.2.10", path: "/ipp/print?password=value" }]) assert.throws(() => printerEndpoint(cfg, companyId, input));
  assert.throws(() => printerEndpoint(cfg, otherCompany, { address: "192.0.2.10" }));
  const overlap = { ...cfg, discoveryNetworks: [...cfg.discoveryNetworks!, { companyId, id: "second", cidr: "192.0.2.0/24" }] };
  assert.throws(() => printerEndpoint(overlap, companyId, { address: "192.0.2.10" }));
  assert.equal(printerEndpoint(overlap, companyId, { address: "192.0.2.10", networkId: "office" }).network.id, "office");
});
test("printer observations retain provenance and unavailable status, isolate companies and disappear when range changes", async () => {
  const { ctx, logged } = memoryContext(); let calls = 0;
  const read: typeof readPrinterAttributes = async () => { calls++; return parsePrinterResponse(response(42), 42); };
  await assert.rejects(checkPrinter(ctx, cfg, { ...run, userPermission: undefined }, { address: "192.0.2.10" }, read));
  await assert.rejects(checkPrinter(ctx, cfg, { ...run, companyId: otherCompany }, { address: "192.0.2.10" }, read)); assert.equal(calls, 0);
  const observed = await checkPrinter(ctx, cfg, run, { address: "192.0.2.10" }, read); assert.equal(observed.state, "stopped"); assert.equal(observed.acceptingJobs, false); assert.equal(observed.queuedJobs, 2); assert.equal(logged(), 1);
  assert.equal((await printerHistory(ctx, cfg, companyId)).length, 1); assert.equal((await printerHistory(ctx, cfg, otherCompany)).length, 0);
  const changed = { ...cfg, discoveryNetworks: [{ companyId, id: "office", cidr: "192.0.3.0/24" }] }; assert.equal((await printerHistory(ctx, changed, companyId)).length, 0);
  const unavailable = await checkPrinter(ctx, cfg, run, { address: "192.0.2.10" }, async () => { throw new Error("Private transport details"); });
  assert.equal(unavailable.status, "unavailable"); assert.equal(unavailable.state, "unknown"); assert.ok(!JSON.stringify(unavailable).includes("Private transport"));
  assert.equal((await printerHistory(ctx, cfg, companyId)).length, 1);
});
test("port repair requires fresh recorded prior state and returns an exact separately confirmed recovery object", async () => {
  const namespace = "plugin_customer_support_0c69412611"; const db = new PGlite(); await db.exec(`CREATE SCHEMA ${namespace}`);
  for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const ctx = { db: { namespace, query: async (sql: string, params: unknown[]) => { assert.match(sql.trim(), /^SELECT\b/); return (await db.query(sql, params)).rows; }, execute: async (sql: string, params: unknown[]) => ({ rowCount: (await db.query(sql, params)).affectedRows }) }, activity: { log: async () => {} } } as unknown as PluginContext;
  try {
    const supportCase = await openInteractiveCase(ctx, cfg, run, { target: "pc", summary: "Printer port" });
    const repairRun = { ...run, userPermission: "support:repair" }; const input = { caseId: supportCase.caseId, operation: "change_printer_port", options: { printer: "Queue", expectedPortName: "Previous", newPortName: "Correct" } };
    await assert.rejects(prepareRepair(ctx, cfg, repairRun, input));
    const findings = { printers: [{ Name: "Queue", PortName: "Previous", DriverName: "Installed driver", JobCount: 0 }], ports: [{ Name: "Previous" }, { Name: "Correct", PrinterHostAddress: "192.0.2.10" }] };
    await db.query(`INSERT INTO ${namespace}.support_diagnostics(company_id,case_id,check_kind,result,user_id) VALUES($1,$2,'printers',$3::jsonb,'operator')`, [companyId, supportCase.caseId, JSON.stringify({ findings })]);
    const prepared = await prepareRepair(ctx, cfg, repairRun, input); assert.equal(prepared.priorState?.portName, "Previous"); assert.equal(prepared.recoveryRepair?.target, supportCase.target);
    assert.ok(prepared.instruction.includes("nothing was executed or approved"));
    await assert.rejects(prepareRepair(ctx, cfg, run, input)); await assert.rejects(prepareRepair(ctx, cfg, { ...repairRun, companyId: otherCompany }, input));
    await db.query(`UPDATE ${namespace}.support_diagnostics SET created_at=now()-interval '31 minutes' WHERE case_id=$1`, [supportCase.caseId]);
    await assert.rejects(prepareRepair(ctx, cfg, repairRun, input));
  } finally { await db.close(); }
});
test("Windows port rehearsal changes, verifies and restores only a simulated queue; stale state and jobs prevent writes", { skip: process.platform !== "win32" }, async () => {
  const options = { printer: "Queue'; not executable", expectedPortName: "Previous", newPortName: "Correct" };
  const forward = buildRepairRecipe("change_printer_port", options); const inverse = buildRepairRecipe("change_printer_port", { ...options, expectedPortName: "Correct", newPortName: "Previous" });
  const mock = `$global:q=[pscustomobject]@{Name="Queue'; not executable";PortName='Previous';JobCount=0}; $global:writes=0
function Get-Printer { $global:q }
function Get-PrinterPort { [pscustomobject]@{Name='Previous'}; [pscustomobject]@{Name='Correct'} }
function Set-Printer { param($InputObject,$PortName,$ErrorAction); $InputObject.PortName=$PortName; $global:writes++ }
`;
  const rehearsal = `${mock}\n& { ${forward.script} }\n& { ${forward.verificationScript} }\n& { ${inverse.script} }\n& { ${inverse.verificationScript} }\nif ($global:writes -ne 2 -or $global:q.PortName -ne 'Previous') { throw 'Recovery failed' }\n$global:q.JobCount=1; $blocked=$false; try { & { ${forward.script} } } catch { $blocked=$true }; if (-not $blocked -or $global:writes -ne 2) { throw 'Queued work was changed' }\n$global:q.JobCount=0; $global:q.PortName='Unexpected'; $blocked=$false; try { & { ${forward.script} } } catch { $blocked=$true }; if (-not $blocked -or $global:writes -ne 2) { throw 'Stale state was changed' }\n'PASSED'`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; }); child.on("error", reject); child.on("close", code => code === 0 && output.includes("PASSED") ? resolve() : reject(new Error(output))); child.stdin.end(rehearsal);
  });
});
