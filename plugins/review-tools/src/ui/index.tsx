import { useEffect, useState, type CSSProperties } from "react";
import {
  useHostContext,
  usePluginData,
  type PluginWidgetProps,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { ReviewList } from "./ReviewList.js";
import { ReviewEditor } from "./ReviewEditor.js";
import { locationRatingLabel, locationReplyBadge, type BadgeTone } from "./editorState.js";
import { describeReplyError } from "./replyErrors.js";
import { ErrorNote, css, linkButton, mutedText } from "./shared.js";

interface LocationSummary {
  locationKey: string;
  locationName: string;
  unreplied: number;
  avgRating: number | null;
  totalReviews: number;
}

interface ReviewSummaryData {
  locations: LocationSummary[];
  /** True when this is HQ's cross-company roll-up rather than one company's. */
  isRollup?: boolean;
  updatedAt: string;
}

export function ReviewSummaryWidget(_props: PluginWidgetProps) {
  const host = useHostContext();
  // Same scoping as the full page. This widget had the identical unscoped
  // call, so wherever it was placed it showed every company's locations.
  const { data, loading, error } = usePluginData<ReviewSummaryData>("review-summary", {
    companyId: host.companyId,
  });

  if (loading) return <div style={{ padding: "12px", color: "#888" }}>Loading GBP review data…</div>;
  // The same mapper the page uses, so the widget never prints a bracketed
  // code such as [ESCOPE] at a person.
  if (error) {
    return (
      <div style={{ padding: "12px", display: "grid", gap: 8 }}>
        <strong>GBP Reviews</strong>
        <ErrorNote>{describeReplyError(error)}</ErrorNote>
      </div>
    );
  }
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

/**
 * The Reviews page: the location cards, then one location's reviews, then
 * one review with its reply box on the right.
 *
 * The host has no router for plugin-internal views, so the view lives in
 * React state and is mirrored into window.location.search (?location= and
 * ?review=) the way phone-tools does, so a reload and the browser's back
 * button land on the same screen.
 */
export function ReviewDashboardPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [view, setView] = useState<View>(() => readViewFromUrl());
  // Bumped after a post or a sync so the list re-reads its rows.
  const [listRefreshKey, setListRefreshKey] = useState(0);

  useEffect(() => {
    writeViewToUrl(view);
  }, [view]);

  useEffect(() => {
    const onPop = () => setView(readViewFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // companyId is sent so the host can check it matches the company it
  // validated; the worker scopes on the host's own stamp, never on this.
  const summary = usePluginData<ReviewSummaryData>("review-summary", {
    companyId: host.companyId,
  });
  const { data, loading, error } = summary;

  if (!host.companyId) {
    return (
      <div style={pageRoot}>
        <p style={mutedText}>Open this page inside a company to see its reviews.</p>
      </div>
    );
  }
  const companyId = host.companyId;

  const selectedLocation = view.locationKey
    ? data?.locations.find((l) => l.locationKey === view.locationKey) ?? null
    : null;

  function onPosted() {
    setListRefreshKey((k) => k + 1);
    summary.refresh();
  }

  return (
    <div style={pageRoot}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setView({})} style={linkButton} disabled={!view.locationKey}>
          GBP Reviews
        </button>
        {view.locationKey && (
          <>
            <span style={mutedText}>›</span>
            <button
              type="button"
              onClick={() => setView({ locationKey: view.locationKey })}
              style={linkButton}
              disabled={!view.reviewName}
            >
              {selectedLocation?.locationName ?? view.locationKey}
            </button>
          </>
        )}
        {view.reviewName && (
          <>
            <span style={mutedText}>›</span>
            <span>Reply</span>
          </>
        )}
      </header>

      {!view.locationKey && (
        <>
          <div>
            <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>GBP Review Dashboard</h1>
            <p style={{ ...mutedText, margin: 0 }}>
              {data?.isRollup
                ? "Every location across the portfolio, because you are viewing from HQ. Open a location to read its reviews; replies are posted from the location's own company."
                : "Locations belonging to the company you are viewing. Open a location to read and reply to its reviews."}
            </p>
          </div>

          {loading && !data && <p style={mutedText}>Loading review data...</p>}
          {error && !data && <ErrorNote>{describeReplyError(error)}</ErrorNote>}

          {data && data.locations.length > 0 && (
            <div style={{ display: "grid", gap: 12 }}>
              {data.locations.map((loc) => (
                <button
                  key={loc.locationKey}
                  type="button"
                  onClick={() => setView({ locationKey: loc.locationKey })}
                  style={locationCard(loc.unreplied > 0)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 16 }}>{loc.locationName}</h3>
                    <span style={badgeStyle(locationReplyBadge(loc.unreplied, loc.totalReviews).tone)}>
                      {locationReplyBadge(loc.unreplied, loc.totalReviews).label}
                    </span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 14, color: css.muted, display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <span>{locationRatingLabel(loc.avgRating)}</span>
                    <span>{loc.totalReviews} total reviews</span>
                    <span style={{ marginLeft: "auto", fontWeight: 600 }}>Open ›</span>
                  </div>
                </button>
              ))}
            </div>
          )}

          {data?.locations.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px", color: css.muted }}>
              <p>No GBP locations configured yet.</p>
              <p style={{ fontSize: "13px" }}>
                Add locations in the plugin settings page to start tracking reviews.
              </p>
            </div>
          )}
        </>
      )}

      {view.locationKey && (
        <div style={view.reviewName ? splitLayout : undefined}>
          <ReviewList
            companyId={companyId}
            locationKey={view.locationKey}
            selectedReviewName={view.reviewName ?? null}
            onOpenReview={(reviewName) => setView({ locationKey: view.locationKey, reviewName })}
            onChanged={() => summary.refresh()}
            refreshKey={listRefreshKey}
          />
          {view.reviewName && (
            // Keyed by the review so switching reviews starts a fresh editor
            // (its own draft, its own idempotency key).
            <ReviewEditor
              key={view.reviewName}
              companyId={companyId}
              companyPrefix={host.companyPrefix}
              reviewName={view.reviewName}
              onPosted={onPosted}
              onClose={() => setView({ locationKey: view.locationKey })}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface View {
  locationKey?: string;
  reviewName?: string;
}

function readViewFromUrl(): View {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const locationKey = params.get("location") ?? undefined;
  const reviewName = params.get("review") ?? undefined;
  if (!locationKey) return {};
  return reviewName ? { locationKey, reviewName } : { locationKey };
}

function writeViewToUrl(view: View): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("location");
  url.searchParams.delete("review");
  if (view.locationKey) url.searchParams.set("location", view.locationKey);
  if (view.locationKey && view.reviewName) url.searchParams.set("review", view.reviewName);
  window.history.replaceState({}, "", url.toString());
}

const pageRoot: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  maxWidth: 1200,
};

const splitLayout: CSSProperties = {
  display: "grid",
  gap: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
  alignItems: "start",
};

/**
 * The colour of a location card's badge. A location with no reviews gets a
 * grey badge, not a green one: green reads as "all done", which is a claim
 * about work that never existed.
 */
function badgeStyle(tone: BadgeTone): CSSProperties {
  const background = tone === "good" ? "#22c55e" : tone === "bad" ? "#ef4444" : tone === "warn" ? "#f59e0b" : "#9ca3af";
  return {
    background,
    color: "white",
    borderRadius: "12px",
    padding: "3px 10px",
    fontSize: "13px",
    fontWeight: 600,
  };
}

function locationCard(needsAttention: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    cursor: "pointer",
    border: "1px solid var(--border, #e5e7eb)",
    borderRadius: "8px",
    padding: "16px",
    // Tint the "needs attention" card off the amber accent rather than
    // painting a fixed near-white surface: a light card under the dark
    // theme put near-white text on a near-white background.
    background: needsAttention
      ? "color-mix(in oklab, #f59e0b 14%, var(--card, #fffbeb))"
      : "var(--card, #f9fafb)",
    color: "var(--card-foreground, inherit)",
    font: "inherit",
  };
}
