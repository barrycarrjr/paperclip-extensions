/**
 * Plain text of a PDF's first pages, via pdf.js (pure JavaScript, bundled).
 * Used only to find the policy period printed on a document.
 */
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";

// Run pdf.js's parser in this process instead of a separate worker file,
// which the bundled plugin does not ship.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfWorker;

export async function pdfText(bytes: Buffer, maxPages = 40): Promise<string> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    let out = "";
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      out += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
    }
    return out;
  } catch {
    return "";
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
