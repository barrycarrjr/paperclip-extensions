import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import { DRIVE_CONTENT_TOOLS } from "../schemas.js";
import { ContentError, contentError, DEFAULT_FILE_BYTES, fileId, googleUrl, input, integer, invalid, MAX_FILE_BYTES, MAX_TEXT_CHARS, openContentSession, splitSurrogate, type ContentSession } from "./content-api.js";

const NATIVE = "application/vnd.google-apps.";
const FOLDER = NATIVE + "folder";
interface Metadata {
  id?: string; name?: string; mimeType?: string; parents?: string[]; version?: string; size?: string;
  trashed?: boolean; capabilities?: { canDownload?: boolean };
}
const fields = "id,name,mimeType,parents,version,size,trashed,capabilities(canDownload)";

async function metadata(session: ContentSession, id: string) {
  const response = await session.json<Metadata>(googleUrl("drive", id, "", { fields, supportsAllDrives: "true" }));
  if (!response.data || response.data.id !== id || typeof response.data.mimeType !== "string" || response.data.trashed !== false) throw new ContentError("EGOOGLE_FORMAT", "The exact file was not returned, is trashed, or has incomplete metadata.");
  return response;
}
function parent(meta: Metadata): string {
  if (!Array.isArray(meta.parents) || meta.parents.length !== 1) throw new ContentError("EPARENT_MISMATCH", "Move requires one known parent. No parent was removed.");
  return fileId(meta.parents[0]);
}
const exports: Record<string, string[]> = {
  [NATIVE + "document"]: ["text/plain", "text/markdown", "application/pdf"],
  [NATIVE + "spreadsheet"]: ["text/csv", "text/tab-separated-values", "application/pdf"],
  [NATIVE + "presentation"]: ["text/plain", "application/pdf"],
  [NATIVE + "drawing"]: ["image/png", "image/svg+xml", "application/pdf"],
};
function textMime(mime: string): boolean { return mime.startsWith("text/") || /^(application\/(json|xml|javascript)|image\/svg\+xml)$/.test(mime); }

