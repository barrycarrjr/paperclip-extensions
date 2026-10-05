/**
 * One review, and the reply box for it.
 *
 * The page never chooses where a reply goes: the "Posts as" line comes from
 * the worker, computed from the plugin's settings, and is not editable here.
 * Pressing "Post to Google" opens a confirm panel rather than posting; the
 * panel mints one idempotency key and every attempt from it, including a
 * retry after a lost connection, carries that key, so the worker can tell
 * one post from two. The Post button is not rendered at all when the worker
 * would refuse (switch off, wrong company, Google unreachable, an attempt
 * still pending, or a role that can only read); one sentence says why, and
 * the review, the suggested reply and the text box stay so the words can be
 * copied into Google's console by hand.
 */
// Only names the host's React stand-in re-exports may be imported here. The
// page is one module: a name the stand-in does not export fails at link time
// and the whole file never runs, so the page registers nothing and the host
// shows a placeholder. That is what happened in 0.1.10, which imported
// useReducer. reactImports.test.ts pins the list.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { usePluginAction, usePluginData, usePluginToast } from "@paperclipai/plugin-sdk/ui";
import {
  MAX_REPLY_LENGTH,
  canShowPostButton,
  clearDraft,
  confirmReady,
  draftStorageKey,
  formatTime,
  initialEditorState,
  postToast,
  readDraft,
  receiptSteps,
  reduceEditor,
  whyNoPostButton,
  writeDraft,
  type DraftStorage,
  type EditorEvent,
  type EditorState,
  type PostReceipt,
  type ReviewDetail,
} from "./editorState.js";
import { describeReplyError } from "./replyErrors.js";
import { ErrorNote, Note, Stars, cardStyle, css, disabledStyle, linkButton, mutedText, primaryButton, secondaryButton } from "./shared.js";

export interface ReviewEditorProps {
  companyId: string;
  companyPrefix: string | null;
  reviewName: string;
  /** Called after a successful post so the list and the dashboard refresh. */
  onPosted: () => void;
  onClose: () => void;
}

/** window.localStorage, or nothing when the browser blocks it (the accessor itself can throw). */
function browserStorage(): DraftStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The worker returns the receipt as-is; this only guards against a shape
 * the page does not expect, so a post that DID happen is never shown as a
 * failure because the receipt was odd.
 */
function toPostReceipt(raw: unknown, text: string): PostReceipt {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<PostReceipt>;
  return {
    postedAt: typeof r.postedAt === "string" ? r.postedAt : new Date().toISOString(),
    location: r.location && typeof r.location.displayName === "string" ? r.location : { key: "", displayName: "this location" },
    account: typeof r.account === "string" ? r.account : "the configured Google account",
    replyText: typeof r.replyText === "string" ? r.replyText : text,
    replaced: r.replaced === true,
    previousReplyText: typeof r.previousReplyText === "string" ? r.previousReplyText : null,
    issueId: typeof r.issueId === "string" ? r.issueId : null,
    recordedLocally: r.recordedLocally === true,
    alreadyPosted: r.alreadyPosted === true,
  };
}

