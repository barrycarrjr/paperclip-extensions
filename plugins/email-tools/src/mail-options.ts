/**
 * The outgoing message, as nodemailer options.
 *
 * Built in one place because the same message is built twice: once to send,
 * and once more for the copy uploaded to the Sent folder (see sent-copy.ts).
 * Two copies of this mapping would drift, and the copy in Sent would then
 * stop matching what the recipient actually got.
 */
import type Mail from "nodemailer/lib/mailer/index.js";
import { mapAttachmentsForNodemailer, type OutboundAttachment } from "./attachments.js";

export interface SendInput {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string[];
  /** Validated wire shape (see parseOutboundAttachments); decoded to Buffers at send time. */
  attachments?: OutboundAttachment[];
}

export function ensureAngled(id: string): string {
  const t = id.trim();
  if (!t) return t;
  if (t.startsWith("<") && t.endsWith(">")) return t;
  return `<${t}>`;
}

export function toField(v: string | string[]): string {
  return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * `date` is passed in rather than left to nodemailer so the copy in Sent can
 * carry the same Date header as the message that went out.
 */
export function toMailOptions(input: SendInput, date: Date): Mail.Options {
  return {
    from: input.from,
    to: toField(input.to),
    cc: input.cc ? toField(input.cc) : undefined,
    bcc: input.bcc ? toField(input.bcc) : undefined,
    replyTo: input.replyTo,
    subject: input.subject,
    text: input.body,
    html: input.bodyHtml,
    date,
    inReplyTo: input.inReplyTo ? ensureAngled(input.inReplyTo) : undefined,
    references:
      input.references && input.references.length > 0
        ? input.references.map(ensureAngled).join(" ")
        : undefined,
    attachments:
      input.attachments && input.attachments.length > 0
        ? mapAttachmentsForNodemailer(input.attachments)
        : undefined,
  };
}
