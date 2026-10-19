// Synthetic host only. Never reads a live instance, resolves secrets or allows network access.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import manifest from "../dist/manifest.js";

const denyNetwork = `
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const deny = () => { throw new Error("SYNTHETIC_NETWORK_DISABLED"); };
globalThis.fetch = deny;
http.request = http.get = https.request = https.get = deny;
net.connect = net.createConnection = net.Socket.prototype.connect = deny;
syncBuiltinESMExports();
`;
const env = {};
for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
const worker = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(denyNetwork)}`, fileURLToPath(new URL("../dist/worker.js", import.meta.url))], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
});
const exit = once(worker, "exit");
const pending = new Map();
let nextId = 1;
let unexpectedHostCalls = 0;
let stderr = false;
worker.stderr.on("data", () => { stderr = true; });
const config = { allowMutations: true, defaultAccount: "example", accounts: [{ key: "example", clientIdRef: "example-client-ref", clientSecretRef: "example-secret-ref", refreshTokenRef: "example-refresh-ref", allowedCompanies: [] }] };
const send = message => worker.stdin.write(JSON.stringify(message) + "\n");
const lines = createInterface({ input: worker.stdout });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method) {
    if (message.id === undefined) { assert.equal(message.method, "log"); return; }
    if (message.method === "config.get") send({ jsonrpc: "2.0", id: message.id, result: config });
    else if (message.method === "events.subscribe") send({ jsonrpc: "2.0", id: message.id, result: null });
    else {
      unexpectedHostCalls++;
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Synthetic host denies this method" } });
    }
  } else {
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
  }
});
function rpc(method, params) {
  const id = `smoke-${nextId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Synthetic worker RPC timed out")); }, 10000);
    pending.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
const companyId = "11111111-1111-4111-8111-111111111111";
const runContext = { companyId, agentId: "synthetic-agent", runId: "synthetic-run" };
const edit = { documentId: "doc-example", text: "Synthetic text", requiredRevisionId: "revision-example" };
const cases = {
  gdoc_read: { documentId: "doc-example" },
  gdoc_insert_text: { ...edit, index: 1 },
  gdoc_append_text: edit,
  gdoc_replace_text: { ...edit, startIndex: 1, endIndex: 6, expectedText: "Hello" },
  gdrive_read_file: { fileId: "file-example" },
  gdrive_rename_file: { fileId: "file-example", name: "Renamed example" },
  gdrive_move_file: { fileId: "file-example", expectedParentId: "folder-source", destinationFolderId: "folder-target" },
};
try {
  assert.equal((await rpc("initialize", { manifest, config })).ok, true);
  assert.equal((await rpc("health", {})).status, "ok");
  for (const [toolName, parameters] of Object.entries(cases)) {
    const tool = manifest.tools.find(tool => tool.name === toolName);
    assert.ok(tool);
    const call = rpc("executeTool", { toolName, parameters, runContext });
    if (toolName.startsWith("gdoc_") && tool.actionType === "change_files") {
      assert.equal(tool.writes, undefined);
      // Pre-send failures still propagate through the SDK despite no host cache.
      await assert.rejects(call, /^Error: \[ECOMPANY_NOT_ALLOWED\]/);
    } else assert.match((await call).error, /^\[ECOMPANY_NOT_ALLOWED\]/);
  }
  config.accounts[0].allowedCompanies = [companyId];
  config.allowMutations = false;
  for (const toolName of ["gdoc_insert_text", "gdoc_append_text", "gdoc_replace_text"]) {
    await assert.rejects(rpc("executeTool", { toolName, parameters: cases[toolName], runContext }), /^Error: \[EMUTATIONS_DISABLED\]/);
  }
  assert.equal(unexpectedHostCalls, 0);
  await rpc("shutdown", {});
  const [code] = await exit;
  assert.equal(code, 0);
  assert.equal(stderr, false);
  console.log(JSON.stringify({ worker: "built bundle", initialized: true, health: "ok", newToolsRegisteredAndDenied: Object.keys(cases).length, docsApprovalRetainedWithoutRepeatCaching: 3, docsPreSendErrorsPropagateThroughRpc: true, mutationSwitchDenied: 3, secretsResolved: 0, network: "disabled", shutdown: "clean" }));
} finally {
  for (const { timer } of pending.values()) clearTimeout(timer);
  lines.close();
  if (worker.exitCode === null) worker.kill();
}
