import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { fixture } from "./fixtures.js";
import { plugin } from "./worker.js";

test("isolated HTTP app serves scoped roster, rejects agent/foreign-company calls and confirms a logged pause", async () => {
  const f = await fixture();
  await plugin.definition.setup(f.ctx);
  // Minimal host transport substitute, not a Paperclip install or auth test.
  // Only synthetic in-memory data; an ephemeral loopback port prevents live access.
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (req.headers["x-example-board"] !== "true") { res.writeHead(403).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await plugin.definition.onApiRequest!({
      routeKey: req.method === "POST" ? "roster.pause" : "roster.list", method: req.method!, path: url.pathname,
      params: { agentId: url.pathname.split("/")[2] }, query: {}, headers: {},
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
      actor: { actorType: "user", actorId: "board-example", ...(req.headers["x-example-pause-grant"] === "true" ? { grantedPermission: "agents:create" } : {}) }, companyId: url.searchParams.get("companyId") ?? "",
    });
    res.writeHead(response.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(response.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = { "x-example-board": "true" };
  try {
    // Dates relative to the server clock keep this runtime check repeatable.
    await f.db.exec(`UPDATE agents SET created_at = now() - interval '100 days'; UPDATE agents SET created_at = now() - interval '1 day' WHERE id = 'new-a'; UPDATE heartbeat_runs SET started_at = now() - interval '1 day' WHERE id IN ('run-a1','run-a2','run-a3','run-a4','run-low'); UPDATE cost_events SET occurred_at = now() - interval '1 day' WHERE cost_cents IN (125,75,400);`);
    const response = await fetch(`${origin}/roster?companyId=company-a`, { headers });
    assert.equal(response.status, 200);
    const roster = await response.json() as { rows: Array<{ id: string; verdict: string }>; idleCount: number; idleCostCents30: number };
    assert.equal(roster.idleCount, 1); assert.equal(roster.idleCostCents30, 200);
    assert.equal(roster.rows.find((row) => row.id === "active-a")?.verdict, "Active");
    assert.equal(roster.rows.find((row) => row.id === "new-a")?.verdict, "New");
    assert.equal((await fetch(`${origin}/roster?companyId=company-b`, { headers })).status, 403);
    assert.equal((await fetch(`${origin}/roster?companyId=company-a`)).status, 403);
    const denied = await fetch(`${origin}/agents/idle-a/pause?companyId=company-a`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, requestId: "request-http-example", grantedPermission: "agents:create", actor: { grantedPermission: "agents:create" } }) });
    assert.equal(denied.status, 403);
    assert.equal(f.entries.length, 0);
    assert.equal((await f.ctx.agents.get("idle-a", "company-a"))?.status, "idle");
    const pause = await fetch(`${origin}/agents/idle-a/pause?companyId=company-a`, { method: "POST", headers: { ...headers, "x-example-pause-grant": "true", "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true, requestId: "request-http-example" }) });
    assert.equal(pause.status, 200); assert.deepEqual(await pause.json(), { paused: true });
    assert.equal((await f.ctx.agents.get("idle-a", "company-a"))?.status, "paused");
    assert.equal(f.entries.at(-1)?.message, "agent_roster.pause_completed");
    console.log("HTTP fixture: roster 200, denied company 403, non-board 403, confirmed pause 200, completion activity recorded");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await plugin.definition.onShutdown?.();
    await f.db.close();
  }
});
