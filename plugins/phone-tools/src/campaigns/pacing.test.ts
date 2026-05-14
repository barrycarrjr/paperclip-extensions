/**
 * Unit tests for the predictive pacing module (pure).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  adjustPacing,
  appendOutcome,
  computeStats,
  emptyWindow,
  estimateRemaining,
} from "./pacing.js";
import type { CampaignPacing } from "./types.js";

const baseConfigured: CampaignPacing = {
  maxConcurrent: 2,
  secondsBetweenDials: 90,
  maxPerHour: 30,
  maxPerDay: 200,
};

test("emptyWindow + appendOutcome bound by maxSize", () => {
  let w = emptyWindow(3);
  for (let i = 0; i < 5; i++) {
    w = appendOutcome(w, {
      answered: i % 2 === 0,
      durationSec: 60,
      endedAt: new Date().toISOString(),
    });
  }
  assert.equal(w.outcomes.length, 3);
});

test("computeStats: empty window returns zeros", () => {
  const s = computeStats(emptyWindow());
  assert.equal(s.sampleSize, 0);
  assert.equal(s.answerRate, 0);
});

test("computeStats: half answered = 0.5 rate", () => {
  let w = emptyWindow();
  for (let i = 0; i < 10; i++) {
    w = appendOutcome(w, {
      answered: i < 5,
      durationSec: 60,
      costUsd: 0.1,
      endedAt: new Date().toISOString(),
    });
  }
  const s = computeStats(w);
  assert.equal(s.sampleSize, 10);
  assert.equal(s.answerRate, 0.5);
  assert.equal(s.meanDurationSec, 60);
  assert.equal(Math.round(s.meanCostUsd * 100), 10);
});

test("adjustPacing: small sample → unchanged", () => {
  let w = emptyWindow();
  for (let i = 0; i < 5; i++) {
    w = appendOutcome(w, { answered: false, durationSec: 60, endedAt: "now" });
  }
  const r = adjustPacing(baseConfigured, computeStats(w));
  assert.equal(r.adjusted, false);
  assert.equal(r.secondsBetweenDials, baseConfigured.secondsBetweenDials);
  assert.equal(r.maxConcurrent, baseConfigured.maxConcurrent);
});

test("adjustPacing: low answer rate (<10%) → tighten + bump concurrency", () => {
  let w = emptyWindow();
  for (let i = 0; i < 20; i++) {
    w = appendOutcome(w, { answered: false, durationSec: 30, endedAt: "now" });
  }
  const r = adjustPacing(baseConfigured, computeStats(w));
  assert.equal(r.adjusted, true);
  assert.equal(r.secondsBetweenDials, 45); // 90 * 0.5
  assert.equal(r.maxConcurrent, 3); // 2 * 1.5
});

test("adjustPacing: high answer rate (>40%) → loosen + same concurrency", () => {
  let w = emptyWindow();
  for (let i = 0; i < 20; i++) {
    w = appendOutcome(w, { answered: i < 10, durationSec: 90, endedAt: "now" }); // 50%
  }
  const r = adjustPacing(baseConfigured, computeStats(w));
  assert.equal(r.adjusted, true);
  assert.equal(r.secondsBetweenDials, 180); // 90 * 2
  assert.equal(r.maxConcurrent, 2);
});

test("adjustPacing: mid answer rate (10-40%) → unchanged", () => {
  let w = emptyWindow();
  for (let i = 0; i < 20; i++) {
    w = appendOutcome(w, { answered: i < 5, durationSec: 60, endedAt: "now" }); // 25%
  }
  const r = adjustPacing(baseConfigured, computeStats(w));
  assert.equal(r.adjusted, false);
});

test("adjustPacing: never produces secondsBetweenDials < 5", () => {
  let w = emptyWindow();
  for (let i = 0; i < 20; i++) {
    w = appendOutcome(w, { answered: false, durationSec: 30, endedAt: "now" });
  }
  const tinyConfigured: CampaignPacing = { ...baseConfigured, secondsBetweenDials: 6 };
  const r = adjustPacing(tinyConfigured, computeStats(w));
  // 6 * 0.5 = 3 → floored at 5
  assert.ok(r.secondsBetweenDials >= 5);
});

test("estimateRemaining: low sample uses fallbacks", () => {
  const stats = computeStats(emptyWindow());
  const e = estimateRemaining({
    pendingLeads: 100,
    effectiveConcurrent: 2,
    stats,
    fallbackDurationSec: 90,
    fallbackCostUsd: 0.07,
  });
  // 100 calls × 90s / 2 concurrent / 60 = 75 minutes
  assert.equal(e.estimatedMinutesRemaining, 75);
  // 100 × $0.07 = $7
  assert.equal(e.estimatedRemainingCostUsd, 7);
  assert.ok(e.notes.some((n) => n.includes("Low sample")));
});

test("estimateRemaining: large sample uses observed mean", () => {
  let w = emptyWindow();
  for (let i = 0; i < 30; i++) {
    w = appendOutcome(w, {
      answered: i < 10,
      durationSec: 60,
      costUsd: 0.05,
      endedAt: "now",
    });
  }
  const e = estimateRemaining({
    pendingLeads: 50,
    effectiveConcurrent: 2,
    stats: computeStats(w),
    fallbackDurationSec: 999, // would dominate if used
    fallbackCostUsd: 999,
  });
  // 50 × 60s / 2 / 60 = 25 minutes
  assert.equal(e.estimatedMinutesRemaining, 25);
  assert.equal(e.estimatedRemainingCostUsd, 2.5);
  assert.equal(e.notes.length, 0);
});
