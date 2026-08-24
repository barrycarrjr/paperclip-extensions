/**
 * Pure attachment helpers, shared by the IMAP layer (inbound metadata and
 * retrieval) and the SMTP send path (outbound validation and nodemailer
 * mapping). Kept free of imapflow/nodemailer imports so the logic is unit
 * testable without a live connection.
 */
import { Buffer } from "node:buffer";

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Deterministic, collision-free part id for an attachment: its position in
 * the parsed attachment list. The id is an opaque token that only needs to
 * stay stable between a fetch and a later get on the same message, so
 * index-based derivation is safe. (An earlier version preferred the CID when
 * present, but CIDs can repeat within a message, so two parts could share a
 * partId and the wrong one would be returned.)
 */
export function attachmentPartId(idx: number): string {
  return `att-${idx}`;
}

/** The subset of mailparser's Attachment this module needs. */
export interface AttachmentLike {
  filename?: string;
  contentType?: string;
  size?: number;
  related?: boolean;
  contentDisposition?: string;
  /** Present on inline parts; deliberately NOT used for partId (CIDs can repeat). */
  cid?: string;
}

export interface AttachmentMeta {
  name: string;
  mime: string;
  size: number;
  partId: string;
  inline: boolean;
}

/**
 * True when mailparser marks the part as related/inline (signature images,
 * tracking pixels). The UI uses this to hide such parts from the attachment
 * chip row; they stay retrievable by partId.
 */
export function isInlineAttachment(a: AttachmentLike): boolean {
  return a.related === true || a.contentDisposition === "inline";
}

export function collectAttachmentMeta(attachments: AttachmentLike[]): AttachmentMeta[] {
  return attachments.map((a, idx) => ({
    name: a.filename ?? "(unnamed)",
    mime: a.contentType ?? "application/octet-stream",
    size: a.size ?? 0,
    partId: attachmentPartId(idx),
    inline: isInlineAttachment(a),
  }));
}

/**
 * Outbound wire shape: what the agent tools (email_send / email_reply) and
 * the UI bridge actions (email.send-new / email.send-reply) accept.
 */
export interface OutboundAttachment {
  name: string;
  mime?: string;
  contentBase64: string;
}

export type ParseOutboundAttachmentsResult =
  | { ok: true; attachments: OutboundAttachment[] }
  | { ok: false; error: string };

// Strict base64 (standard alphabet, trailing padding only). Buffer.from(s,
// "base64") silently skips invalid characters, so garbage input would
// otherwise become a corrupt attachment instead of an error the caller can
// act on. Deliberately a flat character class, not a repeated group: a
// grouped quantifier overflows the regex engine's stack on multi-megabyte
// strings. Length-multiple-of-4 is checked separately by the caller.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded byte count of an already-compacted (no whitespace) base64 string. */
function decodedBase64Bytes(compact: string): number {
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return (compact.length / 4) * 3 - padding;
}

/**
 * Validates the untyped `attachments` param from a tool call or bridge
 * action. Returns the cleaned wire-shape array (whitespace stripped from the
 * base64) or a structured error. `undefined`/`null` means "no attachments"
 * and is not an error.
 */
export function parseOutboundAttachments(raw: unknown): ParseOutboundAttachmentsResult {
  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "[EINVALID_ATTACHMENT] attachments must be an array" };
  }
  const out: OutboundAttachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as { name?: unknown; mime?: unknown; contentBase64?: unknown } | null;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        error: `[EINVALID_ATTACHMENT] attachments[${i}] must be an object with name and contentBase64`,
      };
    }
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) {
      return {
        ok: false,
        error: `[EINVALID_ATTACHMENT] attachments[${i}].name must be a non-empty string`,
      };
    }
    if (item.mime !== undefined && item.mime !== null && typeof item.mime !== "string") {
      return {
        ok: false,
        error: `[EINVALID_ATTACHMENT] attachments[${i}].mime must be a string when set`,
      };
    }
    if (typeof item.contentBase64 !== "string" || item.contentBase64.length === 0) {
      return {
        ok: false,
        error: `[EINVALID_ATTACHMENT] attachments[${i}].contentBase64 must be a non-empty base64 string`,
      };
    }
    const compact = item.contentBase64.replace(/\s+/g, "");
    if (compact.length === 0 || compact.length % 4 !== 0) {
      return {
        ok: false,
        error: `[EINVALID_ATTACHMENT] attachments[${i}] ("${name}"): contentBase64 is not valid base64`,
      };
    }
    // Size check before the character scan: it is pure arithmetic, so an
    // over-cap payload is rejected without walking its megabytes first.
    const decodedBytes = decodedBase64Bytes(compact);
    if (decodedBytes > ATTACHMENT_MAX_BYTES) {
      return {
        ok: false,
        error: `[EATTACHMENT_TOO_LARGE] attachments[${i}] ("${name}") is ${decodedBytes} bytes decoded; the limit is 25 MB per attachment`,
      };
    }
    if (!BASE64_RE.test(compact)) {
      return {
        ok: false,
        error: `[EINVALID_ATTACHMENT] attachments[${i}] ("${name}"): contentBase64 is not valid base64`,
      };
    }
    const mime = typeof item.mime === "string" && item.mime.trim() ? item.mime.trim() : undefined;
    out.push({ name, mime, contentBase64: compact });
  }
  return { ok: true, attachments: out };
}

/** Nodemailer's documented attachment shape (the subset this plugin emits). */
export interface NodemailerAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

/**
 * Maps the validated wire shape to nodemailer's attachment shape. The
 * content is passed as a decoded Buffer, so no `encoding` field is needed.
 * When mime is omitted nodemailer infers contentType from the filename.
 */
export function mapAttachmentsForNodemailer(
  attachments: OutboundAttachment[],
): NodemailerAttachment[] {
  return attachments.map((a) => ({
    filename: a.name,
    contentType: a.mime,
    content: Buffer.from(a.contentBase64, "base64"),
  }));
}
