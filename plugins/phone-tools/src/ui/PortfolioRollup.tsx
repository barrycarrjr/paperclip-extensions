import { useEffect, useState, type CSSProperties } from "react";

interface RollupEntry {
  companyId: string;
  companyName?: string;
  isPortfolioRoot?: boolean;
  campaigns: number;
  running: number;
  paused: number;
  todayDialed: number;
  todayQualified: number;
  todayTransferred: number;
  todayCostUsd: number;
}

interface RollupResponse {
  perCompany: RollupEntry[];
  totals: {
    companiesActive: number;
    campaigns: number;
    running: number;
    todayDialed: number;
    todayQualified: number;
    todayTransferred: number;
    todayCostUsd: number;
  };
}

export interface PortfolioRollupProps {
  companyId: string;
  onBack: () => void;
}

/**
 * Cross-LLC rollup of phone-campaign activity. Lives at the
 * Campaigns sidebar entry's "Portfolio" sub-view; most useful when
 * viewed from the HQ / portfolio-root company. Non-HQ callers see
 * a single-company degenerate rollup, which is harmless.
 */
export function PortfolioRollup({ companyId, onBack }: PortfolioRollupProps) {
  const [data, setData] = useState<RollupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    const url = new URL(
      "/api/plugins/phone-tools/api/campaigns/portfolio-rollup",
      window.location.origin,
    );
    url.searchParams.set("companyId", companyId);
    fetch(url.toString(), { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
              ? (body as { error: string }).error
              : `Request failed (${res.status})`,
          );
        }
        return body as RollupResponse;
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    // Refresh every 30s — rollup is a "background context" view, not
    // a real-time dashboard. The per-campaign detail view polls fast.
    const id = window.setInterval(() => {
      // Re-trigger by changing the cancelled flag indirectly via state.
      // Cheap: just kick off another fetch.
      void fetch(url.toString(), { credentials: "include" })
        .then((r) => r.json())
        .then((b) => {
          if (!cancelled) setData(b as RollupResponse);
        })
        .catch(() => {});
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [companyId]);

  return (
    <div style={stack}>
      <button type="button" onClick={onBack} style={ghostButton}>
        ← Back to my company's campaigns
      </button>

      {error && <div style={errBox}>{error}</div>}

      {data && (
        <>
          <section style={panel}>
            <h3 style={panelTitle}>Today across the portfolio</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
              <Stat label="Active LLCs" value={String(data.totals.companiesActive)} />
              <Stat label="Campaigns" value={`${data.totals.running} running / ${data.totals.campaigns} total`} />
              <Stat label="Dialed today" value={String(data.totals.todayDialed)} />
              <Stat label="Qualified" value={`${data.totals.todayQualified} (${data.totals.todayTransferred} transferred)`} />
              <Stat label="Cost today" value={`$${data.totals.todayCostUsd.toFixed(2)}`} />
            </div>
          </section>

          <section style={panel}>
            <h3 style={panelTitle}>Per-company breakdown</h3>
            {data.perCompany.length === 0 ? (
              <p style={muted}>No active campaigns across the portfolio today.</p>
            ) : (
              <table style={table}>
                <thead>
                  <tr style={trHead}>
                    <th style={thLeft}>Company</th>
                    <th style={th}>Campaigns</th>
                    <th style={th}>Running</th>
                    <th style={th}>Dialed today</th>
                    <th style={th}>Qualified</th>
                    <th style={th}>Cost today</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perCompany.map((c) => (
                    <tr key={c.companyId} style={trBody}>
                      <td style={tdLeft}>
                        <strong>{c.companyName ?? c.companyId}</strong>
                        {c.isPortfolioRoot && (
                          <span style={{ marginLeft: 6, fontSize: 10, padding: "1px 6px", border: "1px solid var(--border)" }}>
                            HQ
                          </span>
                        )}
                      </td>
                      <td style={td}>{c.campaigns}</td>
                      <td style={td}>{c.running}</td>
                      <td style={td}>{c.todayDialed}</td>
                      <td style={td}>
                        {c.todayQualified} ({c.todayTransferred} transferred)
                      </td>
                      <td style={td}>${c.todayCostUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {data == null && !error && <p style={muted}>Loading rollup…</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ ...muted, fontSize: 11, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 16 };
const panel: CSSProperties = { padding: 16, border: "1px solid var(--border)" };
const panelTitle: CSSProperties = { margin: "0 0 12px", fontSize: 13, fontWeight: 600 };
const muted: CSSProperties = { color: "var(--muted-foreground)" };
const errBox: CSSProperties = {
  padding: 12,
  border: "1px solid var(--destructive, #f00)",
  color: "var(--destructive, #f00)",
  fontSize: 13,
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
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const trHead: CSSProperties = { borderBottom: "1px solid var(--border)" };
const trBody: CSSProperties = { borderBottom: "1px solid var(--border)" };
const th: CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--muted-foreground)",
};
const thLeft: CSSProperties = { ...th, paddingLeft: 0 };
const td: CSSProperties = { padding: "8px" };
const tdLeft: CSSProperties = { ...td, paddingLeft: 0 };
