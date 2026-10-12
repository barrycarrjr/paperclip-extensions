import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Drive } from "./drive.js";

interface FakeFile {
  id: string;
  name: string;
  parent: string;
  mimeType: string;
  md5?: string;
}

/** A tiny in-memory Drive behind a fake global fetch. */
function fakeDrive(files: FakeFile[], calls: string[]) {
  let n = 100;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "t" });
    if (method === "GET" && url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(q)![1];
      const eq = /name = '([^']+)'/.exec(q)?.[1];
      const contains = /name contains '([^']+)'/.exec(q)?.[1];
      const folderOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      const hits = files.filter(
        (f) =>
          f.parent === parent &&
          (!eq || f.name === eq) &&
          (!contains || f.name.includes(contains)) &&
          (!folderOnly || f.mimeType === "application/vnd.google-apps.folder"),
      );
      return json({ files: hits.map((f) => ({ id: f.id, name: f.name, md5Checksum: f.md5, webViewLink: `https://drive/${f.id}` })) });
    }
    if (method === "POST" && url.pathname === "/drive/v3/files") {
      const meta = JSON.parse(String(init!.body));
      const f = { id: `f${n++}`, name: meta.name, parent: meta.parents[0], mimeType: meta.mimeType };
      files.push(f);
      return json({ id: f.id });
    }
    if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
      const body = init!.body as Buffer;
      const text = body.toString("latin1");
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(text)![1]);
      const pdfStart = text.indexOf("%PDF");
      const pdfEnd = text.lastIndexOf("\r\n--");
      const md5 = createHash("md5").update(body.subarray(pdfStart, pdfEnd)).digest("hex");
      const f = { id: `f${n++}`, name: meta.name, parent: meta.parents[0], mimeType: "application/pdf", md5 };
      files.push(f);
      return json({ id: f.id, name: f.name, webViewLink: `https://drive/${f.id}` });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

test("creates missing folders, skips identical files, never overwrites", async () => {
  const files: FakeFile[] = [{ id: "ins", name: "Insurance", parent: "root", mimeType: "application/vnd.google-apps.folder" }];
  const calls: string[] = [];
  const restore = fakeDrive(files, calls);
  try {
    const drive = await Drive.connect({ clientId: "c", clientSecret: "s", refreshToken: "r" });
    const folder = await drive.ensureFolder("My Drive/Insurance/Selective/2026");
    const sel = files.find((f) => f.name === "Selective")!;
    assert.equal(sel.parent, "ins", "reused the existing Insurance folder");
    assert.equal(files.find((f) => f.id === folder)!.name, "2026");

    const a = Buffer.from("%PDF-1.4 declarations A");
    const b = Buffer.from("%PDF-1.4 declarations B");
    const first = await drive.savePdf(folder, "Selective - Declarations - 2026-10-08", a);
    assert.equal(first.status, "saved");
    assert.equal(first.name, "Selective - Declarations - 2026-10-08.pdf");

    const again = await drive.savePdf(folder, "Selective - Declarations - 2026-10-08", a);
    assert.equal(again.status, "already_saved");
    assert.equal(again.id, first.id);

    const different = await drive.savePdf(folder, "Selective - Declarations - 2026-10-08", b);
    assert.equal(different.status, "saved");
    assert.equal(different.name, "Selective - Declarations - 2026-10-08 (2).pdf");

    assert.ok(!calls.some((c) => /^(PUT|PATCH|DELETE) /.test(c)), `no overwrite or delete: ${calls.join(", ")}`);
  } finally {
    restore();
  }
});
