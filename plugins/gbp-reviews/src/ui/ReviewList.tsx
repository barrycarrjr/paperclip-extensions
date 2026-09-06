/**
 * One location's reviews, newest first with the unreplied ones on top.
 *
 * Reads the local reviews table only (review-list). A review that so far
 * arrived by email has no row and no Google name, so it is not here; the
 * "Sync now" button is the honest way in, and it is only offered from the
 * location's own company because the sync files issues in that company.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { formatTime, replyStatusLabel, type EditorReview } from "./editorState.js";
import { describeReplyError } from "./replyErrors.js";
import { ErrorNote, Note, Stars, css, disabledStyle, mutedText, secondaryButton } from "./shared.js";

/** What review-list returns. Mirrors the worker's handler. */
interface ReviewListData {
  location: { key: string; displayName: string };
  account: { key: string; label: string };
  lastSyncedAt: string | null;
  canPostFromHere: boolean;
  isRollup: boolean;
  reviews: EditorReview[];
}

interface SyncResult {
  total: number;
  new: number;
  lastSyncedAt: string | null;
}

export interface ReviewListProps {
  companyId: string;
  locationKey: string;
  selectedReviewName: string | null;
  onOpenReview: (reviewName: string) => void;
  /** Called after a sync so the shell can refresh the dashboard counts. */
  onChanged: () => void;
  /** Bumped by the shell when something elsewhere (a post) changed the rows. */
  refreshKey: number;
}

export function ReviewList({ companyId, locationKey, selectedReviewName, onOpenReview, onChanged, refreshKey }: ReviewListProps) {
  // companyId is sent so the host can check it matches the company it
  // validated; the worker scopes on the host's own stamp, never on this.
  const { data, loading, error, refresh } = usePluginData<ReviewListData>("review-list", { companyId, locationKey });
  const sync = usePluginAction("review-sync-location");
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => {
    if (refreshKey > 0) refresh();
    // refresh is stable for the life of the hook; only the key matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  async function syncNow() {
    if (syncing) return;
    setSyncing(true);
    setSyncError(null);
    setSyncNote(null);
    try {
      const result = (await sync({ companyId, locationKey })) as Partial<SyncResult> | null;
      const added = typeof result?.new === "number" ? result.new : 0;
      setSyncNote(added === 1 ? "1 new review pulled in." : `${added} new reviews pulled in.`);
      refresh();
      onChanged();
    } catch (err) {
      setSyncError(describeReplyError(err));
    } finally {
      setSyncing(false);
    }
  }

  if (loading && !data) return <p style={mutedText}>Loading reviews...</p>;
  if (error && !data) return <ErrorNote>{describeReplyError(error)}</ErrorNote>;
  if (!data) return null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{data.location.displayName}</h2>
          <div style={mutedText}>
            Google account {data.account.label}. Last synced {data.lastSyncedAt ? formatTime(data.lastSyncedAt) : "never"}.
          </div>
        </div>
        {data.canPostFromHere ? (
          <div>
            <button
              type="button"
              onClick={syncNow}
              disabled={syncing}
              style={disabledStyle(secondaryButton, syncing)}
              title="Pull in reviews that arrived since the last sync, including ones that so far only came in by email."
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          </div>
        ) : (
          <span style={mutedText}>Sync now is available inside this location's own company.</span>
        )}
      </div>
      {syncNote && <Note>{syncNote}</Note>}
      {syncError && <ErrorNote>{syncError}</ErrorNote>}

      {data.reviews.length === 0 ? (
        <Note>No reviews are stored for this location yet. {data.canPostFromHere ? "Press Sync now to pull them in." : ""}</Note>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {data.reviews.map((review) => {
            const selected = review.reviewName === selectedReviewName;
            const unreplied = !review.replyText;
            return (
              <li key={review.reviewName}>
                <button
                  type="button"
                  onClick={() => onOpenReview(review.reviewName)}
                  aria-pressed={selected}
                  style={rowStyle(selected, unreplied)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <strong>{review.reviewerName}</strong>
                    <span style={mutedText}>{formatTime(review.reviewTime)}</span>
                  </div>
                  <div style={{ marginTop: 2 }}>
                    <Stars rating={review.starRating} />
                  </div>
                  {review.reviewText ? (
                    <p style={{ margin: "6px 0 0", fontSize: 13, whiteSpace: "pre-wrap" }}>{clip(review.reviewText, 240)}</p>
                  ) : (
                    <p style={{ ...mutedText, margin: "6px 0 0" }}>No text, just the stars.</p>
                  )}
                  <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: unreplied ? "#b45309" : css.muted }}>
                    {replyStatusLabel(review.replyText, review.replySource)}
                    {review.replyTime && !unreplied ? ` on ${formatTime(review.replyTime)}` : ""}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
}

function rowStyle(selected: boolean, unreplied: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: 12,
    borderRadius: 8,
    cursor: "pointer",
    color: "var(--card-foreground, inherit)",
    border: selected ? "1px solid var(--primary, #111827)" : css.border,
    // The unreplied tint sits on top of the theme's card surface so it reads
    // in both themes (see the v0.1.7 note in the README).
    background: unreplied ? "color-mix(in oklab, #f59e0b 14%, var(--card, #fffbeb))" : css.card,
    boxShadow: selected ? "0 0 0 2px color-mix(in oklab, var(--primary, #111827) 25%, transparent)" : "none",
  };
}
