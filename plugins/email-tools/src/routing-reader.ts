import type { ImapFlow, MessageStructureObject } from "imapflow";
import { simpleParser } from "mailparser";
import type { ParsedMessage } from "./imap.js";

export interface MessageLocator { folder: string; uid: number; uidValidity: string; messageId: string | null }
export interface VerifiedMail { parsed: ParsedMessage; uidValidity: string }
export type RoutingReader = (locator: MessageLocator) => Promise<VerifiedMail>;

/** EXAMINE plus ImapFlow's BODY.PEEK downloads. Only a bounded text part is downloaded, never attachments. */
export async function readRoutingMessage(client: ImapFlow, locator: MessageLocator): Promise<VerifiedMail> {
  const lock = await client.getMailboxLock(locator.folder, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    const validity = mailbox && String(mailbox.uidValidity);
    if (!validity || validity !== locator.uidValidity) throw new Error("[EMESSAGE_MISMATCH] UIDVALIDITY changed. Search the mailbox again.");
    const msg = await client.fetchOne(String(locator.uid), {
      uid: true, bodyParts: [{ key: "HEADER", start: 0, maxLength: 32_769 }], bodyStructure: true,
    }, { uid: true });
    if (!msg || msg.uid !== locator.uid || !msg.headers) throw new Error("[EMESSAGE_NOT_FOUND] Message is no longer in this folder.");
    if (msg.headers.length > 32_768) throw new Error("[EMESSAGE_LIMIT] Headers exceed the routing limit. Review manually.");
    const header = await simpleParser(msg.headers);
    const actualId = header.messageId ?? null;
    // ENVELOPE preserves malformed header values; mailparser adds brackets or removes comments.
    // Compare the proposal to the bounded server header, never normalize arbitrary caller input.
    const idLines = header.headerLines?.filter(line => line.key === "message-id") ?? [];
    const rawId = idLines[0]?.line.replace(/^message-id:\s*/i, "").replace(/\r?\n[ \t]+/g, " ").trim() || null;
    if (idLines.length > 1 || rawId !== locator.messageId) throw new Error("[EMESSAGE_MISMATCH] Message-ID does not match the current message.");
    const attachments: ParsedMessage["attachments"] = [];
    let bodyPart: MessageStructureObject | undefined;
    let nodes = 0;
    function visit(node: MessageStructureObject, depth: number) {
      if (++nodes > 200 || depth > 20) throw new Error("[EMESSAGE_LIMIT] MIME structure exceeds the routing limit.");
      if (node.disposition === "attachment" || node.dispositionParameters?.filename || node.parameters?.name) {
        if (attachments.length < 30) attachments.push({
          name: (node.dispositionParameters?.filename ?? node.parameters?.name ?? "(unnamed)").slice(0, 200),
          mime: node.type.slice(0, 100), size: Math.max(0, Number(node.size) || 0), partId: (node.part ?? "").slice(0, 30), inline: node.disposition === "inline",
        });
        return; // Do not inspect attached messages as if they were the message body.
      }
      if (node.type === "text/plain" && !bodyPart) bodyPart = node;
      for (const child of node.childNodes ?? []) visit(child, depth + 1);
    }
    if (msg.bodyStructure) visit(msg.bodyStructure, 0);
    let text = "";
    if (bodyPart) {
      const downloaded = await client.download(String(locator.uid), bodyPart.part || "1", { uid: true, maxBytes: 24_000, chunkSize: 8192 });
      if (!downloaded?.content) throw new Error("[EMESSAGE_NOT_FOUND] The message disappeared while reading its text part.");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of downloaded.content) {
        const b = Buffer.from(chunk);
        chunks.push(b.subarray(0, Math.max(0, 24_000 - bytes)));
        bytes += b.length;
        if (bytes >= 24_000) { downloaded.content.destroy(); break; }
      }
      text = Buffer.concat(chunks).toString("utf8");
      if (bytes >= 24_000) text += "\n[Text truncated for routing.]";
    } else text = "[No plain-text body available. Open the original email to review HTML content.]";
    const addressText = (value: typeof header.from) => value?.text?.slice(0, 1000) ?? "";
    const to = header.to ? (Array.isArray(header.to) ? header.to : [header.to]) : [];
    const cc = header.cc ? (Array.isArray(header.cc) ? header.cc : [header.cc]) : [];
    return { uidValidity: validity, parsed: {
      // Preserve the raw invalid identity for UID-keyed WAITING, never upgrade it into a handoff.
      uid: msg.uid, messageId: rawId === actualId ? actualId : rawId, inReplyTo: null, references: [],
      from: addressText(header.from), fromAddress: header.from?.value[0]?.address?.slice(0, 320) ?? null,
      to: to.slice(0, 10).map(addressText), cc: cc.slice(0, 10).map(addressText),
      subject: (header.subject ?? "").slice(0, 300), date: header.date?.toISOString() ?? "(unknown)",
      text, html: "", markdown: text, attachments, answered: false, forwarded: false,
    } };
  } finally { lock.release(); }
}
