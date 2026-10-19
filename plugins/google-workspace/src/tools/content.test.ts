import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { OAuth2Client } from "google-auth-library";
import { registerDocsTools } from "./docs.js";
import { MAX_DOC_RESULT_BYTES, MAX_PAGE_PARAGRAPHS } from "./docs.js";
import { registerDriveContentTools } from "./drive-content.js";
import { registerDriveTools } from "./drive.js";
import { registerSheetsTools } from "./sheets.js";
import { ALL_TOOLS, DOCS_TOOLS, DRIVE_CONTENT_TOOLS } from "../schemas.js";
import { DEFAULT_SCOPES, type InstanceConfig } from "../googleAuth.js";
import manifest from "../manifest.js";
import { DEFAULT_FILE_BYTES, MAX_DOC_BYTES, MAX_FILE_BYTES } from "./content-api.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const run = { companyId, agentId: "synthetic-agent", runId: "synthetic-run" } as ToolRunContext;
function paragraph(start: number, text: string, style = "NORMAL_TEXT") {
  return { startIndex: start, endIndex: start + text.length, paragraph: { paragraphStyle: { namedStyleType: style, ...(style.startsWith("HEADING") ? { headingId: "example-heading" } : {}) }, elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text, textStyle: { bold: true } } }] } };
}
function tab(id = "t.0", text = "Hello world\n") {
  return { tabProperties: { tabId: id, title: "Example tab" }, documentTab: { body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }, paragraph(1, "Heading\n", "HEADING_1"), paragraph(9, text)] } } };
}
function document() { return { documentId: "doc-example", title: "Synthetic document", revisionId: "revision-example-1", suggestionsViewMode: "SUGGESTIONS_INLINE", tabs: [tab()] }; }
function meta(id = "file-example", mimeType = "text/plain", parents = ["folder-source"]) {
  return { id, name: "Synthetic file", mimeType, parents, version: "1", size: "11", trashed: false, capabilities: { canDownload: true } };
}
function json(value: unknown, headers: Record<string, string> = {}) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } }); }
type Handler = (p: unknown, run: ToolRunContext) => Promise<ToolResult>;
async function fixture(t: TestContext) {
  const key = `example-${randomUUID()}`;
  const cfg: InstanceConfig = { allowMutations: true, defaultAccount: key, accounts: [{ key, clientIdRef: "example-client-ref", clientSecretRef: "example-secret-ref", refreshTokenRef: "example-refresh-ref", allowedCompanies: [companyId] }] };
  const handlers = new Map<string, Handler>();
  const declarations = new Map<string, unknown>();
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const secrets: string[] = [];
  const audit: any[] = [];
  const docs: any = document();
  const files = new Map<string, any>([["file-example", meta()], ["doc-example", meta("doc-example", "application/vnd.google-apps.document")], ["folder-target", meta("folder-target", "application/vnd.google-apps.folder", [])]]);
  let bytes: Buffer = Buffer.from("Hello world");
  let respond: ((url: URL, init: RequestInit) => Promise<Response> | Response) | undefined;
  let auditFailure: "attempt" | "completed" | undefined;
  let resolveFailure = false;
  const ctx = {
    config: { get: async () => cfg },
    secrets: { resolve: async (ref: string) => { secrets.push(ref); if (resolveFailure) throw new Error("synthetic-private-provider-message"); return ref === "example-refresh-ref" ? "example-refresh-not-real" : `synthetic-${ref}`; } },
    tools: { register: (name: string, declaration: unknown, handler: Handler) => { assert.ok(!handlers.has(name)); declarations.set(name, declaration); handlers.set(name, handler); } },
    logger: { warn: () => {} },
    telemetry: { track: async () => {} },
    activity: { log: async (event: any) => { if (event.metadata.phase === auditFailure) throw new Error("synthetic-private-provider-message"); audit.push(event); } },
  } as unknown as PluginContext;
  t.mock.method(OAuth2Client.prototype, "getAccessToken", async function(this: OAuth2Client) {
    assert.equal(this.credentials.refresh_token, "example-refresh-not-real");
    return { token: "example-access-not-real" };
  });
  function defaultResponse(url: URL, init: RequestInit) {
    if (url.origin === "https://docs.googleapis.com") {
      if (init.method === "POST") {
        // Model Google's atomic required-revision check, not just preflight.
        if (JSON.parse(init.body as string).writeControl.requiredRevisionId !== docs.revisionId) return new Response(null, { status: 400 });
        docs.revisionId = `revision-example-${Number(docs.revisionId.split("-").at(-1)) + 1}`;
        return json({ documentId: "doc-example", writeControl: { requiredRevisionId: docs.revisionId } });
      }
      return json(docs);
    }
    const id = url.pathname.split("/")[4];
    if (url.searchParams.get("alt") === "media" || url.pathname.endsWith("/export")) return new Response(new Uint8Array(bytes));
    if (init.method === "PATCH") {
      const previous = files.get(id);
      const patch = JSON.parse(init.body as string);
      const updated = { ...previous, ...patch, version: String(Number(previous.version) + 1), ...(url.searchParams.has("addParents") ? { parents: [url.searchParams.get("addParents")] } : {}) };
      files.set(id, updated);
      return json(updated);
    }
    return json(files.get(id), { etag: '"example-etag"' });
  }
  t.mock.method(globalThis, "fetch", async (value: URL | string, init: RequestInit) => {
    const url = new URL(value);
    calls.push({ url, init });
    assert.equal((init.headers as any).Authorization, "Bearer example-access-not-real");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return respond ? respond(url, init) : defaultResponse(url, init);
  });
  registerDocsTools(ctx); registerDriveContentTools(ctx);
  const rawCall = (name: string, p: unknown, context = run) => handlers.get(name)!(p, context) as Promise<any>;
  const stored = new Map<string, any>();
  const host = { releases: 0, settles: 0, replays: 0 };
  // Matches the inspected host dispatcher: cache returned results, release on
  // thrown RPC errors, and bypass the store when writes is not true.
  async function dispatch(name: string, p: unknown) {
    if (!(declarations.get(name) as any).writes) return rawCall(name, p);
    const key = JSON.stringify([run, name, p]);
    if (stored.has(key)) { host.replays++; return stored.get(key); }
    let result;
    try { result = await rawCall(name, p); }
    catch (err) { host.releases++; throw err; }
    stored.set(key, result); host.settles++;
    return result;
  }
  return { cfg, ctx, key, calls, secrets, audit, docs, files, declarations, handlers, rawCall, dispatch, host, defaultResponse,
    call: async (name: string, p: unknown, context = run): Promise<any> => {
      try { return await rawCall(name, p, context); }
      catch (err) { return { error: (err as Error).message }; }
    },
    response: (fn: typeof respond) => { respond = fn; }, setBytes: (b: Buffer) => { bytes = b; }, failAudit: (phase: typeof auditFailure) => { auditFailure = phase; }, failSecrets: (fail = true) => { resolveFailure = fail; } };
}
const read = { documentId: "doc-example" };
const append = { ...read, text: "Example append", requiredRevisionId: "revision-example-1" };

