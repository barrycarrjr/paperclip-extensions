import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ATTACHMENT_BYTES,
  decodedBase64Bytes,
  findAttachmentMeta,
  validateOutboundAttachments,
} from "./attachments.js";

describe("validateOutboundAttachments", () => {
  it("returns undefined when there is nothing to attach", () => {
    assert.equal(validateOutboundAttachments(undefined), undefined);
    assert.equal(validateOutboundAttachments(null), undefined);
    assert.equal(validateOutboundAttachments([]), undefined);
  });

  it("maps the wire contract to Help Scout's attachment shape", () => {
    const out = validateOutboundAttachments([
      { fileName: "file.txt", mimeType: "text/plain", contentBase64: "ZmlsZQ==" },
    ]);
    assert.deepEqual(out, [{ fileName: "file.txt", mimeType: "text/plain", data: "ZmlsZQ==" }]);
  });

  it("allows multiple attachments and preserves their order", () => {
    const out = validateOutboundAttachments([
      { fileName: "a.txt", mimeType: "text/plain", contentBase64: "YQ==" },
      { fileName: "b.pdf", mimeType: "application/pdf", contentBase64: "Yg==" },
      { fileName: "c.png", mimeType: "image/png", contentBase64: "Yw==" },
    ]);
    assert.deepEqual(
      out?.map((a) => a.fileName),
      ["a.txt", "b.pdf", "c.png"],
    );
  });

  it("strips line-wrapping whitespace out of the base64", () => {
    const out = validateOutboundAttachments([
      { fileName: "file.txt", mimeType: "text/plain", contentBase64: "Zml\nsZQ=\n=" },
    ]);
    assert.equal(out?.[0]?.data, "ZmlsZQ==");
  });

  it("rejects a non-array container", () => {
    assert.throws(
      () => validateOutboundAttachments({ fileName: "x" }),
      /\[EINVALID_INPUT\] `attachments` must be an array/,
    );
  });

  it("rejects a non-object entry", () => {
    assert.throws(
      () => validateOutboundAttachments(["nope"]),
      /\[EINVALID_INPUT\] attachments\[0\] must be an object/,
    );
  });

  it("rejects a missing or blank fileName", () => {
    assert.throws(
      () => validateOutboundAttachments([{ mimeType: "text/plain", contentBase64: "YQ==" }]),
      /attachments\[0\]\.fileName/,
    );
    assert.throws(
      () =>
        validateOutboundAttachments([
          { fileName: "  ", mimeType: "text/plain", contentBase64: "YQ==" },
        ]),
      /attachments\[0\]\.fileName/,
    );
  });

  it("rejects a missing mimeType, and names the right index", () => {
    assert.throws(
      () =>
        validateOutboundAttachments([
          { fileName: "a.txt", mimeType: "text/plain", contentBase64: "YQ==" },
          { fileName: "b.txt", contentBase64: "Yg==" },
        ]),
      /attachments\[1\]\.mimeType/,
    );
  });

  it("rejects missing, non-string, and empty contentBase64", () => {
    assert.throws(
      () => validateOutboundAttachments([{ fileName: "a.txt", mimeType: "text/plain" }]),
      /attachments\[0\]\.contentBase64 must be a base64 string/,
    );
    assert.throws(
      () =>
        validateOutboundAttachments([
          { fileName: "a.txt", mimeType: "text/plain", contentBase64: 42 },
        ]),
      /attachments\[0\]\.contentBase64 must be a base64 string/,
    );
    assert.throws(
      () =>
        validateOutboundAttachments([
          { fileName: "a.txt", mimeType: "text/plain", contentBase64: "  " },
        ]),
      /attachments\[0\]\.contentBase64 is empty/,
    );
  });

  it("rejects invalid base64 (bad characters, bad length, data: URLs)", () => {
    for (const bad of ["not base64!!", "YQ=", "abc", "data:text/plain;base64,ZmlsZQ=="]) {
      assert.throws(
        () =>
          validateOutboundAttachments([
            { fileName: "a.txt", mimeType: "text/plain", contentBase64: bad },
          ]),
        /attachments\[0\]\.contentBase64 is not valid base64/,
        `expected "${bad}" to be rejected`,
      );
    }
  });

  it("accepts a decoded size of exactly the limit and rejects one byte more", () => {
    const atLimit = Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64");
    const overLimit = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64");

    const ok = validateOutboundAttachments([
      { fileName: "max.bin", mimeType: "application/octet-stream", contentBase64: atLimit },
    ]);
    assert.equal(ok?.length, 1);

    assert.throws(
      () =>
        validateOutboundAttachments([
          { fileName: "big.bin", mimeType: "application/octet-stream", contentBase64: overLimit },
        ]),
      /attachment "big\.bin" decodes to .* at most 10 MB/,
    );
  });
});

describe("decodedBase64Bytes", () => {
  it("computes the decoded length from the base64 length and padding", () => {
    assert.equal(decodedBase64Bytes("YQ=="), 1); // "a"
    assert.equal(decodedBase64Bytes("YWI="), 2); // "ab"
    assert.equal(decodedBase64Bytes("YWJj"), 3); // "abc"
    assert.equal(decodedBase64Bytes("ZmlsZQ=="), 4); // "file"
  });
});

describe("findAttachmentMeta", () => {
  const conversation = {
    _embedded: {
      threads: [
        { type: "customer", _embedded: { attachments: [] } },
        {
          type: "reply",
          _embedded: {
            attachments: [
              { id: 101, filename: "logo.jpg", mimeType: "image/jpeg", size: 2331 },
              { id: 102, filename: "notes.txt", mimeType: "text/plain", size: 88 },
            ],
          },
        },
      ],
    },
  };

  it("finds an attachment by id across threads", () => {
    assert.deepEqual(findAttachmentMeta(conversation, "102"), {
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 88,
    });
  });

  it("matches numeric ids against the string parameter", () => {
    assert.equal(findAttachmentMeta(conversation, "101")?.fileName, "logo.jpg");
  });

  it("returns null when the id is not on any thread", () => {
    assert.equal(findAttachmentMeta(conversation, "999"), null);
  });

  it("tolerates bodies without embedded threads or attachments", () => {
    assert.equal(findAttachmentMeta(null, "1"), null);
    assert.equal(findAttachmentMeta({}, "1"), null);
    assert.equal(findAttachmentMeta({ _embedded: {} }, "1"), null);
    assert.equal(findAttachmentMeta({ _embedded: { threads: [{}] } }, "1"), null);
  });

  it("accepts fileName as an alternative key to filename", () => {
    const conv = {
      _embedded: {
        threads: [
          { _embedded: { attachments: [{ id: 7, fileName: "alt.pdf", mimeType: "application/pdf" }] } },
        ],
      },
    };
    assert.deepEqual(findAttachmentMeta(conv, "7"), {
      fileName: "alt.pdf",
      mimeType: "application/pdf",
      size: null,
    });
  });
});
