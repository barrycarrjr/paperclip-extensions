import assert from "node:assert/strict";
import test from "node:test";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { registerInteractiveTools } from "./interactive-tools.js";
import type { Config } from "./routing.js";

test("knowledge and capability tools require host permission, a person and a configured company", async () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const cfg: Config = { remoteAccessProfiles: [{ id: "office", companyId, credentialUser: "EXAMPLE\\support", passwordRef: "33333333-3333-4333-8333-333333333333", scopes: [{ kind: "dns_suffix", value: "example.local", transport: "Wmi" }] }] };
  const callbacks = new Map<string, (input: unknown, run: ToolRunContext) => Promise<{ data?: unknown; error?: string }>>();
  let dbCalls = 0;
  const ctx = { tools: { register: (name: string, _tool: unknown, handler: typeof callbacks extends Map<string, infer H> ? H : never) => callbacks.set(name, handler) },
    db: { query: async () => { dbCalls++; return []; }, execute: async () => { dbCalls++; return { rowCount: 1 }; } },
  } as unknown as PluginContext;
  registerInteractiveTools(ctx, async () => cfg);
  const run: ToolRunContext = { companyId, userId: "operator", chatSessionId: "chat", agentId: "", runId: "turn", userPermission: "support:diagnose" };
  const catalog = callbacks.get("support_list_capabilities")!;
  assert.ok((await catalog({}, run)).data);
  for (const invalid of [{ ...run, userPermission: undefined }, { ...run, userId: null }, { ...run, companyId: "22222222-2222-4222-8222-222222222222" }]) {
    assert.ok((await catalog({}, invalid)).error);
    assert.ok((await callbacks.get("support_search_knowledge")!({ query: "printer" }, invalid)).error);
  }
  assert.ok((await callbacks.get("support_save_knowledge")!({ title: "Note", topic: "printers", body: "Steps", kind: "procedure" }, { ...run, userPermission: "support:repair", userConfirmed: false })).error);
  assert.equal(dbCalls, 0);
});
