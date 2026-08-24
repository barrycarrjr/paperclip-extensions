/**
 * Tests for the pure attachment helpers.
 *
 * partId used to prefer the part's CID when one was present. CIDs can repeat
 * within a message, so two parts could share a partId and email_get_attachment
 * would silently return the wrong one. The id is only a token between a fetch
 * and a later get on the same message, so a plain index is both deterministic
 * and collision-free.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  ATTACHMENT_MAX_BYTES,
  attachmentPartId,
  collectAttachmentMeta,
  isInlineAttachment,
  mapAttachmentsForNodemailer,
  parseOutboundAttachments,
  type ParseOutboundAttachmentsResult,
} from "./attachments.js";

/** Asserts the parse failed and hands back its error message. */
function errOf(res: ParseOutboundAttachmentsResult): string {
  assert.ok(!res.ok, "expected the parse to be rejected");
  return res.ok ? "" : res.error;
}

test("partId is index-based and ignores the CID", () => {
  const meta = collectAttachmentMeta([
    { filename: "a.pdf", contentType: "application/pdf", size: 10 },
    // Same CID twice: with the old cid-preferring derivation these two would
    // have collided and the second been unreachable.
    { filename: "logo.png", contentType: "image/png", size: 5, contentDisposition: "inline", cid: "logo" },
    { filename: "logo2.png", contentType: "image/png", size: 6, contentDisposition: "inline", cid: "logo" },
  ]);
  assert.deepEqual(
    meta.map((m) => m.partId),
    ["att-0", "att-1", "att-2"],
  );
  assert.equal(attachmentPartId(7), "att-7");
});

test("collectAttachmentMeta fills defaults for nameless untyped parts", () => {
  const [m] = collectAttachmentMeta([{}]);
  assert.equal(m.name, "(unnamed)");
  assert.equal(m.mime, "application/octet-stream");
  assert.equal(m.size, 0);
  assert.equal(m.partId, "att-0");
  assert.equal(m.inline, false);
});

test("inline flag: related parts and inline disposition are inline, plain attachments are not", () => {
  assert.equal(isInlineAttachment({ related: true }), true);
  assert.equal(isInlineAttachment({ contentDisposition: "inline" }), true);
  assert.equal(isInlineAttachment({ related: true, contentDisposition: "inline" }), true);
  assert.equal(isInlineAttachment({ contentDisposition: "attachment" }), false);
  assert.equal(isInlineAttachment({}), false);
  const meta = collectAttachmentMeta([
    { filename: "sig.png", related: true },
    { filename: "invoice.pdf", contentDisposition: "attachment" },
  ]);
  assert.deepEqual(
    meta.map((m) => m.inline),
    [true, false],
  );
});

test("parseOutboundAttachments: omitted means no attachments", () => {
  for (const raw of [undefined, null]) {
    const res = parseOutboundAttachments(raw);
    assert.ok(res.ok);
    assert.deepEqual(res.attachments, []);
  }
});

test("parseOutboundAttachments accepts multiple valid attachments", () => {
  const res = parseOutboundAttachments([
    { name: "hello.txt", mime: "text/plain", contentBase64: Buffer.from("hello").toString("base64") },
    { name: "raw.bin", contentBase64: Buffer.from([0, 1, 2, 3]).toString("base64") },
  ]);
  assert.ok(res.ok);
  assert.equal(res.attachments.length, 2);
  assert.equal(res.attachments[0].name, "hello.txt");
  assert.equal(res.attachments[0].mime, "text/plain");
  assert.equal(res.attachments[1].mime, undefined);
});

test("parseOutboundAttachments tolerates whitespace inside the base64", () => {
  const b64 = Buffer.from("hello world").toString("base64");
  const spaced = b64.slice(0, 4) + "\r\n" + b64.slice(4);
  const res = parseOutboundAttachments([{ name: "x.txt", contentBase64: spaced }]);
  assert.ok(res.ok);
  assert.equal(Buffer.from(res.attachments[0].contentBase64, "base64").toString(), "hello world");
});

test("parseOutboundAttachments rejects a non-array and malformed items", () => {
  assert.match(errOf(parseOutboundAttachments("nope")), /^\[EINVALID_ATTACHMENT\]/);
  assert.match(errOf(parseOutboundAttachments([{ contentBase64: "aGk=" }])), /attachments\[0\]\.name/);
  assert.match(errOf(parseOutboundAttachments([{ name: "a.txt" }])), /contentBase64/);
  assert.match(errOf(parseOutboundAttachments([null])), /^\[EINVALID_ATTACHMENT\]/);
});

test("parseOutboundAttachments rejects non-base64 garbage with a clear error", () => {
  for (const garbage of ["not base64 at all!!!", "abc", "a===", "%%%%"]) {
    const error = errOf(parseOutboundAttachments([{ name: "x.bin", contentBase64: garbage }]));
    assert.match(error, /not valid base64/, `expected rejection for: ${JSON.stringify(garbage)}`);
    assert.match(error, /x\.bin/);
  }
});

test("parseOutboundAttachments rejects a single decoded attachment over 25 MB", () => {
  // "AAAA".repeat(n) is valid unpadded base64; each 4 chars decode to 3 bytes.
  const overCap = "AAAA".repeat(Math.ceil((ATTACHMENT_MAX_BYTES + 3) / 3));
  const error = errOf(parseOutboundAttachments([{ name: "big.zip", contentBase64: overCap }]));
  assert.match(error, /^\[EATTACHMENT_TOO_LARGE\]/);
  assert.match(error, /25 MB/);
  assert.match(error, /big\.zip/);

  // Exactly at the cap is allowed. The cap is not a multiple of 3, so the
  // final base64 quantum needs padding to land on it precisely.
  const whole = Math.floor(ATTACHMENT_MAX_BYTES / 3);
  const remainder = ATTACHMENT_MAX_BYTES - whole * 3;
  const tail = remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : "";
  const atCap = "AAAA".repeat(whole) + tail;
  const okRes = parseOutboundAttachments([{ name: "fits.zip", contentBase64: atCap }]);
  assert.ok(okRes.ok);
});

test("mapAttachmentsForNodemailer maps to nodemailer's documented shape", () => {
  const content = Buffer.from("attachment body");
  const mapped = mapAttachmentsForNodemailer([
    { name: "report.pdf", mime: "application/pdf", contentBase64: content.toString("base64") },
    { name: "notes.txt", contentBase64: Buffer.from("hi").toString("base64") },
  ]);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].filename, "report.pdf");
  assert.equal(mapped[0].contentType, "application/pdf");
  assert.ok(Buffer.isBuffer(mapped[0].content));
  assert.equal(mapped[0].content.toString(), "attachment body");
  // mime omitted: contentType stays undefined so nodemailer infers it from
  // the filename.
  assert.equal(mapped[1].contentType, undefined);
  assert.equal(mapped[1].content.toString(), "hi");
});
