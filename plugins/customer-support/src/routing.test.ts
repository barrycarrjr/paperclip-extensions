import assert from "node:assert/strict";
import test from "node:test";
import { companyHasConnection, IntakeError, parseMessage, resolveConnection, type Config } from "./routing.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const config: Config = {
  connections: [{
    id: "example-workspace",
    source: "slack",
    externalAccountId: "TEXAMPLE01",
    ingestAgentId: "intake-agent",
    allowedCompanies: [companyA, companyB],
    routes: [
      { externalRouteId: "C-ALPHA", companyId: companyA },
      { externalRouteId: "C-BETA", companyId: companyB },
    ],
  }],
};

function incoming(overrides: Record<string, unknown> = {}) {
  return parseMessage({
    companyId: companyA,
    connectionId: "example-workspace",
    externalAccountId: "TEXAMPLE01",
    externalRouteId: "C-ALPHA",
    externalConversationId: "thread-1",
    externalMessageId: "message-1",
    title: "Order page error",
    body: "The order page returned an error.",
    authorKind: "customer",
    occurredAt: "2026-09-27T12:00:00Z",
    ...overrides,
  });
}

test("one Slack workspace can serve two companies with explicit routes", () => {
  assert.equal(resolveConnection(config, incoming()).source, "slack");
  assert.equal(resolveConnection(config, incoming({ companyId: companyB, externalRouteId: "C-BETA" })).id, "example-workspace");
  assert.equal(companyHasConnection(config, companyA), true);
  assert.equal(companyHasConnection(config, companyB), true);
});

test("a route cannot put a Company Beta message in Alpha", () => {
  assert.throws(() => resolveConnection(config, incoming({ companyId: companyB })),
    (error) => error instanceof IntakeError && error.status === 403);
});

test("unmapped and duplicate route rules fail closed", () => {
  assert.throws(() => resolveConnection(config, incoming({ externalRouteId: "C-UNKNOWN" })), IntakeError);
  const duplicate: Config = {
    connections: [{ ...config.connections![0]!, routes: [
      { externalRouteId: "C-ALPHA", companyId: companyA }, { externalRouteId: "C-ALPHA", companyId: companyB },
    ] }],
  };
  assert.throws(() => resolveConnection(duplicate, incoming()), IntakeError);
});

test("empty company access and duplicate connections fail closed", () => {
  const blocked: Config = { connections: [{ ...config.connections![0]!, allowedCompanies: [] }] };
  assert.equal(companyHasConnection(blocked, companyA), false);
  assert.throws(() => resolveConnection(blocked, incoming()), IntakeError);
  const duplicate: Config = { connections: [config.connections![0]!, config.connections![0]!] };
  assert.throws(() => resolveConnection(duplicate, incoming()), IntakeError);
});

test("malformed messages are rejected before storage", () => {
  assert.throws(() => incoming({ companyId: "not-a-uuid" }), IntakeError);
  assert.throws(() => incoming({ body: "" }), IntakeError);
  assert.throws(() => incoming({ externalUrl: "javascript:alert(1)" }), IntakeError);
  assert.throws(() => incoming({ occurredAt: "yesterday" }), IntakeError);
});
