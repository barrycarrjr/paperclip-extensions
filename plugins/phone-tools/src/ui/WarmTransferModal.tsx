import { useState, type CSSProperties } from "react";

/**
 * Warm-transfer config modal — surfaces the v0.4.0 transferTarget /
 * transferMessage / transferIssueProjectId fields so an operator can
 * configure warm transfer without curling the phone-config API.
 *
 * Posts to the same /api/plugins/phone-tools/api/assistants/:agentId/phone-config
 * endpoint that the wizard uses, but only sends the transfer-related
 * fields plus the required `voice` and `callerIdNumberId` (read from
 * the existing config — the API requires them on every POST).
 */
export interface WarmTransferModalProps {
  assistantName: string;
  agentId: string;
  companyId: string;
  voice: string;
  callerIdNumberId: string;
  currentTransferTarget: string | undefined;
  currentTransferMessage: string | undefined;
  currentTransferIssueProjectId: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}

export function WarmTransferModal({
  assistantName,
  agentId,
  companyId,
  voice,
  callerIdNumberId,
  currentTransferTarget,
  currentTransferMessage,
  currentTransferIssueProjectId,
  onClose,
  onSaved,
}: WarmTransferModalProps) {
  const [transferTarget, setTransferTarget] = useState(currentTransferTarget ?? "");
  const [transferMessage, setTransferMessage] = useState(currentTransferMessage ?? "");
  const [transferIssueProjectId, setTransferIssueProjectId] = useState(
    currentTransferIssueProjectId ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    const trimmed = transferTarget.trim();
    if (trimmed && !/^\+[1-9]\d{6,14}$/.test(trimmed)) {
      setError("Destination must be empty (to disable) or a valid E.164 number, e.g. +12154636348.");
      return;
    }
    setSubmitting(true);
    try {
      const url = new URL(
        `/api/plugins/phone-tools/api/assistants/${agentId}/phone-config`,
        window.location.origin,
      );
      url.searchParams.set("companyId", companyId);
      const res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        // Pass the current voice / callerIdNumberId so the API's
        // required-field guard passes — the engine projection step
        // re-creates the Vapi assistant with the new transferTarget
        // baked into model.tools.
        body: JSON.stringify({
          voice,
          callerIdNumberId,
          transferTarget: trimmed,
          transferMessage,
          transferIssueProjectId: transferIssueProjectId.trim(),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `Request failed (${res.status})`,
        );
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save warm-transfer config.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDisable() {
    setError(null);
    setSubmitting(true);
    try {
      const url = new URL(
        `/api/plugins/phone-tools/api/assistants/${agentId}/phone-config`,
        window.location.origin,
      );
      url.searchParams.set("companyId", companyId);
      const res = await fetch(url.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          voice,
          callerIdNumberId,
          transferTarget: "",
          transferMessage: "",
          transferIssueProjectId: "",
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
            ? (payload as { error: string }).error
            : `Request failed (${res.status})`,
        );
      }
      setTransferTarget("");
      setTransferMessage("");
      setTransferIssueProjectId("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable warm transfer.");
    } finally {
      setSubmitting(false);
    }
  }

  const hasExisting = !!currentTransferTarget;

  return (
    <Backdrop onClose={onClose}>
      <Modal title={`Warm transfer — ${assistantName}`} onClose={onClose}>
        <div style={stack}>
          <p style={hint}>
            When set, {assistantName} can hand the call off to a human by invoking its
            transferCall tool. Vapi places an outbound leg to this number and bridges the caller.
            Typically a DID on your 3CX PBX that routes to a human extension or queue.
          </p>

          <div style={field}>
            <label style={label}>Transfer destination (E.164)</label>
            <input
              type="tel"
              value={transferTarget}
              onChange={(e) => setTransferTarget(e.target.value)}
              placeholder="+12154636348"
              style={input}
            />
            <span style={hint}>Leave empty to disable warm transfer.</span>
          </div>

          <div style={field}>
            <label style={label}>Spoken handoff line (optional)</label>
            <input
              type="text"
              value={transferMessage}
              onChange={(e) => setTransferMessage(e.target.value)}
              placeholder="One moment, transferring you to a person who can help."
              style={input}
            />
            <span style={hint}>
              What the AI says right before the SIP bridge. Default is shown above as placeholder.
            </span>
          </div>

          <div style={field}>
            <label style={label}>Auto-file qualified leads to project (optional)</label>
            <input
              type="text"
              value={transferIssueProjectId}
              onChange={(e) => setTransferIssueProjectId(e.target.value)}
              placeholder="Paperclip project UUID"
              style={input}
            />
            <span style={hint}>
              On every transfer, a Paperclip issue with the transcript-so-far is filed here so the
              human picking up has full context. Leave empty if you'd rather subscribe to{" "}
              <code>plugin.phone-tools.call.transferred</code> from a skill and route manually.
            </span>
          </div>

          {error && <div style={{ color: "var(--destructive, #f00)", fontSize: 13 }}>{error}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
            {hasExisting ? (
              <button
                type="button"
                onClick={handleDisable}
                disabled={submitting}
                style={destructiveButton}
                title="Clear all warm-transfer fields and disable the transferCall tool on this assistant."
              >
                Disable
              </button>
            ) : (
              <span />
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" onClick={onClose} style={ghostButton}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || !transferTarget.trim()}
                style={primaryButton}
              >
                {submitting ? "Saving…" : "Save"}
              </button>
            </div>
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

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--background)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        width: 520,
        maxWidth: "90vw",
        padding: 18,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <button
          type="button"
          onClick={onClose}
          style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 12 };
const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const label: CSSProperties = { fontSize: 12, color: "var(--muted-foreground)" };
const hint: CSSProperties = { fontSize: 11, color: "var(--muted-foreground)" };
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
const destructiveButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--destructive, #f00)",
  background: "transparent",
  color: "var(--destructive, #f00)",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
