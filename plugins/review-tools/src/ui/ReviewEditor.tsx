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
  approvalByline,
  canOfferApproval,
  canShowPostButton,
  canShowSkipButton,
  clearDraft,
  confirmReady,
  draftStorageKey,
  formatTime,
  initialEditorState,
  isSkipped,
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
import {
  REJECT_NOTES,
  approvalsForReview,
  decideApproval,
  fetchPendingReplyApprovals,
  type PendingReplyApproval,
} from "./replyApprovals.js";
import {
  ErrorNote,
  Note,
  Stars,
  cardStyle,
  css,
  dangerButton,
  dangerOutlineButton,
  disabledStyle,
  linkButton,
  mutedText,
  primaryButton,
  secondaryButton,
} from "./shared.js";

export interface ReviewEditorProps {
  companyId: string;
  companyPrefix: string | null;
  reviewName: string;
  /**
   * Called after a successful post, and after "Don't reply" or its undo, so
   * the list and the dashboard refresh.
   */
  onPosted: () => void;
  onClose: () => void;
  /**
   * Whether to offer a way out of the editor. False on a task page, where
   * the editor is the tab and there is no list behind it to return to.
   */
  showClose?: boolean;
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
    ...(typeof r.issueClosed === "boolean" ? { issueClosed: r.issueClosed } : {}),
    recordedLocally: r.recordedLocally === true,
    alreadyPosted: r.alreadyPosted === true,
  };
}

