/**
 * Tests for the error mapper.
 *
 * The bug this guards against is "[object Object]" on screen: the bridge
 * rejects with a plain object, not an Error. The other thing pinned here is
 * that every sentence a person can read is free of long dashes.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { describeReplyError, isAccessRefusal } from "./replyErrors.js";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

test("a worker refusal with a known code maps to its sentence", () => {
  const sentence = describeReplyError({
    code: "WORKER_ERROR",
    message: "[EREPLY_CHANGED] The reply on Google changed since you opened this review. Open it again to see the current reply.",
  });
  assert.match(sentence, /changed since you opened this review/);
  assert.doesNotMatch(sentence, /\[EREPLY_CHANGED\]/, "the code is not shown to a person");

  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EREPLY_EXISTS] A reply is already on Google" }), /already on Google/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EDUPLICATE_IN_PROGRESS] x" }), /already being posted/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EPOST_UNCONFIRMED] x" }), /will not post twice/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EACCOUNT_NOT_FOUND] x" }), /not in the plugin settings/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EREPLIES_DISABLED] x" }), /switched off/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EROLLUP_READ_ONLY] x" }), /own company/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[ESCOPE] x" }), /inside a company/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EREVIEW_NOT_FOUND] x" }), /Sync now/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[ELOCATION_NOT_FOUND] x" }), /plugin settings/);
});

test("the unconfirmed-post sentence points at the panel that is still open, not at reopening the review", () => {
  const sentence = describeReplyError({ code: "WORKER_ERROR", message: "[EPOST_UNCONFIRMED] x" });
  assert.equal(
    sentence,
    "The connection dropped while posting, so it is not known whether the reply reached Google. Press Yes, post it again: it checks Google first and will not post twice.",
  );
  // Reopening the review starts a fresh editor with a fresh key, which is
  // the one route that cannot settle this attempt, so it must not be the
  // advice given.
  assert.doesNotMatch(sentence, /Open the review again/);
  // It must not claim the reply did or did not reach Google.
  assert.match(sentence, /it is not known whether/);
});

test("WORKER_UNAVAILABLE and TIMEOUT map to the not-running sentence whatever the message", () => {
  const a = describeReplyError({ code: "WORKER_UNAVAILABLE", message: "Plugin worker is not running" });
  const b = describeReplyError({ code: "TIMEOUT", message: "Worker did not respond within 30000ms" });
  assert.equal(a, b);
  assert.match(a, /not running right now/);
});

test("a viewer is told their role is view-only, not that they can read reviews", () => {
  const expected =
    "Your role in this company is view-only, and this page needs a role that can create work. Ask an admin to change your role to see or reply to reviews.";
  assert.equal(describeReplyError({ code: "UNKNOWN", message: "Viewer access is read-only" }), expected);
  assert.equal(describeReplyError(new Error("Viewer access is read-only")), expected);
  // Every read on this page is refused for a viewer, so the old sentence
  // promised a capability the same screen had just withheld.
  assert.doesNotMatch(expected, /can read reviews/);
  assert.equal(isAccessRefusal({ message: "Viewer access is read-only" }), true);
  assert.equal(isAccessRefusal({ message: "[EREPLY_EXISTS] x" }), false);
});

test("a non-member and a suspended member are told they have no access, not that they have a small role", () => {
  const expected = "You do not have access to this company's reviews.";
  // The host's two wordings: a person who is not a member of the company,
  // and a member whose access has been suspended. Neither is about a role.
  assert.equal(describeReplyError({ code: "UNKNOWN", message: "User does not have access to this company" }), expected);
  assert.equal(describeReplyError({ code: "UNKNOWN", message: "User does not have active company access" }), expected);
  assert.equal(isAccessRefusal({ message: "User does not have access to this company" }), true);
  assert.equal(isAccessRefusal({ message: "User does not have active company access" }), true);
  // The two refusals are different people with different fixes, so the page
  // must not give them the same sentence.
  assert.notEqual(describeReplyError({ message: "Viewer access is read-only" }), expected);
});

test("an unknown code returns the raw message", () => {
  assert.equal(describeReplyError({ code: "CAPABILITY_DENIED", message: "Plugin lacks capability http.outbound" }), "Plugin lacks capability http.outbound");
  assert.equal(describeReplyError({ code: "UNKNOWN", message: "Network request failed" }), "Network request failed");
});

test("a new worker code shows the worker's own sentence without the code", () => {
  assert.equal(describeReplyError({ code: "WORKER_ERROR", message: "[EINVALID_INPUT] The reply is empty." }), "The reply is empty.");
  assert.equal(describeReplyError({ code: "WORKER_ERROR", message: "[ESOMETHING_NEW] Plain words here." }), "Plain words here.");
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[EGBP_HTTP_403] PERMISSION_DENIED" }), /Google returned an error: PERMISSION_DENIED/);
  assert.match(describeReplyError({ code: "WORKER_ERROR", message: "[ESOMETHING_NEW]" }), /no reason was given/);
});

test("an Error instance and a string never produce [object Object]", () => {
  assert.equal(describeReplyError(new Error("[EREPLY_CHANGED] x")).includes("[object Object]"), false);
  assert.equal(describeReplyError("plain text"), "plain text");
  assert.equal(describeReplyError({}).includes("[object Object]"), false);
  assert.equal(describeReplyError({ message: 42 }).includes("[object Object]"), false);
  assert.equal(describeReplyError(null).includes("[object Object]"), false);
  assert.equal(describeReplyError(undefined).length > 0, true);
  assert.equal(describeReplyError({ code: "WORKER_ERROR", message: "" }).length > 0, true);
});

test("no mapped sentence contains a long dash", () => {
  const inputs: unknown[] = [
    { code: "WORKER_UNAVAILABLE", message: "x" },
    { code: "TIMEOUT", message: "x" },
    { message: "Viewer access is read-only" },
    { message: "User does not have access to this company" },
    { message: "User does not have active company access" },
    {},
    ...[
      "ESCOPE",
      "EREPLIES_DISABLED",
      "EROLLUP_READ_ONLY",
      "ELOCATION_NOT_FOUND",
      "EREVIEW_NOT_FOUND",
      "EDUPLICATE_IN_PROGRESS",
      "EREPLY_EXISTS",
      "EREPLY_CHANGED",
      "EPOST_UNCONFIRMED",
      "ECOMPANY_NOT_ALLOWED",
      "EACCOUNT_NOT_FOUND",
      "EAUTH",
      "ECONFIG",
      "ECONFIG_SECRET_MISSING",
      "EGBP_HTTP_500",
      "ENEW",
    ].map((code) => ({ code: "WORKER_ERROR", message: `[${code}]` })),
  ];
  for (const input of inputs) {
    assert.doesNotMatch(describeReplyError(input), LONG_DASHES, JSON.stringify(input));
  }
});
