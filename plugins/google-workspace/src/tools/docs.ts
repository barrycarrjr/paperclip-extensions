import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import { createHash } from "node:crypto";
import { DOCS_TOOLS } from "../schemas.js";
import { ContentError, contentError, documentTabId, editText, fileId, googleUrl, input, integer, invalid, MAX_TEXT_CHARS, openContentSession, revision, splitSurrogate, type ContentSession } from "./content-api.js";

interface Element {
  startIndex?: number; endIndex?: number;
  paragraph?: { paragraphStyle?: { namedStyleType?: string; headingId?: string }; elements?: Array<{ startIndex?: number; endIndex?: number; textRun?: { content?: string }; [key: string]: unknown }> };
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: Element[] }> }> };
  tableOfContents?: { content?: Element[] };
  sectionBreak?: unknown;
}
interface Tab {
  tabProperties?: { tabId?: string; title?: string };
  documentTab?: { body?: { content?: Element[] }; [key: string]: unknown };
  childTabs?: Tab[];
}
interface Document { documentId?: string; title?: string; revisionId?: string; suggestionsViewMode?: string; tabs?: Tab[] }
interface Paragraph {
  text: string; startIndex: number; endIndex: number; textOffset: number; editable: boolean;
  style: string; headingId?: string;
}

export const MAX_DOC_RESULT_BYTES = 64 * 1024;
export const MAX_PAGE_PARAGRAPHS = 100;

async function readDocument(session: ContentSession, id: string, mutation: boolean) {
  let doc: Document;
  try {
    ({ data: doc } = await session.json<Document>(googleUrl("docs", id, "", { includeTabsContent: "true", suggestionsViewMode: mutation ? "SUGGESTIONS_INLINE" : "DEFAULT_FOR_CURRENT_ACCESS" })));
  } catch (err) {
    if (mutation && err instanceof ContentError && err.code === "EGOOGLE_FORBIDDEN") throw new ContentError("EEDIT_ACCESS", "Google denied the pre-edit read. Editing requires editor access, the Docs API and an existing write-capable OAuth grant.");
    throw err;
  }
  if (!doc || doc.documentId !== id || !Array.isArray(doc.tabs) || !doc.tabs.length) throw new ContentError("EGOOGLE_FORMAT", "Google returned an unexpected document or missing tabs.");
  if (!["SUGGESTIONS_INLINE", "PREVIEW_WITHOUT_SUGGESTIONS", "PREVIEW_SUGGESTIONS_ACCEPTED"].includes(doc.suggestionsViewMode ?? "")) throw new ContentError("EGOOGLE_FORMAT", "Google did not return the applied suggestions view mode.");
  const tabs: Array<{ tab: Tab; tabId: string; title: string; parentTabId: string | null }> = [];
  function visit(items: Tab[], parentTabId: string | null, depth: number) {
    if (depth > 20) throw new ContentError("EREAD_LIMIT", "Document tab nesting exceeds the supported limit.");
    for (const tab of items) {
      const tabId = documentTabId(tab.tabProperties?.tabId);
      if (tabs.length >= 100 || tabs.some(item => item.tabId === tabId)) throw new ContentError("EGOOGLE_FORMAT", "Document tabs are too numerous or ambiguous.");
      tabs.push({ tab, tabId, title: tab.tabProperties?.title ?? "", parentTabId });
      if (tab.childTabs) visit(tab.childTabs, tabId, depth + 1);
    }
  }
  visit(doc.tabs, null, 0);
  return { doc, tabs };
}

