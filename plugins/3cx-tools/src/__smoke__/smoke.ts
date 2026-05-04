/**
 * Smoke test for 3cx-tools — exercises the rejection paths and a stubbed
 * happy path. Run with:
 *
 *     pnpm exec tsx src/__smoke__/smoke.ts
 *
 * This is NOT a unit-test suite (no test runner) — it's an exit-code
 * sentinel that fails the build if a guard regresses.
 */
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../manifest.js";
import plugin from "../worker.js";
import { clearEngineCache } from "../engines/registry.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";
const SECRET_CLIENT_ID = "secret-client-id";
const SECRET_CLIENT_SECRET = "secret-client-secret";
const ACCOUNT_KEY = "test";

let failures = 0;

function ok(label: string): void {
  // eslint-disable-next-line no-console
  console.log(`  PASS  ${label}`);
}
function fail(label: string, detail: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`  FAIL  ${label}\n        → ${String(detail)}`);
  failures += 1;
}

function expectError(
  label: string,
  result: { error?: string; data?: unknown },
  codeFragment: string,
): void {
  if (typeof result.error === "string" && result.error.includes(codeFragment)) {
    ok(`${label} → ${codeFragment}`);
  } else {
    fail(label, `expected error containing ${codeFragment}; got ${JSON.stringify(result)}`);
  }
}

function expectOk(
  label: string,
  result: { error?: string; data?: unknown },
): void {
  if (!result.error) ok(label);
  else fail(label, result.error);
}

interface StubFetch {
  restore: () => void;
  callLog: string[];
}

