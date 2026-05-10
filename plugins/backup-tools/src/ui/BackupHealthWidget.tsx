import { usePluginData } from "@paperclipai/plugin-sdk/ui";

type DashboardHealth = {
  lastRun: { status: string; started_at: string; size_bytes: number | null } | null;
  nextRunAfter: string | null;
};

function statusColor(status: string | undefined) {
  if (!status) return "#9ca3af";
  if (status === "succeeded") return "#10b981";
  if (status === "partial") return "#f59e0b";
  return "#ef4444";
}

function timeAgo(iso: string | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const seconds = (Date.now() - then) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export function BackupHealthWidget() {
  const { data, loading } = usePluginData<DashboardHealth>("dashboard.health", {});

  if (loading) {
    return (
      <div style={{ padding: 12, fontSize: 13, color: "#6b7280" }}>
        Loading backup status…
      </div>
    );
  }

  const last = data?.lastRun ?? null;
  const next = data?.nextRunAfter ?? null;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: statusColor(last?.status),
          }}
        />
        <strong style={{ fontSize: 14 }}>Backups</strong>
      </div>
      <div style={{ fontSize: 13, color: "#374151" }}>
        Last run: <b>{last?.status ?? "never"}</b>
        {last?.started_at ? <> · {timeAgo(last.started_at)} · {formatSize(last.size_bytes)}</> : null}
      </div>
      <div style={{ fontSize: 12, color: "#6b7280" }}>
        Next scheduled: {next ? new Date(next).toUTCString() : "—"}
      </div>
    </div>
  );
}
