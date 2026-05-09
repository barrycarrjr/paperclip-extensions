import { useEffect, useRef, useState, type CSSProperties } from "react";

interface TestCallModalProps {
  assistantName: string;
  agentId: string;
  companyId: string;
  operatorPhone: string | null;
  existingCallId?: string;
  onClose: () => void;
}

interface CallStatus {
  callId?: string;
  status?: string;
  durationSec?: number | null;
  costUsd?: number | null;
  endedAt?: string | null;
  endReason?: string | null;
}

interface TranscriptTurn {
  role?: "agent" | "caller" | string;
  text?: string;
  ts?: string;
}

interface TranscriptResp {
  transcript: { format: string; turns?: TranscriptTurn[]; text?: string };
}

const POLL_INTERVAL_MS = 3000;

export function TestCallModal({
  assistantName,
  agentId,
  companyId,
  operatorPhone,
  existingCallId,
  onClose,
}: TestCallModalProps) {
  const [phone, setPhone] = useState(operatorPhone ?? "");
  const [callId, setCallId] = useState<string | null>(existingCallId ?? null);
  const [status, setStatus] = useState<CallStatus | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    async function poll() {
      try {
        const statusUrl = new URL(
          `/api/plugins/phone-tools/api/assistants/${agentId}/calls/${callId}/status`,
          window.location.origin,
        );
        statusUrl.searchParams.set("companyId", companyId);
        const sRes = await fetch(statusUrl.toString(), { credentials: "include" });
        const sBody = await sRes.json().catch(() => null);
        if (!cancelled && sRes.ok) {
          setStatus((sBody as { status?: CallStatus }).status ?? null);
        }

        const transcriptUrl = new URL(
          `/api/plugins/phone-tools/api/assistants/${agentId}/calls/${callId}/transcript`,
          window.location.origin,
        );
        transcriptUrl.searchParams.set("companyId", companyId);
        const tRes = await fetch(transcriptUrl.toString(), { credentials: "include" });
        if (tRes.ok) {
          const tBody = (await tRes.json()) as TranscriptResp;
          if (!cancelled) setTurns(tBody.transcript?.turns ?? []);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    poll();
    pollRef.current = window.setInterval(poll, POLL_INTERVAL_MS) as unknown as number;
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [callId, agentId, companyId]);

  // Stop polling once the call ends.
  useEffect(() => {
    if (status?.status && ["ended", "failed", "no-answer", "busy", "canceled"].includes(status.status) && pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [status?.status]);

  async function startCall() {
    setError(null);
    if (!/^\+[1-9]\d{6,14}$/.test(phone.trim())) {
      setError("Enter a valid E.164 number first.");
      return;
    }
    setStarting(true);
    try {
      const url = new URL(
        `/api/plugins/phone-tools/api/assistants/${agentId}/phone-config/test`,
        window.location.origin,
      );
      url.searchParams.set("companyId", companyId);
      const res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ to: phone.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string")
            ? (body as { error: string }).error
            : `Request failed (${res.status})`,
        );
      }
      setCallId(String((body as { callId?: string }).callId ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to place test call.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <Modal title={callId ? `Test call to ${phone}` : `Test ${assistantName} on your phone`} onClose={onClose}>
        {!callId ? (
          <div style={stack}>
            <div style={field}>
              <label style={labelStyle}>Your phone number (E.164)</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+15551234567"
                style={inputStyle}
              />
            </div>
            {error && <div style={{ color: "var(--destructive, #f00)", fontSize: 13 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={onClose} style={ghostButton}>Cancel</button>
              <button type="button" onClick={startCall} disabled={starting} style={primaryButton}>
                {starting ? "Calling…" : "📞 Call me"}
              </button>
            </div>
          </div>
        ) : (
          <div style={stack}>
            <div style={{ display: "flex", gap: 12, fontSize: 13, color: "var(--muted-foreground)" }}>
              <span><Dot status={status?.status} /> {status?.status ?? "queued"}</span>
              {typeof status?.durationSec === "number" && <span>{status.durationSec}s</span>}
              {typeof status?.costUsd === "number" && <span>${status.costUsd.toFixed(2)}</span>}
            </div>
            <div style={{ border: "1px solid var(--border)", padding: 10, maxHeight: 320, overflow: "auto", fontSize: 13 }}>
              {turns.length === 0 ? (
                <p style={{ color: "var(--muted-foreground)", margin: 0 }}>
                  Waiting for transcript… (this can take 5–10s after the call connects)
                </p>
              ) : (
                turns.map((turn, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <strong style={{ color: turn.role === "agent" ? "var(--foreground)" : "var(--muted-foreground)" }}>
                      {turn.role === "agent" ? "AI" : "YOU"}:
                    </strong>{" "}
                    {turn.text ?? ""}
                  </div>
                ))
              )}
            </div>
            {error && <div style={{ color: "var(--destructive, #f00)", fontSize: 13 }}>{error}</div>}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={onClose} style={primaryButton}>
                {status?.status === "ended" ? "Close" : "End test call"}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </Backdrop>
  );
}

function Dot({ status }: { status: string | undefined }) {
  const color =
    status === "ended" || status === "in-progress" ? "#22c55e" :
    status === "failed" || status === "no-answer" || status === "busy" || status === "canceled" ? "#ef4444" :
    "#a1a1aa";
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        marginRight: 4,
      }}
    />
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
      width: 520,
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
const labelStyle: CSSProperties = { fontSize: 12, color: "var(--muted-foreground)" };
const inputStyle: CSSProperties = {
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