export function ReviewEditor({ companyId, companyPrefix, reviewName, onPosted, onClose }: ReviewEditorProps) {
  const { data, loading, error, refresh } = usePluginData<ReviewDetail>("review-detail", { companyId, reviewName });
  const postReply = usePluginAction("review-post-reply");
  const toast = usePluginToast();

  const storage = useMemo(() => browserStorage(), []);
  const draftKey = draftStorageKey(companyId, reviewName);
  // useState plus a dispatch wrapper, not useReducer: the host's React
  // stand-in does not forward useReducer. reduceEditor is unchanged and still
  // decides every transition; the updater form hands it the newest state, so
  // this behaves exactly as the reducer hook did, including two dispatches in
  // one handler.
  const [state, setState] = useState<EditorState>(() => initialEditorState(readDraft(storage, draftKey)));
  const dispatch = useCallback((event: EditorEvent) => {
    setState((s) => reduceEditor(s, event));
  }, []);

  // Whatever is typed is kept in this browser until it is posted or cleared.
  useEffect(() => {
    if (state.stage === "posted") return;
    writeDraft(storage, draftKey, state.text);
  }, [storage, draftKey, state.text, state.stage]);

  function setText(text: string) {
    dispatch({ type: "textChanged", text });
  }

  async function post() {
    if (!data || state.stage === "posting" || !confirmReady(state, data)) return;
    const text = state.text.trim();
    const idempotencyKey = state.idempotencyKey;
    if (!idempotencyKey) return;
    dispatch({ type: "postStarted" });
    try {
      const raw = await postReply({
        companyId,
        reviewName,
        replyText: text,
        idempotencyKey,
        // The reply the person was shown, so the worker can refuse if
        // Google's copy changed underneath them.
        expectedReplyUpdateTime: data.liveReply?.updateTime ?? null,
        replaceExisting: data.liveReply !== null && state.replaceAcknowledged,
      });
      const receipt = toPostReceipt(raw, text);
      clearDraft(storage, draftKey);
      dispatch({ type: "postSucceeded", receipt });
      // The panel and the toast must agree. On a retry the worker finds the
      // attempt already landed and sends nothing, so announcing a fresh post
      // beside a panel saying nothing was sent would be one of them lying.
      toast({ ...postToast(receipt), tone: "success" });
      refresh();
      onPosted();
    } catch (err) {
      dispatch({ type: "postFailed", error: describeReplyError(err) });
    }
  }

  if (loading && !data) return <div style={cardStyle}><p style={mutedText}>Loading the review and checking Google...</p></div>;
  if (error && !data) return <div style={cardStyle}><ErrorNote>{describeReplyError(error)}</ErrorNote></div>;
  if (!data) return null;

  const { review } = data;
  const trimmedLength = state.text.trim().length;
  const tooLong = trimmedLength > MAX_REPLY_LENGTH;
  const showPost = canShowPostButton(data);
  const noPostReason = whyNoPostButton(data);
  const inPanel = state.stage === "confirming" || state.stage === "posting" || state.stage === "failed";

  return (
    <div style={{ ...cardStyle, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 16 }}>{review.reviewerName}</strong>
            <Stars rating={review.starRating} />
          </div>
          <div style={mutedText}>{formatTime(review.reviewTime)}</div>
        </div>
        <button type="button" onClick={onClose} style={{ ...linkButton, fontWeight: 400, fontSize: 13, color: css.muted }}>
          Close
        </button>
      </div>

      {review.reviewText ? (
        <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 14 }}>{review.reviewText}</p>
      ) : (
        <p style={{ ...mutedText, margin: 0 }}>No text, just the stars.</p>
      )}

      <ExistingReply detail={data} />

      {state.stage === "posted" && state.receipt ? (
        <Receipt receipt={state.receipt} companyPrefix={companyPrefix} onClose={onClose} />
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{data.postsAs}</div>

          {!inPanel && (
            <div style={{ display: "grid", gap: 8 }}>
              <textarea
                value={state.text}
                onChange={(e) => setText(e.target.value)}
                rows={7}
                placeholder="Write the reply here, or start from the suggested reply."
                style={textareaStyle}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={() => setText(data.suggestedReply)} style={secondaryButton}>
                  Start from the suggested reply
                </button>
                <span style={{ ...mutedText, color: tooLong ? css.danger : css.muted }}>
                  {trimmedLength} / {MAX_REPLY_LENGTH}
                </span>
              </div>
              {showPost ? (
                <div>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "enterConfirm" })}
                    disabled={trimmedLength === 0 || tooLong}
                    style={disabledStyle(primaryButton, trimmedLength === 0 || tooLong)}
                  >
                    Post to Google
                  </button>
                </div>
              ) : (
                noPostReason && <Note>{noPostReason}</Note>
              )}
            </div>
          )}

          {inPanel && (
            <ConfirmPanel
              state={state}
              detail={data}
              onBack={() => dispatch({ type: "backToEditing" })}
              onPublic={(value) => dispatch({ type: "setPublicAcknowledged", value })}
              onReplace={(value) => dispatch({ type: "setReplaceAcknowledged", value })}
              onPost={post}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * What is already on Google, said before the person types a word. The live
 * read is the truth; the local row is shown only when Google could not be
 * asked, and labelled as such.
 */
function ExistingReply({ detail }: { detail: ReviewDetail }) {
  const { liveChecked, liveReply, liveError, review } = detail;
  if (liveChecked && liveReply) {
    return (
      <div style={quoteStyle}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>
          Reply already on Google, updated {formatTime(liveReply.updateTime)}
        </div>
        <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 13 }}>{liveReply.text}</p>
      </div>
    );
  }
  if (liveChecked && !liveReply && review.replyText) {
    return (
      <div style={quoteStyle}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>
          Paperclip recorded a reply, but Google shows none right now. It may have been removed in Google's console.
        </div>
        <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 13 }}>{review.replyText}</p>
      </div>
    );
  }
  if (liveChecked) {
    return <div style={{ ...mutedText, fontWeight: 600 }}>Not replied yet on Google.</div>;
  }
  return (
    <div style={quoteStyle}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>Google could not be checked for an existing reply.</div>
      {liveError && <div style={{ ...mutedText, marginTop: 2 }}>{describeReplyError(liveError)}</div>}
      {review.replyText && (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6 }}>Reply recorded in Paperclip{review.replyTime ? ` on ${formatTime(review.replyTime)}` : ""}</div>
          <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 13 }}>{review.replyText}</p>
        </>
      )}
    </div>
  );
}

