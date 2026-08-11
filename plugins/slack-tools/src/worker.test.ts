import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeChannelName, slackErrorCode } from "./worker.js";

/**
 * Both helpers exist so an agent's request converges on the outcome the
 * operator asked for instead of bouncing off Slack's rules. That is behaviour
 * worth pinning: the failure mode they prevent is a setup routine that half
 * works and reports success.
 */

describe("normalizeChannelName", () => {
  it("turns a human channel name into one Slack will accept", () => {
    assert.equal(normalizeChannelName("M3 Orders"), "m3-orders");
    assert.equal(normalizeChannelName("#m3-support"), "m3-support");
    assert.equal(normalizeChannelName("Print  Production"), "print-production");
  });

  it("strips characters Slack rejects rather than failing the call", () => {
    assert.equal(normalizeChannelName("M3 / Escalations!"), "m3-escalations");
    assert.equal(normalizeChannelName("orders@2026"), "orders-2026");
  });

  it("does not leave leading or trailing separators", () => {
    assert.equal(normalizeChannelName("  -m3-orders-  "), "m3-orders");
    assert.equal(normalizeChannelName("...vendor..."), "vendor");
  });

  it("collapses runs of separators", () => {
    assert.equal(normalizeChannelName("m3 --- orders"), "m3-orders");
  });

  it("keeps names Slack already allows untouched", () => {
    assert.equal(normalizeChannelName("m3-orders"), "m3-orders");
    assert.equal(normalizeChannelName("general"), "general");
  });

  it("truncates to Slack's 80-character ceiling", () => {
    assert.equal(normalizeChannelName("a".repeat(120)).length, 80);
  });

  it("returns empty for input with nothing usable, so the caller can refuse", () => {
    assert.equal(normalizeChannelName("   "), "");
    assert.equal(normalizeChannelName("!!!"), "");
  });
});

describe("slackErrorCode", () => {
  it("pulls the raw Slack error out of a web-api rejection", () => {
    assert.equal(slackErrorCode({ data: { error: "name_taken" } }), "name_taken");
    assert.equal(
      slackErrorCode({ data: { error: "already_in_channel" } }),
      "already_in_channel",
    );
  });

  it("returns null for anything that isn't a Slack platform error", () => {
    // A network failure or a bug in our own code must NOT be mistaken for
    // "the channel already exists" — that would report success on a failure.
    assert.equal(slackErrorCode(new Error("socket hang up")), null);
    assert.equal(slackErrorCode(undefined), null);
    assert.equal(slackErrorCode({ code: "slack_webapi_platform_error" }), null);
  });
});
