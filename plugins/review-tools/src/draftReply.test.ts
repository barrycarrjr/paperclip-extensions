/**
 * Tests for the suggested reply and the "Posts as" line.
 *
 * The bug these exist to keep out: the old buildDraftReply expected Google's
 * 'ONE'..'FIVE' strings, so a numeric 5 from the table read as 0 and every
 * stored review would have been offered the apology. It also quoted the
 * customer's complaint back at them, and carried an em-dash.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { accountLabel, buildDraftReply, postsAs } from "./draftReply.js";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASH = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");
const BUSINESS = "Acme Main St";
const REVIEWER = "Jordan";
const COMPLAINT = "the counter staff ignored me for twenty minutes and then got my order wrong";

test("1, 3 and 5 stars each name the reviewer and business, with no long dashes and none of the customer's words", () => {
  for (const stars of [1, 3, 5]) {
    const out = buildDraftReply(BUSINESS, REVIEWER, stars, COMPLAINT);
    assert.doesNotMatch(out, LONG_DASH, `${stars} stars has a long dash`);
    assert.ok(out.includes(REVIEWER), `${stars} stars names the reviewer`);
    assert.ok(out.includes(BUSINESS), `${stars} stars names the business`);
    assert.ok(!out.includes(COMPLAINT.slice(0, 20)), `${stars} stars quotes the review back`);
    assert.ok(!out.includes("…"), `${stars} stars has the old ellipsis splice`);
  }
});

test("a numeric 5 gets the thank-you template, not the apology", () => {
  const out = buildDraftReply(BUSINESS, REVIEWER, 5);
  assert.match(out, /Thank you so much for the kind words/);
  assert.doesNotMatch(out, /make this right/);
});

test("4 stars is also a thank-you; 3 is the middle template; 1 and 2 apologise", () => {
  assert.match(buildDraftReply(BUSINESS, REVIEWER, 4), /kind words/);
  assert.match(buildDraftReply(BUSINESS, REVIEWER, 3), /always working to improve/);
  assert.match(buildDraftReply(BUSINESS, REVIEWER, 2), /make this right/);
  assert.match(buildDraftReply(BUSINESS, REVIEWER, 1), /make this right/);
});

test("a rating that cannot be read falls to the careful template rather than the thank-you", () => {
  assert.match(buildDraftReply(BUSINESS, REVIEWER, Number.NaN), /make this right/);
  assert.match(buildDraftReply(BUSINESS, REVIEWER, 0), /make this right/);
});

test("the low-rating reply is the same whether or not the customer wrote anything", () => {
  assert.equal(
    buildDraftReply(BUSINESS, REVIEWER, 1, COMPLAINT),
    buildDraftReply(BUSINESS, REVIEWER, 1, undefined),
  );
});

test("postsAs prefers userEmail, then displayName, then key", () => {
  const location = { displayName: "Main St Store" };
  assert.equal(
    postsAs(location, { key: "acct-1", displayName: "Owner", userEmail: "owner@example.com" }),
    "Posts as: Main St Store, using the Google account owner@example.com",
  );
  assert.equal(
    postsAs(location, { key: "acct-1", displayName: "Owner" }),
    "Posts as: Main St Store, using the Google account Owner",
  );
  assert.equal(
    postsAs(location, { key: "acct-1" }),
    "Posts as: Main St Store, using the Google account acct-1",
  );
  // Blank strings do not count as present.
  assert.equal(accountLabel({ key: "acct-1", displayName: "  ", userEmail: "" }), "acct-1");
});

test("postsAs reads nothing from any params object", () => {
  // The signature takes only the resolved location and account. A page that
  // sends its own hostScope, companyId or accountKey cannot change the line.
  const location = { displayName: "Main St Store" };
  const account = { key: "acct-1", userEmail: "owner@example.com" };
  const params = { hostScope: { companyId: "company-b", userId: "user-1" }, accountKey: "acct-2", locationKey: "other" };
  assert.equal(
    (postsAs as unknown as (...args: unknown[]) => string)(location, account, params),
    postsAs(location, account),
  );
  assert.equal(postsAs.length, 2);
  assert.doesNotMatch(postsAs(location, account), LONG_DASH);
});
