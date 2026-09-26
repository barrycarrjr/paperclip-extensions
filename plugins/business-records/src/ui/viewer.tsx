/**
 * A full-screen viewer for the documents on a business, so reading one does
 * not mean leaving the page or downloading it. Shows PDFs and images inline,
 * the start of text files, and "no preview" for anything else (Word, Excel
 * and zip files would need a converter). Arrow keys step through the list,
 * Escape closes.
 */
import { useEffect, useState } from "react";
import type { DocumentApi } from "../domain.js";
import { Button } from "./_primitives.js";
import type { HostAttachment } from "./api.js";
import { formatDate, humanize } from "./format.js";

const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];
const TEXT_LIMIT = 256 * 1024;

export function previewKind(contentType: string | null | undefined): "pdf" | "image" | "text" | "none" {
  const type = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (TEXT_TYPES.includes(type)) return "text";
  return "none";
}

function TextBody({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setError(null);
    fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load the file (${res.status})`);
        const body = await res.text();
        setText(body.length > TEXT_LIMIT ? `${body.slice(0, TEXT_LIMIT)}\n\n(showing the start of the file)` : body);
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [url]);
  if (error) return <p className="p-4 text-sm text-red-300">{error}</p>;
  if (text === null) return <p className="p-4 text-sm text-white/70">Loading...</p>;
  return (
    <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background p-4 font-mono text-xs text-foreground">
      {text}
    </pre>
  );
}

export function DocumentViewer({
  documents,
  attachments,
  index,
  onIndexChange,
  onClose,
}: {
  documents: DocumentApi[];
  attachments: Record<string, HostAttachment>;
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const count = documents.length;
  const doc = documents[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && count > 1) onIndexChange((index + 1) % count);
      else if (e.key === "ArrowLeft" && count > 1) onIndexChange((index - 1 + count) % count);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, count, onClose, onIndexChange]);

  if (!doc) return null;
  const file = doc.attachmentRef ? attachments[doc.attachmentRef] : undefined;
  const url = doc.attachmentRef ? `/api/attachments/${encodeURIComponent(doc.attachmentRef)}/content` : null;
  const kind = previewKind(file?.contentType);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-4 px-5 py-3 text-sm text-white/80">
        <div className="min-w-0">
          <p className="truncate font-medium">{doc.title}</p>
          <p className="truncate text-xs text-white/50">
            {humanize(doc.docType)}
            {doc.documentDate ? `, dated ${formatDate(doc.documentDate)}` : ""}
            {file?.originalFilename ? `, ${file.originalFilename}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs tabular-nums text-white/40">
            {index + 1} / {count}
          </span>
          {url && (
            <a
              href={url}
              download={file?.originalFilename ?? doc.title}
              className="text-xs text-white/70 underline hover:text-white"
            >
              Download
            </a>
          )}
          <Button variant="ghost" size="sm" className="text-white/70 hover:text-white" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center gap-2 px-2 pb-6"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="flex w-16 shrink-0 justify-center">
          {count > 1 && (
            <Button
              variant="ghost"
              className="text-white/70 hover:text-white"
              onClick={() => onIndexChange((index - 1 + count) % count)}
              aria-label="Previous document"
            >
              Prev
            </Button>
          )}
        </div>
        <div className="flex h-full min-w-0 flex-1 items-center justify-center">
          {!url ? (
            <p className="text-sm text-white/70">This document has no file attached.</p>
          ) : kind === "pdf" ? (
            <iframe title={doc.title} src={url} className="h-full w-full rounded-lg border-0 bg-white" />
          ) : kind === "image" ? (
            <img src={url} alt={doc.title} className="max-h-full max-w-full rounded-lg object-contain" />
          ) : kind === "text" ? (
            <TextBody url={url} />
          ) : (
            <p className="text-sm text-white/70">No preview for this file type. Use Download to open it.</p>
          )}
        </div>
        <div className="flex w-16 shrink-0 justify-center">
          {count > 1 && (
            <Button
              variant="ghost"
              className="text-white/70 hover:text-white"
              onClick={() => onIndexChange((index + 1) % count)}
              aria-label="Next document"
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