test("Docs read uses exact REST ID, all tabs, access-appropriate suggestions and structured headings with bounded pages", async t => {
  const f = await fixture(t);
  f.docs.tabs[0].documentTab.body.content[2] = paragraph(9, "Hello \uD83D\uDE00 world\n");
  const first = await f.call("gdoc_read", { ...read, maxChars: 15 });
  assert.equal(first.error, undefined);
  assert.equal(first.data.text, "Heading\nHello ");
  assert.equal(first.data.nextOffset, 14);
  assert.equal(first.data.headings[0].style, "HEADING_1");
  assert.equal(first.data.headings[0].startIndex, 1);
  assert.equal(first.data.paragraphs[1].textStartIndex, 9);
  assert.equal(first.data.paragraphs[1].clipped, true);
  const second = await f.call("gdoc_read", { ...read, offset: first.data.nextOffset, requiredRevisionId: first.data.revisionId });
  assert.equal(second.data.text, "\uD83D\uDE00 world\n");
  assert.equal(second.data.complete, true);
  const request = f.calls[0];
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.body, undefined);
  assert.equal(request.url.origin + request.url.pathname, "https://docs.googleapis.com/v1/documents/doc-example");
  assert.equal(request.url.searchParams.get("includeTabsContent"), "true");
  assert.equal(request.url.searchParams.get("suggestionsViewMode"), "DEFAULT_FOR_CURRENT_ACCESS");
  assert.equal(first.data.suggestionsViewMode, "SUGGESTIONS_INLINE");
  assert.equal(f.audit.length, 0);
});

test("Docs exposes nested tab choices and refuses ambiguous or missing tabs for edits", async t => {
  const f = await fixture(t);
  f.docs.tabs[0].childTabs = [tab("t.synthetic-child", "Nested\n")];
  const list = await f.call("gdoc_read", read);
  assert.equal(list.data.requiresTabSelection, true);
  assert.equal(list.data.tabs[1].parentTabId, "t.0");
  assert.match((await f.call("gdoc_append_text", append)).error, /ETAB_REQUIRED/);
  assert.match((await f.call("gdoc_append_text", { ...append, tabId: "unknown" })).error, /ETAB_REQUIRED/);
  const nested = await f.call("gdoc_read", { ...read, tabId: "t.synthetic-child" });
  assert.equal(nested.data.text, "Heading\nNested\n");
  assert.equal(f.calls.filter(c => c.init.method !== "GET").length, 0);
});

test("viewer and commenter API snapshots page without editor revisions or additional Drive access", async t => {
  const f = await fixture(t);
  delete f.docs.revisionId;
  for (const mode of ["PREVIEW_WITHOUT_SUGGESTIONS", "SUGGESTIONS_INLINE"]) {
    f.docs.suggestionsViewMode = mode;
    f.response((url, init) => {
      assert.equal(url.origin, "https://docs.googleapis.com");
      if (mode === "PREVIEW_WITHOUT_SUGGESTIONS" && url.searchParams.get("suggestionsViewMode") === "SUGGESTIONS_INLINE") return new Response(null, { status: 403 });
      return f.defaultResponse(url, init);
    });
    const first = await f.call("gdoc_read", { ...read, maxChars: 10 });
    assert.equal(first.error, undefined);
    assert.equal(first.data.revisionId, null);
    assert.equal(first.data.suggestionsViewMode, mode);
    assert.match(first.data.readToken, /^[a-f0-9]{64}$/);
    const next = await f.call("gdoc_read", { ...read, offset: first.data.nextOffset, requiredReadToken: first.data.readToken });
    assert.equal(next.error, undefined);
    assert.equal(first.data.text + next.data.text, "Heading\nHello world\n");
    assert.equal(next.data.complete, true);
    const edit = await f.call("gdoc_append_text", append);
    assert.match(edit.error, /EEDIT_ACCESS.*editor access/);
  }
  assert.equal(f.calls.filter(c => c.init.method !== "GET").length, 0);
});

test("nonrevision snapshot tokens reject content, metadata and applied-view changes without returning mixed pages", async t => {
  const f = await fixture(t);
  delete f.docs.revisionId;
  f.docs.suggestionsViewMode = "PREVIEW_WITHOUT_SUGGESTIONS";
  const first = await f.call("gdoc_read", { ...read, maxChars: 5 });
  const later = { ...read, offset: first.data.nextOffset, requiredReadToken: first.data.readToken };
  for (const change of [
    () => { f.docs.tabs[0].documentTab.body.content[2] = paragraph(9, "Changed text\n"); },
    () => { f.docs.title = "Changed title"; },
    () => { f.docs.suggestionsViewMode = "SUGGESTIONS_INLINE"; },
    () => { f.docs.tabs[0].documentTab.body.content[2].startIndex++; },
    () => { f.docs.tabs[0].documentTab.body.content[2].endIndex++; },
    () => { f.docs.tabs[0].documentTab.body.content[2].paragraph.elements[0].startIndex++; },
    () => { f.docs.tabs[0].documentTab.body.content[2].paragraph.paragraphStyle.namedStyleType = "HEADING_2"; },
    () => { f.docs.tabs[0].documentTab.body.content[1].paragraph.paragraphStyle.headingId = "changed-heading"; },
    () => { f.docs.tabs[0].documentTab.body.content[2].paragraph.elements[0].suggestedInsertionIds = ["example-suggestion"]; },
    () => { f.docs.tabs[0].documentTab.body.content.push({ unknownElement: {} }); },
    () => { f.docs.tabs[0].tabProperties.title = "Changed tab"; },
    () => { f.docs.tabs[0].childTabs = [tab("t.child")]; },
    () => { f.docs.revisionId = "revision-example-2"; },
  ]) {
    const original = structuredClone(f.docs);
    change();
    const result = await f.call("gdoc_read", later);
    assert.match(result.error, /EREVISION_CONFLICT/);
    assert.equal(result.data, undefined);
    for (const key of Object.keys(f.docs)) delete f.docs[key];
    Object.assign(f.docs, original);
  }
  const reverseKeys = (value: any): any => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
  f.response(() => json(reverseKeys(f.docs)));
  assert.equal((await f.call("gdoc_read", later)).error, undefined);
  assert.match((await f.call("gdoc_read", { ...later, requiredReadToken: "bad" })).error, /EINVALID_INPUT/);
});

