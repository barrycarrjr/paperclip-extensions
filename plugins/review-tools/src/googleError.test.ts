/**
 * The three Google refusals that all arrive as a 403 and all used to read
 * "Request had insufficient authentication scopes", plus the token refresh
 * failures that used to read only "invalid_grant".
 *
 * Each one needs a different person to do a different thing, so each gets
 * its own code and its own sentence. These are the exact payload shapes
 * Google returns; the scope one is copied from the live failure on
 * 2026-10-19.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { describeGoogleApiError, describeTokenRefreshError } from "./googleError.js";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

const SCOPE_403 = JSON.stringify({
  error: {
    code: 403,
    message: "Request had insufficient authentication scopes.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
        domain: "googleapis.com",
        metadata: { service: "mybusiness.googleapis.com" },
      },
    ],
  },
});

const DISABLED_403 = JSON.stringify({
  error: {
    code: 403,
    message:
      "My Business Account Management API has not been used in project 123456789012 before or it is disabled.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        metadata: { service: "mybusinessaccountmanagement.googleapis.com" },
      },
    ],
  },
});

const QUOTA_429 = JSON.stringify({
  error: {
    code: 429,
    message: "Quota exceeded for quota metric 'Requests' of service 'mybusiness.googleapis.com'.",
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }],
  },
});

test("a token missing the scope says so, and says reconnecting is the fix", () => {
  const message = describeGoogleApiError("gbp", 403, SCOPE_403);
  assert.match(message, /^\[EAUTH_SCOPE\]/);
  assert.match(message, /business\.manage/);
  assert.match(message, /Reconnect/);
  // The thing that actually went wrong is named, not just the HTTP status.
  assert.doesNotMatch(message, /EGBP_HTTP_403/);
});

test("the same refusal from Gmail names Gmail and its own scope", () => {
  const message = describeGoogleApiError("gmail", 403, SCOPE_403);
  assert.match(message, /^\[EAUTH_SCOPE\]/);
  assert.match(message, /gmail\.readonly/);
  assert.match(message, /Gmail/);
});

test("an API that is switched off in the Cloud project is told apart from a scope problem", () => {
  const message = describeGoogleApiError("gbp", 403, DISABLED_403);
  assert.match(message, /^\[EGBP_API_DISABLED\]/);
  assert.match(message, /mybusinessaccountmanagement\.googleapis\.com/);
  assert.match(message, /Enable it/);
});

test("a quota refusal explains that zero quota means access was never approved", () => {
  const message = describeGoogleApiError("gbp", 429, QUOTA_429);
  assert.match(message, /^\[EGBP_QUOTA\]/);
  assert.match(message, /not yet approved/);
});

test("anything unrecognised keeps the status, so nothing is swallowed", () => {
  const message = describeGoogleApiError("gbp", 500, JSON.stringify({ error: { message: "Internal error" } }));
  assert.match(message, /^\[EGBP_HTTP_500\]/);
  assert.match(message, /Internal error/);
});

test("a body that is not JSON at all still produces a usable message", () => {
  // The wrong host answers with an HTML 404 page, which is how the dead v4
  // accounts endpoint presented itself.
  const message = describeGoogleApiError("gbp", 404, "<!DOCTYPE html><title>Error 404 (Not Found)!!1</title>");
  assert.match(message, /^\[EGBP_HTTP_404\]/);
});

test("a revoked or wrong-client refresh token says which credential Google rejected", () => {
  const revoked = describeTokenRefreshError(new Error("invalid_grant"));
  assert.match(revoked, /^\[EAUTH_INVALID_GRANT\]/);
  assert.match(revoked, /Reconnect/);

  const badClient = describeTokenRefreshError(new Error("invalid_client: Unauthorized"));
  assert.match(badClient, /^\[EAUTH_CLIENT\]/);
  assert.match(badClient, /client ID and secret/);
});

test("an already-coded error is passed through rather than wrapped twice", () => {
  const already = describeTokenRefreshError(new Error("[EGBP_QUOTA] already mapped"));
  assert.equal(already, "[EGBP_QUOTA] already mapped");
});

test("every sentence is free of long dashes", () => {
  const all = [
    describeGoogleApiError("gbp", 403, SCOPE_403),
    describeGoogleApiError("gmail", 403, SCOPE_403),
    describeGoogleApiError("gbp", 403, DISABLED_403),
    describeGoogleApiError("gbp", 429, QUOTA_429),
    describeGoogleApiError("gbp", 500, "{}"),
    describeTokenRefreshError(new Error("invalid_grant")),
    describeTokenRefreshError(new Error("invalid_client")),
    describeTokenRefreshError(new Error("something else")),
  ];
  for (const message of all) assert.doesNotMatch(message, LONG_DASHES);
});
