import { useRef, useState, type CSSProperties, type ChangeEvent, type ClipboardEvent, type DragEvent } from "react";

interface PlaceCallModalProps {
  assistantName: string;
  agentId: string;
  companyId: string;
  spent: number;
  cap: number;
  onClose: () => void;
  onPlaced: (callId: string) => void;
}

interface AttachedImage {
  id: string;
  name: string;
  mediaType: string;
  base64: string;
  previewUrl: string;
  sizeBytes: number;
}

const MAX_ATTACHED_IMAGES = 8;
const MAX_IMAGE_BYTES = 9 * 1024 * 1024; // ~9 MB binary; host applies the same cap

function fileToAttached(file: File): Promise<AttachedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("expected data URL"));
        return;
      }
      const commaIdx = result.indexOf(",");
      if (commaIdx < 0) {
        reject(new Error("malformed data URL"));
        return;
      }
      const base64 = result.slice(commaIdx + 1);
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: file.name || "image",
        mediaType: file.type || "image/png",
        base64,
        previewUrl: result,
        sizeBytes: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function PlaceCallModal({
  assistantName,
  agentId,
  companyId,
  spent,
  cap,
  onClose,
  onPlaced,
}: PlaceCallModalProps) {
  const [to, setTo] = useState("");
  const [calleeName, setCalleeName] = useState("");
  const [objective, setObjective] = useState("");
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (incoming.length === 0) return;
    if (images.length + incoming.length > MAX_ATTACHED_IMAGES) {
      setError(`Up to ${MAX_ATTACHED_IMAGES} images per call.`);
      return;
    }
    for (const f of incoming) {
      if (f.size > MAX_IMAGE_BYTES) {
        setError(`"${f.name}" is over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB — try a smaller image.`);
        return;
      }
    }
    try {
      const attached = await Promise.all(incoming.map(fileToAttached));
      setImages((prev) => [...prev, ...attached]);
      setExtractedText(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read image.");
    }
  }

  function removeImage(id: string) {
    setImages((prev) => prev.filter((img) => img.id !== id));
    setExtractedText(null);
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void addFiles(e.dataTransfer.files);
    }
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      void addFiles(e.target.files);
    }
    e.target.value = "";
  }

  async function extractImageFacts(): Promise<string | null> {
    if (images.length === 0) return null;
    setExtracting(true);
    try {
      const url = new URL(
        `/api/plugins/phone-tools/api/assistants/${agentId}/calls/describe-attachments`,
        window.location.origin,
      );
      url.searchParams.set("companyId", companyId);
      const res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          objective: objective.trim() || undefined,
          images: images.map((img) => ({
            mediaType: img.mediaType,
            base64: img.base64,
            name: img.name,
          })),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string")
            ? (payload as { error: string }).error
            : `Image-describe failed (${res.status})`,
        );
      }
      const text = ((payload as { text?: string }).text ?? "").trim();
      setExtractedText(text || "(model returned no extractable facts)");
      return text || null;
    } finally {
      setExtracting(false);
    }
  }

  async function handleSubmit() {
    setError(null);
    if (!/^\+[1-9]\d{6,14}$/.test(to.trim())) {
      setError("Phone must be in E.164 format, e.g. +15551234567.");
      return;
    }
    setSubmitting(true);
    try {
      // If images are attached, extract facts first (unless already extracted)
      // and send them as `additionalContext` — a per-call system-prompt
      // addendum the assistant references but does NOT recite aloud. The
      // operator's typed `objective` still flows into the firstMessage
      // (`{the reason for call}` substitution) as the spoken opening line.
      let extractedContext: string | null = null;
      if (images.length > 0) {
        extractedContext = extractedText ?? (await extractImageFacts());
      }

      const url = new URL(
        `/api/plugins/phone-tools/api/assistants/${agentId}/calls`,
        window.location.origin,
      );
      url.searchParams.set("companyId", companyId);
      const res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          to: to.trim(),
          calleeName: calleeName.trim(),
          objective: objective.trim(),
          additionalContext: extractedContext ?? undefined,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string")
            ? (payload as { error: string }).error
            : `Request failed (${res.status})`,
        );
      }
      onPlaced(String((payload as { callId?: string }).callId ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place call.");
    } finally {
      setSubmitting(false);
    }
  }

  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;

  return (
    <Backdrop onClose={onClose}>
      <Modal title={`Have ${assistantName} call someone`} onClose={onClose}>
        <div style={stack}>
          <div style={field}>
            <label style={label}>Number</label>
            <input
              type="tel"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="+15551234567"
              style={input}
            />
          </div>
          <div style={field}>
            <label style={label}>Name (optional)</label>
            <input
              type="text"
              value={calleeName}
              onChange={(e) => setCalleeName(e.target.value)}
              placeholder="e.g. Bryon at Acme"
              style={input}
            />
          </div>
          <div style={field}>
            <label style={label}>What should {assistantName} accomplish?</label>
            <div
              onPaste={handlePaste}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              style={{
                border: dragOver
                  ? "1px dashed var(--foreground)"
                  : "1px solid var(--border)",
                background: dragOver ? "var(--muted)" : "transparent",
              }}
            >
              <textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                placeholder={
                  images.length === 0
                    ? "e.g. Schedule the intro call. Suggest Tue 2pm or Wed 10:30am ET.\n\nTip: paste, drop, or upload images and the AI will extract the facts for the call."
                    : "Optional — tell the AI what to focus on in the attached image(s)."
                }
                rows={4}
                style={{
                  ...input,
                  width: "100%",
                  boxSizing: "border-box",
                  border: "none",
                  background: "transparent",
                  resize: "vertical",
                  fontFamily: "inherit",
                  outline: "none",
                }}
              />
              {images.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    padding: "0 8px 8px",
                  }}
                >
                  {images.map((img) => (
                    <div
                      key={img.id}
                      style={{
                        position: "relative",
                        border: "1px solid var(--border)",
                        padding: 2,
                      }}
                    >
                      <img
                        src={img.previewUrl}
                        alt={img.name}
                        title={`${img.name} (${Math.round(img.sizeBytes / 1024)} KB)`}
                        style={{ display: "block", width: 64, height: 64, objectFit: "cover" }}
                      />
                      <button
                        type="button"
                        onClick={() => removeImage(img.id)}
                        title="Remove"
                        style={{
                          position: "absolute",
                          top: -8,
                          right: -8,
                          width: 18,
                          height: 18,
                          border: "1px solid var(--border)",
                          background: "var(--background)",
                          color: "var(--foreground)",
                          fontSize: 11,
                          lineHeight: 1,
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={ghostButton}
              >
                📎 Attach image
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileInputChange}
                style={{ display: "none" }}
              />
              {images.length > 0 && (
                <button
                  type="button"
                  onClick={() => void extractImageFacts()}
                  disabled={extracting}
                  style={ghostButton}
                  title="Preview the facts the AI will extract before placing the call"
                >
                  {extracting ? "Extracting…" : "👁 Preview extracted facts"}
                </button>
              )}
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                paste · drop · upload
              </span>
            </div>
            {extractedText !== null && (
              <pre
                style={{
                  marginTop: 6,
                  padding: 8,
                  border: "1px solid var(--border)",
                  background: "var(--muted)",
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  maxHeight: 160,
                  overflow: "auto",
                }}
              >
                {extractedText}
              </pre>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
            Today's spend on {assistantName}: ${spent.toFixed(2)} / ${cap.toFixed(2)}
            <span style={{
              display: "inline-block",
              width: 80,
              height: 6,
              marginLeft: 8,
              background: "var(--muted)",
              verticalAlign: "middle",
            }}>
              <span style={{
                display: "block",
                height: 6,
                width: `${pct}%`,
                background: pct > 90 ? "var(--destructive, #f00)" : "var(--foreground)",
              }} />
            </span>
          </div>
          {error && <div style={{ color: "var(--destructive, #f00)", fontSize: 13 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onClose} style={ghostButton}>Cancel</button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !to.trim()}
              style={primaryButton}
            >
              {submitting ? "Placing…" : "📞 Place call"}
            </button>
          </div>
        </div>
      </Modal>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      {children}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--background)",
      color: "var(--foreground)",
      border: "1px solid var(--border)",
      width: 480,
      maxWidth: "90vw",
      padding: 18,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <button type="button" onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}>✕</button>
      </div>
      {children}
    </div>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 10 };
const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const label: CSSProperties = { fontSize: 12, color: "var(--muted-foreground)" };
const input: CSSProperties = {
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  padding: "8px 10px",
  fontSize: 13,
};
const primaryButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--foreground)",
  background: "var(--foreground)",
  color: "var(--background)",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
const ghostButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