test("rotating image and chart URLs in the selected and other tabs do not interrupt visible-text pagination", async t => {
  const f = await fixture(t);
  delete f.docs.revisionId;
  f.docs.suggestionsViewMode = "PREVIEW_WITHOUT_SUGGESTIONS";
  let sequence = 0;
  f.response((url, init) => {
    assert.equal(url.origin, "https://docs.googleapis.com");
    assert.equal(init.method, "GET");
    for (const item of f.docs.tabs) {
      const embeddedObject = { imageProperties: { contentUri: `https://example.invalid/image?signature=${++sequence}` }, linkedContentReference: { sheetsChartReference: { spreadsheetId: "sheet-example", chartId: 1 } } };
      item.documentTab.inlineObjects = { image: { inlineObjectProperties: { embeddedObject } } };
      item.documentTab.positionedObjects = { chart: { positionedObjectProperties: { embeddedObject } } };
    }
    return json(f.docs);
  });
  for (const multipleTabs of [false, true]) {
    if (multipleTabs) f.docs.tabs.push(tab("t.other"));
    f.docs.tabs[0].documentTab.body.content.push({ startIndex: 21, endIndex: 23, paragraph: { elements: [
      { startIndex: 21, endIndex: 22, inlineObjectElement: { inlineObjectId: "image" } },
      { startIndex: 22, endIndex: 23, textRun: { content: "\n" } },
    ] } });
    const first = await f.call("gdoc_read", { ...read, tabId: "t.0", maxChars: 5 });
    assert.equal(first.error, undefined);
    let text = first.data.text, nextOffset = first.data.nextOffset;
    while (nextOffset !== null) {
      const next = await f.call("gdoc_read", { ...read, tabId: "t.0", offset: nextOffset, maxChars: 7, requiredReadToken: first.data.readToken });
      assert.equal(next.error, undefined);
      assert.equal(next.data.readToken, first.data.readToken);
      text += next.data.text;
      nextOffset = next.data.nextOffset;
    }
    assert.equal(text, "Heading\nHello world\n" + "\uFFFC\n".repeat(multipleTabs ? 2 : 1));
    if (multipleTabs) {
      const swapped = await f.call("gdoc_read", { ...read, tabId: "t.other", offset: 5, requiredReadToken: first.data.readToken });
      assert.match(swapped.error, /EREVISION_CONFLICT/);
      f.docs.tabs[1].documentTab.body.content[2] = paragraph(9, "Unrendered other tab text\n");
      assert.equal((await f.call("gdoc_read", { ...read, tabId: "t.0", offset: 5, requiredReadToken: first.data.readToken })).error, undefined);
    }
  }
  assert.ok(sequence > 10);
});

test("serialized Docs pages bound 5000 short paragraphs and headings without losing text or metadata", async t => {
  const f = await fixture(t);
  const content = Array.from({ length: 5000 }, (_item, i) => paragraph(1 + i * 2, "x\n", "HEADING_1"));
  f.docs.tabs[0].documentTab.body.content = content;
  let text = "", offset = 0, token: string | undefined, headings = 0;
  do {
    const result = await f.call("gdoc_read", { ...read, offset, ...(token ? { requiredReadToken: token } : {}) });
    assert.equal(result.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_DOC_RESULT_BYTES);
    assert.ok(result.data.paragraphs.length <= MAX_PAGE_PARAGRAPHS);
    assert.equal(result.data.paragraphs.map((p: any) => p.text).join(""), result.data.text);
    headings += result.data.headings.length;
    text += result.data.text;
    token = result.data.readToken;
    if (result.data.nextOffset === null) break;
    assert.ok(result.data.nextOffset > offset);
    offset = result.data.nextOffset;
  } while (offset <= 10000);
  assert.equal(text, "x\n".repeat(5000));
  assert.equal(headings, 5000);
});

test("giant paragraphs, escaping, table headings and Unicode page boundaries obey the entire JSON budget", async t => {
  const f = await fixture(t);
  const source = "\u0001\"\\\uD83D\uDE00".repeat(7000) + "\n";
  f.docs.tabs[0].documentTab.body.content = [paragraph(1, source, "HEADING_1"),
    { table: { tableRows: [{ tableCells: [{ content: [paragraph(source.length + 3, "Table heading\n", "HEADING_2")] }] }] } }];
  let text = "", offset = 0, token: string | undefined, clipped = false;
  for (let page = 0; page < 100; page++) {
    const result = await f.call("gdoc_read", { ...read, offset, maxChars: 20000, ...(token ? { requiredReadToken: token } : {}) });
    assert.equal(result.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_DOC_RESULT_BYTES);
    assert.equal(result.data.paragraphs.map((p: any) => p.text).join(""), result.data.text);
    assert.equal(result.data.headings.map((p: any) => p.text).join(""), result.data.text);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(result.data.text));
    clipped ||= result.data.headings.some((p: any) => p.clipped);
    text += result.data.text;
    token = result.data.readToken;
    if (result.data.nextOffset === null) break;
    assert.ok(result.data.nextOffset > offset);
    offset = result.data.nextOffset;
  }
  assert.equal(text, source + "Table heading\n");
  assert.equal(clipped, true);
  f.docs.title = "\u0001".repeat(MAX_DOC_RESULT_BYTES);
  const oversized = await f.call("gdoc_read", read);
  assert.match(oversized.error, /EREAD_LIMIT/);
  assert.equal(oversized.data, undefined);
  f.docs.tabs.push(tab("t.other"));
  assert.match((await f.call("gdoc_read", read)).error, /EREAD_LIMIT/);
});

