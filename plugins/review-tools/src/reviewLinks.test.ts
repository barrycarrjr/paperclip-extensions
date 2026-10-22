/**
 * The two links on a review task: the review inside Paperclip, and the
 * listing on Google.
 *
 * The rule worth pinning is that neither is ever guessed. A missing company
 * prefix gives no in-app link rather than one pointing at the wrong place,
 * and a listing with no recorded address gives no Google link rather than a
 * search for the business name, which can land on somebody else's listing.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  googleListingUrl,
  locationLinksStateKey,
  readLocationLinks,
  reviewPageUrl,
  reviewTaskLinkLines,
} from "./reviewLinks.js";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

const REVIEW = "accounts/111/locations/222/reviews/abc-123";
// The shape Google returns, with made-up identifiers.
const LIVE_LINKS = {
  placeId: "ChIJexampleExamplePlaceId00",
  mapsUri: "https://maps.google.com/maps?cid=10000000000000000001",
  newReviewUri: "https://search.google.com/local/writereview?placeid=ChIJexampleExamplePlaceId00",
};

test("the in-app link opens the exact review, and is omitted without a company prefix", () => {
  const url = reviewPageUrl("MME", "main-st", REVIEW);
  assert.equal(url, "/MME/reviews?location=main-st&review=accounts%2F111%2Flocations%2F222%2Freviews%2Fabc-123");
  // The page reads these two parameters, so a round trip must survive.
  const parsed = new URLSearchParams(url!.split("?")[1]);
  assert.equal(parsed.get("location"), "main-st");
  assert.equal(parsed.get("review"), REVIEW);

  assert.equal(reviewPageUrl(null, "main-st", REVIEW), null);
  assert.equal(reviewPageUrl("", "main-st", REVIEW), null);
});

test("the Google link is Google's own, with the place id as a fallback and nothing invented", () => {
  assert.equal(googleListingUrl(LIVE_LINKS), LIVE_LINKS.mapsUri);
  assert.equal(
    googleListingUrl({ placeId: "ChIJabc" }),
    "https://www.google.com/maps/place/?q=place_id:ChIJabc",
  );
  // No address recorded: no link, rather than a search by business name.
  assert.equal(googleListingUrl({}), null);
  assert.equal(googleListingUrl(null), null);
});

test("stored links are read back defensively", () => {
  assert.deepEqual(readLocationLinks({ ...LIVE_LINKS, fetchedAt: "2026-10-22T00:00:00Z" }), {
    ...LIVE_LINKS,
    fetchedAt: "2026-10-22T00:00:00Z",
  });
  // Junk, or a record with nothing usable in it, counts as nothing.
  assert.equal(readLocationLinks(null), null);
  assert.equal(readLocationLinks("nope"), null);
  assert.equal(readLocationLinks({ newReviewUri: "https://example.test" }), null);
  assert.equal(readLocationLinks({ mapsUri: 7 }), null);
  assert.equal(locationLinksStateKey("main-st").stateKey, "location-links:main-st");
});

test("the task body links to the review first, and says what the Google link actually opens", () => {
  const lines = reviewTaskLinkLines({
    companyPrefix: "MME",
    locationKey: "main-st",
    reviewName: REVIEW,
    locationName: "Main St Store",
    links: LIVE_LINKS,
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^\*\*\[Open this review and reply\]\(\/MME\/reviews\?/);
  assert.match(lines[1]!, /Open Main St Store on Google Maps/);
  // The wording must not promise a link to one review: Google has no such
  // address, and the first version of this line read as if it did.
  assert.match(lines[1]!, /choose its Reviews tab/);
  assert.match(lines[1]!, /no address that opens one review/);
  for (const line of lines) assert.doesNotMatch(line, LONG_DASHES);
});

test("each link stands alone, so one missing piece does not remove the other", () => {
  const noPrefix = reviewTaskLinkLines({
    companyPrefix: null,
    locationKey: "main-st",
    reviewName: REVIEW,
    locationName: "Main St Store",
    links: LIVE_LINKS,
  });
  assert.equal(noPrefix.length, 1);
  assert.match(noPrefix[0]!, /on Google Maps/);

  const noGoogle = reviewTaskLinkLines({
    companyPrefix: "MME",
    locationKey: "main-st",
    reviewName: REVIEW,
    locationName: "Main St Store",
    links: null,
  });
  assert.equal(noGoogle.length, 1);
  assert.match(noGoogle[0]!, /Open this review and reply/);

  assert.deepEqual(
    reviewTaskLinkLines({
      companyPrefix: null,
      locationKey: "main-st",
      reviewName: REVIEW,
      locationName: "Main St Store",
      links: null,
    }),
    [],
  );
});
