import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

interface AccountEntry {
  key: string;
  displayName: string;
}
interface AccountsResponse {
  accounts: AccountEntry[];
  defaultAccount: string | null;
}
interface PbxExtension {
  extension: string;
  displayName: string;
}
interface PbxExtensionsResponse {
  extensions: PbxExtension[];
  error?: string;
}
interface Recording {
  id: string;
  extension: string;
  from: string;
  receivedAt: string;
  durationSec: number;
  audioContentType: string;
  audioUrl: string;
}
interface RecordingListResponse {
  recordings: Recording[];
  nextCursor?: string;
  error?: string;
}

type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";
const PRESET_KEYS: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];
const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

interface Filters {
  account: string;
  extension: string;
  preset: DatePreset;
  customFrom: string;
  customTo: string;
}

const DEFAULT_FILTERS: Filters = {
  account: "",
  extension: "",
  preset: "mtd",
  customFrom: "",
  customTo: "",
};

/**
 * Recordings page.
 *
 * Filters: account picker (when multi-account), extension dropdown
 * (pulled from /xapi Users — every PBX user, sorted by extension), and
 * a date range — preset chips (mirroring the Portfolio Costs page) plus
 * a custom from/to. Default preset is Month to Date.
 *
 * Pagination is incremental: each fresh filter set fetches the first
 * page (50 rows); a "Load more" button uses the worker-returned
 * `nextCursor` to append the next page until exhausted.
 *
 * Audio for each row is fetched on play via the plugin's audio-proxy
 * route — the browser never sees the 3CX bearer token.
 */
