/**
 * Outbound and inbound attachment helpers.
 *
 * Wire contract on every plugin surface (agent tools and the UI bridge):
 *   { fileName: string; mimeType: string; contentBase64: string }
 *
 * Help Scout's Mailbox API v2 accepts attachments inline in the JSON body of
 * POST /conversations/{id}/reply and on thread objects at conversation create,
 * as { fileName, mimeType, data } where `data` is base64. The attachment-data
 * read side is GET /conversations/{id}/attachments/{attachmentId}/data, which
 * answers { data: "<base64>" }.
 */

/** Attachment in the shape Help Scout's Mailbox API accepts on writes. */
export interface HelpScoutAttachment {
  fileName: string;
  mimeType: string;
  data: string;
}

/**
 * Help Scout requires the original (decoded) file to be less than 10MB per
 * attachment; larger uploads fail server-side with a bare 400. Enforced here
 * before the request so the caller gets a clear error instead.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decoded byte length of a canonical base64 string. The string must already
 * be whitespace-free and length-divisible by 4.
 */
export function decodedBase64Bytes(compact: string): number {
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return (compact.length / 4) * 3 - padding;
}

/**
 * Validate the wire-contract `attachments` array and map it to the shape
 * Help Scout's API expects. Returns undefined when there is nothing to attach
 * (missing or empty input), so callers can spread/omit the field cleanly.
 *
 * Throws [EINVALID_INPUT] with a specific message on the first problem found:
 * wrong container type, missing/empty fields, invalid base64, or a decoded
 * size over the per-attachment limit. Whitespace inside the base64 (line
 * wrapping from some encoders) is tolerated and stripped.
 */
export function validateOutboundAttachments(
  input: unknown,
): HelpScoutAttachment[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) {
    throw new Error(
      "[EINVALID_INPUT] `attachments` must be an array of { fileName, mimeType, contentBase64 }",
    );
  }
  if (input.length === 0) return undefined;

  const out: HelpScoutAttachment[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i] as {
      fileName?: unknown;
      mimeType?: unknown;
      contentBase64?: unknown;
    } | null;
    if (typeof item !== "object" || item === null) {
      throw new Error(
        `[EINVALID_INPUT] attachments[${i}] must be an object with fileName, mimeType, and contentBase64`,
      );
    }
    const fileName = typeof item.fileName === "string" ? item.fileName.trim() : "";
    if (!fileName) {
      throw new Error(`[EINVALID_INPUT] attachments[${i}].fileName must be a non-empty string`);
    }
    const mimeType = typeof item.mimeType === "string" ? item.mimeType.trim() : "";
    if (!mimeType) {
      throw new Error(`[EINVALID_INPUT] attachments[${i}].mimeType must be a non-empty string`);
    }
    if (typeof item.contentBase64 !== "string") {
      throw new Error(
        `[EINVALID_INPUT] attachments[${i}].contentBase64 must be a base64 string`,
      );
    }
    const compact = item.contentBase64.replace(/\s+/g, "");
    if (compact.length === 0) {
      throw new Error(
        `[EINVALID_INPUT] attachments[${i}].contentBase64 is empty ("${fileName}")`,
      );
    }
    if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
      throw new Error(
        `[EINVALID_INPUT] attachments[${i}].contentBase64 is not valid base64 ("${fileName}"). ` +
          "Use standard base64 with padding, not a data: URL or base64url.",
      );
    }
    const bytes = decodedBase64Bytes(compact);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      const mb = (bytes / (1024 * 1024)).toFixed(1);
      throw new Error(
        `[EINVALID_INPUT] attachment "${fileName}" decodes to ${mb} MB. ` +
          "Help Scout accepts at most 10 MB per attachment.",
      );
    }
    out.push({ fileName, mimeType, data: compact });
  }
  return out;
}

/** Metadata for one attachment, pulled from a conversation's embedded threads. */
export interface AttachmentMeta {
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
}

/**
 * Find one attachment's metadata inside a conversation body fetched with
 * embed=threads. Help Scout lists each thread's attachments under
 * thread._embedded.attachments as { id, filename, mimeType, size, ... }.
 * Returns null when the id is not present, so callers can treat metadata as
 * a nice-to-have next to the attachment-data endpoint's base64.
 */
export function findAttachmentMeta(
  conversation: unknown,
  attachmentId: string,
): AttachmentMeta | null {
  const threads = (
    conversation as { _embedded?: { threads?: unknown[] } } | null
  )?._embedded?.threads;
  if (!Array.isArray(threads)) return null;

  for (const thread of threads) {
    const attachments = (
      thread as { _embedded?: { attachments?: unknown[] } } | null
    )?._embedded?.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const raw of attachments) {
      const a = raw as {
        id?: unknown;
        filename?: unknown;
        fileName?: unknown;
        mimeType?: unknown;
        size?: unknown;
      } | null;
      if (a === null || typeof a !== "object") continue;
      if (a.id === undefined || String(a.id) !== attachmentId) continue;
      const fileName =
        typeof a.filename === "string"
          ? a.filename
          : typeof a.fileName === "string"
            ? a.fileName
            : null;
      return {
        fileName,
        mimeType: typeof a.mimeType === "string" ? a.mimeType : null,
        size: typeof a.size === "number" ? a.size : null,
      };
    }
  }
  return null;
}
