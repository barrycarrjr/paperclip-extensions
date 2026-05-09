import { useState, type CSSProperties } from "react";

interface PlaceCallModalProps {
  assistantName: string;
  agentId: string;
  companyId: string;
  spent: number;
  cap: number;
  onClose: () => void;
  onPlaced: (callId: string) => void;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!/^\+[1-9]\d{6,14}$/.test(to.trim())) {
      setError("Phone must be in E.164 format, e.g. +15551234567.");
      return;
    }
    setSubmitting(true);
    try {
      const url = new URL(
        `/api/plugins/phone-tools/api/assistants/${agentId}/calls`,
        window.location.origin,
      );
      url.searchParams.set("companyId", companyId);
      const res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ to: to.trim(), calleeName: calleeName.trim(), objective: objective.trim() }),
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
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="e.g. Schedule the intro call. Suggest Tue 2pm or Wed 10:30am ET."
              rows={4}
              style={{ ...input, resize: "vertical", fontFamily: "inherit" }}
            />
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
