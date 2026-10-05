/**
 * Tests for review resource-name checking.
 *
 * The dangerous direction is accepting something that should have been
 * refused: a name that addresses a different endpoint, or a review from a
 * location the caller was never authorised for.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { canonicalReviewName, parseReviewName, reviewBelongsToLocation } from "./reviewName.js";

const GOOD = "accounts/123456789/locations/987654321/reviews/AbC-d_9";

test("parses a well-formed name", () => {
  assert.deepEqual(parseReviewName(GOOD), {
    accountId: "123456789",
    locationId: "987654321",
    reviewId: "AbC-d_9",
  });
});

test("tolerates surrounding whitespace only", () => {
  assert.ok(parseReviewName(`  ${GOOD}  `));
});

test("refuses anything that is not a review name", () => {
  for (const bad of [
    "",
    "accounts/123",
    "accounts/123/locations/456",
    "accounts/123/locations/456/reviews/",
    "accounts/abc/locations/456/reviews/x",
    "accounts/123/locations/xyz/reviews/x",
    "accounts/123/locations/456/reviews/x/reply",
    "../accounts/123/locations/456/reviews/x",
    "accounts/123/locations/456/reviews/x?foo=1",
    "accounts/123/locations/456/reviews/x#frag",
    "accounts/123/locations/456/reviews/has space",
    "accounts/123/locations/456/reviews/slash/inside",
    42,
    null,
    undefined,
    {},
  ]) {
    assert.equal(parseReviewName(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("a review belongs to a location only when BOTH ids match", () => {
  const parsed = parseReviewName(GOOD)!;
  assert.equal(
    reviewBelongsToLocation(parsed, { googleAccountId: "123456789", locationId: "987654321" }),
    true,
  );
  // Same location number under a different account is not the same place.
  assert.equal(
    reviewBelongsToLocation(parsed, { googleAccountId: "999", locationId: "987654321" }),
    false,
  );
  assert.equal(
    reviewBelongsToLocation(parsed, { googleAccountId: "123456789", locationId: "111" }),
    false,
  );
  assert.equal(reviewBelongsToLocation(parsed, {}), false);
});

test("the canonical name is rebuilt from checked parts, not echoed", () => {
  const parsed = parseReviewName(GOOD)!;
  assert.equal(canonicalReviewName(parsed), GOOD);
  // A part that somehow carried a reserved character would be encoded rather
  // than placed raw in a URL path.
  assert.equal(
    canonicalReviewName({ accountId: "1", locationId: "2", reviewId: "a b" }),
    "accounts/1/locations/2/reviews/a%20b",
  );
});