test("Docs insert, append and exact replace send only bounded operations with revision control and selected tab", async t => {
  const f = await fixture(t);
  const insert = await f.call("gdoc_insert_text", { ...append, index: 9 });
  assert.equal(insert.data.documentId, "doc-example");
  assert.equal(insert.data.revisionId, "revision-example-2");
  let call = f.calls.at(-1)!;
  assert.equal(call.url.href, "https://docs.googleapis.com/v1/documents/doc-example:batchUpdate");
  assert.equal(call.init.method, "POST");
  assert.equal((call.init.headers as any)["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(call.init.body as string), { writeControl: { requiredRevisionId: "revision-example-1" }, requests: [{ insertText: { text: "Example append", location: { tabId: "t.0", index: 9 } } }] });
  assert.equal((await f.call("gdoc_append_text", { ...append, requiredRevisionId: f.docs.revisionId })).error, undefined);
  assert.deepEqual(JSON.parse(f.calls.at(-1)!.init.body as string).requests, [{ insertText: { text: "Example append", endOfSegmentLocation: { tabId: "t.0" } } }]);
  const replacement = await f.call("gdoc_replace_text", { ...append, requiredRevisionId: f.docs.revisionId, startIndex: 9, endIndex: 14, expectedText: "Hello", text: "Hi" });
  assert.equal(replacement.error, undefined);
  assert.deepEqual(JSON.parse(f.calls.at(-1)!.init.body as string).requests, [
    { deleteContentRange: { range: { tabId: "t.0", startIndex: 9, endIndex: 14 } } },
    { insertText: { text: "Hi", location: { tabId: "t.0", index: 9 } } },
  ]);
  assert.equal(f.audit.length, 6);
  assert.deepEqual(f.audit.map(e => e.metadata.phase), ["attempt", "completed", "attempt", "completed", "attempt", "completed"]);
  assert.ok(!JSON.stringify(f.audit).includes("Example append"));
  assert.ok(!JSON.stringify(f.audit).includes("Hello"));
});

test("Docs rejects stale revisions, missing revision, mismatched text, paragraph deletion, structural indices and surrogate splits without a write", async t => {
  const f = await fixture(t);
  for (const p of [{ ...append, requiredRevisionId: "stale" }, { ...append, requiredRevisionId: undefined }]) assert.ok((await f.call("gdoc_append_text", p)).error);
  const replacements = [
    { startIndex: 9, endIndex: 14, expectedText: "Wrong" },
    { startIndex: 9, endIndex: 21, expectedText: "Hello world\n" },
    { startIndex: 9, endIndex: 10, expectedText: "Hello" },
  ];
  for (const p of replacements) assert.ok((await f.call("gdoc_replace_text", { ...append, ...p })).error);
  assert.ok((await f.call("gdoc_insert_text", { ...append, index: 0 })).error);
  f.docs.tabs[0].documentTab.body.content[2] = paragraph(9, "\uD83D\uDE00\n");
  assert.ok((await f.call("gdoc_insert_text", { ...append, index: 10 })).error);
  assert.ok((await f.call("gdoc_replace_text", { ...append, startIndex: 9, endIndex: 10, expectedText: "\uD83D" })).error);
  assert.ok((await f.call("gdoc_read", { ...read, offset: 9, requiredRevisionId: "revision-example-1" })).error);
  assert.equal(f.calls.filter(c => c.init.method !== "GET").length, 0);
});

test("Docs reads tables and marks images and generated table of contents text as not editable", async t => {
  const f = await fixture(t);
  f.docs.tabs[0].documentTab.body.content.push(
    { startIndex: 21, endIndex: 40, table: { tableRows: [{ tableCells: [{ content: [paragraph(24, "Cell\n", "HEADING_2")] }] }] } },
    { startIndex: 40, endIndex: 50, tableOfContents: { content: [paragraph(42, "TOC\n")] } },
    { startIndex: 50, endIndex: 52, paragraph: { elements: [{ startIndex: 50, endIndex: 51, inlineObjectElement: { inlineObjectId: "image-example" } }, { startIndex: 51, endIndex: 52, textRun: { content: "\n" } }] } },
  );
  const result = await f.call("gdoc_read", read);
  assert.ok(result.data.text.includes("Cell\nTOC\n\uFFFC\n"));
  assert.equal(result.data.headings[1].style, "HEADING_2");
  assert.equal(result.data.unsupportedElements, 1);
  for (const index of [21, 42, 50]) assert.ok((await f.call("gdoc_insert_text", { ...append, index })).error);
  assert.equal((await f.call("gdoc_insert_text", { ...append, index: 24 })).error, undefined);
});

test("Docs flags suggestions and refuses edits, wrong document responses and malformed JSON", async t => {
  const f = await fixture(t);
  f.docs.tabs[0].documentTab.body.content[2].paragraph.elements[0].suggestedInsertionIds = ["suggestion-example"];
  assert.equal((await f.call("gdoc_read", read)).data.hasSuggestions, true);
  assert.match((await f.call("gdoc_append_text", append)).error, /EUNSUPPORTED_EDIT/);
  f.docs.documentId = "different-doc";
  assert.match((await f.call("gdoc_read", read)).error, /EGOOGLE_FORMAT/);
  f.response(() => new Response("synthetic-private-provider-message"));
  const failed = await f.call("gdoc_read", read);
  assert.match(failed.error, /EGOOGLE_FORMAT/);
  assert.ok(!failed.error.includes("private"));
});

test("all new tools deny absent, empty, malformed and foreign company allowlists before secrets or HTTP, including wildcard without company", async t => {
  const f = await fixture(t);
  const args: Record<string, unknown> = {
    gdoc_read: read, gdoc_append_text: append, gdoc_insert_text: { ...append, index: 9 },
    gdoc_replace_text: { ...append, startIndex: 9, endIndex: 14, expectedText: "Hello" },
    gdrive_read_file: { fileId: "file-example" }, gdrive_rename_file: { fileId: "file-example", name: "Renamed" },
    gdrive_move_file: { fileId: "file-example", destinationFolderId: "folder-target", expectedParentId: "folder-source" },
  };
  for (const allowed of [undefined, [], [otherCompanyId], "*", ["*", 7]]) {
    f.cfg.accounts![0].allowedCompanies = allowed as any;
    for (const [name, p] of Object.entries(args)) assert.match((await f.call(name, p)).error, /ECOMPANY_NOT_ALLOWED/);
  }
  f.cfg.accounts![0].allowedCompanies = ["*"];
  assert.match((await f.call("gdoc_read", read, { ...run, companyId: "" })).error, /ECOMPANY_NOT_ALLOWED/);
  assert.equal(f.secrets.length, 0);
  assert.equal(f.calls.length, 0);
});

test("mutations default off and broker declarations classify only writes as change_files", async t => {
  const f = await fixture(t);
  f.cfg.allowMutations = false;
  assert.match((await f.call("gdoc_append_text", append)).error, /EMUTATIONS_DISABLED/);
  assert.match((await f.call("gdrive_rename_file", { fileId: "file-example", name: "Renamed" })).error, /EMUTATIONS_DISABLED/);
  assert.match((await f.call("gdrive_move_file", { fileId: "file-example", expectedParentId: "folder-source", destinationFolderId: "folder-target" })).error, /EMUTATIONS_DISABLED/);
  assert.equal(f.secrets.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call("gdoc_read", read)).error, undefined);
  for (const tool of [...DOCS_TOOLS, ...DRIVE_CONTENT_TOOLS]) {
    assert.deepEqual(manifest.tools!.find(t => t.name === tool.name), tool);
    const mutation = !["gdoc_read", "gdrive_read_file"].includes(tool.name);
    assert.equal(tool.actionType, mutation ? "change_files" : undefined);
    assert.equal(tool.writes, mutation ? undefined : false);
    assert.equal(tool.parametersSchema.additionalProperties, false);
    assert.equal(tool.executionTimeoutMs, 30000);
  }
  assert.ok(!ALL_TOOLS.some(t => /g(drive|doc)_.*(delete|trash|batch)/.test(t.name)));
  assert.equal(DEFAULT_SCOPES.some(s => s.endsWith("/documents")), false);
});

test("unknown and duplicate accounts, missing credential references and secret failures fail closed and sanitize messages", async t => {
  const f = await fixture(t);
  assert.match((await f.call("gdoc_read", { ...read, account: "unknown" })).error, /EACCOUNT_REQUIRED/);
  f.cfg.accounts!.push({ ...f.cfg.accounts![0], key: f.key.toUpperCase() });
  assert.match((await f.call("gdoc_read", read)).error, /EACCOUNT_REQUIRED/);
  f.cfg.accounts!.pop();
  const original = f.cfg.accounts![0].refreshTokenRef;
  delete f.cfg.accounts![0].refreshTokenRef;
  assert.match((await f.call("gdoc_read", read)).error, /ECONFIG/);
  assert.equal(f.secrets.length, 0);
  f.cfg.accounts![0].refreshTokenRef = original;
  f.failSecrets();
  const result = await f.call("gdoc_read", read);
  assert.match(result.error, /ECONFIG/);
  assert.ok(!JSON.stringify(result).includes("private-provider"));
  assert.equal(f.calls.length, 0);
});

test("credential cache stays account/company scoped and current allowlists are checked on every request", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("gdoc_read", read)).error, undefined);
  assert.equal(f.secrets.length, 3);
  f.cfg.accounts![0].allowedCompanies = [otherCompanyId];
  assert.match((await f.call("gdoc_read", read)).error, /ECOMPANY_NOT_ALLOWED/);
  assert.equal(f.secrets.length, 3);
  f.cfg.accounts![0].allowedCompanies = [companyId, otherCompanyId];
  assert.equal((await f.call("gdoc_read", read, { ...run, companyId: otherCompanyId })).error, undefined);
  assert.equal(f.secrets.length, 6);
  f.cfg.accounts!.push({ ...f.cfg.accounts![0], key: "other-account", refreshTokenRef: "changed-ref" });
  // A different credential cannot use the first account's cached OAuth client.
  assert.match((await f.call("gdoc_read", { ...read, account: "other-account" })).error, /EGOOGLE_UNAVAILABLE/);
  assert.equal(f.secrets.length, 9);
});