/**
 * Inline, not a modal: the review stays in view while the person reads the
 * exact words that are about to become public. "Yes, post it" lights up
 * only when every box is ticked, and is disabled while the post is in
 * flight so a double click is one attempt.
 */
function ConfirmPanel({
  state,
  detail,
  onBack,
  onPublic,
  onReplace,
  onPost,
}: {
  state: EditorState;
  detail: ReviewDetail;
  onBack: () => void;
  onPublic: (value: boolean) => void;
  onReplace: (value: boolean) => void;
  onPost: () => void;
}) {
  const replacing = detail.liveReply !== null;
  const ready = confirmReady(state, detail);
  const posting = state.stage === "posting";
  const text = state.text.trim();

  return (
    <div style={panelStyle}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{replacing ? "Replace the reply on Google?" : "Post this reply to Google?"}</div>

      {replacing ? (
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <div style={quoteStyle}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>On Google now</div>
            <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 13 }}>{detail.liveReply?.text}</p>
          </div>
          <div style={quoteStyle}>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Your reply</div>
            <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 13 }}>{text}</p>
          </div>
        </div>
      ) : (
        <div style={quoteStyle}>
          <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 13 }}>{text}</p>
        </div>
      )}

      <div style={{ fontSize: 13, fontWeight: 600 }}>{detail.postsAs}</div>
      <p style={{ margin: 0, fontSize: 13 }}>
        Anyone can read this on Google. Paperclip cannot take it down afterwards; only Google's console can.
      </p>

      <label style={checkboxRow}>
        <input type="checkbox" checked={state.publicAcknowledged} disabled={posting} onChange={(e) => onPublic(e.target.checked)} />
        <span>I understand this will be public</span>
      </label>
      {replacing && (
        <label style={checkboxRow}>
          <input type="checkbox" checked={state.replaceAcknowledged} disabled={posting} onChange={(e) => onReplace(e.target.checked)} />
          <span>Replace the reply that is already on Google</span>
        </label>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={onPost} disabled={!ready || posting} style={disabledStyle(primaryButton, !ready || posting)}>
          {posting ? "Posting..." : replacing ? "Replace the reply on Google" : "Yes, post it"}
        </button>
        <button type="button" onClick={onBack} disabled={posting} style={disabledStyle(secondaryButton, posting)}>
          Back to editing
        </button>
      </div>
      {state.stage === "failed" && state.error && <ErrorNote>{state.error}</ErrorNote>}
    </div>
  );
}

/** What actually happened, step by step, in the shape of the host's starter activation receipt. */
function Receipt({ receipt, companyPrefix, onClose }: { receipt: PostReceipt; companyPrefix: string | null; onClose: () => void }) {
  const steps = receiptSteps(receipt, companyPrefix);
  return (
    <div style={panelStyle}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{receipt.alreadyPosted ? "Already posted" : "Reply posted"}</div>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {steps.map((step) => (
          <li key={step.label} style={{ fontSize: 13, color: step.status === "done" ? css.fg : "#b45309" }}>
            <span aria-hidden="true">{step.status === "done" ? "✓" : "!"}</span> <strong>{step.label}.</strong> {step.detail}
            {step.href && (
              <>
                {" "}
                <a href={step.href} style={{ color: "inherit" }}>Open the task</a>
              </>
            )}
          </li>
        ))}
      </ul>
      <div style={quoteStyle}>
        <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 13 }}>{receipt.replyText}</p>
      </div>
      <div>
        <button type="button" onClick={onClose} style={secondaryButton}>Back to the list</button>
      </div>
    </div>
  );
}

const textareaStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: 10,
  border: "1px solid var(--input, #d1d5db)",
  borderRadius: 6,
  background: css.background,
  color: css.fg,
  fontSize: 14,
  fontFamily: "inherit",
  resize: "vertical",
};

const quoteStyle: CSSProperties = {
  padding: "10px 12px",
  borderLeft: "3px solid var(--border, #e5e7eb)",
  background: css.background,
  borderRadius: 4,
};

const panelStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  padding: 16,
  border: "1px solid color-mix(in oklab, var(--primary, #111827) 35%, transparent)",
  borderRadius: 8,
  background: css.background,
};

const checkboxRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  cursor: "pointer",
};