export function ReviewEditor({ companyId, companyPrefix, reviewName, onPosted, onClose, showClose = true }: ReviewEditorProps) {
  const { data, loading, error, refresh } = usePluginData<ReviewDetail>("review-detail", { companyId, reviewName });
  const postReply = usePluginAction("review-post-reply");
  const generateReply = usePluginAction("review-generate-reply");
  const toast = usePluginToast();
  const [writing, setWriting] = useState(false);
  const [writeNote, setWriteNote] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const skipAction = usePluginAction("review-skip");
  const unskipAction = usePluginAction("review-unskip");
  // "Don't reply" asks first, inline like the post confirmation, so the
  // review stays in view while the person decides.
  const [skipStage, setSkipStage] = useState<"idle" | "confirming" | "working">("idle");
  const [skipError, setSkipError] = useState<string | null>(null);

  // Replies an agent drafted for this review that are waiting for approval.
  // Read from Paperclip's own approvals, so approving here is the same act
  // as approving from the approvals list.
  const [approvals, setApprovals] = useState<PendingReplyApproval[]>([]);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  // Set after Approve, until the review has been read again: the approvals
  // route says the approval was approved, not whether the reply then posted,
  // so the page checks Google before saying it did.
  const [verifyingApproval, setVerifyingApproval] = useState<{ id: string; before: ReviewDetail } | null>(null);
  const [approvalsKey, setApprovalsKey] = useState(0);

  useEffect(() => {
    let live = true;
    fetchPendingReplyApprovals(companyId)
      .then((all) => {
        if (!live) return;
        setApprovals(approvalsForReview(all, reviewName));
        setApprovalsError(null);
      })
      .catch((err) => {
        if (!live) return;
        setApprovals([]);
        setApprovalsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [companyId, reviewName, approvalsKey]);

  /**
   * Turn down every waiting approval for this review, because the person has
   * just settled it another way. Best effort: the reply tool would refuse a
   * late approval anyway (the review has a reply, or was skipped), so a
   * failure here leaves a card that cannot do harm, not a second post.
   */
  async function rejectWaitingApprovals(note: string) {
    const waiting = approvals;
    if (waiting.length === 0) return;
    await Promise.all(waiting.map((a) => decideApproval(a.approvalId, "reject", note).catch(() => null)));
    setApprovalsKey((k) => k + 1);
  }

  async function approve(approval: PendingReplyApproval) {
    if (approvalBusy) return;
    setApprovalBusy(approval.approvalId);
    setApprovalError(null);
    try {
      await decideApproval(approval.approvalId, "approve");
      if (data) setVerifyingApproval({ id: approval.approvalId, before: data });
      refresh();
      onPosted();
    } catch (err) {
      setApprovalError(describeReplyError(err));
    } finally {
      setApprovalBusy(null);
      setApprovalsKey((k) => k + 1);
    }
  }

  async function reject(approval: PendingReplyApproval) {
    if (approvalBusy) return;
    setApprovalBusy(approval.approvalId);
    setApprovalError(null);
    try {
      await decideApproval(approval.approvalId, "reject", REJECT_NOTES.rejected);
      toast({ title: "Reply rejected", body: "Nothing was posted. The review still needs a reply.", tone: "success" });
      onPosted();
    } catch (err) {
      setApprovalError(describeReplyError(err));
    } finally {
      setApprovalBusy(null);
      setApprovalsKey((k) => k + 1);
    }
  }

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
      void rejectWaitingApprovals(REJECT_NOTES.replaced);
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

  async function skip() {
    if (skipStage === "working") return;
    setSkipStage("working");
    setSkipError(null);
    try {
      const result = (await skipAction({ companyId, reviewName })) as { issueId?: string | null; issueClosed?: boolean } | null;
      setSkipStage("idle");
      void rejectWaitingApprovals(REJECT_NOTES.skipped);
      toast({
        title: "Not replying",
        body:
          result?.issueId && result.issueClosed === false
            ? "Moved to Not replying. Its task could not be closed automatically; close it yourself."
            : "Moved to Not replying. Undo it here with Reply after all.",
        tone: "success",
      });
      refresh();
      onPosted();
    } catch (err) {
      setSkipStage("confirming");
      setSkipError(describeReplyError(err));
    }
  }

  async function unskip() {
    if (skipStage === "working") return;
    setSkipStage("working");
    setSkipError(null);
    try {
      await unskipAction({ companyId, reviewName });
      setSkipStage("idle");
      toast({ title: "Needs a reply again", body: "The review is back in Needs a reply.", tone: "success" });
      refresh();
      onPosted();
    } catch (err) {
      setSkipStage("idle");
      setSkipError(describeReplyError(err));
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
  const skipped = isSkipped(data);
  const showSkip = canShowSkipButton(data);
  const offerApprovals = canOfferApproval(data);
  // Judged only on a fresh read of the review, never on the one from before
  // the approval, which would always say "no reply yet".
  const approvalOutcome =
    verifyingApproval && verifyingApproval.before !== data && !loading
      ? data.liveChecked && data.liveReply
        ? "posted"
        : "not-posted"
      : null;

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
        {showClose && (
          <button type="button" onClick={onClose} style={{ ...linkButton, fontWeight: 400, fontSize: 13, color: css.muted }}>
            Close
          </button>
        )}
      </div>

      {data.googleListingUrl && (
        <div style={{ fontSize: 13 }}>
          <a href={data.googleListingUrl} target="_blank" rel="noopener noreferrer" style={externalLink}>
            Open the listing on Google Maps
          </a>
          <span style={{ ...mutedText, marginLeft: 6 }}>
            then choose its Reviews tab. Google publishes no address that opens one review on its own.
          </span>
        </div>
      )}

      {review.reviewText ? (
        <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 14 }}>{review.reviewText}</p>
      ) : (
        <p style={{ ...mutedText, margin: 0 }}>No text, just the stars.</p>
      )}

      <ExistingReply detail={data} />

      {approvalOutcome === "posted" && (
        <Note>Approved. The reply is now on Google, and the review's task is closed.</Note>
      )}
      {approvalOutcome === "not-posted" && verifyingApproval && (
        <ErrorNote>
          Approved, but no reply is on Google yet, so Paperclip did not post it. The approval says why.{" "}
          {companyPrefix && (
            <a href={`/${companyPrefix}/approvals/${verifyingApproval.id}`} style={{ color: "inherit" }}>
              Open the approval
            </a>
          )}
        </ErrorNote>
      )}

      {state.stage === "posted" && state.receipt ? (
        <Receipt receipt={state.receipt} companyPrefix={companyPrefix} onClose={onClose} showClose={showClose} />
      ) : skipped ? (
        <SkippedPanel
          skippedAt={review.skippedAt ?? null}
          canUndo={data.canPostFromHere}
          working={skipStage === "working"}
          error={skipError}
          onUndo={unskip}
        />
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{data.postsAs}</div>

          {!inPanel && offerApprovals && approvals.length > 0 && (
            <ApprovalPanel
              approvals={approvals}
              canApprove={showPost}
              cannotApproveReason={noPostReason}
              busyId={approvalBusy}
              error={approvalError}
              companyPrefix={companyPrefix}
              textInBox={state.text.trim()}
              onApprove={approve}
              onEdit={(a) => setText(a.replyText)}
              onReject={reject}
            />
          )}
          {!inPanel && offerApprovals && approvalsError && (
            <p style={{ ...mutedText, margin: 0 }}>
              Could not check for a reply waiting for approval ({approvalsError}). The approvals list still has any there are.
            </p>
          )}

          {!inPanel && (
            <div style={{ display: "grid", gap: 8 }}>
              <textarea
                value={state.text}
                onChange={(e) => setText(e.target.value)}
                rows={7}
                placeholder="Write the reply here, or start from the suggested reply."
                style={textareaStyle}
              />
              {writeNote && <Note>{writeNote}</Note>}
              {writeError && <ErrorNote>{writeError}</ErrorNote>}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    disabled={writing}
                    style={disabledStyle(primaryButton, writing)}
                    title="Writes a reply for this review. You can edit it before posting; nothing is posted by this button."
                    onClick={async () => {
                      setWriting(true);
                      setWriteNote(null);
                      setWriteError(null);
                      try {
                        const result = (await generateReply({ companyId, reviewName, draft: state.text })) as {
                          text?: string;
                          source?: string;
                          note?: string;
                        };
                        if (typeof result?.text === "string" && result.text.trim()) setText(result.text);
                        if (result?.note) setWriteNote(result.note);
                      } catch (err) {
                        setWriteError(describeReplyError(err));
                      } finally {
                        setWriting(false);
                      }
                    }}
                  >
                    {writing ? "Writing..." : state.text.trim() ? "Improve this reply with AI" : "Write a reply with AI"}
                  </button>
                  <button type="button" onClick={() => setText(data.suggestedReply)} style={secondaryButton}>
                    Use the standard template
                  </button>
                </div>
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

          {!inPanel && showSkip && (
            <SkipControl
              stage={skipStage}
              error={skipError}
              onAsk={() => {
                setSkipError(null);
                setSkipStage("confirming");
              }}
              onCancel={() => {
                setSkipError(null);
                setSkipStage("idle");
              }}
              onConfirm={skip}
            />
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
 * A reply an agent drafted, waiting for approval, shown on the review it is
 * for. Approve does exactly what the approvals list's Approve does: the
 * drafted reply is posted, through the same guard as every other post.
 * Edit first puts the words in the box below, and posting from there turns
 * the approval down so it cannot post a second, older version later.
 */
function ApprovalPanel({
  approvals,
  canApprove,
  cannotApproveReason,
  busyId,
  error,
  companyPrefix,
  textInBox,
  onApprove,
  onEdit,
  onReject,
}: {
  approvals: PendingReplyApproval[];
  canApprove: boolean;
  cannotApproveReason: string | null;
  busyId: string | null;
  error: string | null;
  companyPrefix: string | null;
  textInBox: string;
  onApprove: (approval: PendingReplyApproval) => void;
  onEdit: (approval: PendingReplyApproval) => void;
  onReject: (approval: PendingReplyApproval) => void;
}) {
  return (
    <div style={approvalStyle}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>
        {approvals.length === 1 ? "A reply is waiting for your approval" : `${approvals.length} replies are waiting for your approval`}
      </div>
      {approvals.map((approval) => {
        const busy = busyId === approval.approvalId;
        const anyBusy = busyId !== null;
        const inBox = textInBox === approval.replyText;
        return (
          <div key={approval.approvalId} style={{ display: "grid", gap: 8 }}>
            <div style={mutedText}>
              {approvalByline(approval.createdAt, null)}
              {companyPrefix && (
                <>
                  {" "}
                  <a href={`/${companyPrefix}/approvals/${approval.approvalId}`} style={{ color: "inherit" }}>
                    Open the approval
                  </a>
                </>
              )}
            </div>
            <p style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 13 }}>{approval.replyText}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {canApprove && (
                <button
                  type="button"
                  onClick={() => onApprove(approval)}
                  disabled={anyBusy}
                  style={disabledStyle(primaryButton, anyBusy)}
                  title="Posts this reply to Google now, as written. Anyone can read it there."
                >
                  {busy ? "Working..." : "Approve and post to Google"}
                </button>
              )}
              <button
                type="button"
                onClick={() => onEdit(approval)}
                disabled={anyBusy || inBox}
                style={disabledStyle(secondaryButton, anyBusy || inBox)}
                title="Puts this reply in the box below to change before posting."
              >
                {inBox ? "In the reply box" : "Edit first"}
              </button>
              <button
                type="button"
                onClick={() => onReject(approval)}
                disabled={anyBusy}
                style={disabledStyle(secondaryButton, anyBusy)}
                title="Turns this reply down. Nothing is posted, and the review still needs a reply."
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
      {!canApprove && cannotApproveReason && <p style={{ ...mutedText, margin: 0 }}>{cannotApproveReason}</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/**
 * "Don't reply", set apart from the reply buttons and in the danger colour,
 * because it is a decision not to answer a customer rather than a way of
 * answering one. Pressing it asks first.
 */
function SkipControl({
  stage,
  error,
  onAsk,
  onCancel,
  onConfirm,
}: {
  stage: "idle" | "confirming" | "working";
  error: string | null;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (stage === "idle") {
    return (
      <div style={skipRow}>
        <span style={mutedText}>Better left unanswered, for example because a reply this late would do more harm than good?</span>
        <button type="button" onClick={onAsk} style={dangerOutlineButton}>
          Don't reply
        </button>
      </div>
    );
  }
  const working = stage === "working";
  return (
    <div style={skipPanelStyle}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Are you sure you don't want to reply to this review?</div>
      <p style={{ margin: 0, fontSize: 13 }}>
        It moves to Not replying and its task is closed. Agents will not reply to it, and any reply waiting for approval
        is turned down. Nothing is sent to Google, and you can undo this with Reply after all. If the customer edits
        their review, it comes back to Needs a reply by itself.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={onConfirm} disabled={working} style={disabledStyle(dangerButton, working)}>
          {working ? "Saving..." : "Yes, don't reply"}
        </button>
        <button type="button" onClick={onCancel} disabled={working} style={disabledStyle(secondaryButton, working)}>
          Cancel
        </button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** Where the reply box would be, for a review somebody chose not to answer. */
function SkippedPanel({
  skippedAt,
  canUndo,
  working,
  error,
  onUndo,
}: {
  skippedAt: string | null;
  canUndo: boolean;
  working: boolean;
  error: string | null;
  onUndo: () => void;
}) {
  return (
    <div style={{ ...quoteStyle, display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        Not replying{skippedAt ? `, decided ${formatTime(skippedAt)}` : ""}.
      </div>
      <p style={{ margin: 0, fontSize: 13 }}>
        Someone chose not to reply to this review. It is not counted as needing a reply, its task is closed, and agents
        will not reply to it.
      </p>
      {canUndo ? (
        <div>
          <button type="button" onClick={onUndo} disabled={working} style={disabledStyle(secondaryButton, working)}>
            {working ? "Saving..." : "Reply after all"}
          </button>
        </div>
      ) : (
        <p style={{ ...mutedText, margin: 0 }}>Open this location's own company to change this.</p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
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
const externalLink: CSSProperties = {
  color: "inherit",
  textDecoration: "underline",
  fontWeight: 600,
};

function Receipt({
  receipt,
  companyPrefix,
  onClose,
  showClose = true,
}: {
  receipt: PostReceipt;
  companyPrefix: string | null;
  onClose: () => void;
  showClose?: boolean;
}) {
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
        {showClose && (
          <button type="button" onClick={onClose} style={secondaryButton}>Back to the list</button>
        )}
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

const approvalStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  padding: "12px 14px",
  borderLeft: "3px solid var(--primary, #111827)",
  background: "color-mix(in oklab, var(--primary, #111827) 8%, var(--background, #ffffff))",
  borderRadius: 4,
};

const skipRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  paddingTop: 12,
  borderTop: css.border,
};

const skipPanelStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  padding: 16,
  border: "1px solid color-mix(in oklab, var(--destructive, #b91c1c) 45%, transparent)",
  borderRadius: 8,
  background: "color-mix(in oklab, var(--destructive, #b91c1c) 6%, var(--background, #ffffff))",
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