test("revocation, credential changes and disabled mutation switch between preflight and write stop the write", async t => {
  const f = await fixture(t);
  for (const change of [
    () => { f.cfg.accounts![0].allowedCompanies = []; },
    () => { f.cfg.accounts![0].refreshTokenRef = "changed-ref"; },
    () => { f.cfg.allowMutations = false; },
  ]) {
    f.cfg.accounts![0].allowedCompanies = [companyId];
    f.cfg.accounts![0].refreshTokenRef = "example-refresh-ref";
    f.cfg.allowMutations = true;
    f.response(() => { change(); return json(f.docs); });
    assert.ok((await f.call("gdoc_append_text", append)).error);
  }
  assert.equal(f.calls.filter(c => c.init.method !== "GET").length, 0);
});

test("new tools refuse URLs, injected fields, fractional bounds and silently stripped text before credentials", async t => {
  const f = await fixture(t);
  const invalidReads = [{ documentId: "https://docs.google.com/document/d/example" }, { documentId: "../other" }, { ...read, requests: [{ deleteContentRange: {} }] }, { ...read, maxChars: 1.5 }, { ...read, offset: 1 }, { ...read, account: 2 }];
  for (const p of invalidReads) assert.match((await f.call("gdoc_read", p)).error, /EINVALID_INPUT/);
  for (const text of ["", "\u0000", "\uE000", "\uD800", "x".repeat(20001)]) assert.match((await f.call("gdoc_append_text", { ...append, text })).error, /EINVALID_INPUT/);
  assert.match((await f.call("gdrive_rename_file", { fileId: "file-example", name: "Rename", parents: [] })).error, /EINVALID_INPUT/);
  assert.equal(f.secrets.length, 0);
  assert.equal(f.calls.length, 0);
});

test("Drive text read uses media, returns exact ID and paginates with pinned versions", async t => {
  const f = await fixture(t);
  const first = await f.call("gdrive_read_file", { fileId: "file-example", maxChars: 5 });
  assert.equal(first.data.content, "Hello");
  assert.equal(first.data.fileId, "file-example");
  assert.equal(first.data.nextOffset, 5);
  assert.equal(first.data.complete, false);
  assert.equal(f.calls[1].url.href, "https://www.googleapis.com/drive/v3/files/file-example?alt=media&supportsAllDrives=true");
  assert.equal(f.calls.length, 3);
  const second = await f.call("gdrive_read_file", { fileId: "file-example", offset: 5, requiredVersion: "1" });
  assert.equal(second.data.content, " world");
  assert.equal(second.data.complete, true);
  f.files.get("file-example").version = "2";
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example", offset: 5, requiredVersion: "1" })).error, /EREVISION_CONFLICT/);
});

test("Drive binary stays base64; UTF-8 decoding never silently replaces invalid bytes", async t => {
  const f = await fixture(t);
  f.setBytes(Buffer.from([0, 255, 128, 1]));
  f.files.get("file-example").mimeType = "application/pdf";
  const binary = await f.call("gdrive_read_file", { fileId: "file-example" });
  assert.equal(binary.data.encoding, "base64");
  assert.deepEqual(Buffer.from(binary.data.content, "base64"), Buffer.from([0, 255, 128, 1]));
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example", encoding: "text" })).error, /EUNSUPPORTED_ENCODING/);
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example", encoding: "base64", offset: 1, requiredVersion: "1" })).error, /EINVALID_INPUT/);
});

test("binary default is 32 KiB with a small serialized result and larger reads require explicit opt-in", async t => {
  const f = await fixture(t);
  const file = f.files.get("file-example");
  file.mimeType = "application/pdf";
  file.size = String(DEFAULT_FILE_BYTES);
  f.setBytes(Buffer.alloc(DEFAULT_FILE_BYTES, 255));
  const result = await f.call("gdrive_read_file", { fileId: "file-example" });
  assert.equal(result.error, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 45000);
  assert.equal(Buffer.from(result.data.content, "base64").length, DEFAULT_FILE_BYTES);
  file.size = String(DEFAULT_FILE_BYTES + 1);
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example" })).error, /EREAD_LIMIT/);
  file.size = String(MAX_FILE_BYTES);
  f.setBytes(Buffer.alloc(MAX_FILE_BYTES, 255));
  const optIn = await f.call("gdrive_read_file", { fileId: "file-example", maxBytes: MAX_FILE_BYTES });
  assert.equal(optIn.error, undefined);
  assert.equal(Buffer.from(optIn.data.content, "base64").length, MAX_FILE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(optIn)) < 1400000);
});

test("native files export only supported formats and explicit Sheets exports warn first-sheet-only", async t => {
  const f = await fixture(t);
  const doc = await f.call("gdrive_read_file", { fileId: "doc-example" });
  assert.equal(doc.data.mimeType, "text/plain");
  assert.equal(f.calls[1].url.href, "https://www.googleapis.com/drive/v3/files/doc-example/export?mimeType=text%2Fplain");
  f.files.set("sheet-example", meta("sheet-example", "application/vnd.google-apps.spreadsheet"));
  assert.match((await f.call("gdrive_read_file", { fileId: "sheet-example" })).error, /EUNSUPPORTED_FORMAT/);
  const sheet = await f.call("gdrive_read_file", { fileId: "sheet-example", exportMimeType: "text/csv" });
  assert.match(sheet.data.scope, /First sheet only/);
  assert.equal(f.calls.at(-2)!.url.searchParams.get("mimeType"), "text/csv");
  assert.match((await f.call("gdrive_read_file", { fileId: "doc-example", exportMimeType: "text/csv" })).error, /EUNSUPPORTED_FORMAT/);
  for (const mime of ["application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut", "application/vnd.google-apps.form"]) {
    f.files.get("file-example").mimeType = mime;
    const count = f.calls.length;
    assert.match((await f.call("gdrive_read_file", { fileId: "file-example" })).error, /EUNSUPPORTED_FORMAT/);
    assert.equal(f.calls.length, count + 1);
  }
});

