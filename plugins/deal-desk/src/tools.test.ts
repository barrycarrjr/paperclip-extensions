/**
 * Handler-level tests with a fake context: company isolation runs before
 * anything else, and the manifest, the handlers and the domain lists agree.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { PluginApiRequestInput, ToolRunContext } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import { companyAccessError, isCompanyAllowed } from "./companyAccess.js";
import { DEAL_INPUT_KEYS } from "./dealInputs.js";
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_STATUSES,
  CLAIMED_BY,
  DEAL_STAGES,
  DEAL_STRUCTURES,
  EARNINGS_BASES,
  PERIOD_SOURCE_KINDS,
} from "./domain.js";
import { createDealService, type DealDb, type DealService } from "./service.js";
import { TOOL_OPS, createToolHandlers, errorMessage, handleApiRequest, type HandlerDeps } from "./tools.js";
import { DealDeskError } from "./validate.js";

const HQ = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEAL = "11111111-1111-4111-8111-111111111111";

function runCtx(companyId: string): ToolRunContext {
  return { agentId: "agent-1", runId: "run-1", companyId };
}

function fakeDeps(allowedCompanies: string[] | undefined, service?: DealService) {
  const calls = { service: 0, warn: 0, error: 0 };
  const deps: HandlerDeps = {
    getConfig: async () => ({ allowedCompanies }),
    logger: {
      warn: () => {
        calls.warn += 1;
      },
      error: () => {
        calls.error += 1;
      },
    },
    getService: () => {
      calls.service += 1;
      if (!service) throw new Error("the service must not be reached");
      return service;
    },
  };
  return { deps, calls };
}

// ---- Rule 6: isolation preflight ----

test("companyAccessError: empty or missing allow-list denies, wildcard and listed ids allow", () => {
  assert.match(companyAccessError(undefined, HQ)!, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.match(companyAccessError([], HQ)!, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.match(companyAccessError([HQ], OTHER)!, /^\[ECOMPANY_NOT_ALLOWED\]/);
  assert.equal(companyAccessError([HQ], HQ), null);
  assert.equal(companyAccessError(["*"], OTHER), null);
  assert.equal(isCompanyAllowed([HQ], HQ), true);
});

test("every tool refuses a company outside the allow-list before touching the database", async () => {
  const { deps, calls } = fakeDeps([HQ]);
  const handlers = createToolHandlers(deps);
  for (const name of Object.keys(TOOL_OPS)) {
    const result = await handlers[name]!({ dealId: DEAL }, runCtx(OTHER));
    assert.match(result.error ?? "", /^\[ECOMPANY_NOT_ALLOWED\]/, name);
    assert.equal(result.data, undefined, `${name} returned data to a disallowed company`);
    assert.equal(result.content, undefined, name);
  }
  assert.equal(calls.service, 0, "no tool may reach the service for a disallowed company");
  assert.equal(calls.warn, Object.keys(TOOL_OPS).length, "each refusal is logged");
});

test("every tool refuses when no company is configured at all", async () => {
  const { deps, calls } = fakeDeps(undefined);
  const handlers = createToolHandlers(deps);
  for (const name of Object.keys(TOOL_OPS)) {
    const result = await handlers[name]!({}, runCtx(HQ));
    assert.match(result.error ?? "", /^\[ECOMPANY_NOT_ALLOWED\]/, name);
  }
  assert.equal(calls.service, 0);
});

test("every API route refuses a company outside the allow-list with 403 and no data", async () => {
  const { deps, calls } = fakeDeps([HQ]);
  for (const route of manifest.apiRoutes ?? []) {
    const res = await handleApiRequest(deps, {
      routeKey: route.routeKey,
      companyId: OTHER,
      params: { dealId: DEAL },
      query: {},
      body: null,
      actor: { actorType: "user", userId: "user-1" },
    } as unknown as PluginApiRequestInput);
    assert.equal(res.status, 403, route.routeKey);
    assert.match(String((res.body as { error?: string }).error), /^\[ECOMPANY_NOT_ALLOWED\]/);
    assert.deepEqual(Object.keys(res.body as object), ["error"]);
  }
  assert.equal(calls.service, 0);
});

test("a deal id from another company is not found, exactly like a missing one", async () => {
  const db: DealDb = {
    namespace: "plugin_deal_desk_bf83b73d01",
    query: (async () => []) as DealDb["query"],
    execute: async () => ({ rowCount: 0 }),
  };
  const { deps } = fakeDeps([HQ, OTHER], createDealService({ db }));
  const res = await createToolHandlers(deps).deal_get!({ dealId: DEAL }, runCtx(OTHER));
  assert.match(res.error ?? "", /^\[EDEAL_NOT_FOUND\]/);
  const api = await handleApiRequest(deps, {
    routeKey: "deals.get",
    companyId: OTHER,
    params: { dealId: DEAL },
    query: {},
  } as unknown as PluginApiRequestInput);
  assert.equal(api.status, 404);
});

test("a tool call from an allowed company reaches the service and returns content plus data", async () => {
  const db: DealDb = {
    namespace: "plugin_deal_desk_bf83b73d01",
    query: (async () => []) as DealDb["query"],
    execute: async () => ({ rowCount: 0 }),
  };
  const { deps } = fakeDeps([HQ], createDealService({ db }));
  const result = await createToolHandlers(deps).deal_list!({}, runCtx(HQ));
  assert.equal(result.error, undefined);
  assert.equal(result.content, "No deals match.");
  assert.deepEqual(result.data, { deals: [] });
});

// ---- Error shape ----

test("errors keep their [ECODE] and unexpected errors never echo quoted values", () => {
  assert.deepEqual(errorMessage(new DealDeskError("EEVIDENCE_REQUIRED", "x"), "t"), { message: "[EEVIDENCE_REQUIRED] x", code: "EEVIDENCE_REQUIRED" });
  const leaked = errorMessage(new Error('invalid input syntax for type uuid: "12-3456789"'), "deal_get");
  assert.equal(leaked.code, "EINTERNAL");
  assert.ok(!leaked.message.includes("3456789"), leaked.message);
  const detail = errorMessage(new Error("Key (deal_id, period_label, lower(description))=(x, 2025, owner password) already exists"), "deal_adjustment_upsert");
  assert.ok(!detail.message.includes("owner password"), detail.message);
});

// ---- Manifest and worker agree ----

test("the manifest declares exactly the tools the worker has handlers for", () => {
  const declared = (manifest.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(declared, Object.keys(TOOL_OPS).sort());
  assert.equal(declared.length, 9);
});

test("the manifest enum lists and input keys match the code", () => {
  const tools = Object.fromEntries((manifest.tools ?? []).map((t) => [t.name, t.parametersSchema as any]));
  assert.deepEqual(tools.deal_upsert.properties.stage.enum, [...DEAL_STAGES]);
  assert.deepEqual(tools.deal_upsert.properties.structure.enum, [...DEAL_STRUCTURES]);
  assert.deepEqual(tools.deal_list.properties.stage.anyOf[0].enum, [...DEAL_STAGES]);
  assert.deepEqual(tools.deal_period_upsert.properties.sourceKind.enum, [...PERIOD_SOURCE_KINDS]);
  assert.deepEqual(tools.deal_adjustment_upsert.properties.kind.enum, [...ADJUSTMENT_KINDS]);
  assert.deepEqual(tools.deal_adjustment_upsert.properties.claimedBy.enum, [...CLAIMED_BY]);
  assert.deepEqual(tools.deal_adjustment_set_status.properties.status.enum, [...ADJUSTMENT_STATUSES]);
  assert.deepEqual(tools.deal_scenario_run.properties.earningsBasis.enum, [...EARNINGS_BASES]);
  assert.deepEqual(tools.deal_normalize.properties.sourceKind.enum, [...PERIOD_SOURCE_KINDS]);
  const inputKeys = Object.keys(tools.deal_scenario_run.properties.inputs.properties).sort();
  // cashFlowCents comes from the earnings basis, so it is not offered inside inputs.
  assert.deepEqual(inputKeys, DEAL_INPUT_KEYS.filter((k) => k !== "cashFlowCents").sort());
});

test("tool descriptions state the rules plainly", () => {
  const d = Object.fromEntries((manifest.tools ?? []).map((t) => [t.name, t.description]));
  assert.match(d.deal_adjustment_set_status!, /EEVIDENCE_REQUIRED/);
  assert.match(d.deal_scenario_run!, /ECONSERVATIVE_FIRST/);
  assert.match(d.deal_scenario_run!, /ASSUMPTION/);
  assert.match(d.deal_scenario_run!, /never changes a number/);
  assert.match(d.deal_adjustment_upsert!, /EDUPLICATE_ADJUSTMENT/);
  assert.match(d.deal_upsert!, /ESECRET_NOT_ALLOWED/);
});

test("the manifest declares only what the plugin uses: no UI, no issue access, no core tables", () => {
  assert.equal(manifest.id, "deal-desk");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.displayName, "Deal Desk");
  assert.equal(manifest.ui, undefined);
  assert.equal(manifest.entrypoints.ui, undefined);
  assert.deepEqual([...manifest.capabilities].sort(), [
    "agent.tools.register",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "instance.settings.register",
  ]);
  assert.equal(manifest.database?.namespaceSlug, "deal_desk");
  assert.equal(manifest.database?.coreReadTables, undefined);
  assert.deepEqual((manifest.instanceConfigSchema as any).required, ["allowedCompanies"]);
  assert.deepEqual((manifest.apiRoutes ?? []).map((r) => [r.routeKey, r.auth, r.method]), [
    ["deals.list", "board", "GET"],
    ["deals.get", "board", "GET"],
  ]);
});

test("no dashes that are not hyphens in anything the manifest shows", () => {
  const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  assert.doesNotMatch(JSON.stringify(manifest), dashes);
});
