/**
 * Tests for the reply editor's decisions.
 *
 * The dangerous directions: showing a Post button the worker would refuse,
 * letting "Yes, post it" light up before every tick, and handing the worker
 * a fresh idempotency key on a retry so a post that did land goes twice.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  MAX_REPLY_LENGTH,
  approvalByline,
  canOfferApproval,
  canShowPostButton,
  canShowSkipButton,
  hasAnyReply,
  isSkipped,
  clearDraft,
  confirmReady,
  defaultMintKey,
  draftStorageKey,
  initialEditorState,
  locationRatingLabel,
  locationReplyBadge,
  postToast,
  readDraft,
  receiptSteps,
  reduceEditor,
  replyStatusLabel,
  whyNoPostButton,
  writeDraft,
  type EditorState,
  type PostReceipt,
  type ReviewDetail,
} from "./editorState.js";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

function detail(overrides: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    review: {
      reviewName: "accounts/1/locations/2/reviews/r1",
      reviewerName: "Pat",
      starRating: 5,
      reviewText: "Great",
      replyText: null,
      replyTime: null,
      replySource: null,
      reviewTime: "2026-09-01T10:00:00.000Z",
      issueId: "issue-1",
    },
    liveReply: null,
    liveChecked: true,
    liveError: null,
    suggestedReply: "Thank you",
    postsAs: "Posts as: Main St Store, using the Google account owner@example.com",
    posting: { enabled: true, accountFound: true, accountAllowed: true },
    canPostFromHere: true,
    isRollup: false,
    pendingAttempt: null,
    issueId: "issue-1",
    ...overrides,
  };
}

function keys(): { mint: () => string; minted: string[] } {
  const minted: string[] = [];
  return {
    minted,
    mint: () => {
      const key = `key-${minted.length + 1}`;
      minted.push(key);
      return key;
    },
  };
}

// ---------------------------------------------------------------------------
// Post button
// ---------------------------------------------------------------------------

test("canShowPostButton is true only when every condition holds", () => {
  assert.equal(canShowPostButton(detail()), true);
  assert.equal(canShowPostButton(detail({ posting: { enabled: false, accountFound: true, accountAllowed: true } })), false);
  assert.equal(canShowPostButton(detail({ posting: { enabled: true, accountFound: true, accountAllowed: false } })), false);
  assert.equal(
    canShowPostButton(detail({ posting: { enabled: true, accountFound: false, accountAllowed: false, accountKey: "main" } })),
    false,
  );
  assert.equal(canShowPostButton(detail({ canPostFromHere: false, isRollup: true })), false);
  assert.equal(canShowPostButton(detail({ liveChecked: false, liveError: "[EAUTH] no" })), false);
  assert.equal(
    canShowPostButton(detail({ pendingAttempt: { createdAt: "2026-09-01T10:00:00.000Z", status: "posting" } })),
    false,
  );
});

test("whyNoPostButton returns one plain sentence per reason, and none when the button may show", () => {
  assert.equal(whyNoPostButton(detail()), null);

  const reasons = [
    whyNoPostButton(detail({ posting: { enabled: false, accountFound: true, accountAllowed: true } })),
    whyNoPostButton(detail({ canPostFromHere: false, isRollup: true })),
    whyNoPostButton(detail({ posting: { enabled: true, accountFound: true, accountAllowed: false } })),
    whyNoPostButton(detail({ liveChecked: false, liveError: "[EAUTH] no" })),
    whyNoPostButton(detail({ pendingAttempt: { createdAt: "2026-09-01T10:00:00.000Z", status: "unknown" } })),
  ];
  for (const sentence of reasons) {
    assert.ok(sentence && sentence.length > 0);
    assert.doesNotMatch(sentence, LONG_DASHES);
  }
  assert.match(reasons[0]!, /switched off in the plugin settings/);
  assert.match(reasons[1]!, /own company/);
  assert.match(reasons[2]!, /not allowed/);
  assert.match(reasons[3]!, /could not be checked/);
  assert.match(reasons[4]!, /did not finish/);
  // Five different reasons, five different sentences.
  assert.equal(new Set(reasons).size, 5);
});

test("a missing Google account is named as missing, not as refused by an allow-list", () => {
  // The account the location names is not in the settings at all. Telling
  // the reader it is "not allowed for this company" sends them looking for
  // an allow-list entry that cannot exist.
  const sentence = whyNoPostButton(
    detail({ posting: { enabled: true, accountFound: false, accountAllowed: false, accountKey: "main" } }),
  );
  assert.equal(
    sentence,
    "This location's Google account (main) is not in the plugin settings, so nothing can be posted from here.",
  );
  assert.doesNotMatch(sentence!, /not allowed/);
  assert.doesNotMatch(sentence!, LONG_DASHES);
});

test("a missing account with no key sent says so without inventing one", () => {
  const sentence = whyNoPostButton(detail({ posting: { enabled: true, accountFound: false, accountAllowed: false } }));
  assert.equal(
    sentence,
    "This location's Google account is not in the plugin settings, so nothing can be posted from here.",
  );
  assert.doesNotMatch(sentence!, /\(\)/, "no empty brackets where the key would have been");
  assert.doesNotMatch(sentence!, LONG_DASHES);
});

test("the missing-account sentence comes before the allow-list one", () => {
  const missing = whyNoPostButton(
    detail({ posting: { enabled: true, accountFound: false, accountAllowed: false, accountKey: "main" } }),
  );
  const refused = whyNoPostButton(detail({ posting: { enabled: true, accountFound: true, accountAllowed: false } }));
  assert.match(missing!, /not in the plugin settings/);
  assert.match(refused!, /not allowed for this company/);
  assert.notEqual(missing, refused);
});

test("the master switch is the first reason given, even from the roll-up", () => {
  const sentence = whyNoPostButton(detail({ posting: { enabled: false, accountFound: true, accountAllowed: false }, canPostFromHere: false }));
  assert.match(sentence!, /switched off/);
});

test("replyStatusLabel says where a reply came from in plain words", () => {
  assert.equal(replyStatusLabel(null, null), "Not replied yet");
  assert.equal(replyStatusLabel("", "human"), "Not replied yet");
  assert.equal(replyStatusLabel("Thanks", "human"), "Replied from Paperclip");
  assert.equal(replyStatusLabel("Thanks", "agent"), "Replied by an agent");
  assert.equal(replyStatusLabel("Thanks", "google"), "Replied in Google");
  assert.equal(replyStatusLabel("Thanks", null), "Replied");
});

// ---------------------------------------------------------------------------
// Location cards
// ---------------------------------------------------------------------------

test("a location with no rating says so instead of gluing the fallback into the phrase", () => {
  assert.equal(locationRatingLabel(null), "No rating yet");
  assert.doesNotMatch(locationRatingLabel(null), /\/5 avg/);
  assert.match(locationRatingLabel(4.25), /4\.3\/5 avg$/);
  assert.doesNotMatch(locationRatingLabel(null), LONG_DASHES);
  assert.doesNotMatch(locationRatingLabel(4.25), LONG_DASHES);
});

test("a location with no reviews is not badged as all replied", () => {
  const empty = locationReplyBadge(0, 0);
  assert.equal(empty.label, "No reviews yet");
  assert.equal(empty.tone, "neutral");

  assert.deepEqual(locationReplyBadge(0, 12), { label: "All replied ✓", tone: "good" });
  assert.deepEqual(locationReplyBadge(1, 12), { label: "1 unreplied", tone: "warn" });
  assert.deepEqual(locationReplyBadge(3, 12), { label: "3 unreplied", tone: "bad" });
  for (const badge of [locationReplyBadge(0, 0), locationReplyBadge(0, 12), locationReplyBadge(4, 12)]) {
    assert.doesNotMatch(badge.label, LONG_DASHES);
  }
});

// ---------------------------------------------------------------------------
// The toast beside the receipt
// ---------------------------------------------------------------------------

test("the toast agrees with the receipt when nothing was sent twice", () => {
  const location = { key: "main-st", displayName: "Main St Store" };
  assert.deepEqual(postToast({ alreadyPosted: false, location }), {
    title: "Reply posted",
    body: "Posted as Main St Store.",
  });
  const retry = postToast({ alreadyPosted: true, location });
  assert.deepEqual(retry, {
    title: "Already posted",
    body: "Google already had this reply; nothing was sent twice.",
  });
  // The panel says nothing was sent; the toast must not announce a post.
  assert.doesNotMatch(retry.title, /^Reply posted$/);
  assert.doesNotMatch(retry.body, LONG_DASHES);
  assert.doesNotMatch(retry.title, LONG_DASHES);
});

// ---------------------------------------------------------------------------
// Confirm panel readiness
// ---------------------------------------------------------------------------

function confirming(text: string, ticks: Partial<Pick<EditorState, "publicAcknowledged" | "replaceAcknowledged">> = {}): EditorState {
  const { mint } = keys();
  const opened = reduceEditor(reduceEditor(initialEditorState(), { type: "textChanged", text }, mint), { type: "enterConfirm" }, mint);
  return { ...opened, ...ticks };
}

test("confirmReady is false until the public box is ticked", () => {
  assert.equal(confirmReady(confirming("Thanks"), detail()), false);
  assert.equal(confirmReady(confirming("Thanks", { publicAcknowledged: true }), detail()), true);
});

test("confirmReady also requires the replace box when a reply is already on Google", () => {
  const live = detail({ liveReply: { text: "Old", updateTime: "2026-09-01T09:00:00.000Z" } });
  assert.equal(confirmReady(confirming("Thanks", { publicAcknowledged: true }), live), false);
  assert.equal(confirmReady(confirming("Thanks", { publicAcknowledged: true, replaceAcknowledged: true }), live), true);
  // The replace tick alone is not enough either.
  assert.equal(confirmReady(confirming("Thanks", { replaceAcknowledged: true }), live), false);
});

test("confirmReady rejects empty and over-long text", () => {
  assert.equal(confirmReady({ ...confirming("x", { publicAcknowledged: true }), text: "   " }, detail()), false);
  assert.equal(confirmReady({ ...confirming("x", { publicAcknowledged: true }), text: "a".repeat(MAX_REPLY_LENGTH + 1) }, detail()), false);
  assert.equal(confirmReady({ ...confirming("x", { publicAcknowledged: true }), text: "a".repeat(MAX_REPLY_LENGTH) }, detail()), true);
});

test("confirmReady is false outside the confirm panel", () => {
  const { mint } = keys();
  const editing = reduceEditor(initialEditorState(), { type: "textChanged", text: "Thanks" }, mint);
  assert.equal(confirmReady({ ...editing, publicAcknowledged: true }, detail()), false);
});

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

test("one idempotencyKey per confirm open, reused across a retry", () => {
  const { mint, minted } = keys();
  let state = initialEditorState();
  state = reduceEditor(state, { type: "textChanged", text: "Thanks" }, mint);
  assert.equal(state.idempotencyKey, null, "no key until the panel opens");

  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  assert.equal(state.stage, "confirming");
  assert.equal(state.idempotencyKey, "key-1");

  state = reduceEditor(state, { type: "postStarted" }, mint);
  assert.equal(state.stage, "posting");
  state = reduceEditor(state, { type: "postFailed", error: "The connection dropped" }, mint);
  assert.equal(state.stage, "failed");
  assert.equal(state.error, "The connection dropped");
  assert.equal(state.idempotencyKey, "key-1", "a retry carries the same key");

  // Trying again straight from the failed panel keeps the key too.
  state = reduceEditor(state, { type: "postStarted" }, mint);
  assert.equal(state.idempotencyKey, "key-1");
  assert.deepEqual(minted, ["key-1"]);
});

test("the key survives closing and reopening the panel with the same text", () => {
  const { mint, minted } = keys();
  let state = initialEditorState();
  state = reduceEditor(state, { type: "textChanged", text: "Thanks" }, mint);
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  state = reduceEditor(state, { type: "backToEditing" }, mint);
  assert.equal(state.stage, "editing");
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  assert.equal(state.idempotencyKey, "key-1");
  assert.deepEqual(minted, ["key-1"]);
});

test("a new key is minted only when the text changes", () => {
  const { mint, minted } = keys();
  let state = initialEditorState();
  state = reduceEditor(state, { type: "textChanged", text: "Thanks" }, mint);
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  state = reduceEditor(state, { type: "postFailed", error: "no" }, mint);

  state = reduceEditor(state, { type: "textChanged", text: "Thanks a lot" }, mint);
  assert.equal(state.stage, "editing");
  assert.equal(state.error, null, "an edit clears the old failure");
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  assert.equal(state.idempotencyKey, "key-2");
  assert.deepEqual(minted, ["key-1", "key-2"]);

  // Whitespace-only changes are the same attempt.
  state = reduceEditor(state, { type: "textChanged", text: "  Thanks a lot \n" }, mint);
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  assert.equal(state.idempotencyKey, "key-2");
});

test("the ticks reset when the text changes and are kept on a plain retry", () => {
  const { mint } = keys();
  let state = initialEditorState();
  state = reduceEditor(state, { type: "textChanged", text: "Thanks" }, mint);
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  state = reduceEditor(state, { type: "setPublicAcknowledged", value: true }, mint);
  state = reduceEditor(state, { type: "setReplaceAcknowledged", value: true }, mint);
  state = reduceEditor(state, { type: "postFailed", error: "no" }, mint);
  assert.equal(state.publicAcknowledged, true);

  state = reduceEditor(state, { type: "textChanged", text: "Other" }, mint);
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  assert.equal(state.publicAcknowledged, false);
  assert.equal(state.replaceAcknowledged, false);
});

test("the panel cannot open on empty text and a success is final", () => {
  const { mint, minted } = keys();
  let state = initialEditorState();
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  assert.equal(state.stage, "reading");
  assert.deepEqual(minted, []);

  state = reduceEditor(state, { type: "textChanged", text: "Thanks" }, mint);
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  state = reduceEditor(state, { type: "postStarted" }, mint);
  const receipt: PostReceipt = {
    postedAt: "2026-09-01T10:00:00.000Z",
    location: { key: "main", displayName: "Main St Store" },
    account: "owner@example.com",
    replyText: "Thanks",
    replaced: false,
    previousReplyText: null,
    issueId: "issue-1",
    recordedLocally: true,
    alreadyPosted: false,
  };
  state = reduceEditor(state, { type: "postSucceeded", receipt }, mint);
  assert.equal(state.stage, "posted");
  assert.equal(reduceEditor(state, { type: "textChanged", text: "again" }, mint).stage, "posted");
  assert.equal(reduceEditor(state, { type: "enterConfirm" }, mint).stage, "posted");
});

test("a double click while posting changes nothing", () => {
  const { mint } = keys();
  let state = initialEditorState();
  state = reduceEditor(state, { type: "textChanged", text: "Thanks" }, mint);
  state = reduceEditor(state, { type: "enterConfirm" }, mint);
  state = reduceEditor(state, { type: "postStarted" }, mint);
  assert.equal(reduceEditor(state, { type: "postStarted" }, mint), state);
  assert.equal(reduceEditor(state, { type: "enterConfirm" }, mint), state);
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

test("drafts are keyed per company and review, and storage failures are swallowed", () => {
  assert.equal(draftStorageKey("company-a", "accounts/1/locations/2/reviews/r1"), "review-tools:draft:company-a:accounts/1/locations/2/reviews/r1");

  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  writeDraft(storage, "k", "hello");
  assert.equal(readDraft(storage, "k"), "hello");
  writeDraft(storage, "k", "");
  assert.equal(readDraft(storage, "k"), "", "an empty draft removes the entry");
  writeDraft(storage, "k", "again");
  clearDraft(storage, "k");
  assert.equal(store.has("k"), false);

  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.equal(readDraft(broken, "k"), "");
  assert.doesNotThrow(() => writeDraft(broken, "k", "x"));
  assert.doesNotThrow(() => clearDraft(broken, "k"));
  assert.equal(readDraft(undefined, "k"), "");
});

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

test("the receipt lists the steps and never calls a public post failed", () => {
  const base: PostReceipt = {
    postedAt: "2026-09-01T10:00:00.000Z",
    location: { key: "main", displayName: "Main St Store" },
    account: "owner@example.com",
    replyText: "Thanks",
    replaced: false,
    previousReplyText: null,
    issueId: "issue-1",
    recordedLocally: false,
    alreadyPosted: false,
  };
  const steps = receiptSteps(base, "ACME");
  assert.deepEqual(steps.map((s) => s.label), ["Checked Google for an existing reply", "Posted to Google", "Recorded in Paperclip", "Task"]);
  assert.equal(steps[1]!.status, "done");
  assert.match(steps[1]!.detail, /Main St Store using owner@example\.com/);
  assert.equal(steps[2]!.status, "note", "a failed local write is a note, not a failure");
  assert.match(steps[2]!.detail, /next sync/);
  assert.equal(steps[3]!.href, "/ACME/issues/issue-1");
  for (const step of steps) assert.doesNotMatch(`${step.label} ${step.detail}`, LONG_DASHES);

  const replaced = receiptSteps({ ...base, replaced: true, previousReplyText: "Old", recordedLocally: true, issueId: null }, null);
  assert.match(replaced[0]!.detail, /replace/);
  assert.equal(replaced[2]!.status, "done");
  assert.equal(replaced[3]!.href, undefined);
  assert.match(replaced[3]!.detail, /No task/);

  const again = receiptSteps({ ...base, alreadyPosted: true }, "ACME");
  assert.match(again[0]!.detail, /nothing was sent twice/);
});

test("an idempotency key can be minted without a secure context", () => {
  // Paperclip is commonly reached over plain http on a LAN name, where
  // crypto.randomUUID does not exist. Calling it there threw
  // "crypto.randomUUID is not a function" the moment somebody pressed Post,
  // and the whole Reviews page went to the error boundary.
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const install = (value: unknown) =>
    Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
  try {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    // A secure context: the built-in is used as before.
    install({ randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    assert.equal(defaultMintKey(), "11111111-1111-4111-8111-111111111111");

    // Plain http: randomUUID is gone, getRandomValues remains.
    let tick = 0;
    install({
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (i * 7 + 3 + tick) & 0xff;
        tick++;
        return a;
      },
    });
    const built = defaultMintKey();
    assert.match(built, uuid, "the fallback still looks like a version 4 UUID");
    assert.notEqual(built, defaultMintKey(), "a second panel gets a different key");

    // Nothing cryptographic at all: still a usable, unique-enough key.
    install(undefined);
    const bare = defaultMintKey();
    assert.ok(bare.length > 12);
    assert.notEqual(bare, defaultMintKey());
  } finally {
    if (real) Object.defineProperty(globalThis, "crypto", real);
  }
});

test("the receipt says what became of the task rather than always saying it is open", () => {
  const base: PostReceipt = {
    postedAt: "2026-10-22T00:41:27.000Z",
    location: { key: "main-st", displayName: "Main St Store" },
    account: "owner@example.test",
    replyText: "Thank you.",
    replaced: false,
    previousReplyText: null,
    issueId: "issue-1",
    recordedLocally: true,
    alreadyPosted: false,
  };
  const taskStep = (receipt: PostReceipt) => receiptSteps(receipt, "MME").find((s) => s.label === "Task")!;

  // The bug: a task the worker had just closed was still reported as open,
  // telling the person to go and close it themselves.
  const closed = taskStep({ ...base, issueClosed: true });
  assert.equal(closed.status, "done");
  assert.match(closed.detail, /Closed, because this review now has a reply/);
  assert.doesNotMatch(closed.detail, /yourself/);
  assert.equal(closed.href, "/MME/issues/issue-1");

  // Closing genuinely failed: the person does have something to do.
  const stillOpen = taskStep({ ...base, issueClosed: false });
  assert.equal(stillOpen.status, "note");
  assert.match(stillOpen.detail, /Still open/);
  assert.match(stillOpen.detail, /Close it yourself/);

  // An older worker sends no verdict; neither claim is made.
  const unknown = taskStep(base);
  assert.doesNotMatch(unknown.detail, /Closed, because/);
  assert.doesNotMatch(unknown.detail, /Still open/);

  // No task at all is unchanged.
  assert.match(taskStep({ ...base, issueId: null }).detail, /No task is linked/);

  for (const step of [closed, stillOpen, unknown]) assert.doesNotMatch(step.detail, LONG_DASHES);
});

// ── Don't reply, and a reply waiting for approval ──────────────────────────

function reviewWith(extra: Partial<ReviewDetail["review"]>): Pick<ReviewDetail, "review"> {
  return { review: { ...detail().review, ...extra } };
}

test("a skipped review says Not replying, and a reply wins over the skip", () => {
  assert.equal(replyStatusLabel(null, null, "2026-10-01T00:00:00Z"), "Not replying");
  assert.equal(replyStatusLabel("Thanks", "google", "2026-10-01T00:00:00Z"), "Replied in Google");
  assert.equal(replyStatusLabel(null, null, null), "Not replied yet");
});

test("Don't reply is offered only for an unanswered review, from its own company", () => {
  assert.equal(canShowSkipButton(detail()), true);
  // From HQ, or another company viewing it: no.
  assert.equal(canShowSkipButton(detail({ canPostFromHere: false })), false);
  // A reply on Google, or recorded when Google could not be read: no.
  assert.equal(canShowSkipButton(detail({ liveReply: { text: "Thanks", updateTime: "t" } })), false);
  assert.equal(canShowSkipButton(detail({ liveChecked: false, ...reviewWith({ replyText: "Thanks" }) })), false);
  // Already skipped: the undo is offered instead.
  const skipped = detail(reviewWith({ skippedAt: "2026-10-01T00:00:00Z" }));
  assert.equal(isSkipped(skipped), true);
  assert.equal(canShowSkipButton(skipped), false);
  // The posting switch is irrelevant: nothing goes to Google.
  assert.equal(canShowSkipButton(detail({ posting: { enabled: false, accountFound: true, accountAllowed: true } })), true);
});

test("a skipped review that has since been answered on Google is not shown as skipped", () => {
  const answered = detail({ ...reviewWith({ skippedAt: "2026-10-01T00:00:00Z" }), liveReply: { text: "Thanks", updateTime: "t" } });
  assert.equal(hasAnyReply(answered), true);
  assert.equal(isSkipped(answered), false);
});

test("a reply waiting for approval is offered only while the review still needs one, from its own company", () => {
  assert.equal(canOfferApproval(detail()), true);
  assert.equal(canOfferApproval(detail({ canPostFromHere: false })), false);
  assert.equal(canOfferApproval(detail({ liveReply: { text: "Thanks", updateTime: "t" } })), false);
  assert.equal(canOfferApproval(detail(reviewWith({ skippedAt: "2026-10-02T00:00:00Z" }))), false);
});

test("the approval byline names the agent when known and never carries long dashes", () => {
  const byline = approvalByline("2026-10-01T09:00:00Z", "Review agent");
  assert.match(byline, /^Drafted by Review agent on /);
  assert.equal(approvalByline(null, null), "Drafted by an agent");
  assert.doesNotMatch(byline, LONG_DASHES);
});

test("a location with nothing waiting but some reviews left unanswered on purpose is All handled, not All replied", () => {
  assert.deepEqual(locationReplyBadge(0, 12, 2), { label: "All handled ✓", tone: "good" });
  assert.deepEqual(locationReplyBadge(0, 12, 0), { label: "All replied ✓", tone: "good" });
  assert.deepEqual(locationReplyBadge(1, 12, 2), { label: "1 unreplied", tone: "warn" });
});