test("Drive read refuses download denial, trash, changed versions and oversized metadata without returning partial content", async t => {
  const f = await fixture(t);
  const m = f.files.get("file-example");
  m.capabilities.canDownload = false;
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example" })).error, /EGOOGLE_FORBIDDEN/);
  m.capabilities.canDownload = true;
  m.trashed = true;
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example" })).error, /EGOOGLE_FORMAT/);
  m.trashed = false; m.size = String(MAX_FILE_BYTES + 1);
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example" })).error, /EREAD_LIMIT/);
  assert.ok(!f.calls.some(c => c.url.searchParams.has("alt")));
  m.size = "11";
  let reads = 0;
  f.response(url => url.searchParams.has("alt") ? new Response("private-example-text") : json({ ...m, version: String(++reads) }));
  const changed = await f.call("gdrive_read_file", { fileId: "file-example" });
  assert.match(changed.error, /EREVISION_CONFLICT/);
  assert.equal(changed.data, undefined);
  assert.ok(!JSON.stringify(changed).includes("private-example-text"));
});

test("streaming caps actual bytes even without or with false Content-Length and cancels oversized bodies", async t => {
  const f = await fixture(t);
  let cancelled = 0;
  for (const declared of [undefined, "1", String(MAX_DOC_BYTES + 1)]) {
    f.response(() => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_DOC_BYTES + 1)); },
      cancel() { cancelled++; },
    }), { headers: declared ? { "content-length": declared } : {} }));
    const failed = await f.call("gdoc_read", read);
    assert.match(failed.error, /EREAD_LIMIT/);
    assert.equal(failed.data, undefined);
  }
  assert.equal(cancelled, 3);
  f.response(url => url.searchParams.has("alt") ? new Response(new Uint8Array(20)) : json(meta()));
  assert.match((await f.call("gdrive_read_file", { fileId: "file-example", maxBytes: 15 })).error, /EREAD_LIMIT/);
});

test("rename PATCH contains name only, uses exact ID and documented preflight version checks without conditional headers", async t => {
  const f = await fixture(t);
  const result = await f.call("gdrive_rename_file", { fileId: "file-example", name: "Renamed example" });
  assert.equal(result.error, undefined);
  assert.equal(result.data.fileId, "file-example");
  assert.equal(f.calls.length, 3);
  const call = f.calls[2];
  assert.equal(call.init.method, "PATCH");
  assert.equal(call.url.origin + call.url.pathname, "https://www.googleapis.com/drive/v3/files/file-example");
  assert.deepEqual(JSON.parse(call.init.body as string), { name: "Renamed example" });
  assert.equal(call.url.searchParams.has("removeParents"), false);
  assert.equal(call.url.searchParams.has("addParents"), false);
  assert.equal((call.init.headers as any)["If-Match"], undefined);
});

test("move validates destination, removes only explicit source, adds destination in the same PATCH and preserves ID", async t => {
  const f = await fixture(t);
  const result = await f.call("gdrive_move_file", { fileId: "file-example", expectedParentId: "folder-source", destinationFolderId: "folder-target" });
  assert.equal(result.error, undefined);
  assert.equal(result.data.fileId, "file-example");
  assert.deepEqual(result.data.parents, ["folder-target"]);
  assert.equal(f.calls.length, 4);
  const call = f.calls[3];
  assert.equal(call.init.method, "PATCH");
  assert.equal(call.url.searchParams.get("addParents"), "folder-target");
  assert.equal(call.url.searchParams.get("removeParents"), "folder-source");
  assert.deepEqual(JSON.parse(call.init.body as string), {});
  const again = await f.call("gdrive_move_file", { fileId: "file-example", expectedParentId: "folder-source", destinationFolderId: "folder-target" });
  assert.equal(again.data.unchanged, true);
  assert.equal(f.calls.filter(c => c.init.method === "PATCH").length, 1);
});

test("move refuses absent, multiple, mismatched parents, invalid destination, self and folder trees before patching", async t => {
  const f = await fixture(t);
  const p = { fileId: "file-example", expectedParentId: "folder-source", destinationFolderId: "folder-target" };
  for (const parents of [undefined, [], ["other"], ["folder-source", "other"]]) {
    f.files.get("file-example").parents = parents;
    assert.match((await f.call("gdrive_move_file", p)).error, /EPARENT_MISMATCH/);
  }
  f.files.get("file-example").parents = ["folder-source"];
  f.files.get("folder-target").mimeType = "text/plain";
  assert.match((await f.call("gdrive_move_file", p)).error, /EINVALID_INPUT/);
  f.files.get("folder-target").mimeType = "application/vnd.google-apps.folder";
  f.files.get("folder-target").trashed = true;
  assert.ok((await f.call("gdrive_move_file", p)).error);
  f.files.get("file-example").mimeType = "application/vnd.google-apps.folder";
  assert.match((await f.call("gdrive_move_file", p)).error, /EUNSUPPORTED_MOVE/);
  assert.match((await f.call("gdrive_move_file", { ...p, destinationFolderId: "file-example" })).error, /EINVALID_INPUT/);
  assert.equal(f.calls.filter(c => c.init.method === "PATCH").length, 0);
});

test("host repeat rules let rename A/B/A and move out/back/out execute while retaining change_files approval metadata", async t => {
  const f = await fixture(t);
  f.files.set("folder-source", meta("folder-source", "application/vnd.google-apps.folder", []));
  for (const name of ["A", "B", "A"]) {
    const result = await f.dispatch("gdrive_rename_file", { fileId: "file-example", name });
    assert.equal(result.error, undefined);
    assert.equal(f.files.get("file-example").name, name);
  }
  for (const [source, destination] of [["folder-source", "folder-target"], ["folder-target", "folder-source"], ["folder-source", "folder-target"]]) {
    const result = await f.dispatch("gdrive_move_file", { fileId: "file-example", expectedParentId: source, destinationFolderId: destination });
    assert.equal(result.error, undefined);
    assert.deepEqual(f.files.get("file-example").parents, [destination]);
  }
  assert.equal(f.calls.filter(c => c.init.method === "PATCH").length, 6);
  assert.equal(f.host.replays, 0);
  for (const name of ["gdrive_rename_file", "gdrive_move_file"]) {
    assert.equal((f.declarations.get(name) as any).actionType, "change_files");
    assert.notEqual((f.declarations.get(name) as any).writes, true);
  }
});

test("Drive writes refuse absent or changed preflight versions and leave a documented GET/PATCH race window", async t => {
  const f = await fixture(t);
  for (const tool of ["gdrive_rename_file", "gdrive_move_file"]) {
    const params = tool === "gdrive_rename_file" ? { fileId: "file-example", name: "A" }
      : { fileId: "file-example", expectedParentId: "folder-source", destinationFolderId: "folder-target" };
    for (const initial of [undefined, "1"]) {
      f.files.get("file-example").version = initial;
      let seen = 0;
      f.response((url, init) => {
        if (url.pathname.endsWith("/file-example") && ++seen === 2) f.files.get("file-example").version = "2";
        return f.defaultResponse(url, init);
      });
      const result = await f.call(tool, params);
      assert.match(result.error, /EREVISION_CONFLICT/);
    }
  }
  assert.equal(f.calls.filter(c => c.init.method === "PATCH").length, 0);
});