function stubFetch(
  responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): StubFetch {
  const original = (globalThis as { fetch?: typeof fetch }).fetch;
  const callLog: string[] = [];
  (globalThis as { fetch: typeof fetch }).fetch = async (
    input: unknown,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : String(input);
    callLog.push(`${init?.method ?? "GET"} ${url}`);
    return responder(url, init);
  };
  return {
    callLog,
    restore: () => {
      if (original) (globalThis as { fetch: typeof fetch }).fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function makeHarness(config: Record<string, unknown>) {
  // Reset cross-test state so the previous harness's cached engines and
  // in-flight token fetches don't leak into this one.
  clearEngineCache();
  const harness = createTestHarness({ manifest, config });
  // Stub secrets resolver — return canned values for our two refs.
  (harness.ctx.secrets as { resolve: (ref: string) => Promise<string> }).resolve =
    async (ref: string) => {
      if (ref === SECRET_CLIENT_ID) return "real-client-id";
      if (ref === SECRET_CLIENT_SECRET) return "real-client-secret";
      throw new Error(`unknown secret ref: ${ref}`);
    };
  await plugin.definition.setup(harness.ctx);
  return harness;
}

const baseAccount = {
  key: ACCOUNT_KEY,
  pbxBaseUrl: "https://voice.example.test",
  pbxVersion: "20",
  clientIdRef: SECRET_CLIENT_ID,
  clientSecretRef: SECRET_CLIENT_SECRET,
  mode: "manual",
  companyRouting: [
    {
      companyId: COMPANY_A,
      extensionRanges: ["100-119", "201"],
      queueIds: ["800"],
      dids: ["+18005551212"],
    },
  ],
  allowedCompanies: [COMPANY_A],
};

async function testCompanyNotAllowed() {
  const harness = await makeHarness({
    allowMutations: false,
    defaultAccount: ACCOUNT_KEY,
    accounts: [baseAccount],
  });
  const result = await harness.executeTool(
    "pbx_queue_list",
    {},
    { agentId: "a", runId: "r", companyId: COMPANY_B, projectId: "p" },
  );
  expectError("ECOMPANY_NOT_ALLOWED (company not in allowedCompanies)", result, "ECOMPANY_NOT_ALLOWED");
}

async function testCompanyEmptyAllowed() {
  const harness = await makeHarness({
    allowMutations: false,
    defaultAccount: ACCOUNT_KEY,
    accounts: [{ ...baseAccount, allowedCompanies: [] }],
  });
  const result = await harness.executeTool(
    "pbx_queue_list",
    {},
    { agentId: "a", runId: "r", companyId: COMPANY_A, projectId: "p" },
  );
  expectError("ECOMPANY_NOT_ALLOWED (empty allowedCompanies)", result, "ECOMPANY_NOT_ALLOWED");
}

async function testCompanyNotRouted() {
  const harness = await makeHarness({
    allowMutations: false,
    defaultAccount: ACCOUNT_KEY,
    accounts: [
      {
        ...baseAccount,
        companyRouting: [],
        allowedCompanies: [COMPANY_A],
      },
    ],
  });
  const result = await harness.executeTool(
    "pbx_queue_list",
    {},
    { agentId: "a", runId: "r", companyId: COMPANY_A, projectId: "p" },
  );
  expectError("ECOMPANY_NOT_ROUTED (manual mode, no routing entry)", result, "ECOMPANY_NOT_ROUTED");
}

async function testAccountRequired() {
  const harness = await makeHarness({
    allowMutations: false,
    accounts: [baseAccount],
  });
  const result = await harness.executeTool(
    "pbx_queue_list",
    {},
    { agentId: "a", runId: "r", companyId: COMPANY_A, projectId: "p" },
  );
  expectError("EACCOUNT_REQUIRED (no defaultAccount + no `account` param)", result, "EACCOUNT_REQUIRED");
}

async function testMutationsDisabled() {
  const harness = await makeHarness({
    allowMutations: false,
    defaultAccount: ACCOUNT_KEY,
    accounts: [baseAccount],
  });
  const result = await harness.executeTool(
    "pbx_click_to_call",
    { fromExtension: "100", toNumber: "+18005551212" },
    { agentId: "a", runId: "r", companyId: COMPANY_A, projectId: "p" },
  );
  expectError("EDISABLED (mutation gate off)", result, "EDISABLED");
}

async function testScopeViolation() {
  const harness = await makeHarness({
    allowMutations: true,
    defaultAccount: ACCOUNT_KEY,
    accounts: [baseAccount],
  });
  // Stub fetch — token request only; mutation guard fires before reaching it.
  const stub = stubFetch(async (url) => {
    if (url.endsWith("/connect/token")) {
      return jsonResponse({ access_token: "test", expires_in: 3600 });
    }
    return new Response("not stubbed", { status: 500 });
  });
  try {
    const result = await harness.executeTool(
      "pbx_click_to_call",
      { fromExtension: "999", toNumber: "+18005551212" }, // 999 not in 100-119/201
      { agentId: "a", runId: "r", companyId: COMPANY_A, projectId: "p" },
    );
    expectError("ESCOPE_VIOLATION (fromExtension out of scope)", result, "ESCOPE_VIOLATION");
  } finally {
    stub.restore();
  }
}

async function testHappyReadPath() {
  const harness = await makeHarness({
    allowMutations: false,
    defaultAccount: ACCOUNT_KEY,
    accounts: [baseAccount],
  });
  const stub = stubFetch(async (url) => {
    if (url.endsWith("/connect/token")) {
      return jsonResponse({ access_token: "tok", expires_in: 3600 });
    }
    if (url.includes("/xapi/v1/Queues")) {
      return jsonResponse({
        value: [
          {
            Id: "q800",
            Number: "800",
            Name: "Support",
            WaitingCalls: 2,
            LongestWaitTimeSec: 47,
            Agents: [{ IsLoggedIn: true }, { IsLoggedIn: true }, { IsLoggedIn: false }],
          },
          {
            Id: "q900",
            Number: "900",
            Name: "Sales (other company)",
            WaitingCalls: 0,
            Agents: [],
          },
        ],
      });
    }
    return new Response("not stubbed", { status: 404 });
  });
  try {
    const result = (await harness.executeTool(
      "pbx_queue_list",
      {},
      { agentId: "a", runId: "r", companyId: COMPANY_A, projectId: "p" },
    )) as { error?: string; data?: { queues: Array<{ extension: string; depth: number }> } };
    expectOk("pbx_queue_list happy path returns data", result);
    if (result.data?.queues) {
      const ours = result.data.queues.find((q) => q.extension === "800");
      const theirs = result.data.queues.find((q) => q.extension === "900");
      if (ours && ours.depth === 2 && !theirs) {
        ok("pbx_queue_list filtered out queue '900' (out of company scope)");
      } else {
        fail(
          "pbx_queue_list scope filter",
          `expected queue 800 only; got ${JSON.stringify(result.data.queues)}`,
        );
      }
    } else {
      fail("pbx_queue_list shape", "result.data.queues missing");
    }
  } finally {
    stub.restore();
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log("3cx-tools smoke tests\n─────────────────────");
  await testCompanyNotAllowed();
  await testCompanyEmptyAllowed();
  await testCompanyNotRouted();
  await testAccountRequired();
  await testMutationsDisabled();
  await testScopeViolation();
  await testHappyReadPath();

  if (failures > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n${failures} smoke test(s) failed`);
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log("\nAll smoke tests passed.");
  }
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("Smoke test runner crashed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // runWorker holds stdin open; force-exit so the test process doesn't
    // hang waiting for JSON-RPC messages that will never arrive.
    process.exit(process.exitCode ?? 0);
  });
