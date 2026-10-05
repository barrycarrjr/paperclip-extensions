/**
 * Tests for deciding a reply's source at sync time.
 *
 * The thing to protect: a reply a person posted from Paperclip must keep
 * saying so after the next sync, and a reply edited in Google's console must
 * stop claiming it came from Paperclip.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { nextReplySource } from "./replySource.js";

test("unchanged text keeps 'human'", () => {
  assert.equal(
    nextReplySource({ replyText: "Thanks, Jordan!", replySource: "human" }, { replyText: "Thanks, Jordan!" }),
    "human",
  );
});

test("unchanged text keeps 'agent' and 'google' too", () => {
  assert.equal(nextReplySource({ replyText: "Thanks", replySource: "agent" }, { replyText: "Thanks" }), "agent");
  assert.equal(nextReplySource({ replyText: "Thanks", replySource: "google" }, { replyText: "Thanks" }), "google");
});

test("changed text becomes 'google'", () => {
  assert.equal(
    nextReplySource({ replyText: "Thanks, Jordan!", replySource: "human" }, { replyText: "Thanks so much, Jordan!" }),
    "google",
  );
});

test("a first-seen reply becomes 'google'", () => {
  assert.equal(nextReplySource({ replyText: null, replySource: null }, { replyText: "Thanks" }), "google");
  assert.equal(nextReplySource({ replyText: undefined, replySource: undefined }, { replyText: "Thanks" }), "google");
});

test("matching text with no recorded source is still 'google', not a guess", () => {
  // A row synced before reply_source existed has text but no source. We
  // cannot know who wrote it, so it is Google's until the plugin posts one.
  assert.equal(nextReplySource({ replyText: "Thanks", replySource: null }, { replyText: "Thanks" }), "google");
  assert.equal(nextReplySource({ replyText: "Thanks", replySource: "bogus" }, { replyText: "Thanks" }), "google");
});

test("no reply gives null, whatever was stored", () => {
  assert.equal(nextReplySource({ replyText: "Thanks", replySource: "human" }, { replyText: null }), null);
  assert.equal(nextReplySource({ replyText: null, replySource: null }, { replyText: undefined }), null);
});