test("Docs pre-send credentials, rate limit, activity failure and mutation switch can retry unchanged arguments and revision", async t => {
  const f = await fixture(t);
  for (const failure of ["credentials", "rate-limit", "activity", "mutation-switch"] as const) {
    const params = { ...append, requiredRevisionId: f.docs.revisionId, text: `Synthetic ${failure}` };
    if (failure === "rate-limit") f.response(() => new Response(null, { status: 429 }));
    if (failure === "credentials") f.failSecrets();
    if (failure === "activity") f.failAudit("attempt");
    if (failure === "mutation-switch") f.cfg.allowMutations = false;
    const count = f.calls.filter(c => c.init.method === "POST").length;
    await assert.rejects(f.dispatch("gdoc_append_text", params), /ECONFIG|EGOOGLE_RATE_LIMIT|EAUDIT_UNAVAILABLE|EMUTATIONS_DISABLED/);
    assert.equal(f.calls.filter(c => c.init.method === "POST").length, count);
    f.response(undefined); f.failAudit(undefined); f.failSecrets(false); f.cfg.allowMutations = true;
    assert.equal((await f.dispatch("gdoc_append_text", params)).error, undefined);
    assert.equal(f.calls.filter(c => c.init.method === "POST").length, count + 1);
    await assert.rejects(f.dispatch("gdoc_append_text", params), /EREVISION_CONFLICT/);
    assert.equal(f.calls.filter(c => c.init.method === "POST").length, count + 1);
  }
  assert.deepEqual(f.host, { releases: 0, settles: 0, replays: 0 });
});

test("Docs authentication timeout immediately before send dispatches nothing and permits the same edit", async t => {
  const f = await fixture(t);
  let tokens = 0;
  const tokenMock = t.mock.method(OAuth2Client.prototype, "getAccessToken", async () => {
    if (++tokens === 2) return new Promise<never>(() => {});
    return { token: "example-access-not-real" };
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.dispatch("gdoc_append_text", append);
  const rejected = assert.rejects(pending, /EGOOGLE_TIMEOUT.*No file request was made/);
  // Let the GET finish and enter the mutation token wait before ticking.
  for (let turn = 0; turn < 20 && tokens < 2; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(tokens, 2);
  t.mock.timers.tick(10001);
  await rejected;
  t.mock.timers.reset(); tokenMock.mock.restore();
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 0);
  assert.equal((await f.dispatch("gdoc_append_text", append)).error, undefined);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 1);
  assert.deepEqual(f.host, { releases: 0, settles: 0, replays: 0 });
});

test("uncertain unapplied Docs network failure is visible, sanitized and retryable with the same revision", async t => {
  const f = await fixture(t);
  f.response((url, init) => {
    if (init.method === "POST") throw new Error("synthetic-private-provider-message");
    return f.defaultResponse(url, init);
  });
  const result = await f.dispatch("gdoc_append_text", append);
  assert.match(result.error, /Verify the remote result before retrying a write/);
  assert.ok(!result.error.includes("private-provider"));
  f.response(undefined);
  assert.equal((await f.dispatch("gdoc_append_text", append)).error, undefined);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 2);
  await assert.rejects(f.dispatch("gdoc_append_text", append), /EREVISION_CONFLICT/);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 2);
  assert.deepEqual(f.host, { releases: 0, settles: 0, replays: 0 });
});

test("Docs 503, 429 and read-only-grant 403 POST failures allow exactly one new dispatch after recovery", async t => {
  const f = await fixture(t);
  for (const tool of DOCS_TOOLS.filter(tool => tool.actionType === "change_files")) {
    assert.equal((f.declarations.get(tool.name) as any).actionType, "change_files");
    assert.equal((f.declarations.get(tool.name) as any).writes, undefined);
    for (const status of [503, 429, 403]) {
      const params = { ...append, requiredRevisionId: f.docs.revisionId,
        ...(tool.name === "gdoc_insert_text" ? { index: 9 } : tool.name === "gdoc_replace_text" ? { startIndex: 9, endIndex: 14, expectedText: "Hello" } : {}) };
      const before = f.calls.filter(c => c.init.method === "POST").length;
      f.response((url, init) => init.method === "POST" ? new Response("synthetic-private-provider-message", { status }) : f.defaultResponse(url, init));
      const failure = await f.dispatch(tool.name, params);
      assert.match(failure.error, /EGOOGLE_UNAVAILABLE|EGOOGLE_RATE_LIMIT|EGOOGLE_FORBIDDEN/);
      assert.ok(!failure.error.includes("private-provider"));
      assert.equal(f.calls.filter(c => c.init.method === "POST").length, before + 1);
      const unchanged = await f.call("gdoc_read", read);
      assert.equal(unchanged.data.revisionId, params.requiredRevisionId);
      f.response(undefined);
      assert.equal((await f.dispatch(tool.name, params)).error, undefined);
      assert.equal(f.calls.filter(c => c.init.method === "POST").length, before + 2);
      await assert.rejects(f.dispatch(tool.name, params), /EREVISION_CONFLICT/);
      assert.equal(f.calls.filter(c => c.init.method === "POST").length, before + 2);
    }
  }
  assert.deepEqual(f.host, { releases: 0, settles: 0, replays: 0 });
});

test("an applied Docs edit with a lost reply refuses identical retry, even when a stale GET reaches Google's revision check", async t => {
  const f = await fixture(t);
  const before = structuredClone(f.docs);
  let applied = 0;
  f.response((url, init) => {
    if (init.method === "POST") {
      f.defaultResponse(url, init); applied++;
      throw new Error("synthetic-private-provider-message");
    }
    return f.defaultResponse(url, init);
  });
  const failure = await f.dispatch("gdoc_append_text", append);
  assert.match(failure.error, /Verify the remote result before retrying/);
  f.response(undefined);
  assert.notEqual((await f.call("gdoc_read", read)).data.revisionId, append.requiredRevisionId);
  await assert.rejects(f.dispatch("gdoc_append_text", append), /EREVISION_CONFLICT/);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 1);
  f.response((url, init) => init.method === "GET" ? json(before) : f.defaultResponse(url, init));
  assert.match((await f.dispatch("gdoc_append_text", append)).error, /EGOOGLE_BAD_REQUEST/);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 2);
  assert.equal(f.docs.revisionId, "revision-example-2");
  assert.equal(applied, 1);
  assert.deepEqual(f.host, { releases: 0, settles: 0, replays: 0 });
});

test("concurrent identical Docs edits pass preflight together but Google's atomic revision check applies only one", async t => {
  const f = await fixture(t);
  let gets = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  f.response(async (url, init) => {
    if (init.method === "GET") {
      const snapshot = structuredClone(f.docs);
      if (++gets === 2) release();
      await ready;
      return json(snapshot);
    }
    return f.defaultResponse(url, init);
  });
  const results = await Promise.all([f.dispatch("gdoc_append_text", append), f.dispatch("gdoc_append_text", append)]);
  assert.equal(results.filter(result => result.data?.revisionId === "revision-example-2").length, 1);
  assert.equal(results.filter(result => /EGOOGLE_BAD_REQUEST/.test(result.error)).length, 1);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 2);
  assert.equal(f.docs.revisionId, "revision-example-2");
  assert.deepEqual(f.host, { releases: 0, settles: 0, replays: 0 });
});