// Hash the full visible projection before pagination, never raw image URLs or
// unrendered response fields. Include tab selection so tokens cannot cross tabs.
// Canonical object keys avoid false conflicts from JSON property ordering.
function readToken(projection: Record<string, unknown>): string {
  const snapshot = JSON.stringify(projection, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  return createHash("sha256").update(snapshot).digest("hex");
}

function resultBytes(result: ToolResult): number { return Buffer.byteLength(JSON.stringify(result), "utf8"); }
function boundedResult(result: ToolResult): ToolResult {
  if (resultBytes(result) > MAX_DOC_RESULT_BYTES) throw new ContentError("EREAD_LIMIT", "Document metadata exceeds the 64 KiB serialized result limit.");
  return result;
}

function readPage(body: ReturnType<typeof bodyText>, common: Record<string, unknown>, offset: number, maxChars: number): ToolResult {
  if (offset > body.text.length || splitSurrogate(body.text, offset)) invalid("Offset is outside the text or splits a Unicode character.");
  let limit = Math.min(offset + maxChars, body.text.length);
  const intersecting = body.paragraphs.filter(p => p.textOffset < limit && p.textOffset + p.text.length > offset);
  if (intersecting.length > MAX_PAGE_PARAGRAPHS) limit = Math.min(limit, intersecting[MAX_PAGE_PARAGRAPHS].textOffset);
  const candidates = intersecting.slice(0, MAX_PAGE_PARAGRAPHS);
  function endAt(length: number) {
    const end = offset + length;
    return splitSurrogate(body.text, end) ? end - 1 : end;
  }
  function build(pageEnd: number): ToolResult {
    const paragraphs = candidates.filter(p => p.textOffset < pageEnd && p.textOffset + p.text.length > offset).map(paragraph => {
      const from = Math.max(offset - paragraph.textOffset, 0);
      const to = Math.min(pageEnd - paragraph.textOffset, paragraph.text.length);
      return { ...paragraph, text: paragraph.text.slice(from, to), textStartIndex: paragraph.editable ? paragraph.startIndex + from : null, clipped: from > 0 || to < paragraph.text.length };
    });
    return { content: "Document body text and headings read.", data: {
      ...common, text: body.text.slice(offset, pageEnd), paragraphs,
      headings: paragraphs.filter(p => /^(HEADING_[1-6]|TITLE|SUBTITLE)$/.test(p.style)).map(p => ({ text: p.text, style: p.style, headingId: p.headingId, startIndex: p.startIndex, endIndex: p.endIndex, clipped: p.clipped })),
      offset, nextOffset: pageEnd < body.text.length ? pageEnd : null, totalChars: body.text.length,
      complete: pageEnd === body.text.length, unsupportedElements: body.unsupportedElements, hasSuggestions: body.hasSuggestions,
      scope: "Selected tab body, including table cells and table of contents. Headers, footers, footnotes, images and comments are not rendered. Suggestions follow suggestionsViewMode; hidden suggestions cannot be detected.",
    } };
  }
  let end = endAt(limit - offset);
  let result = build(end);
  if (resultBytes(result) > MAX_DOC_RESULT_BYTES) {
    let low = 0, high = limit - offset;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (resultBytes(build(endAt(mid))) <= MAX_DOC_RESULT_BYTES) low = mid;
      else high = mid - 1;
    }
    end = endAt(low);
    result = build(end);
  }
  if (end === offset && offset < body.text.length) throw new ContentError("EREAD_LIMIT", "Document metadata leaves no room for text within the 64 KiB result limit.");
  return boundedResult(result);
}

