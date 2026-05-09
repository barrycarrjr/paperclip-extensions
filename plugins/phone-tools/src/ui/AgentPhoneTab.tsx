import { useEffect, useState } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";
import { PlaceCallModal } from "./PlaceCallModal.js";
import { TestCallModal } from "./TestCallModal.js";

interface PhoneConfig {
  voice?: string;
  callerIdNumberId?: string;
  costCapDailyUsd?: number;
  enabled?: boolean;
  vapiAssistantId?: string;
  account?: string;
}

interface CostWindow {
  capUsd: number;
  todaySpentUsd: number;
}

interface AgentSummary {
  id: string;
  name: string;
  role: string;
}

interface PhoneStatus {
  isAssistant: boolean;
  agent: AgentSummary | null;
  config: PhoneConfig | null;
  today: CostWindow | null;
}

interface OperatorPhone {
  e164: string | null;
  verifiedAt: string | null;
}

export function AgentPhoneTab(_props: PluginDetailTabProps) {
  const host = useHostContext();
  const agentId = host.entityId ?? "";
  const status = usePluginData<PhoneStatus>("assistants.agent-phone-status", {
    companyId: host.companyId,
    agentId,
  });

  const [operatorPhone, setOperatorPhone] = useState<OperatorPhone | null>(null);
  useEffect(() => {
    if (!host.companyId) return;
    const url = new URL(
      "/api/plugins/phone-tools/api/operator-phone",
      window.location.origin,
    );
    url.searchParams.set("companyId", host.companyId);
    let cancelled = false;
    fetch(url.toString(), { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        if (body && typeof body === "object") setOperatorPhone(body as OperatorPhone);
      })
      .catch(() => {
        // best-effort; the modal can re-collect the number from the operator
      });
    return () => {
      cancelled = true;
    };
  }, [host.companyId]);

  const [placeCallOpen, setPlaceCallOpen] = useState(false);
  const [testCallOpen, setTestCallOpen] = useState(false);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);

  if (status.loading) {
    return <p style={{ fontSize: 13, color: "var(--muted-foreground)" }}>Loading phone capability…</p>;
  }
  const data = status.data;
  // Hide the tab content entirely on non-assistant agents (CEO/CFO/etc.).
  // The host renders the tab button from the manifest, but an empty pane is
  // less noisy than a placeholder and matches the plan §2 default.
  if (!data?.isAssistant) {
    return null;
  }

  const config = data.config;
  const today = data.today;
  const cap = today?.capUsd ?? 10;
  const spent = today?.todaySpentUsd ?? 0;
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const assistantName = data.agent?.name ?? "this assistant";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {!config && (
        <div style={{ padding: 12, border: "1px solid var(--border)", fontSize: 13 }}>
          Phone capability isn't configured for {assistantName} yet. Use the Assistant Builder
          wizard or the Configuration tab to set voice, caller ID, and a daily cap.
        </div>
      )}

      {config && (
        <div style={{ display: "grid", gap: 12, padding: 16, border: "1px solid var(--border)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 6, fontSize: 13 }}>
            <span style={{ color: "var(--muted-foreground)" }}>Voice</span>
            <span>{config.voice ?? "—"}</span>
            <span style={{ color: "var(--muted-foreground)" }}>Caller ID</span>
            <span style={{ fontFamily: "monospace" }}>{config.callerIdNumberId ?? "—"}</span>
            <span style={{ color: "var(--muted-foreground)" }}>Account</span>
            <span style={{ fontFamily: "monospace" }}>{config.account ?? "(default)"}</span>
            <span style={{ color: "var(--muted-foreground)" }}>Daily cap</span>
            <span>${cap.toFixed(2)}</span>
            <span style={{ color: "var(--muted-foreground)" }}>Spent today</span>
            <span>
              ${spent.toFixed(2)}
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
            </span>
            <span style={{ color: "var(--muted-foreground)" }}>Engine assistant</span>
            <span style={{ fontFamily: "monospace", fontSize: 11 }}>
              {config.vapiAssistantId ?? "—"}
            </span>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setPlaceCallOpen(true)}
              style={primaryButtonStyle}
            >
              📞 Have {assistantName} call someone
            </button>
            <button
              type="button"
              onClick={() => setTestCallOpen(true)}
              style={secondaryButtonStyle}
            >
              📲 Test on my phone
            </button>
          </div>
        </div>
      )}

      <RecentCallsList agentId={agentId} companyId={host.companyId ?? ""} />

      {placeCallOpen && (
        <PlaceCallModal
          assistantName={assistantName}
          agentId={agentId}
          companyId={host.companyId ?? ""}
          spent={spent}
          cap={cap}
          onClose={() => setPlaceCallOpen(false)}
          onPlaced={(callId) => {
            setActiveCallId(callId);
            setPlaceCallOpen(false);
          }}
        />
      )}
      {testCallOpen && (
        <TestCallModal
          assistantName={assistantName}
          agentId={agentId}
          companyId={host.companyId ?? ""}
          operatorPhone={operatorPhone?.e164 ?? null}
          onClose={() => setTestCallOpen(false)}
        />
      )}
      {activeCallId && (
        <TestCallModal
          assistantName={assistantName}
          agentId={agentId}
          companyId={host.companyId ?? ""}
          operatorPhone={null}
          existingCallId={activeCallId}
          onClose={() => setActiveCallId(null)}
        />
      )}
    </div>
  );
}

function RecentCallsList({ agentId, companyId }: { agentId: string; companyId: string }) {
  const calls = usePluginData<{ calls: Array<Record<string, unknown>> }>(
    "assistants.recent-calls",
    { companyId, agentId },
  );
  if (calls.loading) {
    return <p style={{ fontSize: 13, color: "var(--muted-foreground)" }}>Loading recent calls…</p>;
  }
  if (calls.error) {
    return <p style={{ fontSize: 13, color: "var(--destructive)" }}>{calls.error.message}</p>;
  }
  const list = calls.data?.calls ?? [];
  if (list.length === 0) {
    return (
      <div style={{ padding: 12, border: "1px solid var(--border)", fontSize: 13, color: "var(--muted-foreground)" }}>
        No calls yet. Place a test call above to see one here.
      </div>
    );
  }
  return (
    <div>
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: "8px 0" }}>Recent calls</h3>
      <div style={{ border: "1px solid var(--border)" }}>
        {list.map((call) => {
          const id = String(call.callId ?? call.id ?? "");
          const status = String(call.status ?? "—");
          const to = String(call.to ?? "—");
          const cost = typeof call.costUsd === "number" ? call.costUsd : null;
          const duration = typeof call.durationSec === "number" ? call.durationSec : null;
          return (
            <div
              key={id}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto auto auto",
                gap: 12,
                fontSize: 13,
                padding: "6px 12px",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ fontFamily: "monospace" }}>{to}</span>
              <span style={{ color: "var(--muted-foreground)" }}>{status}</span>
              <span style={{ color: "var(--muted-foreground)" }}>
                {duration != null ? `${duration}s` : "—"}
              </span>
              <span>{cost != null ? `$${cost.toFixed(2)}` : "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const primaryButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--foreground)",
  background: "var(--foreground)",
  color: "var(--background)",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
