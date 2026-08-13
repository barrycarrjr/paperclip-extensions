import { useState } from "react";
import type { CSSProperties } from "react";
import {
  useHostContext,
  usePluginData,
  usePluginAction,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

type Tab = "overview" | "schedules" | "destinations" | "history" | "restore";

type Backup = {
  id: string;
  archive_uuid: string;
  cadence: string;
  schedule_id: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  size_bytes: number | null;
};

type Destination = { id: string; kind: string; label: string };

// Host theme tokens, with the old light-mode literals kept as fallbacks. These
// have to be tokens rather than fixed hexes: the page previously painted the
// selected tab in near-black, which is invisible against the dark theme's
// near-black page, so the tab you were actually on was the one you could not
// read. Anything that sets a colour here reads a token.
const css = {
  border: "1px solid var(--border, #e5e7eb)",
  hairline: "1px solid color-mix(in oklab, var(--border, #f3f4f6) 55%, transparent)",
  fg: "var(--foreground, #111827)",
  muted: "var(--muted-foreground, #6b7280)",
  card: "var(--card, #ffffff)",
  sunken: "var(--muted, #f3f4f6)",
  danger: "var(--destructive, #b91c1c)",
};

const primaryButton: CSSProperties = {
  padding: "8px 14px",
  background: "var(--primary, #111827)",
  color: "var(--primary-foreground, #ffffff)",
  border: "none",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};

const inputStyle: CSSProperties = {
  padding: 6,
  border: "1px solid var(--input, #d1d5db)",
  borderRadius: 4,
  background: "var(--background, #ffffff)",
  color: css.fg,
};

const cardStyle: CSSProperties = {
  border: css.border,
  background: css.card,
  padding: 16,
  borderRadius: 6,
};

function statusBadge(status: string) {
  const color = status === "succeeded" ? "#10b981" : status === "partial" ? "#f59e0b" : status === "running" ? "#3b82f6" : "#ef4444";
  return (
    <span
      style={{
        display: "inline-block",
        background: color,
        color: "white",
        padding: "2px 8px",
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function fmtSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export function BackupPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div style={{ padding: 24, color: css.fg }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Backups</h1>
      <p style={{ color: css.muted, fontSize: 14, marginBottom: 16 }}>
        System backup manager — encrypted snapshots fan out to your configured destinations.
      </p>

      <nav style={{ display: "flex", gap: 4, borderBottom: css.border, marginBottom: 16 }}>
        {(["overview", "schedules", "destinations", "history", "restore"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "page" : undefined}
            style={{
              padding: "8px 14px",
              border: "none",
              background: "transparent",
              fontSize: 14,
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? css.fg : css.muted,
              borderBottom: tab === t ? `2px solid ${css.fg}` : "2px solid transparent",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {t}
          </button>
        ))}
      </nav>

      {tab === "overview" && <OverviewTab companyId={host.companyId} />}
      {tab === "schedules" && <SchedulesTab />}
      {tab === "destinations" && <DestinationsTab companyId={host.companyId} />}
      {tab === "history" && <HistoryTab companyId={host.companyId} />}
      {tab === "restore" && <RestoreTab companyId={host.companyId} />}
    </div>
  );
}

function OverviewTab({ companyId: _companyId }: { companyId: string | null }) {
  const { data, loading, refresh } = usePluginData<{ lastRun: Backup | null; nextRunAfter: string | null }>(
    "dashboard.health",
    {},
  );
  const runNowAction = usePluginAction("backups.run-now");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (loading) return <div>Loading…</div>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
      <div style={cardStyle}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Last backup</h3>
        {data?.lastRun ? (
          <>
            <div>{statusBadge(data.lastRun.status)}</div>
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <div>Started: {new Date(data.lastRun.started_at).toLocaleString()}</div>
              <div>Size: {fmtSize(data.lastRun.size_bytes)}</div>
              <div>Cadence: {data.lastRun.cadence || "—"}</div>
            </div>
          </>
        ) : (
          <div style={{ color: css.muted, fontSize: 13 }}>No backups yet.</div>
        )}
      </div>

      <div style={cardStyle}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Next scheduled run</h3>
        <div style={{ fontSize: 13 }}>
          {data?.nextRunAfter ? new Date(data.nextRunAfter).toUTCString() : "—"}
        </div>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const result = await runNowAction({});
              setMsg(`Started: ${(result as { backupId?: string })?.backupId ?? "(see history)"}`);
              await refresh();
            } catch (err) {
              setMsg(err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          }}
          style={{
            ...primaryButton,
            marginTop: 12,
            cursor: busy ? "wait" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Running…" : "Run backup now"}
        </button>
        {msg && <div style={{ marginTop: 8, fontSize: 12, color: css.muted }}>{msg}</div>}
      </div>
    </div>
  );
}

function SchedulesTab() {
  return (
    <div style={{ fontSize: 13, color: css.muted }}>
      Schedules are configured on the plugin's <a href="/instance/settings/plugins/backup-tools">settings page</a>.
      This tab will surface schedule_state (last run, next run, consecutive failures) in v0.1.1.
    </div>
  );
}

function DestinationsTab({ companyId }: { companyId: string | null }) {
  const { data, loading } = usePluginData<{ destinations: Destination[] }>("destinations.list", { companyId });
  if (loading) return <div>Loading…</div>;
  const dests = data?.destinations ?? [];
  if (dests.length === 0) return <div>No destinations configured.</div>;
  return (
    <table style={{ width: "100%", fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: css.border }}>
          <th style={{ padding: 8 }}>ID</th>
          <th style={{ padding: 8 }}>Kind</th>
          <th style={{ padding: 8 }}>Label</th>
        </tr>
      </thead>
      <tbody>
        {dests.map((d) => (
          <tr key={d.id} style={{ borderBottom: css.hairline }}>
            <td style={{ padding: 8 }}>{d.id}</td>
            <td style={{ padding: 8 }}>{d.kind}</td>
            <td style={{ padding: 8 }}>{d.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HistoryTab({ companyId }: { companyId: string | null }) {
  const { data, loading } = usePluginData<{ backups: Backup[] }>("backups.list", { companyId });
  if (loading) return <div>Loading…</div>;
  const rows = data?.backups ?? [];
  if (rows.length === 0) return <div>No backups yet.</div>;
  return (
    <table style={{ width: "100%", fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: "left", borderBottom: css.border }}>
          <th style={{ padding: 8 }}>Started</th>
          <th style={{ padding: 8 }}>Cadence</th>
          <th style={{ padding: 8 }}>Status</th>
          <th style={{ padding: 8 }}>Size</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((b) => (
          <tr key={b.id} style={{ borderBottom: css.hairline }}>
            <td style={{ padding: 8 }}>{new Date(b.started_at).toLocaleString()}</td>
            <td style={{ padding: 8 }}>{b.cadence}</td>
            <td style={{ padding: 8 }}>{statusBadge(b.status)}</td>
            <td style={{ padding: 8 }}>{fmtSize(b.size_bytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RestoreTab({ companyId: _companyId }: { companyId: string | null }) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [destinationId, setDestinationId] = useState("");
  const [archiveKey, setArchiveKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const previewAction = usePluginAction("restore.preview");
  const applyAction = usePluginAction("restore.apply");

  const phraseOk = confirmPhrase === "RESTORE THIS INSTANCE";

  return (
    <div style={{ maxWidth: 640 }}>
      <div
        style={{
          background: "color-mix(in oklab, var(--destructive, #b91c1c) 14%, var(--background, #fef2f2))",
          border: "1px solid color-mix(in oklab, var(--destructive, #b91c1c) 45%, transparent)",
          padding: 12,
          borderRadius: 6,
          marginBottom: 16,
        }}
      >
        <strong style={{ color: css.danger }}>Destructive — instance-admin only.</strong>
        <div style={{ fontSize: 13, color: css.fg, marginTop: 4 }}>
          Restore overwrites the entire instance database. There is no undo. Make sure you have a fresh backup of the
          current state before applying.
        </div>
      </div>

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 1 — Pick archive</h3>
          <label style={{ fontSize: 13 }}>
            Destination ID:
            <input
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              style={{ ...inputStyle, marginLeft: 8 }}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            Archive key (e.g. paperclip-backups/20260509T030700-uuid.pcback):
            <input
              value={archiveKey}
              onChange={(e) => setArchiveKey(e.target.value)}
              style={{ ...inputStyle, marginLeft: 8, width: 400 }}
            />
          </label>
          <button
            disabled={!destinationId || !archiveKey}
            onClick={() => setStep(2)}
            style={{ ...primaryButton, opacity: !destinationId || !archiveKey ? 0.5 : 1 }}
          >
            Next
          </button>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 2 — Passphrase</h3>
          <label style={{ fontSize: 13 }}>
            Backup passphrase:
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              style={{ ...inputStyle, marginLeft: 8, width: 400 }}
            />
          </label>
          <button
            disabled={passphrase.length < 8}
            onClick={() => setStep(3)}
            style={{ ...primaryButton, opacity: passphrase.length < 8 ? 0.5 : 1 }}
          >
            Next
          </button>
        </div>
      )}

      {step === 3 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 3 — Preview</h3>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await previewAction({
                  destinationId, archiveKey, passphrase, conflictMode: "overwrite",
                });
                setResult(r);
                setStep(4);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
            style={{ ...primaryButton, opacity: busy ? 0.6 : 1 }}
          >
            {busy ? "Previewing…" : "Run preview"}
          </button>
          {error && <div style={{ color: css.danger, fontSize: 13 }}>{error}</div>}
        </div>
      )}

      {step === 4 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>Step 4 — Confirm</h3>
          {!!result && (
            <pre
              style={{
                background: css.sunken,
                color: css.fg,
                padding: 12,
                borderRadius: 6,
                fontSize: 11,
                overflow: "auto",
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
          <label style={{ fontSize: 13 }}>
            Type <code>RESTORE THIS INSTANCE</code> to enable apply:
            <input
              value={confirmPhrase}
              onChange={(e) => setConfirmPhrase(e.target.value)}
              style={{
                ...inputStyle,
                marginLeft: 8,
                borderColor: phraseOk ? "#10b981" : "var(--input, #d1d5db)",
                width: 400,
                fontFamily: "monospace",
              }}
            />
          </label>
          <button
            disabled={!phraseOk || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await applyAction({
                  destinationId, archiveKey, passphrase, conflictMode: "overwrite", confirmPhrase,
                });
                setResult(r);
                setStep(5);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            }}
            style={{
              ...primaryButton,
              background: css.danger,
              color: "var(--destructive-foreground, #ffffff)",
              opacity: !phraseOk || busy ? 0.5 : 1,
            }}
          >
            {busy ? "Restoring…" : "Apply restore"}
          </button>
          {error && <div style={{ color: css.danger, fontSize: 13 }}>{error}</div>}
        </div>
      )}

      {step === 5 && (
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: "#10b981" }}>Restore complete</h3>
          {!!result && (
            <pre
              style={{
                background: css.sunken,
                color: css.fg,
                padding: 12,
                borderRadius: 6,
                fontSize: 11,
                overflow: "auto",
              }}
            >
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