export function RecordingsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [filters, setFilters] = useState<Filters>(() => readFiltersFromUrl());

  useEffect(() => {
    writeFiltersToUrl(filters);
  }, [filters]);

  // ── Accounts (rare to be >1, but the page handles it) ─────────────
  const accountsResult = usePluginData<AccountsResponse>("recordings.accounts", {
    companyId: host.companyId,
  });
  useEffect(() => {
    if (!filters.account && accountsResult.data?.defaultAccount) {
      setFilters((f) => ({ ...f, account: accountsResult.data!.defaultAccount! }));
    }
  }, [accountsResult.data?.defaultAccount, filters.account]);

  // ── Extensions for the dropdown ───────────────────────────────────
  const extensionsResult = usePluginData<PbxExtensionsResponse>(
    "recordings.pbx-extensions",
    { companyId: host.companyId },
  );

  // ── Resolved date range (driven by preset / custom inputs) ────────
  const { from, to, customReady } = useMemo(
    () => resolveRange(filters.preset, filters.customFrom, filters.customTo),
    [filters.preset, filters.customFrom, filters.customTo],
  );

  // ── Pagination state ──────────────────────────────────────────────
  // pages holds previously-loaded pages; current page comes from the
  // active usePluginData call below and is appended at render time.
  const [pages, setPages] = useState<Recording[][]>([]);
  const [pageCursor, setPageCursor] = useState<string | undefined>(undefined);

  // Reset pagination whenever any filter that affects the query changes.
  const filterKey = `${filters.account}|${filters.extension}|${from}|${to}`;
  const lastFilterKey = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey;
      setPages([]);
      setPageCursor(undefined);
    }
  }, [filterKey]);

  const listParams = useMemo(
    () => ({
      companyId: host.companyId,
      account: filters.account || undefined,
      extension: filters.extension || undefined,
      from: from || undefined,
      to: to || undefined,
      cursor: pageCursor,
    }),
    [host.companyId, filters.account, filters.extension, from, to, pageCursor],
  );

  const list = usePluginData<RecordingListResponse>("recordings.list", listParams);

  if (!host.companyId) {
    return (
      <div style={pageRoot}>
        <p style={muted}>No company in context.</p>
      </div>
    );
  }

  const accounts = accountsResult.data?.accounts ?? [];
  const allExtensions = extensionsResult.data?.extensions ?? [];
  const currentPage = list.data?.recordings ?? [];
  const accumulated = [...pages.flat(), ...currentPage];
  const listError = list.data?.error ?? null;
  const hasMore = !!list.data?.nextCursor;

  const onLoadMore = () => {
    if (!list.data?.nextCursor) return;
    setPages((p) => [...p, currentPage]);
    setPageCursor(list.data!.nextCursor);
  };

  return (
    <div style={pageRoot}>
      <header style={pageHeader}>
        <h1 style={heading}>🎙️ Recordings</h1>
        <button
          type="button"
          onClick={() => {
            setPages([]);
            setPageCursor(undefined);
            list.refresh();
          }}
          style={refreshBtn}
          title="Re-fetch from the first page"
        >
          ↻ Refresh
        </button>
      </header>

      {/* Date-range chips, mirroring Portfolio Costs. */}
      <div style={chipRow}>
        {PRESET_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilters((f) => ({ ...f, preset: key }))}
            style={filters.preset === key ? chipActive : chipIdle}
          >
            {PRESET_LABELS[key]}
          </button>
        ))}
        {filters.preset === "custom" && (
          <div style={customRange}>
            <input
              type="date"
              value={filters.customFrom}
              onChange={(e) =>
                setFilters((f) => ({ ...f, customFrom: e.target.value }))
              }
              style={dateInputStyle}
            />
            <span style={{ ...muted, fontSize: 12 }}>to</span>
            <input
              type="date"
              value={filters.customTo}
              onChange={(e) =>
                setFilters((f) => ({ ...f, customTo: e.target.value }))
              }
              style={dateInputStyle}
            />
          </div>
        )}
      </div>

      <div style={filterBar}>
        {accounts.length > 1 && (
          <label style={filterLabel}>
            Account
            <select
              value={filters.account}
              onChange={(e) =>
                setFilters((f) => ({ ...f, account: e.target.value }))
              }
              style={selectStyle}
            >
              {accounts.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        <label style={filterLabel}>
          Extension
          <select
            value={filters.extension}
            onChange={(e) =>
              setFilters((f) => ({ ...f, extension: e.target.value }))
            }
            style={{ ...selectStyle, minWidth: 220 }}
          >
            <option value="">Anyone</option>
            {allExtensions.map((e) => (
              <option key={e.extension} value={e.extension}>
                {e.displayName ? `${e.extension} — ${e.displayName}` : e.extension}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filters.preset === "custom" && !customReady && (
        <p style={muted}>Pick a start and end date.</p>
      )}
      {list.loading && accumulated.length === 0 && (
        <p style={muted}>Loading recordings…</p>
      )}
      {list.error && <p style={errorStyle}>Bridge error: {list.error.message}</p>}
      {listError && <p style={errorStyle}>{listError}</p>}
      {!list.loading && !list.error && !listError && accumulated.length === 0 && customReady && (
        <p style={muted}>
          No recordings in scope for the chosen filter
          {filters.extension && ` (extension ${filters.extension})`}.
        </p>
      )}

      {accumulated.length > 0 && (
        <ul style={listStyle}>
          {accumulated.map((rec) => (
            <RecordingRow key={rec.id} rec={rec} />
          ))}
        </ul>
      )}

      {accumulated.length > 0 && (
        <div style={paginationRow}>
          <span style={{ ...muted, fontSize: 12 }}>
            Showing {accumulated.length} recording{accumulated.length === 1 ? "" : "s"}
            {hasMore ? " (more available)" : " (end of results)"}
          </span>
          {hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={list.loading}
              style={loadMoreBtn}
            >
              {list.loading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RecordingRow({ rec }: { rec: Recording }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  async function loadAudio() {
    if (blobUrl || loadingAudio) return;
    setLoadingAudio(true);
    setAudioError(null);
    try {
      const res = await fetch(rec.audioUrl, { credentials: "same-origin" });
      if (!res.ok) {
        let detail = "";
        try {
          const j = (await res.json()) as { error?: string };
          detail = j.error ?? "";
        } catch {}
        throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
      }
      const body = (await res.json()) as { contentType: string; base64: string };
      const dataUrl = `data:${body.contentType};base64,${body.base64}`;
      const blob = await (await fetch(dataUrl)).blob();
      setBlobUrl(URL.createObjectURL(blob));
    } catch (err) {
      setAudioError((err as Error).message);
    } finally {
      setLoadingAudio(false);
    }
  }

  return (
    <li style={rowStyle}>
      <div style={rowMeta}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 14 }}>{rec.from || "Unknown caller"}</strong>
          <span style={muted}>→ ext {rec.extension}</span>
        </div>
        <div style={{ display: "flex", gap: 12, ...muted, fontSize: 12 }}>
          <span>{formatTimestamp(rec.receivedAt)}</span>
          <span>{formatDuration(rec.durationSec)}</span>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        {blobUrl ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <audio controls autoPlay src={blobUrl} style={{ width: "100%" }} />
        ) : (
          <button
            type="button"
            onClick={loadAudio}
            disabled={loadingAudio}
            style={playBtn}
          >
            {loadingAudio ? "Loading audio…" : "▶ Play"}
          </button>
        )}
        {audioError && <p style={errorStyle}>{audioError}</p>}
      </div>
    </li>
  );
}

// ─── Date resolution + URL persistence ────────────────────────────────

function resolveRange(
  preset: DatePreset,
  customFrom: string,
  customTo: string,
): { from: string; to: string; customReady: boolean } {
  const now = new Date();
  if (preset === "custom") {
    const ready = !!customFrom && !!customTo;
    const fromDate = customFrom ? new Date(customFrom + "T00:00:00") : null;
    const toDate = customTo ? new Date(customTo + "T23:59:59.999") : null;
    return {
      from: fromDate ? fromDate.toISOString() : "",
      to: toDate ? toDate.toISOString() : "",
      customReady: ready,
    };
  }
  const to = now.toISOString();
  switch (preset) {
    case "mtd": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d.toISOString(), to, customReady: true };
    }
    case "7d": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 0, 0, 0, 0);
      return { from: d.toISOString(), to, customReady: true };
    }
    case "30d": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 0, 0, 0, 0);
      return { from: d.toISOString(), to, customReady: true };
    }
    case "ytd": {
      const d = new Date(now.getFullYear(), 0, 1);
      return { from: d.toISOString(), to, customReady: true };
    }
    case "all":
      return { from: "", to: "", customReady: true };
  }
}

