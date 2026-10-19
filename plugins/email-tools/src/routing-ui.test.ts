import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { openPluginDb } from "./pglite-db.js";
import { MailRouting } from "./routing.js";
import manifest from "./manifest.js";
import type { ConfigMailbox } from "./types.js";
import type { PluginBridgeError } from "@paperclipai/plugin-sdk/ui";
import { uiErrorText } from "./ui/error-text.js";

let render: ((data: Record<string, unknown>) => string) | undefined;
let renderSelections: ((data: Record<string, unknown>, steps: Array<{ choice?: string; data?: unknown }>) => string[]) | undefined;
let renderAction: ((data: Record<string, unknown>) => Promise<{ html: string; actions: unknown[] }>) | undefined;
async function renderer() {
  if (render) return render;
  const result = await build({
    stdin: { contents: `import React from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { RoutingSettingsPage } from "./src/ui/RoutingSettingsPage.tsx";
      function markup() { globalThis.__routingFixture.stateCursor = 0; return renderToStaticMarkup(React.createElement(RoutingSettingsPage, {})); }
      export function render(data) { globalThis.__routingFixture = { ...data, state: [], actions: [] }; return markup(); }
      export function renderSelections(data, steps) {
        const html = [render(data)];
        for (const step of steps) {
          if (step.data) globalThis.__routingFixture.data = step.data;
          if (step.choice !== undefined) globalThis.__routingFixture.select({ target: { value: step.choice } });
          html.push(markup());
        }
        return html;
      }
      export async function renderAction(data) {
        render(data); globalThis.__routingFixture.click();
        await new Promise(resolve => setImmediate(resolve));
        return { html: markup(), actions: globalThis.__routingFixture.actions };
      }`, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "node", format: "esm",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(process.cwd()+"/package.json");' },
    plugins: [{ name: "synthetic-sdk-ui-hooks", setup(b) {
      // Keep these component tests portable without a DOM dependency. Retain hook
      // state across two server renders and invoke the actual Dismiss callback.
      b.onResolve({ filter: /^react$/ }, a => a.importer.endsWith("RoutingSettingsPage.tsx") ? { path: "state", namespace: "synthetic" } : undefined);
      b.onResolve({ filter: /^react\/jsx-runtime$/ }, a => a.importer.endsWith("RoutingSettingsPage.tsx") ? { path: "jsx", namespace: "synthetic" } : undefined);
      b.onResolve({ filter: /^@paperclipai\/plugin-sdk\/ui$/ }, () => ({ path: "fixture-hooks", namespace: "synthetic" }));
      b.onLoad({ filter: /.*/, namespace: "synthetic" }, a => a.path === "state" ? ({ contents: `
        export function useState(initial) {
          const f = globalThis.__routingFixture, index = f.stateCursor++;
          if (!(index in f.state)) f.state[index] = initial;
          return [f.state[index], value => { f.state[index] = typeof value === "function" ? value(f.state[index]) : value; }];
        }`, loader: "js" }) : a.path === "jsx" ? ({ contents: `
        import { jsx as realJsx, jsxs as realJsxs, Fragment } from "react/jsx-runtime";
        export { Fragment };
        function capture(type, props) {
          if (type === "select" && props["aria-label"]?.startsWith("Destination for")) globalThis.__routingFixture.select = props.onChange;
        }
        export function jsx(type, props, key) {
          capture(type, props);
          if (type === "button" && props.children === "Dismiss") globalThis.__routingFixture.click = props.onClick;
          return realJsx(type, props, key);
        }
        export function jsxs(type, props, key) { capture(type, props); return realJsxs(type, props, key); }
        `, loader: "js", resolveDir: process.cwd() }) : ({ contents: `
        export function useHostContext() { return { companyId: "example-company" }; }
        export function usePluginAction() { return async params => {
          const f = globalThis.__routingFixture; f.actions.push(params); throw f.actionError;
        }; }
        export function usePluginData(key, params) {
          const f = globalThis.__routingFixture;
          if (!params.mailbox) return { data: { scopes: f.scopes ?? [{ key: "shared", name: "Shared mailbox" }], hasMoreMailboxes: f.hasMoreMailboxes }, error: f.scopeError, loading: false };
          return { data: f.data, error: f.error, loading: false, refresh: async () => {} };
        }`, loader: "js" }));
    } }],
  });
  const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  render = bundled.render; renderAction = bundled.renderAction; renderSelections = bundled.renderSelections;
  return render!;
}
const data = { mode: "review", destinations: [{ key: "operations", label: "Operations" }], total: 1, hasMore: false,
  rows: [{ id: "synthetic-entry", status: "waiting", sender: "sender@example.com", subject: "Invented update", receivedAt: "2026-10-18", note: "Operator review required.", candidates: ["operations"], destination: null, frozen: false, issueIdentifier: null, wake: "pending", audit: "pending" }] };
test("real routing component renders waiting controls and theme tokens", async () => {
  const html = (await renderer())({ data });
  assert.match(html, /Mail routing/); assert.match(html, /Invented update/); assert.match(html, /Route to destination/); assert.match(html, /Dismiss/);
  assert.match(html, /var\(--foreground\)/); assert.match(html, /var\(--border\)/); assert.match(html, /Waiting for the operator: 1/);
});

test("real panel data renders removed/config-invalid/malformed/retry-error/checked states without repeated guidance", async () => {
  const SOURCE = "aaaaaaaa-1111-4222-8333-444444444444", DEST = "bbbbbbbb-1111-4222-8333-444444444444";
  const CLERK = "cccccccc-1111-4222-8333-444444444444", AGENT = "dddddddd-1111-4222-8333-444444444444";
  const PROJECT = "eeeeeeee-1111-4222-8333-444444444444", RUN = "ffffffff-1111-4222-8333-444444444444";
  const scope = { companyId: SOURCE, userId: "synthetic-operator", isInstanceAdmin: true };
  const m: ConfigMailbox = { key: "shared", ingestCompanyId: SOURCE, imapHost: "imap.example.com", user: "clerk@example.com", allowedCompanies: [SOURCE], routing: { mode: "auto", routerAgentId: CLERK, sendingApprovalConfirmed: true, destinations: [{ key: "operations", label: "Operations", companyId: DEST, projectId: PROJECT, assigneeAgentId: AGENT, description: "Routine mail." }] } };
  const opened = await openPluginDb();
  const h = createTestHarness({ manifest, config: { mailboxes: [m] } }); Object.assign(h.ctx, { db: opened.db });
  let mailboxes = [m], fail = false;
  h.ctx.config.get = async () => ({ mailboxes });
  h.ctx.agents.get = async (id, companyId) => ({ id, companyId, status: "idle" }) as never;
  h.ctx.projects.get = async (id, companyId) => ({ id, companyId }) as never;
  h.ctx.issues.create = async req => { fail = true; return { ...req, id: RUN, identifier: "EX-1", originId: req.originId!.replace("email-tools", AGENT) } as never; };
  const service = new MailRouting(h.ctx, async (_m, l) => ({ uidValidity: l.uidValidity, parsed: { uid: l.uid, messageId: l.messageId, subject: "Invented update", from: "sender@example.com", fromAddress: "sender@example.com", to: [], cc: [], date: "2026-10-18", text: "Synthetic body.", markdown: "Synthetic body.", html: "", attachments: [], inReplyTo: null, references: [], answered: false, forwarded: false } }), async () => { if (fail) throw new Error("synthetic credential failure"); });
  const r = await renderer();
  const renderPanel = async () => {
    const scopes = await service.panel({ hostScope: scope }); assert.ok("scopes" in scopes);
    const panel = await service.panel({ mailbox: "shared", hostScope: scope }); assert.ok("rows" in panel);
    // The real worker/UI bridge transports panel data as JSON, including DB timestamps.
    return { html: r(JSON.parse(JSON.stringify({ scopes: scopes.scopes, data: panel }))), panel };
  };
  const proposal = { mailbox: "shared", uid: 1, uidValidity: "42", messageId: "bare@example.com", confidence: "sure", destination: "operations", reason: "Synthetic note." };
  try {
    const waiting = await service.route(proposal, { companyId: SOURCE, agentId: CLERK, runId: RUN } as never);
    const malformed = await renderPanel();
    assert.equal(malformed.panel.rows[0].canRoute, false);
    assert.match(malformed.html, /disabled[^>]*>Route to destination/);
    assert.match(malformed.html, /No usable Message-ID.*Handle this email manually, then close/);
    assert.doesNotMatch(malformed.html, /use the Email page/);
    assert.equal(malformed.html.split("No usable Message-ID").length - 1, 1);
    mailboxes = [];
    const removed = await renderPanel();
    assert.equal(removed.panel.mode, "unavailable");
    assert.equal(removed.html.split("You can close its waiting entries as handled manually without connecting to mail.").length - 1, 1);
    assert.match(removed.html, />Close as handled manually<\/button>/);
    mailboxes = [m]; m.routing!.sendingApprovalConfirmed = false;
    assert.match((await renderPanel()).html, /EROUTING_CONFIG.*sending-approval prerequisite/);
    m.routing!.sendingApprovalConfirmed = true;
    await service.resolve({ mailbox: "shared", entryId: waiting.entryId, decision: "close_manually", hostScope: scope });
    const routed = await service.route({ ...proposal, uid: 2, messageId: "<valid@example.com>" }, { companyId: SOURCE, agentId: CLERK, runId: RUN } as never);
    const result = await service.resolve({ mailbox: "shared", entryId: routed.entryId, decision: "retry_followups", hostScope: scope });
    const failed = await renderPanel(); assert.ok(result.followupError);
    assert.equal(failed.html.split(result.followupError).length - 1, 1);
    assert.match(failed.html, />Mark follow-ups checked<\/button>/);
    await opened.db.execute("UPDATE plugin_email_tools_7cbee3fdf3.email_routing SET wake_state='requested_or_duplicate_verify',audit_state='unknown' WHERE id=$1", [routed.entryId]);
    await service.resolve({ mailbox: "shared", entryId: routed.entryId, decision: "check_followups", hostScope: scope });
    const checked = await renderPanel();
    assert.match(checked.html, /Follow-ups marked checked at .*by synthetic-operator/);
    assert.match(checked.html, /does not prove delivery or cancel work/); assert.match(checked.html, /Source audit: unknown/);
    assert.match(checked.html, /Unknown facts above remain unknown/);
    assert.doesNotMatch(checked.html, />Retry follow-ups|>Mark follow-ups checked/);
    assert.equal(checked.panel.followups, 0);
  } finally { await opened.pg.close(); }
});
test("scope and data-handler failures are visible and cannot become an empty queue", async () => {
  const scopeError: PluginBridgeError = { code: "WORKER_ERROR", message: "Authenticated admin required" };
  const error: PluginBridgeError = { code: "WORKER_ERROR", message: "Synthetic database unavailable" };
  for (const failure of [{ scopeError }, { error }]) {
    const html = (await renderer())(failure);
    assert.match(html, /role="alert"/); assert.doesNotMatch(html, /No routing entries yet/);
    assert.ok(html.includes((failure.scopeError ?? failure.error)!.message));
    assert.doesNotMatch(html, /\[object Object\]/);
  }
});

const fallback = "The request failed. Please try again.";
const bridgeFailure: PluginBridgeError = { code: "WORKER_ERROR", message: "[EROUTE_TERMINAL] Only a waiting or claimed entry can be closed manually.", details: { privatePayload: "DO_NOT_RENDER_DETAILS" } };
const failures: Array<[unknown, string]> = [
  [bridgeFailure, bridgeFailure.message], [new Error("Readable Error message"), "Readable Error message"],
  ["Readable string", "Readable string"], [null, fallback], [undefined, fallback], [42, fallback], [false, fallback],
  [{}, fallback], [{ message: 42, details: "DO_NOT_RENDER_DETAILS" }, fallback], [{ message: {} }, fallback],
  [{ message: null }, fallback], [{ message: "" }, fallback], [{ message: "  \n " }, fallback], ["", fallback], ["  ", fallback],
  [{ code: "WORKER_ERROR", message: "<img src=x onerror=alert(1)> & readable", details: "DO_NOT_RENDER_DETAILS" }, "&lt;img src=x onerror=alert(1)&gt; &amp; readable"],
];

test("UI error text accepts readable messages and uses a fixed fallback without object details", () => {
  for (const [failure, expected] of failures.slice(0, -1)) assert.equal(uiErrorText(failure), expected);
});

test("scope and entries render host-shaped errors and malformed fallbacks as plain React text", async () => {
  const r = await renderer();
  for (const [failure, expected] of failures.filter(([failure]) => failure != null)) {
    for (const field of ["scopeError", "error"]) {
      const html = r({ [field]: failure });
      assert.match(html, /role="alert"/); assert.ok(html.includes(expected), `${field}: ${expected}`);
      assert.doesNotMatch(html, /\[object Object\]|DO_NOT_RENDER_DETAILS|<img|No routing entries yet/);
    }
  }
});

test("actual action catch renders SDK errors, strings, Errors and malformed failures without losing the row", async () => {
  await renderer();
  for (const [actionError, expected] of failures) {
    const result = await renderAction!({ data, actionError });
    assert.match(result.html, /role="alert"/); assert.ok(result.html.includes(expected), expected);
    assert.match(result.html, /Invented update/); assert.match(result.html, />Dismiss<\/button>/);
    assert.doesNotMatch(result.html, /\[object Object\]|DO_NOT_RENDER_DETAILS|<img/);
    assert.equal(result.actions.length, 1);
    assert.equal((result.actions[0] as { decision: string }).decision, "dismiss");
  }
});
test("off/no-account and frozen recovery states explain the next operator step", async () => {
  const r = await renderer();
  assert.match(r({ scopes: [] }), /No accessible mailbox/);
  const off = r({ data: { ...data, mode: "off" } }); assert.match(off, /Routing is off/); assert.match(off, /disabled/);
  const frozen = r({ data: { ...data, rows: [{ ...data.rows[0], frozen: true, destination: { key: "operations", label: "Operations" } }] } });
  assert.match(frozen, /Destination is fixed/); assert.match(frozen, /Reconcile handoff/); assert.match(frozen, /disabled[^>]*>Dismiss/);
  assert.match(frozen, />Close as handled manually<\/button>/);
  const unavailable = r({ data: { ...data, mode: "unavailable", destinations: [], rows: [{ ...data.rows[0], canRoute: false }] } });
  assert.match(unavailable, /without connecting to mail/); assert.match(unavailable, /disabled[^>]*>Route to destination/);
  assert.match(unavailable, />Close as handled manually<\/button>/);
  const closed = r({ data: { ...data, total: 0, rows: [{ ...data.rows[0], status: "handled" }] } });
  assert.match(closed, /earlier handoff may still exist or complete/); assert.doesNotMatch(closed, />Route to destination/);
});

test("real component shows safe configuration reason even without ledger rows", async () => {
  const html = (await renderer())({ data: { ...data, mode: "unavailable", configReason: "[EROUTING_CONFIG] Confirm the operator sending-approval prerequisite before enabling routing.", rows: [], total: 0 } });
  assert.match(html, /role="alert"/); assert.match(html, /EROUTING_CONFIG.*sending-approval prerequisite/);
  assert.doesNotMatch(html, /could not load|NOT_FOUND/);
});

test("real component exposes supported pending follow-up repair and honest unknown labels", async () => {
  const html = (await renderer())({ data: { ...data, followups: 1, total: 0, rows: [{ ...data.rows[0], status: "routed", issueIdentifier: "EX-1", canRetryFollowups: true, wake: "requested_unknown", audit: "unknown", followupError: "The handoff is recorded. Retry follow-ups." }] } });
  assert.match(html, /Handoffs needing follow-ups: 1/); assert.match(html, />Retry follow-ups<\/button>/);
  assert.match(html, /Wake: requested_unknown/); assert.match(html, /unknown.*Verify manually/);
  assert.match(html, /Earlier routing note:/); assert.doesNotMatch(html, />Route to destination|>Dismiss/);
  const closed = (await renderer())({ data: { ...data, total: 0, rows: [{ ...data.rows[0], status: "handled", issueIdentifier: "EX-1", handledAt: "2026-10-19T12:00:00Z", handledByUserId: "synthetic-operator" }] } });
  assert.match(closed, /2026-10-19T12:00:00Z by synthetic-operator/);
  assert.doesNotMatch(closed, /Wake: pending|Retry follow-ups/); assert.match(closed, /No follow-ups will be requested/);
});

test("real component exposes bounded stored-mailbox pagination", async () => {
  const html = (await renderer())({ hasMoreMailboxes: true, data });
  assert.match(html, /More recorded mailboxes/); assert.match(html, /disabled[^>]*>Previous recorded mailboxes/);
});


test("real panel JSON keeps recorded-key controls unavailable and stale destination choices explicit", async () => {
  const SOURCE = "aaaaaaaa-1111-4222-8333-444444444444", CLERK = "dddddddd-1111-4222-8333-444444444444";
  const DEST = "bbbbbbbb-1111-4222-8333-444444444444", AGENT = "eeeeeeee-1111-4222-8333-444444444444", PROJECT = "ffffffff-1111-4222-8333-444444444444", RUN = "11111111-1111-4222-8333-444444444444";
  const scope = { companyId: SOURCE, userId: "synthetic-operator", isInstanceAdmin: true };
  const m: ConfigMailbox = { key: "shared", ingestCompanyId: SOURCE, imapHost: "imap.example.com", user: "clerk@example.com", allowedCompanies: [SOURCE], routing: { mode: "review", routerAgentId: CLERK, sendingApprovalConfirmed: true, destinations: [
    { key: "operations", label: "Operations", companyId: DEST, projectId: PROJECT, assigneeAgentId: AGENT, description: "Routine mail." },
    { key: "property", label: "Property", companyId: DEST, projectId: PROJECT, assigneeAgentId: AGENT, description: "Building mail." },
  ] } };
  const opened = await openPluginDb();
  const h = createTestHarness({ manifest, config: { mailboxes: [m] } }); Object.assign(h.ctx, { db: opened.db });
  const service = new MailRouting(h.ctx, async (_m, l) => ({ uidValidity: l.uidValidity, parsed: { uid: l.uid, messageId: l.messageId, subject: "Invented update", from: "sender@example.com", fromAddress: "sender@example.com", to: [], cc: [], date: "2026-10-18", text: "Synthetic body.", markdown: "Synthetic body.", html: "", attachments: [], inReplyTo: null, references: [], answered: false, forwarded: false } }), async () => {});
  h.ctx.config.get = async () => ({ mailboxes: [m] });
  const r = await renderer();
  const panel = async () => JSON.parse(JSON.stringify(await service.panel({ mailbox: "shared", hostScope: scope })));
  try {
    await service.route({ mailbox: "shared", uid: 1, uidValidity: "42", messageId: "<selection@example.com>", confidence: "sure", destination: "property", reason: "Synthetic note." }, { companyId: SOURCE, agentId: CLERK, runId: RUN } as never);
    m.key = "Shared";
    const unavailable = await panel(); const html = r({ scopes: [{ key: "shared", name: "Recorded entries" }], data: unavailable });
    assert.equal(unavailable.mode, "unavailable"); assert.match(html, /recorded mailbox configuration is unavailable/);
    assert.match(html, /disabled[^>]*>Route to destination/); assert.match(html, /disabled[^>]*>Dismiss/);
    assert.doesNotMatch(html, /disabled[^>]*>Close as handled manually/);
    m.key = "shared";
    const normal = await panel();
    assert.match(r({ data: normal }), /value="property" selected=""/);
    for (const kind of ["disabled", "removed", "candidate"]) {
      m.routing!.destinations![1].enabled = false;
      if (kind === "removed") m.routing!.destinations!.pop();
      if (kind === "candidate") await opened.db.execute("UPDATE plugin_email_tools_7cbee3fdf3.email_routing SET destination=NULL,candidate_keys=$1::jsonb", [JSON.stringify(["property"])]);
      const stale = await panel();
      const states = renderSelections!({ data: stale }, [{ choice: "operations" }]);
      assert.match(states[0], /value="" selected="">Choose a destination/);
      assert.match(states[0], /previous destination is no longer available/);
      assert.match(states[0], /disabled[^>]*>Route to destination/);
      assert.match(states[1], /value="operations" selected=""/);
      assert.doesNotMatch(states[1], /disabled[^>]*>Route to destination/);
      assert.doesNotMatch(states[1], /previous destination is no longer available/);
      if (kind === "removed") m.routing!.destinations!.push({ ...m.routing!.destinations![0], key: "property", label: "Property", enabled: false });
    }
    m.routing!.destinations![1].enabled = true;
    const fresh = await panel();
    const refetched = { ...fresh, destinations: fresh.destinations.filter((d: { key: string }) => d.key !== "operations") };
    const states = renderSelections!({ data: fresh }, [{ choice: "operations" }, { data: refetched }, { choice: "property" }]);
    assert.match(states[2], /value="" selected="">Choose a destination/); assert.match(states[2], /disabled[^>]*>Route to destination/);
    assert.match(states[3], /value="property" selected=""/); assert.doesNotMatch(states[3], /disabled[^>]*>Route to destination/);
    const frozen = r({ data: { ...refetched, destinations: [], rows: [{ ...fresh.rows[0], frozen: true }] } });
    assert.match(frozen, /value="" selected="">Choose a destination/);
    assert.match(frozen, /Restore the original destination configuration/);
  } finally { await opened.pg.close(); }
});