function bodyText(tab: Tab) {
  const paragraphs: Paragraph[] = [];
  const body = tab.documentTab?.body?.content;
  if (!Array.isArray(body)) throw new ContentError("EGOOGLE_FORMAT", "The selected tab has no document body.");
  let total = 0;
  let unsupportedElements = 0;
  function walk(elements: Element[], depth: number, editable: boolean) {
    if (depth > 20) throw new ContentError("EREAD_LIMIT", "Document body nesting exceeds the supported limit.");
    for (const item of elements) {
      if (item.paragraph) {
        const runs = item.paragraph.elements ?? [];
        let text = "";
        let contiguous = editable && Number.isSafeInteger(item.startIndex) && Number.isSafeInteger(item.endIndex);
        let expected = item.startIndex;
        for (const run of runs) {
          const content = run.textRun?.content;
          if (typeof content !== "string") { unsupportedElements++; contiguous = false; text += "\uFFFC"; }
          else {
            if (run.startIndex !== expected || run.endIndex !== run.startIndex! + content.length) contiguous = false;
            text += content;
          }
          expected = run.endIndex;
        }
        if (expected !== item.endIndex) contiguous = false;
        paragraphs.push({ text, startIndex: item.startIndex ?? -1, endIndex: item.endIndex ?? -1, textOffset: total, editable: contiguous,
          style: item.paragraph.paragraphStyle?.namedStyleType ?? "NORMAL_TEXT", headingId: item.paragraph.paragraphStyle?.headingId });
        total += text.length;
      } else if (item.table) {
        for (const row of item.table.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content ?? [], depth + 1, editable);
      } else if (item.tableOfContents) {
        walk(item.tableOfContents.content ?? [], depth + 1, false);
      } else if (!item.sectionBreak) unsupportedElements++;
    }
  }
  walk(body, 0, true);
  const hasSuggestions = /"suggested[A-Za-z]*"\s*:/.test(JSON.stringify(tab.documentTab));
  return { paragraphs, text: paragraphs.map(p => p.text).join(""), unsupportedElements, hasSuggestions };
}

function paragraphAt(paragraphs: Paragraph[], index: number): Paragraph {
  const p = paragraphs.find(p => p.editable && p.startIndex <= index && index < p.endIndex);
  if (!p || splitSurrogate(p.text, index - p.startIndex)) invalid("Index must be inside plain paragraph text and cannot split a Unicode character.");
  return p;
}