function readFiltersFromUrl(): Filters {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  const params = new URLSearchParams(window.location.search);
  const presetRaw = params.get("preset") ?? DEFAULT_FILTERS.preset;
  const preset = (PRESET_KEYS as string[]).includes(presetRaw)
    ? (presetRaw as DatePreset)
    : DEFAULT_FILTERS.preset;
  return {
    account: params.get("account") ?? DEFAULT_FILTERS.account,
    extension: params.get("extension") ?? DEFAULT_FILTERS.extension,
    preset,
    customFrom: params.get("from") ?? DEFAULT_FILTERS.customFrom,
    customTo: params.get("to") ?? DEFAULT_FILTERS.customTo,
  };
}

function writeFiltersToUrl(filters: Filters): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [k, v] of [
    ["account", filters.account],
    ["extension", filters.extension],
    ["preset", filters.preset === DEFAULT_FILTERS.preset ? "" : filters.preset],
    ["from", filters.preset === "custom" ? filters.customFrom : ""],
    ["to", filters.preset === "custom" ? filters.customTo : ""],
  ] as const) {
    if (v) params.set(k, v);
    else params.delete(k);
  }
  const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
  window.history.replaceState({}, "", next);
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(sec: number): string {
  if (!sec || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Inline styles (no CSS pipeline) ──────────────────────────────────

const pageRoot: CSSProperties = {
  padding: 24,
  maxWidth: 880,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};
const pageHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const heading: CSSProperties = { fontSize: 22, fontWeight: 600, margin: 0, flex: 1 };
const refreshBtn: CSSProperties = {
  border: "1px solid rgba(127,127,127,0.3)",
  background: "transparent",
  color: "inherit",
  padding: "4px 10px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
const chipRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  paddingBottom: 8,
  borderBottom: "1px solid rgba(127,127,127,0.15)",
};
const chipBase: CSSProperties = {
  border: "1px solid rgba(127,127,127,0.25)",
  padding: "4px 10px",
  borderRadius: 999,
  cursor: "pointer",
  fontSize: 12,
  color: "inherit",
  background: "transparent",
};
const chipActive: CSSProperties = {
  ...chipBase,
  background: "rgba(127,127,127,0.18)",
  borderColor: "rgba(127,127,127,0.45)",
  fontWeight: 600,
};
const chipIdle: CSSProperties = { ...chipBase };
const customRange: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginLeft: 8,
  border: "1px solid rgba(127,127,127,0.25)",
  borderRadius: 6,
  padding: "2px 6px",
};
const dateInputStyle: CSSProperties = {
  background: "transparent",
  color: "inherit",
  border: "none",
  outline: "none",
  fontSize: 12,
  padding: 2,
};
const filterBar: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: 16,
  padding: "8px 0",
  borderBottom: "1px solid rgba(127,127,127,0.15)",
};
const filterLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "var(--muted-foreground, #6b7280)",
};
const selectStyle: CSSProperties = {
  border: "1px solid rgba(127,127,127,0.3)",
  background: "transparent",
  color: "inherit",
  padding: "4px 8px",
  borderRadius: 6,
  fontSize: 13,
};
const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const rowStyle: CSSProperties = {
  border: "1px solid rgba(127,127,127,0.2)",
  borderRadius: 8,
  padding: 12,
  background: "rgba(127,127,127,0.04)",
};
const rowMeta: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 8,
};
const playBtn: CSSProperties = {
  border: "1px solid rgba(127,127,127,0.3)",
  background: "transparent",
  color: "inherit",
  padding: "6px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
const paginationRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  paddingTop: 8,
  borderTop: "1px solid rgba(127,127,127,0.15)",
};
const loadMoreBtn: CSSProperties = {
  border: "1px solid rgba(127,127,127,0.3)",
  background: "transparent",
  color: "inherit",
  padding: "6px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
};
const muted: CSSProperties = { color: "var(--muted-foreground, #6b7280)" };
const errorStyle: CSSProperties = {
  color: "#dc2626",
  fontSize: 13,
  margin: "8px 0 0 0",
};