test("provider status, network, redirects and credential errors never expose private response details or retry a mutation", async t => {
  const f = await fixture(t);
  for (const status of [400, 401, 403, 404, 409, 412, 429, 500, 302]) {
    f.response(() => new Response("synthetic-private-provider-message", { status }));
    const count = f.calls.length;
    const failed = await f.call("gdoc_read", read);
    assert.ok(failed.error);
    assert.ok(!failed.error.includes("private-provider"));
    assert.equal(f.calls.length, count + 1);
  }
  f.response((_url, init) => init.method === "POST" ? new Response("synthetic-private-provider-message", { status: 400 }) : json(f.docs));
  assert.match((await f.call("gdoc_append_text", append)).error, /EGOOGLE_BAD_REQUEST/);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 1);
  f.response(() => { throw new Error("synthetic-private-provider-message Authorization: example-access-not-real"); });
  const failed = await f.call("gdoc_read", read);
  assert.match(failed.error, /EGOOGLE_UNAVAILABLE/);
  assert.ok(!failed.error.includes("example-access"));
});

test("write attempt audit is required; completion-log failure returns success with do-not-repeat warning", async t => {
  const f = await fixture(t);
  f.failAudit("attempt");
  assert.match((await f.call("gdoc_append_text", append)).error, /EAUDIT_UNAVAILABLE/);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 0);
  f.failAudit("completed");
  const completed = await f.call("gdoc_append_text", append);
  assert.equal(completed.error, undefined);
  assert.match(completed.data.warning, /Do not repeat/);
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 1);
});

test("a write followed by revoked access, oversized response or wrong document ID never reports confirmed success or invites automatic retry", async t => {
  const f = await fixture(t);
  for (const failure of ["revoke", "oversize", "wrong-id", "stream-failure"] as const) {
    f.cfg.accounts![0].allowedCompanies = [companyId];
    f.response((_url, init) => {
      if (init.method !== "POST") return json(f.docs);
      if (failure === "revoke") {
        f.cfg.accounts![0].allowedCompanies = [];
        return json({ documentId: "doc-example" });
      }
      if (failure === "oversize") return new Response("", { headers: { "content-length": String(MAX_DOC_BYTES + 1) } });
      if (failure === "stream-failure") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("synthetic-private-provider-message")); } }));
      return json({ documentId: "different-document" });
    });
    const failed = await f.call("gdoc_append_text", append);
    assert.match(failed.error, /Verify the remote result before retrying/);
    assert.equal(failed.data, undefined);
    assert.ok(!failed.error.includes("private-provider"));
  }
  assert.equal(f.calls.filter(c => c.init.method === "POST").length, 4);
});

test("empty and rejected access tokens fail before any file HTTP request and redact provider errors", async t => {
  const f = await fixture(t);
  t.mock.method(OAuth2Client.prototype, "getAccessToken", async () => ({ token: null }));
  assert.match((await f.call("gdoc_read", read)).error, /EGOOGLE_AUTH/);
  t.mock.method(OAuth2Client.prototype, "getAccessToken", async () => { throw new Error("synthetic-private-provider-message"); });
  const failed = await f.call("gdoc_read", read);
  assert.match(failed.error, /EGOOGLE_UNAVAILABLE/);
  assert.ok(!failed.error.includes("private-provider"));
  assert.equal(f.calls.length, 0);
});

test("existing Drive and Sheets tools retain schemas, pagination, reads, updates and mutation switch", async t => {
  const f = await fixture(t);
  registerDriveTools(f.ctx); registerSheetsTools(f.ctx);
  const legacyCalls: any[] = [];
  t.mock.method(OAuth2Client.prototype, "request", async (options: any) => {
    legacyCalls.push(options);
    if (options.url.includes("/drive/v3/files")) return { data: { files: [meta()], nextPageToken: "example-page-2" } };
    if (options.method === "PUT") return { data: { updatedRange: "Sheet1!A1", updatedCells: 1 } };
    return { data: { range: "Sheet1!A1", values: [["synthetic cell"]] } };
  });
  const listing = await f.call("gdrive_list_folder", { folderId: "folder-source", pageToken: "example-page-1", pageSize: 2 });
  assert.equal(listing.data.nextPageToken, "example-page-2");
  assert.equal(legacyCalls[0].params.pageToken, "example-page-1");
  assert.equal(legacyCalls[0].params.pageSize, 2);
  const cells = await f.call("gsheet_read", { spreadsheetId: "sheet-example", range: "Sheet1!A1" });
  assert.deepEqual(cells.data.values, [["synthetic cell"]]);
  assert.equal(legacyCalls[1].url, "https://sheets.googleapis.com/v4/spreadsheets/sheet-example/values/Sheet1%21A1");
  const update = await f.call("gsheet_update", { spreadsheetId: "sheet-example", range: "Sheet1!A1", values: [["new cell"]], valueInputOption: "RAW" });
  assert.equal(update.data.updatedCells, 1);
  assert.equal(legacyCalls[2].method, "PUT");
  assert.deepEqual(legacyCalls[2].data, { values: [["new cell"]] });
  f.cfg.allowMutations = false;
  assert.match((await f.call("gsheet_update", { spreadsheetId: "sheet-example", range: "Sheet1!A1", values: [["new cell"]] })).error, /EMUTATIONS_DISABLED/);
  assert.equal(legacyCalls.length, 3);
  for (const tool of ALL_TOOLS.filter(t => /^(gsheet_|gdrive_)/.test(t.name))) assert.ok(f.handlers.has(tool.name));
});

test("isolated synthetic HTTP host dispatches a read and revision-protected edit without cloud or live-host access", async t => {
  const f = await fixture(t);
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/tools") { res.writeHead(404).end(); return; }
      let body = ""; for await (const chunk of req) body += chunk;
      const { tool, parameters } = JSON.parse(body);
      const result = await f.call(tool, parameters);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
    } catch { res.writeHead(500).end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  // The loopback client uses node:http, keeping all Google fetches mocked.
  const { request } = await import("node:http");
  async function post(tool: string, parameters: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/tools", method: "POST", headers: { "content-type": "application/json" } }, res => {
        let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(JSON.parse(text)));
      });
      req.on("error", reject); req.end(JSON.stringify({ tool, parameters }));
    });
  }
  try {
    const result = await post("gdoc_read", read);
    assert.equal(result.data.headings[0].text, "Heading\n");
    const changed = await post("gdoc_append_text", { ...append, requiredRevisionId: result.data.revisionId });
    assert.equal(changed.data.revisionId, "revision-example-2");
    const denied = await post("gdoc_append_text", { ...append, requiredRevisionId: "stale" });
    assert.match(denied.error, /EREVISION_CONFLICT/);
    assert.equal(f.calls.filter(c => c.init.method === "POST").length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
