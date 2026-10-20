import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { openPluginDb } from "./pglite-db.js";
import { MailRouting, handoffOrigin, mailboxBinding } from "./routing.js";
import { routingConfig } from "./routing-config.js";
import { ROUTES } from "./routing-store.js";
import type { ConfigMailbox, InstanceConfig } from "./types.js";
import type { VerifiedMail } from "./routing-reader.js";
import { readRoutingMessage } from "./routing-reader.js";
import { fetchParsedMessage } from "./imap.js";
import manifest from "./manifest.js";
import plugin from "./worker.js";

const SOURCE = "aaaaaaaa-1111-4222-8333-444444444444";
const DEST = "bbbbbbbb-1111-4222-8333-444444444444";
const OTHER = "cccccccc-1111-4222-8333-444444444444";
const CLERK = "dddddddd-1111-4222-8333-444444444444";
const AGENT = "eeeeeeee-1111-4222-8333-444444444444";
const PROJECT = "ffffffff-1111-4222-8333-444444444444";
const RUN = "11111111-1111-4222-8333-444444444444";
const ISSUE = "22222222-1111-4222-8333-444444444444";
const PLUGIN = "33333333-1111-4222-8333-444444444444";
const run = { companyId: SOURCE, agentId: CLERK, runId: RUN } as ToolRunContext;
const scope = { companyId: SOURCE, userId: "synthetic-operator", isInstanceAdmin: true };
const input = (n = 1) => ({ mailbox: "shared", uid: n, uidValidity: "42", messageId: `<mail-${n}@example.com>`, confidence: "sure", destination: "operations", reason: "Agent note for operator only." });
function mailbox(): ConfigMailbox {
  return { key: "shared", imapHost: "imap.example.com", user: "clerk@example.com", allowedCompanies: [SOURCE], ingestCompanyId: SOURCE,
    routing: { mode: "auto", routerAgentId: CLERK, sendingApprovalConfirmed: true, destinations: [
      { key: "operations", label: "Operations", description: "Routine operations correspondence.", companyId: DEST, projectId: PROJECT, assigneeAgentId: AGENT },
      { key: "property", label: "Property", description: "Building maintenance correspondence.", companyId: OTHER, projectId: PROJECT, assigneeAgentId: AGENT },
    ] } };
}
function mail(n = 1): VerifiedMail {
  return { uidValidity: "42", parsed: { uid: n, messageId: `<mail-${n}@example.com>`, from: "Example Sender <sender@example.com>", fromAddress: "sender@example.com", to: ["clerk@example.com"], cc: [],
    subject: "Invented operations update", date: "2026-10-18T12:00:00.000Z", text: "Synthetic provider message, not an instruction.", markdown: "Synthetic provider message, not an instruction.", html: "", attachments: [], inReplyTo: null, references: [], answered: false, forwarded: false } };
}
let opened: Awaited<ReturnType<typeof openPluginDb>>;
before(async () => { opened = await openPluginDb(); });
after(async () => { await opened.pg.close(); });
beforeEach(async () => { await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`); });

function fixture() {
  let m = mailbox();
  const calls = { read: 0, credentials: 0, create: [] as Record<string, unknown>[], wake: [] as unknown[], audit: [] as unknown[] };
  let fetched: VerifiedMail | null = null;
  let readFailure = false;
  let credentialFailure = false;
  const h = createTestHarness({ manifest, config: { mailboxes: [m] } });
  const ctx = h.ctx;
  Object.assign(ctx, { db: opened.db });
  ctx.config.get = async () => ({ mailboxes: [m] });
  ctx.agents.get = async (id, companyId) => ({ id, companyId, status: "idle" }) as never;
  ctx.projects.get = async (id, companyId) => ({ id, companyId }) as never;
  const created: Array<Record<string, unknown>> = [];
  ctx.issues.create = async request => {
    calls.create.push(request as unknown as Record<string, unknown>);
    const issue = { ...request, id: ISSUE, identifier: "OPS-1", originId: request.originId!.replace("email-tools", PLUGIN) };
    created.push(issue);
    return issue as never;
  };
  ctx.issues.list = async () => created as never;
  ctx.issues.requestWakeup = async (...args) => { calls.wake.push(args); return { queued: true, runId: null }; };
  ctx.activity.log = async e => { calls.audit.push(e); };
  const service = new MailRouting(ctx, async (_m, locator) => {
    calls.read++;
    if (readFailure) throw new Error("[EMESSAGE_NOT_FOUND] Synthetic mail was deleted.");
    return fetched ?? mail(locator.uid);
  }, async () => { calls.credentials++; if (credentialFailure) throw new Error("Credentials unavailable"); });
  return { ctx, h, calls, service, get m() { return m; }, set m(v) { m = v; }, setFetched(v: VerifiedMail) { fetched = v; }, failRead() { readFailure = true; }, failCredentials() { credentialFailure = true; }, created };
}

test("off is backward compatible and exposes no destinations; ACL and configured clerk still apply", async () => {
  const f = fixture(); delete f.m.routing;
  assert.deepEqual(await f.service.destinations("shared", run), { mode: "off", destinations: [] });
  await assert.rejects(f.service.route(input(), run), /EROUTING_OFF/);
  await assert.rejects(f.service.destinations("shared", { ...run, companyId: OTHER }), /NOT_ALLOWED/);
  f.m.routing = { mode: "off", routerAgentId: CLERK };
  await assert.rejects(f.service.destinations("shared", { ...run, agentId: AGENT }), /NOT_ALLOWED/);
  assert.equal(f.calls.read, 0); assert.equal(f.calls.create.length, 0);
});

test("strict configuration rejects malformed, duplicate, missing, unknown and conflicting fields", () => {
  for (const mutate of [
    (m: ConfigMailbox) => { m.routing!.mode = "bad" as never; },
    (m: ConfigMailbox) => { m.routing!.sendingApprovalConfirmed = false; },
    (m: ConfigMailbox) => { m.routing!.routerAgentId = "bad"; },
    (m: ConfigMailbox) => { delete m.ingestCompanyId; },
    (m: ConfigMailbox) => { m.onReceive = { mode: "issue" }; },
    (m: ConfigMailbox) => { m.routing!.destinations!.push(m.routing!.destinations![0]); },
    (m: ConfigMailbox) => { m.routing!.destinations![0].projectId = "bad"; },
    (m: ConfigMailbox) => { Object.assign(m.routing!, { rawCompany: DEST }); },
    (m: ConfigMailbox) => { Object.assign(m.routing!.destinations![0], { credential: "invented" }); },
  ]) { const m = mailbox(); mutate(m); assert.throws(() => routingConfig(m), /EROUTING_CONFIG/); }
});

test("only host clerk/source/run identities and known enabled keys pass before any IMAP or host effects", async () => {
  const f = fixture();
  for (const r of [{ ...run, companyId: OTHER }, { ...run, agentId: AGENT }, { ...run, runId: undefined }]) await assert.rejects(f.service.route(input(), r as unknown as ToolRunContext), /NOT_ALLOWED/);
  for (const extra of [{ destination: "unknown" }, { candidates: ["unknown"] }, { companyId: DEST }, { title: "injected" }, { actor: scope }, { hostScope: scope }, { uid: 0 }, { uidValidity: "0" }]) await assert.rejects(f.service.route({ ...input(), ...extra }, run), /EROUTE_/);
  f.m.allowedCompanies = [];
  await assert.rejects(f.service.route(input(), run), /NOT_ALLOWED/);
  assert.equal(f.calls.read, 0); assert.equal(f.calls.credentials, 0); assert.equal(f.calls.create.length, 0);
});

test("verified auto routing creates exact configured handoff, trusted actor, bounded mail only and canonical ledger", async () => {
  const f = fixture(); const msg = mail(); msg.parsed.text = "x".repeat(20_000); msg.parsed.markdown = msg.parsed.text;
  msg.parsed.attachments = [{ name: "invented.txt", mime: "text/plain", size: 12, partId: "2", inline: false }]; f.setFetched(msg);
  const r = await f.service.route(input(), run);
  assert.equal(r.outcome, "routed"); assert.equal(r.wake, "requested"); assert.equal(r.audit, "logged");
  const request = f.calls.create[0];
  assert.equal(request.companyId, DEST); assert.equal(request.projectId, PROJECT); assert.equal(request.assigneeAgentId, AGENT);
  assert.equal(request.originKind, "email_handoff"); assert.equal(request.originId, handoffOrigin("shared", input().messageId));
  assert.deepEqual(request.actor, { actorAgentId: CLERK, actorRunId: RUN });
  assert.match(String(request.description), /Synthetic|xxxx/); assert.match(String(request.description), /invented.txt/);
  assert.doesNotMatch(String(request.description), /Agent note/); assert.ok(String(request.description).length < 19_000);
  const row = await f.service.store.find("shared", `msgid:${input().messageId}`);
  assert.match(row!.handoff_origin_id!, new RegExp(PLUGIN)); assert.equal(row!.status, "routed");
  assert.doesNotMatch(JSON.stringify(f.calls.audit), /example.com|operations update|Agent note|mail-1/);
});

test("terminal replay survives moved/deleted mail, changed proposed destination, repeated runs, issue deletion and dismiss", async () => {
  const f = fixture(); await f.service.route(input(), run);
  f.failRead(); f.created.length = 0;
  const replay = await f.service.route({ ...input(), destination: "property", uid: 999, folder: "Archive", uidValidity: "99" }, { ...run, runId: OTHER });
  assert.equal(replay.outcome, "already_routed"); assert.equal(replay.destination!.key, "operations");
  assert.equal(f.calls.read, 1); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.wake.length, 1); assert.equal(f.calls.audit.length, 1);
});

test("review, unsure, missing/invalid ID, sensitive email and cap all wait without creating", async () => {
  const f = fixture(); f.m.routing!.mode = "review";
  assert.equal((await f.service.route(input(), run)).outcome, "waiting");
  f.m.routing!.mode = "auto";
  assert.equal((await f.service.route({ ...input(2), confidence: "unsure" }, run)).outcome, "waiting");
  for (const [n, id] of [[3, null]] as const) {
    const msg = mail(n); msg.parsed.messageId = id; f.setFetched(msg);
    const r = await f.service.route({ ...input(n), messageId: id }, run);
    assert.equal(r.outcome, "waiting"); assert.match(r.note, /No usable Message-ID/);
  }
  const msg = mail(5); msg.parsed.subject = "Security alert: sign-in detected"; f.setFetched(msg);
  assert.equal((await f.service.route(input(5), run)).outcome, "waiting");
  assert.equal(f.calls.create.length, 0);
  const capped = mail(6); f.setFetched(capped);
  assert.equal((await Promise.all(Array.from({ length: 30 }, () => f.service.store.reserve("shared")))).filter(Boolean).length, 25);
  const r = await f.service.route(input(6), run); assert.equal(r.outcome, "waiting"); assert.match(r.note, /limit reached/);
  assert.equal(f.calls.create.length, 0);
});

test("missing or mismatched message/UIDVALIDITY leaves no ledger or issue", async () => {
  const f = fixture();
  const changed = mail(2); f.setFetched(changed);
  await assert.rejects(f.service.route(input(), run), /MISMATCH/);
  changed.parsed.uid = 1; changed.parsed.messageId = input().messageId; changed.uidValidity = "43";
  await assert.rejects(f.service.route(input(), run), /MISMATCH/);
  f.failRead(); await assert.rejects(f.service.route(input(), run), /NOT_FOUND/);
  assert.equal(await f.service.store.find("shared", `msgid:${input().messageId}`), undefined); assert.equal(f.calls.create.length, 0);
});

test("paused or wrong-company target, changed config and missing credential cannot create", async () => {
  for (const kind of ["paused", "company", "config", "credential"]) {
    const f = fixture();
    if (kind === "paused") f.ctx.agents.get = async () => ({ companyId: DEST, status: "paused" }) as never;
    if (kind === "company") f.ctx.projects.get = async () => ({ companyId: OTHER }) as never;
    if (kind === "config") f.ctx.agents.get = async () => { f.m.routing!.mode = "off"; return { companyId: DEST, status: "idle" } as never; };
    if (kind === "credential") f.failCredentials();
    const r = await f.service.route(input(), run); assert.equal(r.outcome, "waiting"); assert.equal(f.calls.create.length, 0);
    await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
  }
});

test("concurrent same-message proposals across destinations create exactly one global handoff", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.service.route({ ...input(), destination: i % 2 ? "property" : "operations" }, run)));
  assert.ok(results.some(r => r.outcome === "routed")); assert.equal(f.calls.create.length, 1);
  assert.equal((await opened.pg.query(`SELECT * FROM ${ROUTES}`)).rows.length, 1);
});

test("waiting/dismissed replays do not re-read deleted mail or grow queue; source change is refused", async () => {
  const f = fixture(); f.m.routing!.mode = "review";
  const first = await f.service.route(input(), run); f.failRead();
  assert.equal((await f.service.route(input(), run)).outcome, "already_waiting"); assert.equal(f.calls.read, 1);
  assert.equal((await f.service.resolve({ mailbox: "shared", entryId: first.entryId, decision: "dismiss", hostScope: scope })).outcome, "dismissed");
  assert.equal((await f.service.route(input(), run)).outcome, "dismissed_earlier"); assert.equal(f.calls.read, 1);
  f.m.user = "different@example.com";
  await assert.rejects(f.service.route(input(), run), /SOURCE_CHANGED/);
});

test("renaming an account alias cannot bypass durable message uniqueness, even after deleting mail", async () => {
  const f = fixture(); await f.service.route(input(), run); f.failRead(); f.m.key = "renamed";
  await assert.rejects(f.service.route({ ...input(), mailbox: "renamed" }, run), /SOURCE_CHANGED/);
  assert.equal(f.calls.read, 1); assert.equal(f.calls.create.length, 1);
});

test("board requires real hostScope admin and source access, ignores spoofed params, and routes fresh with user provenance", async () => {
  const f = fixture(); f.m.routing!.mode = "review";
  const first = await f.service.route(input(), run);
  for (const hostScope of [undefined, { ...scope, isInstanceAdmin: false }, { ...scope, companyId: OTHER }]) {
    await assert.rejects(f.service.panel({ mailbox: "shared", companyId: SOURCE, isInstanceAdmin: true, userId: "spoof", hostScope }), /ADMIN_REQUIRED|NOT_ALLOWED|NOT_FOUND/);
    await assert.rejects(f.service.resolve({ mailbox: "shared", entryId: first.entryId, decision: "route", destination: "operations", hostScope }), /ADMIN_REQUIRED|NOT_ALLOWED|NOT_FOUND/);
  }
  const panel = await f.service.panel({ mailbox: "shared", companyId: OTHER, hostScope: scope });
  assert.ok("total" in panel); assert.equal(panel.total, 1);
  const routed = await f.service.resolve({ mailbox: "shared", entryId: first.entryId, decision: "route", destination: "operations", hostScope: scope });
  assert.equal(routed.outcome, "routed"); assert.equal(f.calls.read, 2); assert.deepEqual(f.calls.create[0].actor, { actorUserId: scope.userId });
});

test("lost core reply recovers same target without IMAP, second create or changed destination", async () => {
  const f = fixture(); const create = f.ctx.issues.create;
  await f.ctx.state.set({ scopeKind: "instance", namespace: "routing", stateKey: "self-plugin-id" }, PLUGIN);
  f.ctx.issues.create = async req => { await create(req); throw new Error("RPC timeout with secret-shaped data must not be stored"); };
  const first = await f.service.route(input(), run); assert.equal(first.outcome, "waiting"); assert.equal(first.frozen, true);
  f.failRead();
  await assert.rejects(f.service.route({ ...input(), destination: "property" }, run), /TARGET_FROZEN/);
  const replay = await f.service.route(input(), run);
  assert.equal(replay.outcome, "already_routed"); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.read, 1);
  assert.doesNotMatch(JSON.stringify(await f.service.store.find("shared", `msgid:${input().messageId}`)), /secret-shaped/);
});

test("exact old host pre-write refusal permits operator retry after upgrade", async () => {
  const f = fixture(); const create = f.ctx.issues.create;
  f.ctx.issues.create = async () => { f.calls.create.push({}); throw new Error("Plugin may only use originKind values under plugin:email-tools"); };
  const r = await f.service.route(input(), run); assert.equal(r.outcome, "waiting"); assert.match(r.note, /HOST_UPGRADE/);
  assert.equal(r.frozen, false);
  for (let i = 0; i < 3; i++) assert.equal((await f.service.route(input(), run)).outcome, "already_waiting");
  assert.equal(f.calls.create.length, 1);
  f.ctx.issues.create = create;
  assert.equal((await f.service.resolve({ mailbox: "shared", entryId: r.entryId, decision: "route", destination: "operations", hostScope: scope })).outcome, "routed");
  assert.equal(f.calls.create.length, 2); assert.equal(f.created.length, 1);
});

test("first-ever lost response waits for proven self identity and never adopts another plugin's issue", async () => {
  const f = fixture(); const create = f.ctx.issues.create;
  f.ctx.issues.create = async req => { await create(req); throw new Error("response lost"); };
  assert.equal((await f.service.route(input(), run)).outcome, "waiting");
  const pending = await f.service.route(input(), run); assert.equal(pending.outcome, "waiting"); assert.match(pending.note, /identity is not confirmed/);
  await f.ctx.state.set({ scopeKind: "instance", namespace: "routing", stateKey: "self-plugin-id" }, PLUGIN);
  const own = f.created[0]; f.created[0] = { ...own, originId: String(own.originId).replace(PLUGIN, OTHER) };
  assert.equal((await f.service.route(input(), run)).outcome, "waiting"); assert.equal(f.calls.create.length, 1);
  f.created[0] = own; assert.equal((await f.service.route(input(), run)).outcome, "already_routed");
});

test("ledger save failure after core creation recovers the canonical handoff without another create", async () => {
  const f = fixture(); const execute = opened.db.execute.bind(opened.db); let fail = true;
  opened.db.execute = async (sql, params) => {
    if (fail && /issue_id=\$3/.test(sql)) { fail = false; throw new Error("synthetic lost ledger save"); }
    return execute(sql, params);
  };
  try {
    assert.equal((await f.service.route(input(), run)).outcome, "waiting"); f.failRead();
    assert.equal((await f.service.route(input(), run)).outcome, "already_routed"); assert.equal(f.calls.create.length, 1);
    assert.equal(f.calls.read, 1); assert.equal(f.calls.wake.length, 1);
  } finally { opened.db.execute = execute; }
});

test("search annotation protects known routing mail even while off, without exposing it to another clerk", async () => {
  const f = fixture(); f.m.routing!.mode = "review"; await f.service.route(input(), run);
  f.m.routing!.mode = "off";
  const items = [{ uid: 1, messageId: input().messageId }, { uid: 2, messageId: "<fresh@example.com>" }];
  const annotated = await f.service.annotate(f.m, run, items, "42", "INBOX");
  assert.equal(annotated[0].routingStatus, "waiting"); assert.equal(annotated[1].routingStatus, undefined);
  assert.deepEqual(await f.service.annotate(f.m, { ...run, agentId: AGENT }, items, "42", "INBOX"), items);
  assert.equal((await f.service.review("shared", SOURCE, AGENT)).total, 0);
});

test("board and agent races share the one ledger path, while current ACL revocation before create refuses effects", async () => {
  const f = fixture(); f.m.routing!.mode = "review"; const first = await f.service.route(input(), run);
  f.m.routing!.mode = "auto";
  const results = await Promise.all([
    f.service.resolve({ mailbox: "shared", entryId: first.entryId, decision: "route", destination: "operations", hostScope: scope }),
    f.service.resolve({ mailbox: "shared", entryId: first.entryId, decision: "route", destination: "property", hostScope: scope }),
    f.service.route(input(), run),
  ]);
  assert.ok(results.some(r => r.outcome === "routed")); assert.equal(f.calls.create.length, 1);
  await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
  const next = fixture();
  next.ctx.agents.get = async () => { next.m.allowedCompanies = []; return { companyId: DEST, status: "idle" } as never; };
  assert.equal((await next.service.route(input(), run)).outcome, "waiting"); assert.equal(next.calls.create.length, 0);
});

test("a slow create can outlive claim takeover without a second destination or overwritten outcome", async () => {
  const f = fixture(); const create = f.ctx.issues.create;
  let resume!: () => void; let began!: () => void;
  const started = new Promise<void>(r => { began = r; });
  const delayed = new Promise<void>(r => { resume = r; });
  f.ctx.issues.create = async req => { began(); await delayed; return create(req); };
  const slow = f.service.route(input(), run); await started;
  await opened.pg.exec(`UPDATE ${ROUTES} SET claimed_at=now()-interval '3 minutes'`);
  const retry = await f.service.route(input(), run); assert.equal(retry.outcome, "waiting");
  await assert.rejects(f.service.route({ ...input(), destination: "property" }, run), /TARGET_FROZEN/);
  resume(); await slow;
  const recovered = await f.service.route(input(), run); assert.equal(recovered.outcome, "already_routed"); assert.equal(f.calls.create.length, 1);
});

test("lost wake response followed by duplicate remains verify rather than refused; audit never duplicates", async () => {
  const f = fixture(); const keys: unknown[] = []; let fail = true;
  f.ctx.issues.requestWakeup = async (_id, _company, opts) => { keys.push(opts?.idempotencyKey); if (fail) throw new Error("synthetic transport"); return { queued: false, runId: null }; };
  f.ctx.activity.log = async entry => { f.calls.audit.push(entry); throw new Error("response lost"); };
  const first = await f.service.route(input(), run); assert.equal(first.wake, "requested_unknown"); assert.equal(first.audit, "unknown");
  fail = false; const again = await f.service.resolve({ mailbox: "shared", entryId: first.entryId, decision: "retry_followups", hostScope: scope }); assert.equal(again.wake, "requested_or_duplicate_verify"); assert.equal(again.audit, "unknown");
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.equal(f.calls.audit.length, 1); assert.equal(f.calls.create.length, 1);
});

test("store fencing blocks old pre-call claim after takeover; durable destination cannot be changed", async () => {
  const f = fixture(); f.m.routing!.mode = "review"; await f.service.route(input(), run);
  let row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  const target = f.m.routing!.destinations![0]; const token1 = (await f.service.store.claim(row, target, {}))!;
  await opened.pg.exec(`UPDATE ${ROUTES} SET claimed_at=now()-interval '3 minutes'`);
  const token2 = (await f.service.store.claim(row, target, {}))!;
  assert.equal(await f.service.store.start(row.id, token1), false);
  assert.equal(await f.service.store.start(row.id, token2), true);
  await f.service.store.waiting(row.id, token2, "unknown");
  row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  assert.equal(await f.service.store.claim(row, f.m.routing!.destinations![1], {}), null);
  assert.equal(await f.service.store.dismiss(row), false);
});

test("actual worker registration, admin denial, validation and additive review counts/error surfaces", async () => {
  const f = fixture(); await plugin.definition.setup(f.ctx);
  try {
    const result = await f.h.executeTool<{ data: { mode: string } }>("email_list_route_destinations", { mailbox: "shared" }, run); assert.equal(result.data.mode, "auto");
    await assert.rejects(f.h.getData("email.list-routing", { mailbox: "shared" }), /ADMIN_REQUIRED/);
    const error = await f.h.executeTool<{ error: string }>("email_route_message", { ...input(), destination: "bad" }, run); assert.match(error.error, /UNKNOWN_DESTINATION/);
    f.m.routing!.mode = "review"; await f.service.route(input(), run);
    const queue = await f.h.executeTool<{ data: { routing: { total: number } } }>("email_list_review_queue", { mailbox: "shared" }, run); assert.equal(queue.data.routing.total, 1);
    assert.equal(plugin.definition.onValidateConfig, undefined);
    opened.failWhen(/email_routing/);
    await assert.rejects(f.h.getData("email.list-routing", { mailbox: "shared", hostScope: scope }), /simulated database/);
  } finally { opened.failWhen(null); await plugin.definition.onShutdown?.(); }
});

test("routing source shape contains no mutating mail primitives; new tools and real UI keys match", async () => {
  for (const file of ["routing.ts", "routing-config.ts", "routing-store.ts", "routing-reader.ts"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /\b(?:moveMessages|setSeenFlag|deliver|sendViaSmtp|findTrashFolder|messageFlagsAdd|messageMove|messageDelete)\s*\(/);
    assert.doesNotMatch(text, /import[^;]*\b(?:moveMessages|setSeenFlag|sendViaSmtp|findTrashFolder)\b/);
  }
  assert.equal(manifest.tools.find(t => t.name === "email_route_message")!.writes, true);
  assert.equal(manifest.tools.find(t => t.name === "email_route_message")!.actionType, "change_knowledge_base");
  assert.equal(manifest.tools.find(t => t.name === "email_list_route_destinations")!.writes, false);
  assert.equal(manifest.tools.find(t => t.name === "email_list_route_destinations")!.actionType, undefined);
  const ui = await readFile(new URL("ui/RoutingSettingsPage.tsx", import.meta.url), "utf8");
  assert.match(ui, /usePluginData<RoutingPanelData>\("email.list-routing"/); assert.match(ui, /query.error/); assert.doesNotMatch(ui, /#[0-9a-f]{3,8}\b/i);
});

test("provider tool schemas have no top-level composition, reply selector stays runtime-exclusive", () => {
  for (const tool of manifest.tools) for (const keyword of ["oneOf", "anyOf", "allOf", "not"]) {
    assert.equal(Object.hasOwn(tool.parametersSchema, keyword), false, `${tool.name}: ${keyword}`);
  }
  const reply = manifest.tools.find(t => t.name === "email_reply")!.parametersSchema as any;
  assert.deepEqual(reply.required, ["mailbox", "body"]);
  for (const key of ["uid", "messageId"]) assert.match(reply.properties[key].description, /exactly one of uid or messageId/i);
});

test("stale pre-call agent claims cannot bypass unsure, review, fresh security or payment holds", async () => {
  for (const kind of ["unsure", "review", "security", "payment"]) {
    await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
    const f = fixture(); f.m.routing!.mode = "review";
    await f.service.route(input(), run);
    const row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
    await f.service.store.claim(row, f.m.routing!.destinations![0], { actorUserId: scope.userId });
    await opened.pg.exec(`UPDATE ${ROUTES} SET claimed_at=now()-interval '3 minutes'`);
    f.m.routing!.mode = kind === "review" ? "review" : "auto";
    if (kind === "security" || kind === "payment") {
      const message = mail(); message.parsed.text = kind === "security" ? "Security notice: password reset" : "Change bank account payment details";
      f.setFetched(message);
    }
    await f.service.route({ ...input(), confidence: kind === "unsure" ? "unsure" : "sure", destination: "property" }, run);
    assert.equal(f.calls.create.length, 0, kind);
    assert.equal(f.calls.wake.length, 0); assert.equal(f.calls.audit.length, 0);
    assert.equal((await f.service.store.find("shared", row.message_key))!.attempt_started, false);
  }
});

test("all host agent statuses enforce availability and membership, unknown values fail closed", async () => {
  let n = 1;
  for (const status of ["active", "paused", "idle", "running", "error", "pending_approval", "terminated", "future_status"]) {
    const f = fixture(); f.ctx.agents.get = async (id, companyId) => ({ id, companyId, status }) as never;
    const result = await f.service.route(input(n++), run);
    assert.equal(result.outcome, ["active", "idle", "running", "error"].includes(status) ? "routed" : "waiting", status);
  }
  const f = fixture(); f.ctx.agents.get = async id => ({ id, companyId: OTHER, status: "active" }) as never;
  assert.equal((await f.service.route(input(n), run)).outcome, "waiting"); assert.equal(f.calls.create.length, 0);
});

test("transport settings preserve account identity, genuine account changes and renamed aliases do not bypass it", async () => {
  const f = fixture(); const binding = mailboxBinding(f.m);
  f.m = { ...f.m, imapHost: "IMAP.EXAMPLE.COM", user: "CLERK@EXAMPLE.COM", imapPort: 143, imapSecure: false, authType: "oauth2" };
  assert.equal(mailboxBinding(f.m), binding);
  f.m.routing!.mode = "review"; const waiting = await f.service.route(input(), run);
  f.m.user = "other@example.com";
  await assert.rejects(f.service.resolve({ mailbox: "shared", entryId: waiting.entryId, decision: "route", destination: "operations", hostScope: scope }), /SOURCE_CHANGED/);
  assert.equal((await f.service.resolve({ mailbox: "shared", entryId: waiting.entryId, decision: "close_manually", hostScope: scope })).outcome, "handled_manually");
  f.m.user = "clerk@example.com";
  assert.equal((await f.service.route(input(), run)).outcome, "handled_manually");
  f.m.key = "renamed";
  await assert.rejects(f.service.route({ ...input(), mailbox: "renamed" }, run), /SOURCE_CHANGED/);
  assert.equal(f.calls.create.length, 0);
});

test("admin manual close fences stale unstarted workers, retains tombstone and needs no current mailbox", async () => {
  const f = fixture(); f.m.routing!.mode = "review";
  const waiting = await f.service.route(input(), run);
  const row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  const token = (await f.service.store.claim(row, f.m.routing!.destinations![0], { actorAgentId: CLERK }))!;
  f.ctx.config.get = async () => ({ mailboxes: [] });
  const panel = await f.service.panel({ mailbox: "shared", hostScope: scope });
  assert.equal((panel as any).mode, "unavailable"); assert.equal((panel as any).total, 1);
  assert.deepEqual((await f.service.panel({ hostScope: scope }) as any).scopes, [{ key: "shared", name: "shared (recorded entries)" }]);
  const params = { mailbox: "shared", entryId: waiting.entryId, decision: "close_manually" };
  for (const hostScope of [undefined, { ...scope, isInstanceAdmin: false }, { ...scope, companyId: OTHER }]) {
    await assert.rejects(f.service.resolve({ ...params, hostScope }), /ADMIN_REQUIRED|NOT_FOUND/);
  }
  assert.equal((await f.service.resolve({ ...params, hostScope: scope })).outcome, "handled_manually");
  assert.equal(await f.service.store.start(row.id, token), false);
  await f.service.store.waiting(row.id, token, "stale worker");
  assert.equal(await f.service.store.claim(row, f.m.routing!.destinations![0], {}), null);
  const closed = (await f.service.store.get(row.id, SOURCE, "shared"))!;
  assert.equal(closed.status, "handled"); assert.equal(closed.handled_by_user_id, scope.userId);
  assert.equal(closed.message_key, row.message_key); assert.deepEqual(closed.actor, { actorAgentId: CLERK });
  assert.equal((await f.service.panel({ mailbox: "shared", hostScope: scope }) as any).total, 0);
  assert.equal(f.calls.read, 1); assert.equal(f.calls.create.length, 0);
  assert.deepEqual((await f.service.panel({ hostScope: { ...scope, companyId: OTHER } }) as any).scopes, []);
});

test("closing an in-flight unknown handoff cannot cancel it, reopen review or trigger another route", async () => {
  const f = fixture(); const create = f.ctx.issues.create;
  let resume!: () => void, began!: () => void;
  const started = new Promise<void>(r => { began = r; }), delayed = new Promise<void>(r => { resume = r; });
  f.ctx.issues.create = async req => { began(); await delayed; return create(req); };
  const slow = f.service.route(input(), run); await started;
  const row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  const close = await f.service.resolve({ mailbox: "shared", entryId: row.id, decision: "close_manually", hostScope: scope });
  assert.equal(close.frozen, true); assert.equal(close.issue, undefined);
  resume(); assert.equal((await slow).outcome, "handled_manually");
  const closed = (await f.service.store.get(row.id, SOURCE, "shared"))!;
  assert.equal(closed.status, "handled"); assert.equal(closed.attempt_started, true); assert.equal(closed.issue_id, ISSUE);
  f.failRead();
  assert.equal((await f.service.route({ ...input(), destination: "property" }, run)).outcome, "handled_manually");
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.wake.length, 0); assert.equal(f.calls.audit.length, 0);
});

test("ambiguous failures never reset attempts, and unknown entries can be closed with facts intact", async () => {
  for (const message of ["origin refused", "Plugin may only use originKind values under plugin:email-tools:other", "Plugin may only use originKind values under plugin:email-tools\nresponse lost"]) {
    await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
    const f = fixture(); f.ctx.issues.create = async () => { f.calls.create.push({}); throw new Error(message); };
    const result = await f.service.route(input(), run); assert.equal(result.frozen, true);
    await f.service.route(input(), run); assert.equal(f.calls.create.length, 1);
    const closed = await f.service.resolve({ mailbox: "shared", entryId: result.entryId, decision: "close_manually", hostScope: scope });
    assert.equal(closed.frozen, true); assert.equal(closed.destination!.key, "operations");
    assert.equal((await f.service.route(input(), run)).outcome, "handled_manually");
  }
});

test("definitive initial wake refusal remains refused", async () => {
  const f = fixture(); f.ctx.issues.requestWakeup = async () => ({ queued: false, runId: null });
  assert.equal((await f.service.route(input(), run)).wake, "refused");
});

test("manual close during the final pre-call recheck fences the worker and reports terminal state", async () => {
  const f = fixture(); let checks = 0;
  const get = f.ctx.config.get;
  f.ctx.config.get = async () => {
    checks++;
    // agentMailbox, finish target lookup, first fresh, then final fresh before start.
    if (checks === 4) {
      const row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
      await f.service.resolve({ mailbox: "shared", entryId: row.id, decision: "close_manually", hostScope: scope });
    }
    return get();
  };
  assert.equal((await f.service.route(input(), run)).outcome, "handled_manually");
  assert.equal(f.calls.create.length, 0);
  const row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  assert.equal(row.status, "handled"); assert.equal(row.attempt_started, false);
});

test("routing retention disclosure names retained content and company-scoped hold limits", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const migration = await readFile(new URL("../migrations/006_routing.sql", import.meta.url), "utf8");
  assert.match(readme, /free-form classifier note[\s\S]*may quote[\s\S]*mail content/);
  assert.match(readme, /indefinitely, including terminal/); assert.match(readme, /hold badges are company-scoped/);
  assert.doesNotMatch(migration, /metadata only/i); assert.match(migration, /possibly mail content/);
});

test("legacy mailbox keys keep actual sender review and safe routing-off tools working", async () => {
  for (const [mailboxes, key] of [
    [[{ ...mailbox(), key: "shared box", routing: undefined }], "shared box"],
    [[{ ...mailbox(), key: "Sales", routing: undefined }, { ...mailbox(), key: "sales", user: "other@example.com", routing: undefined }], "Sales"],
    [[{ ...mailbox(), key: "shared box", routing: { mode: "off" as const } }], "shared box"],
  ] as const) {
    const h = createTestHarness({ manifest, config: { mailboxes } }); Object.assign(h.ctx, { db: opened.db });
    await plugin.definition.setup(h.ctx);
    try {
      const review = await h.executeTool<any>("email_list_review_queue", { mailbox: key }, run);
      assert.equal(review.data.total, 0); assert.deepEqual(review.data.routing, { waiting: [], total: 0 });
      assert.deepEqual((await h.executeTool<any>("email_list_route_destinations", { mailbox: key }, run)).data, { mode: "off", destinations: [] });
    } finally { await plugin.definition.onShutdown?.(); }
  }
});

test("additive routing failure preserves sender rows but legacy sender database failure still surfaces", async () => {
  const f = fixture(); await plugin.definition.setup(f.ctx);
  try {
    opened.failWhen(/email_routing/);
    const result = await f.h.executeTool<any>("email_list_review_queue", { mailbox: "shared" }, run);
    assert.equal(result.data.total, 0); assert.match(result.data.routing.diagnostic, /routing review is unavailable/);
    opened.failWhen(/email_review_queue/);
    await assert.rejects(f.h.executeTool("email_list_review_queue", { mailbox: "shared" }, run), /simulated database/);
  } finally { opened.failWhen(null); await plugin.definition.onShutdown?.(); }
});

test("recorded handoff survives pre-effect failure and restart, with reachable authorized follow-up repair", async () => {
  const f = fixture(); const create = f.ctx.issues.create;
  f.ctx.issues.create = async request => { const result = await create(request); f.failCredentials(); return result; };
  const first = await f.service.route(input(), run);
  assert.equal(first.outcome, "routed"); assert.ok(first.issue); assert.equal(first.wake, "pending"); assert.equal(first.audit, "pending");
  assert.match(first.followupError!, /handoff is recorded/); assert.doesNotMatch(first.followupError!, /Credentials unavailable/);
  assert.equal((await f.service.review("shared", SOURCE, CLERK)).followups, 1);
  assert.equal((await f.service.review("shared", OTHER, CLERK)).total, 0);
  const params = { mailbox: "shared", entryId: first.entryId, decision: "retry_followups", hostScope: scope };
  for (const hostScope of [undefined, { ...scope, isInstanceAdmin: false }, { ...scope, companyId: OTHER }]) {
    await assert.rejects(f.service.resolve({ ...params, hostScope }), /ADMIN_REQUIRED|NOT_FOUND/);
  }
  const panel = await f.service.panel({ mailbox: "shared", hostScope: scope });
  assert.ok("rows" in panel); assert.equal(panel.followups, 1); assert.equal(panel.rows[0].canRetryFollowups, true);
  assert.equal((await f.service.route(input(), run)).outcome, "already_routed");
  const failed = await f.service.resolve(params); assert.equal(failed.outcome, "already_routed"); assert.ok(failed.followupError);
  const restarted = new MailRouting(f.ctx, async () => { throw new Error("Must not reread mail"); }, async () => {});
  const repaired = await restarted.resolve(params);
  assert.equal(repaired.outcome, "already_routed"); assert.equal(repaired.wake, "requested"); assert.equal(repaired.audit, "logged");
  assert.equal((await restarted.review("shared", SOURCE, CLERK)).followups, 0);
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.wake.length, 1); assert.equal(f.calls.audit.length, 1);
});

test("follow-up retry honors current source, clerk, target, mode, eligibility and credentials without effects", async () => {
  const f = fixture(); f.ctx.issues.requestWakeup = async () => { throw new Error("lost response"); };
  f.ctx.activity.log = async () => { throw new Error("lost audit response"); };
  const first = await f.service.route(input(), run);
  const params = { mailbox: "shared", entryId: first.entryId, decision: "retry_followups", hostScope: scope };
  const original = structuredClone(f.m);
  for (const mutate of [
    () => { f.m.allowedCompanies = []; }, () => { f.m.ingestCompanyId = OTHER; },
    () => { f.m.routing!.mode = "off"; }, () => { f.m.routing!.routerAgentId = AGENT; },
    () => { f.m.user = "other@example.com"; }, () => { f.m.routing!.destinations![0].assigneeAgentId = CLERK; },
    () => { f.ctx.agents.get = async () => ({ companyId: DEST, status: "paused" }) as never; },
  ]) {
    f.m = structuredClone(original); mutate();
    const before = f.calls.wake.length;
    const result = await f.service.resolve(params);
    assert.equal(result.outcome, "already_routed"); assert.equal(result.wake, "requested_unknown"); assert.equal(result.audit, "unknown");
    assert.ok(result.followupError); assert.equal(f.calls.wake.length, before);
  }
  assert.equal(f.calls.create.length, 1);
});

test("pending follow-ups remain discoverable in stored mailbox lists and paginated history", async () => {
  const f = fixture(); const first = await f.service.route(input(), run);
  await opened.db.execute(`UPDATE ${ROUTES} SET wake_state='pending',audit_state='pending' WHERE id=$1`, [first.entryId]);
  f.m.key = "replacement";
  const scopes = await f.service.panel({ hostScope: scope }); assert.ok("scopes" in scopes);
  assert.ok(scopes.scopes!.some(m => m.key === "shared"));
  const other = await f.service.panel({ hostScope: { ...scope, companyId: OTHER } }); assert.ok("scopes" in other); assert.equal(other.scopes!.length, 0);
  const firstRow = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  for (let n = 2; n <= 28; n++) {
    await f.service.store.insert({ ...firstRow, ...{ message_key: `msgid:<page-${n}@example.com>`, message_id: `<page-${n}@example.com>` } });
  }
  const page = await f.service.panel({ mailbox: "shared", hostScope: scope }); assert.ok("rows" in page);
  assert.equal(page.rows.length, 25); assert.equal(page.hasMore, true); assert.equal(page.followups, 28);
  const next = await f.service.panel({ mailbox: "shared", offset: 25, hostScope: scope }); assert.ok("rows" in next); assert.equal(next.rows.length, 3);
  assert.equal((await f.service.resolve({ mailbox: "shared", entryId: first.entryId, decision: "retry_followups", hostScope: scope })).wake, "pending");
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.wake.length, 1);
});

test("two overlapping Route reads never make another create after a lost response or deleted handoff history", async () => {
  for (const deleted of [false, true]) {
    await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
    const f = fixture(); f.m.routing!.mode = "review";
    const waiting = await f.service.route(input(), run);
    await f.ctx.state.set({ scopeKind: "instance", namespace: "routing", stateKey: "self-plugin-id" }, PLUGIN);
    let release!: () => void, entered!: () => void; let reads = 0;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    const service = new MailRouting(f.ctx, async () => { if (++reads === 1) { entered(); await gate; } return mail(); }, async () => {});
    const params = { mailbox: "shared", entryId: waiting.entryId, decision: "route", destination: "operations", hostScope: scope };
    const a = service.resolve(params); await started;
    const create = f.ctx.issues.create;
    f.ctx.issues.create = async request => { await create(request); throw new Error("lost response after commit"); };
    assert.equal((await service.resolve(params)).outcome, "waiting");
    if (deleted) f.created.length = 0;
    f.ctx.issues.create = create; release(); await a;
    assert.equal(f.calls.create.length, 1); assert.equal(f.created.length, deleted ? 0 : 1);
    const row = (await service.store.find("shared", `msgid:${input().messageId}`))!;
    assert.equal(await service.store.start(row.id, row.claim_token!), false);
    await service.resolve(params); assert.equal(f.calls.create.length, 1);
  }
});

test("concurrent wake replies cannot relabel a delivered keyed replay as an initial refusal", async () => {
  const f = fixture(); let release!: () => void, entered!: () => void; const keys: unknown[] = [];
  const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
  f.ctx.issues.requestWakeup = async (_id, _company, options) => {
    keys.push(options?.idempotencyKey);
    if (keys.length === 1) { entered(); await gate; }
    return { queued: false, runId: null };
  };
  const first = f.service.route(input(), run); await started;
  const row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  await f.service.resolve({ mailbox: "shared", entryId: row.id, decision: "retry_followups", hostScope: scope });
  release(); const result = await first;
  assert.equal(result.wake, "requested_or_duplicate_verify"); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(f.calls.create.length, 1); assert.equal(f.calls.audit.length, 1);
});

test("real ENVELOPE and mailparser pair keeps malformed IDs in UID-keyed waiting and refuses normalized caller substitutions", async () => {
  const { parseEnvelope } = createRequire(import.meta.url)("imapflow/lib/tools.js");
  for (const [n, rawId] of [[1, "no-brackets@example.com"], [2, "<comment@example.com> (relay)"], [3, "<valid@example.com>"]] as const) {
    const f = fixture();
    const searchId = parseEnvelope([null, null, null, null, null, null, null, null, null, { value: rawId }]).messageId;
    const raw = `From: Example <sender@example.com>\r\nSubject: Invented update\r\nMessage-ID: ${rawId}\r\n\r\n`;
    const client = { mailbox: { uidValidity: 42n }, getMailboxLock: async () => ({ release() {} }),
      fetchOne: async () => ({ uid: n, source: Buffer.from(raw + "Synthetic body."), flags: new Set(), headers: Buffer.from(raw), bodyStructure: { type: "text/plain", part: "1", size: 10 } }),
      download: async () => ({ content: Readable.from([Buffer.from("Synthetic body.")]) }) };
    const service = new MailRouting(f.ctx, async (_m, locator) => readRoutingMessage(client as never, locator), async () => {});
    const fetched = await fetchParsedMessage(client as never, "INBOX", n);
    assert.ok(fetched);
    if (n < 3) {
      assert.notEqual(fetched.messageId, searchId);
      await assert.rejects(service.route({ ...input(n), messageId: fetched.messageId }, run), /MISMATCH/);
      assert.equal((await opened.db.query(`SELECT id FROM ${ROUTES} WHERE uid=$1`, [n])).length, 0);
    } else assert.equal(fetched.messageId, searchId);
    const result = await service.route({ ...input(n), messageId: searchId }, run);
    if (n < 3) {
      assert.equal(result.outcome, "waiting"); assert.match(result.note, /No usable Message-ID/); assert.equal(f.calls.create.length, 0);
      assert.ok(await service.store.find("shared", `uid:42:INBOX:${n}`));
      const normalized = n === 1 ? "<no-brackets@example.com>" : "<comment@example.com>";
      await assert.rejects(service.route({ ...input(n), messageId: normalized }, run), /MISMATCH/);
      await assert.rejects(service.route({ ...input(n), messageId: "<other@example.com>" }, run), /MISMATCH/);
    } else { assert.equal(result.outcome, "routed"); assert.equal(f.calls.create.length, 1); }
  }
});

test("route manifest requires the current search item's identity and explicitly excludes fetch normalization", () => {
  const tool = manifest.tools!.find(t => t.name === "email_route_message")!;
  const schema = tool.parametersSchema as { properties: { messageId: { description: string } } };
  assert.match(schema.properties.messageId.description, /exact messageId.*CURRENT email_search item/);
  assert.match(schema.properties.messageId.description, /not email_fetch.*normalizes malformed IDs/);
  assert.doesNotMatch(schema.properties.messageId.description, /search\/fetch|from.*search or fetch/);
});

test("source-company panel shows safe actual config errors with zero entries and legacy-off compatibility", async () => {
  const f = fixture(); f.m.routing!.sendingApprovalConfirmed = false;
  const invalid = await f.service.panel({ mailbox: "shared", hostScope: scope }); assert.ok("rows" in invalid);
  assert.equal(invalid.mode, "unavailable"); assert.equal(invalid.rows.length, 0); assert.match(invalid.configReason!, /EROUTING_CONFIG.*sending-approval prerequisite/);
  const scopes = await f.service.panel({ hostScope: { ...scope, companyId: OTHER } }); assert.ok("scopes" in scopes); assert.deepEqual(scopes.scopes, []);
  await assert.rejects(f.service.panel({ mailbox: "shared", hostScope: { ...scope, companyId: OTHER } }), /NOT_FOUND/);
  for (const key of ["shared box", "Sales"]) {
    f.m.key = key; f.m.routing = undefined;
    f.ctx.config.get = async () => ({ mailboxes: [f.m, { ...f.m, key: key.toLowerCase() }] });
    const panel = await f.service.panel({ mailbox: key, hostScope: scope }); assert.ok("mode" in panel); assert.equal(panel.mode, "off");
  }
});


test("recovered durable handoff also returns recorded states when follow-up prerequisites fail", async () => {
  const f = fixture(); const create = f.ctx.issues.create;
  await f.ctx.state.set({ scopeKind: "instance", namespace: "routing", stateKey: "self-plugin-id" }, PLUGIN);
  f.ctx.issues.create = async request => { await create(request); throw new Error("lost create response"); };
  assert.equal((await f.service.route(input(), run)).outcome, "waiting");
  const list = f.ctx.issues.list;
  f.ctx.issues.list = async params => { const result = await list(params); f.failCredentials(); return result; };
  const result = await f.service.route(input(), run);
  assert.equal(result.outcome, "already_routed"); assert.ok(result.issue); assert.equal(result.wake, "pending"); assert.equal(result.audit, "pending");
  assert.ok(result.followupError); assert.equal(f.calls.create.length, 1); assert.equal(f.calls.wake.length, 0);
});

test("unknown audit-only history remains discoverable after mailbox removal without replaying it", async () => {
  const f = fixture();
  f.ctx.activity.log = async entry => { f.calls.audit.push(entry); throw new Error("lost audit response"); };
  const result = await f.service.route(input(), run);
  assert.equal(result.audit, "unknown"); assert.equal(result.wake, "requested");
  f.m.key = "replacement";
  const panel = await f.service.panel({ hostScope: scope }); assert.ok("scopes" in panel);
  assert.ok(panel.scopes!.some(m => m.key === "shared"));
  const history = await f.service.panel({ mailbox: "shared", hostScope: scope }); assert.ok("rows" in history);
  assert.equal(history.rows[0].audit, "unknown"); assert.equal(history.rows[0].canRetryFollowups, false);
  f.m.key = "shared";
  await f.service.resolve({ mailbox: "shared", entryId: result.entryId, decision: "retry_followups", hostScope: scope });
  assert.equal(f.calls.audit.length, 1); assert.equal(f.calls.wake.length, 1); assert.equal(f.calls.create.length, 1);
});

test("stored mailbox discovery pages past unresolved unknown audits without exposing another company", async () => {
  const f = fixture(); f.ctx.activity.log = async () => { throw new Error("unknown response"); };
  await f.service.route(input(), run);
  const row = (await f.service.store.find("shared", `msgid:${input().messageId}`))!;
  for (let n = 0; n < 101; n++) {
    const key = `stored-${String(n).padStart(3, "0")}`;
    const inserted = await f.service.store.insert({ ...row, mailbox_key: key, message_key: `msgid:<${key}@example.com>`, message_id: `<${key}@example.com>` });
    await opened.db.execute(`UPDATE ${ROUTES} SET wake_state='requested',audit_state='unknown' WHERE id=$1`, [inserted.id]);
  }
  f.m.key = "replacement";
  const first = await f.service.panel({ hostScope: scope }); assert.ok("scopes" in first);
  assert.equal(first.hasMoreMailboxes, true); assert.equal(first.scopes!.length, 101);
  const last = await f.service.panel({ hostScope: scope, mailboxOffset: 100 }); assert.ok("scopes" in last);
  assert.equal(last.hasMoreMailboxes, false); assert.ok(last.scopes!.some(m => m.key === "stored-100"));
  const other = await f.service.panel({ hostScope: { ...scope, companyId: OTHER }, mailboxOffset: 100 }); assert.ok("scopes" in other); assert.deepEqual(other.scopes, []);
  for (const mailboxOffset of [-1, 1.5, 10_001]) await assert.rejects(f.service.panel({ hostScope: scope, mailboxOffset }), /EROUTE_INPUT/);
});

test("admin follow-up checking clears every stuck routed case without current config or any external effect", async () => {
  const cases = ["done", "deleted", "repointed", "terminated", "router-replaced", "destination-disabled", "source-removed", "account-changed", "off", "audit-unknown"];
  for (const [n, kind] of cases.entries()) {
    const f = fixture(); const original = structuredClone(f.m);
    const create = f.ctx.issues.create;
    f.ctx.issues.create = async request => { const result = await create(request); f.failCredentials(); return result; };
    const routed = await f.service.route(input(n + 1), run);
    assert.equal(routed.outcome, "routed"); assert.equal((await f.service.review("shared", SOURCE, CLERK)).followups, 1);
    if (kind === "audit-unknown") await opened.db.execute(`UPDATE ${ROUTES} SET wake_state='requested_or_duplicate_verify',audit_state='unknown' WHERE id=$1`, [routed.entryId]);
    if (kind === "done") f.created[0].status = "done";
    if (kind === "deleted") f.created.length = 0;
    if (kind === "repointed") f.m.routing!.destinations![0].projectId = OTHER;
    if (kind === "terminated") f.ctx.agents.get = async () => ({ companyId: DEST, status: "terminated" }) as never;
    if (kind === "router-replaced") f.m.routing!.routerAgentId = AGENT;
    if (kind === "destination-disabled") f.m.routing!.destinations = [];
    if (kind === "source-removed") f.ctx.config.get = async () => ({ mailboxes: [] });
    if (kind === "account-changed") f.m.user = "replacement@example.com";
    if (kind === "off") f.m.routing!.mode = "off";
    const before = (await f.service.store.get(routed.entryId, SOURCE, "shared"))!;
    const calls = structuredClone(f.calls);
    const getConfig = f.ctx.config.get;
    f.ctx.config.get = async () => { throw new Error("Operator acknowledgement must not load configuration"); };
    const action = { mailbox: "shared", entryId: routed.entryId, decision: "check_followups", hostScope: scope };
    const checked = await f.service.resolve(action);
    assert.equal(checked.outcome, "followups_checked"); assert.equal(checked.followupsCheckedByUserId, scope.userId); assert.ok(checked.followupsCheckedAt);
    const repeat = await f.service.resolve({ ...action, hostScope: { ...scope, userId: "another-operator" } });
    assert.deepEqual(repeat, checked, "lost-response repeat must preserve the first actor and timestamp");
    await f.service.resolve({ ...action, decision: "retry_followups" });
    assert.deepEqual(f.calls, calls, kind);
    const after = (await f.service.store.get(routed.entryId, SOURCE, "shared"))!;
    for (const field of ["status", "issue_id", "issue_identifier", "handoff_origin_id", "destination", "actor", "message_key", "message_id", "mailbox_binding", "attempt_started", "wake_state", "wake_attempt", "audit_state", "last_error"] as const) assert.deepEqual(after[field], before[field], `${kind}: ${field}`);
    assert.equal((await f.service.store.list(SOURCE, "shared")).followups, 0);
    assert.deepEqual(await f.service.store.mailboxes(SOURCE), []);
    // A known current mailbox still has history, and a later run cannot restart effects.
    f.ctx.config.get = getConfig; f.m = original;
    f.ctx.config.get = async () => ({ mailboxes: [f.m] });
    const panel = await f.service.panel({ mailbox: "shared", hostScope: scope }); assert.ok("rows" in panel);
    assert.equal(panel.rows[0].status, "routed"); assert.equal(panel.rows[0].canRetryFollowups, false); assert.ok(panel.rows[0].followupsCheckedAt);
    assert.equal((await f.service.review("shared", SOURCE, CLERK)).followups, 0);
    assert.equal((await f.service.route(input(n + 1), run)).outcome, "already_routed");
    assert.deepEqual(f.calls, calls);
    await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
  }
});

test("follow-up acknowledgement needs exact stored company/mailbox and host admin, never caller agent authority", async () => {
  const f = fixture(); const result = await f.service.route(input(), run);
  const action = { mailbox: "shared", entryId: result.entryId, decision: "check_followups", hostScope: scope };
  for (const bad of [{ ...action, hostScope: undefined }, { ...action, hostScope: { ...scope, isInstanceAdmin: false } },
    { ...action, hostScope: { ...scope, companyId: OTHER } }, { ...action, mailbox: "foreign" }, { ...action, entryId: OTHER }]) {
    await assert.rejects(f.service.resolve(bad), /ADMIN_REQUIRED|NOT_FOUND/);
  }
  await assert.rejects(f.service.route({ ...input(), decision: "check_followups", hostScope: scope }, run), /EROUTE_INPUT/);
  f.m.routing!.mode = "review";
  const waiting = await f.service.route(input(2), run);
  await assert.rejects(f.service.resolve({ ...action, entryId: waiting.entryId }), /TERMINAL/);
  await f.service.resolve({ ...action, entryId: waiting.entryId, decision: "close_manually" });
  await assert.rejects(f.service.resolve({ ...action, entryId: waiting.entryId }), /TERMINAL/);
  const original = (await f.service.store.get(result.entryId, SOURCE, "shared"))!;
  assert.equal(original.followups_checked_at, null);
});

test("acknowledgement fences stale follow-up claims while already requested wake or audit facts may finish", async () => {
  for (const phase of ["credentials", "wake", "audit"] as const) {
    await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
    const f = fixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    const wake = f.ctx.issues.requestWakeup, audit = f.ctx.activity.log;
    let checks = 0;
    const service = new MailRouting(f.ctx, f.service.read, async () => { if (phase === "credentials" && ++checks === 3) { entered(); await gate; } });
    if (phase === "wake") f.ctx.issues.requestWakeup = async (...args) => { entered(); await gate; return wake(...args); };
    if (phase === "audit") f.ctx.activity.log = async e => { entered(); await gate; return audit(e); };
    const request = service.route(input(), run); await started;
    const row = (await service.store.find("shared", `msgid:${input().messageId}`))!;
    assert.equal(row.status, "routed");
    const checked = await service.resolve({ mailbox: "shared", entryId: row.id, decision: "check_followups", hostScope: scope });
    assert.equal(await service.store.claimWake(row), false);
    assert.equal(await service.store.effect(row.id, "audit", ["pending"], "unknown"), false);
    release(); await request;
    const after = (await service.store.get(row.id, SOURCE, "shared"))!;
    assert.equal(after.status, "routed"); assert.equal(after.followups_checked_by_user_id, scope.userId);
    assert.deepEqual(after.followups_checked_at, checked.followupsCheckedAt);
    assert.equal((await service.store.list(SOURCE, "shared")).followups, 0); assert.deepEqual(await service.store.mailboxes(SOURCE), []);
    assert.equal(f.calls.wake.length, phase === "credentials" ? 0 : 1);
    assert.equal(f.calls.audit.length, phase === "audit" ? 1 : 0);
    assert.equal(after.audit_state, phase === "audit" ? "logged" : "pending");
    await service.resolve({ mailbox: "shared", entryId: row.id, decision: "retry_followups", hostScope: scope });
    assert.equal(f.calls.wake.length, phase === "credentials" ? 0 : 1); assert.equal(f.calls.audit.length, phase === "audit" ? 1 : 0);
  }
});


test("recorded keys stay exact after case-only, other-key or removed configuration changes", async () => {
  for (const replacement of ["Shared", "frontdesk", null]) {
    await opened.pg.exec(`TRUNCATE ${ROUTES},plugin_email_tools_7cbee3fdf3.email_routing_rate`);
    const f = fixture(); f.m.routing!.mode = "review";
    const waiting = await f.service.route(input(), run);
    f.m.routing!.mode = "auto";
    f.ctx.issues.requestWakeup = async () => { throw new Error("synthetic unknown wake"); };
    const routed = await f.service.route(input(2), run);
    const before = await f.service.store.get(waiting.entryId, SOURCE, "shared");
    if (replacement) f.m.key = replacement;
    else f.ctx.config.get = async () => ({ mailboxes: [] });
    const panel = await f.service.panel({ mailbox: "shared", hostScope: scope }); assert.ok("rows" in panel);
    assert.equal(panel.mode, "unavailable"); assert.deepEqual(panel.destinations, []);
    assert.equal(panel.rows.find(r => r.id === waiting.entryId)!.canRoute, false);
    assert.equal(panel.configReason, "The recorded mailbox configuration is unavailable.");
    const calls = JSON.stringify(f.calls);
    for (const decision of ["route", "dismiss"]) {
      await assert.rejects(f.service.resolve({ mailbox: "shared", entryId: waiting.entryId, decision, destination: "operations", hostScope: scope }), /EROUTE_SOURCE_CHANGED.*recorded mailbox configuration is unavailable/);
    }
    assert.deepEqual(await f.service.store.get(waiting.entryId, SOURCE, "shared"), before);
    assert.equal(JSON.stringify(f.calls), calls);
    await assert.rejects(f.service.route({ ...input(), mailbox: replacement ?? "shared" }, run), /SOURCE_CHANGED|Mailbox not found/);
    const rows = await opened.pg.query(`SELECT id FROM ${ROUTES}`); assert.equal(rows.rows.length, 2);
    // Stored manual decisions need no configuration or credentials and preserve known facts.
    f.ctx.config.get = async () => { throw new Error("must not load config"); };
    const closed = await f.service.resolve({ mailbox: "shared", entryId: waiting.entryId, decision: "close_manually", hostScope: scope });
    assert.equal(closed.outcome, "handled_manually");
    const checked = await f.service.resolve({ mailbox: "shared", entryId: routed.entryId, decision: "check_followups", hostScope: scope });
    assert.equal(checked.outcome, "followups_checked"); assert.equal(checked.issue!.id, routed.issue!.id);
    assert.equal(checked.wake, "requested_unknown"); assert.equal(JSON.stringify(f.calls), calls);
  }
});

test("allowed dismissal rereads the stored key even if the configured object changes after its durable save", async () => {
  const f = fixture(); f.m.routing!.mode = "review";
  const waiting = await f.service.route({ ...input(), mailbox: "SHARED" }, run);
  const dismiss = f.service.store.dismiss.bind(f.service.store);
  f.service.store.dismiss = async row => { const result = await dismiss(row); f.m.key = "Shared"; return result; };
  const result = await f.service.resolve({ mailbox: "shared", entryId: waiting.entryId, decision: "dismiss", hostScope: scope });
  assert.equal(result.outcome, "dismissed");
  assert.equal((await f.service.store.get(waiting.entryId, SOURCE, "shared"))!.status, "dismissed");
  assert.equal(f.calls.create.length, 0);
});


test("stored-key follow-up recovery survives a case-only rename with original account checks intact", async () => {
  const f = fixture();
  f.ctx.issues.requestWakeup = async () => { throw new Error("synthetic lost wake response"); };
  const routed = await f.service.route(input(), run); assert.equal(routed.wake, "requested_unknown");
  f.m.key = "Shared";
  f.ctx.issues.requestWakeup = async () => ({ queued: true, runId: null });
  const reads = f.calls.read, creates = f.calls.create.length;
  const retried = await f.service.resolve({ mailbox: "shared", entryId: routed.entryId, decision: "retry_followups", hostScope: scope });
  assert.equal(retried.outcome, "already_routed"); assert.equal(retried.wake, "requested");
  assert.equal(f.calls.read, reads); assert.equal(f.calls.create.length, creates);
  f.m.user = "different@example.com";
  await opened.db.execute(`UPDATE ${ROUTES} SET wake_state='requested_unknown' WHERE id=$1`, [routed.entryId]);
  const wake = f.calls.wake.length;
  const refused = await f.service.resolve({ mailbox: "shared", entryId: routed.entryId, decision: "retry_followups", hostScope: scope });
  assert.match(refused.followupError!, /Follow-ups could not complete/); assert.equal(f.calls.wake.length, wake);
});