export function registerDriveContentTools(ctx: PluginContext): void {
  for (const schema of DRIVE_CONTENT_TOOLS) {
    // Approval uses actionType. Host repeat caching (writes) would incorrectly
    // replay rename A after rename B, and the same problem affects move-back.
    const mutation = schema.actionType === "change_files";
    ctx.tools.register(schema.name, schema, async (params, run): Promise<ToolResult> => {
      try {
        const p = input(params, schema.name === "gdrive_read_file"
          ? ["account", "fileId", "exportMimeType", "encoding", "maxBytes", "offset", "maxChars", "requiredVersion"]
          : schema.name === "gdrive_rename_file" ? ["account", "fileId", "name"] : ["account", "fileId", "destinationFolderId", "expectedParentId"]);
        const id = fileId(p.fileId);
        const destination = schema.name === "gdrive_move_file" ? fileId(p.destinationFolderId) : undefined;
        const expectedParent = schema.name === "gdrive_move_file" ? fileId(p.expectedParentId) : undefined;
        if (destination === id) invalid("A file cannot be its own destination folder.");
        if (schema.name === "gdrive_rename_file" && (typeof p.name !== "string" || !p.name.trim() || p.name.length > 255 || /[\x00-\x1f\x7f]/.test(p.name))) invalid("Name must be nonempty, at most 255 characters and contain no control characters.");
        const maxBytes = integer(p.maxBytes, DEFAULT_FILE_BYTES, 1, MAX_FILE_BYTES);
        const offset = integer(p.offset, 0, 0, MAX_FILE_BYTES);
        const maxChars = integer(p.maxChars, 10000, 2, MAX_TEXT_CHARS);
        if (p.encoding !== undefined && p.encoding !== "text" && p.encoding !== "base64") invalid("Encoding must be text or base64.");
        if (p.exportMimeType !== undefined && typeof p.exportMimeType !== "string") invalid("Export MIME type must be a string.");
        if (p.requiredVersion !== undefined && (typeof p.requiredVersion !== "string" || !/^\d{1,30}$/.test(p.requiredVersion))) invalid("requiredVersion must be the version from a previous read.");
        if (offset > 0 && p.requiredVersion === undefined) invalid("Pagination requires requiredVersion from the previous page.");
        const session = await openContentSession(ctx, run, schema.name, p.account, mutation);
        const before = await metadata(session, id);
        const meta = before.data;
        if (schema.name === "gdrive_read_file") {
          if (meta.capabilities?.canDownload !== true) throw new ContentError("EGOOGLE_FORBIDDEN", "Google does not permit downloading this file.");
          if (typeof meta.version !== "string" || !/^\d+$/.test(meta.version)) throw new ContentError("EGOOGLE_FORMAT", "Google did not return a file version for a consistent read.");
          if (p.requiredVersion !== undefined && meta.version !== p.requiredVersion) throw new ContentError("EREVISION_CONFLICT", "The file changed. Restart the read.");
          let mime = meta.mimeType!;
          let url: URL;
          if (mime.startsWith(NATIVE)) {
            const supported = exports[mime];
            const exportMime = p.exportMimeType ?? (mime === NATIVE + "document" || mime === NATIVE + "presentation" ? "text/plain" : undefined);
            if (!supported || typeof exportMime !== "string" || !supported.includes(exportMime)) throw new ContentError("EUNSUPPORTED_FORMAT", "Choose a supported native-file export MIME type. Folders and shortcuts are not followed. Use gsheet_read for specific sheet tabs.");
            mime = exportMime;
            url = googleUrl("drive", id, "/export", { mimeType: mime });
          } else {
            if (p.exportMimeType !== undefined) invalid("exportMimeType only applies to native Google files.");
            if (meta.size && (!/^\d+$/.test(meta.size) || Number(meta.size) > maxBytes)) throw new ContentError("EREAD_LIMIT", "The file exceeds maxBytes. No content was downloaded.");
            url = googleUrl("drive", id, "", { alt: "media", supportsAllDrives: "true" });
          }
          const encoding = p.encoding ?? (textMime(mime) ? "text" : "base64");
          if (encoding === "base64" && offset !== 0) invalid("Binary reads are bounded whole-file reads and cannot use a text offset.");
          const response = await session.request(url, "GET", undefined, maxBytes);
          const after = await metadata(session, id);
          if (after.data.version !== meta.version || after.data.mimeType !== meta.mimeType) throw new ContentError("EREVISION_CONFLICT", "The file changed during download. No content is returned; restart the read.");
          const common = { fileId: id, name: meta.name, sourceMimeType: meta.mimeType, mimeType: mime, version: meta.version, encoding, bytes: response.bytes.length,
            ...(meta.mimeType === NATIVE + "spreadsheet" && mime.startsWith("text/") ? { scope: "First sheet only. Use gsheet_read for other tabs." } : {}) };
          if (encoding === "base64") return { content: "Bounded file content read as base64.", data: { ...common, content: response.bytes.toString("base64"), complete: true } };
          let text: string;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes); }
          catch { throw new ContentError("EUNSUPPORTED_ENCODING", "File is not valid UTF-8. Request base64 to read the original bytes."); }
          if (offset > text.length || splitSurrogate(text, offset)) invalid("Offset is outside the text or splits a Unicode character.");
          let end = Math.min(offset + maxChars, text.length);
          if (splitSurrogate(text, end)) end--;
          return { content: "Bounded file text read.", data: { ...common, content: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalChars: text.length, complete: end === text.length } };
        }
        let url = googleUrl("drive", id, "", { fields: "id,name,parents,version", supportsAllDrives: "true" });
        let body: Record<string, unknown>;
        if (schema.name === "gdrive_rename_file") {
          body = { name: p.name };
        } else {
          if (meta.mimeType === FOLDER) throw new ContentError("EUNSUPPORTED_MOVE", "This bounded tool moves files only, not folder trees.");
          const current = parent(meta);
          if (current === destination) return { content: "File is already in the destination folder. No write was made.", data: { fileId: id, parents: [current], unchanged: true } };
          if (current !== expectedParent) throw new ContentError("EPARENT_MISMATCH", "The file is no longer in expectedParentId. No parent was removed.");
          const folder = await metadata(session, destination!);
          if (folder.data.mimeType !== FOLDER) invalid("Destination must be an existing, untrashed Drive folder.");
          url.searchParams.set("addParents", destination!);
          url.searchParams.set("removeParents", expectedParent!);
          body = {};
        }
        await session.audit("attempt", id);
        const latest = await metadata(session, id);
        if (typeof meta.version !== "string" || !/^\d+$/.test(meta.version) || latest.data.version !== meta.version) throw new ContentError("EREVISION_CONFLICT", "The file changed or its version is unavailable. Read it again before editing.");
        // One atomic PATCH adds the destination and removes only the explicitly expected parent.
        // Drive v3 documents no conditional metadata update contract. This
        // preflight check cannot close the race between the final GET and PATCH.
        const { data } = await session.json<Metadata>(url, "PATCH", body);
        if (data?.id !== id || (schema.name === "gdrive_rename_file" ? data.name !== p.name : !Array.isArray(data.parents) || data.parents.length !== 1 || data.parents[0] !== destination)) throw new ContentError("EGOOGLE_FORMAT", "Google did not confirm the requested file update. Verify the remote result before retrying.");
        const logged = await session.audit("completed", id);
        return { content: "Drive file updated with its original ID.", data: { fileId: id, name: data.name, parents: data.parents, version: data.version, ...(logged ? {} : { warning: "Write completed, but its completion log failed. Do not repeat it." }) } };
      } catch (err) { return { error: contentError(err) }; }
    });
  }
}
