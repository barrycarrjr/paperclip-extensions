import { usePluginData, type PluginWidgetProps, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";

interface LocationSummary {
  locationKey: string;
  locationName: string;
  unreplied: number;
  avgRating: number | null;
  totalReviews: number;
}

interface ReviewSummaryData {
  locations: LocationSummary[];
  updatedAt: string;
}

export function ReviewSummaryWidget(_props: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<ReviewSummaryData>("review-summary");

  if (loading) return <div style={{ padding: "12px", color: "#888" }}>Loading GBP review data…</div>;
  if (error) return <div style={{ padding: "12px", color: "#c00" }}>GBP Reviews: {error.message}</div>;
  if (!data || data.locations.length === 0) {
    return (
      <div style={{ padding: "12px" }}>
        <strong>GBP Reviews</strong>
        <p style={{ color: "#888", marginTop: 4 }}>No locations configured.</p>
      </div>
    );
  }

  const totalUnreplied = data.locations.reduce((s, l) => s + l.unreplied, 0);

  return (
    <div style={{ padding: "12px", display: "grid", gap: "8px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <strong>GBP Reviews</strong>
        {totalUnreplied > 0 && (
          <span style={{
            background: totalUnreplied >= 3 ? "#ef4444" : "#f59e0b",
            color: "white",
            borderRadius: "12px",
            padding: "2px 8px",
            fontSize: "12px",
            fontWeight: 600,
          }}>
            {totalUnreplied} unreplied
          </span>
        )}
      </div>
      {data.locations.map((loc) => (
        <div key={loc.locationKey} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
          <span>{loc.locationName}</span>
          <span style={{ color: "#888" }}>
            {"⭐".repeat(Math.round(loc.avgRating ?? 0))} · {loc.unreplied} pending · {loc.totalReviews} total
          </span>
        </div>
      ))}
      <div style={{ fontSize: "11px", color: "#aaa" }}>
        Updated {data.updatedAt ? new Date(data.updatedAt).toLocaleString() : "never"}
      </div>
    </div>
  );
}

export function ReviewDashboardPage(_props: PluginPageProps) {
  const { data, loading, error } = usePluginData<ReviewSummaryData>("review-summary");

  return (
    <div style={{ padding: "24px", maxWidth: "900px" }}>
      <h1 style={{ marginBottom: "8px" }}>GBP Review Dashboard</h1>
      <p style={{ color: "#888", marginBottom: "24px" }}>
        Monitor and respond to Google Business Profile reviews across all portfolio locations.
      </p>

      {loading && <p>Loading review data…</p>}
      {error && <p style={{ color: "#c00" }}>Error: {error.message}</p>}

      {data && (
        <div style={{ display: "grid", gap: "16px" }}>
          {data.locations.map((loc) => (
            <div key={loc.locationKey} style={{
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
              padding: "16px",
              background: loc.unreplied > 0 ? "#fffbeb" : "#f9fafb",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ margin: 0 }}>{loc.locationName}</h3>
                <span style={{
                  background: loc.unreplied === 0 ? "#22c55e" : loc.unreplied >= 3 ? "#ef4444" : "#f59e0b",
                  color: "white",
                  borderRadius: "12px",
                  padding: "3px 10px",
                  fontSize: "13px",
                  fontWeight: 600,
                }}>
                  {loc.unreplied === 0 ? "All replied ✓" : `${loc.unreplied} unreplied`}
                </span>
              </div>
              <div style={{ marginTop: "8px", fontSize: "14px", color: "#6b7280", display: "flex", gap: "16px" }}>
                <span>{"⭐".repeat(Math.round(loc.avgRating ?? 0))} {loc.avgRating?.toFixed(1) ?? "—"}/5 avg</span>
                <span>{loc.totalReviews} total reviews</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {data?.locations.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px", color: "#888" }}>
          <p>No GBP locations configured yet.</p>
          <p style={{ fontSize: "13px" }}>
            Add locations in the plugin settings page to start tracking reviews.
          </p>
        </div>
      )}
    </div>
  );
}