export function registerDocsTools(ctx: PluginContext): void {
  for (const schema of DOCS_TOOLS) {
    const mutation = schema.actionType === "change_files";
    ctx.tools.register(schema.name, schema, async (params, run): Promise<ToolResult> => {
      let session: ContentSession | undefined;
      try {
        const fields = mutation
          ? ["account", "documentId", "tabId", "requiredRevisionId", "text", ...(schema.name === "gdoc_insert_text" ? ["index"] : schema.name === "gdoc_replace_text" ? ["startIndex", "endIndex", "expectedText"] : [])]
          : ["account", "documentId", "tabId", "offset", "maxChars", "requiredRevisionId", "requiredReadToken"];
        const p = input(params, fields);
        const id = fileId(p.documentId);
        const tabId = p.tabId === undefined ? undefined : documentTabId(p.tabId);
        const requiredRevision = mutation || p.requiredRevisionId !== undefined ? revision(p.requiredRevisionId) : undefined;
        const text = mutation ? editText(p.text) : undefined;
        const offset = mutation ? 0 : integer(p.offset, 0, 0, 2000000);
        const maxChars = mutation ? 0 : integer(p.maxChars, 10000, 2, MAX_TEXT_CHARS);
        if (p.requiredReadToken !== undefined && (typeof p.requiredReadToken !== "string" || !/^[a-f0-9]{64}$/.test(p.requiredReadToken))) invalid("Pass the readToken from gdoc_read as requiredReadToken.");
        if (offset > 0 && !requiredRevision && !p.requiredReadToken) invalid("Pagination requires the previous requiredRevisionId or requiredReadToken.");
        const index = schema.name === "gdoc_insert_text" ? integer(p.index, -1, 1, 2000000) : undefined;
        const start = schema.name === "gdoc_replace_text" ? integer(p.startIndex, -1, 1, 2000000) : undefined;
        const end = schema.name === "gdoc_replace_text" ? integer(p.endIndex, -1, 2, 2000000) : undefined;
        if (schema.name === "gdoc_replace_text" && (typeof p.expectedText !== "string" || !p.expectedText || p.expectedText.length > MAX_TEXT_CHARS || end! <= start! || p.expectedText.length !== end! - start!)) invalid("Replace requires an exact nonempty expectedText and matching startIndex/endIndex.");
        session = await openContentSession(ctx, run, schema.name, p.account, mutation);
        const { doc, tabs } = await readDocument(session, id, mutation);
        if (mutation && !doc.revisionId) throw new ContentError("EEDIT_ACCESS", "Google did not return an editor revision ID. Editing requires editor access to this document.");
        if (mutation && doc.suggestionsViewMode !== "SUGGESTIONS_INLINE") throw new ContentError("EUNSUPPORTED_EDIT", "The pre-edit document must include inline suggestions.");
        if (requiredRevision && requiredRevision !== doc.revisionId) throw new ContentError("EREVISION_CONFLICT", "The document changed. Read it again before continuing.");
        const tabList = tabs.map(({ tab: _tab, ...info }) => info);
        const selected = tabId ? tabs.find(t => t.tabId === tabId) : tabs.length === 1 ? tabs[0] : undefined;
        const body = selected ? bodyText(selected.tab) : undefined;
        const metadata = { documentId: id, title: doc.title, revisionId: doc.revisionId ?? null, suggestionsViewMode: doc.suggestionsViewMode, tabs: tabList };
        const token = mutation ? undefined : readToken({ ...metadata, tabId: selected?.tabId ?? null, ...body });
        if (p.requiredReadToken !== undefined && p.requiredReadToken !== token) throw new ContentError("EREVISION_CONFLICT", "The visible document snapshot changed. Restart the read.");
        const common = { ...metadata, readToken: token };
        if (!selected) {
          if (!tabId && !mutation) return boundedResult({ content: "Choose a tabId from tabs and call gdoc_read again.", data: { ...common, requiresTabSelection: true } });
          throw new ContentError("ETAB_REQUIRED", "Specify an existing tabId. Read the document to list its tabs.");
        }
        if (!mutation) {
          return readPage(body!, { ...common, tabId: selected.tabId }, offset, maxChars);
        }
        if (body!.hasSuggestions) throw new ContentError("EUNSUPPORTED_EDIT", "Resolve suggestions in this tab before using text edit tools.");
        const location = { tabId: selected.tabId };
        let requests: unknown[];
        if (schema.name === "gdoc_append_text") {
          requests = [{ insertText: { text, endOfSegmentLocation: location } }];
        } else if (schema.name === "gdoc_insert_text") {
          paragraphAt(body!.paragraphs, index!);
          requests = [{ insertText: { text, location: { ...location, index } } }];
        } else {
          const paragraph = paragraphAt(body!.paragraphs, start!);
          // Keep paragraph boundaries and their formatting. Replacements are one exact range.
          const relativeEnd = end! - paragraph.startIndex;
          if (end! >= paragraph.endIndex || splitSurrogate(paragraph.text, relativeEnd) || paragraph.text.slice(start! - paragraph.startIndex, relativeEnd) !== p.expectedText) throw new ContentError("ETEXT_MISMATCH", "Expected text does not match one plain paragraph range, excluding its final newline.");
          requests = [
            { deleteContentRange: { range: { ...location, startIndex: start, endIndex: end } } },
            { insertText: { text, location: { ...location, index: start } } },
          ];
        }
        await session.audit("attempt", id);
        const { data } = await session.json<{ documentId?: string; writeControl?: { requiredRevisionId?: string } }>(googleUrl("docs", id, ":batchUpdate"), "POST", { writeControl: { requiredRevisionId: requiredRevision }, requests });
        if (data?.documentId !== id) throw new ContentError("EGOOGLE_FORMAT", "The write response did not confirm the exact document. Verify the remote result before retrying.");
        const logged = await session.audit("completed", id);
        return { content: "Document text updated.", data: { documentId: id, tabId: selected.tabId, revisionId: data.writeControl?.requiredRevisionId ?? null, ...(logged ? {} : { warning: "Write completed, but its completion log failed. Do not repeat it." }) } };
      } catch (err) {
        const error = contentError(err);
        // Preserve pre-send RPC failures and expose uncertain sent outcomes.
        // Docs edits omit host caching. Every dispatch is revision-guarded at
        // preflight and atomically by Google, including an intentional retry.
        if (mutation && !session?.writeDispatched) throw new Error(error);
        return { error };
      }
    });
  }
}
