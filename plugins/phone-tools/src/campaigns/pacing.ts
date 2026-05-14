/**
 * Predictive pacing — adaptive `secondsBetweenDials` and effective
 * concurrency budget based on the campaign's recent observed
 * answer-rate.
 *
 * Why this matters: a campaign whose answer rate is 5% is sitting on
 * a lot of wasted dial budget — most calls go to voicemail/no-answer,
 * the AI's "in-progress" slot opens back up fast, and the configured
 * pacing dramatically under-utilizes the assistant's capacity. Bumping
 * concurrency or shortening dial spacing is the right move. Conversely,
 * a 60% answer-rate campaign with too-aggressive pacing leaves real
 * humans waiting on hold while the engine ramps up another call.
 *
 * The model is simple — it intentionally does NOT try to be a
 * predictive dialer in the call-center sense (that's a different
 * regulatory + technical regime). It just nudges the configured
 * pacing within a bounded multiplier window based on the rolling
 * answer rate of the last N completed calls.
 *
 * Bounds:
 *   - effective `secondsBetweenDials` ∈ [0.5x, 2x] of configured
 *   - effective `maxConcurrent`        ∈ [1x, 1.5x] of configured
 *   These bounds prevent runaway adjustment from misreading early-
 *   campaign noise as signal.
 *
 * Pure module — no I/O. Caller persists the rolling window via state.
 */

import type { CampaignPacing } from "./types.js";

export interface CallOutcome {
  /** Did the recipient answer (vs. voicemail / no-answer / busy)? */
  answered: boolean;
  /** Engine-reported call duration in seconds. */
  durationSec: number;
  /** Optional cost reported by the engine for this call. */
  costUsd?: number;
  /** When the call ended. */
  endedAt: string;
}

/**
 * Bounded ring of recent outcomes used to compute the rolling answer
 * rate. Default window is 30 — long enough to filter early-campaign
 * noise, short enough to react to a list shift.
 */
export interface AnswerRateWindow {
  outcomes: CallOutcome[];
  maxSize: number;
}

export const DEFAULT_WINDOW_SIZE = 30;
const MIN_SAMPLE_FOR_ADJUST = 10;

export function emptyWindow(maxSize: number = DEFAULT_WINDOW_SIZE): AnswerRateWindow {
  return { outcomes: [], maxSize };
}

export function appendOutcome(
  window: AnswerRateWindow,
  outcome: CallOutcome,
): AnswerRateWindow {
  const outcomes = [...window.outcomes, outcome];
  while (outcomes.length > window.maxSize) outcomes.shift();
  return { outcomes, maxSize: window.maxSize };
}

export interface AnswerRateStats {
  sampleSize: number;
  answerRate: number; // [0, 1]
  meanDurationSec: number;
  meanCostUsd: number;
}

export function computeStats(window: AnswerRateWindow): AnswerRateStats {
  const n = window.outcomes.length;
  if (n === 0) {
    return { sampleSize: 0, answerRate: 0, meanDurationSec: 0, meanCostUsd: 0 };
  }
  let answered = 0;
  let durSum = 0;
  let costSum = 0;
  for (const o of window.outcomes) {
    if (o.answered) answered++;
    durSum += Number.isFinite(o.durationSec) ? o.durationSec : 0;
    costSum += Number.isFinite(o.costUsd ?? NaN) ? (o.costUsd ?? 0) : 0;
  }
  return {
    sampleSize: n,
    answerRate: answered / n,
    meanDurationSec: durSum / n,
    meanCostUsd: costSum / n,
  };
}

export interface AdjustedPacing {
  /** Effective values to use this tick. */
  secondsBetweenDials: number;
  maxConcurrent: number;
  /** Reason string suitable for telemetry / audit. */
  rationale: string;
  /** True if any adjustment was applied (vs. defaults returned). */
  adjusted: boolean;
}

/**
 * Given the configured pacing and a rolling-window stats snapshot,
 * return the effective pacing to use this tick. Pure; no side effects.
 *
 * Heuristic: classify answer rate into three bands and apply a
 * scalar multiplier. Below MIN_SAMPLE_FOR_ADJUST, return configured
 * pacing unchanged.
 */
export function adjustPacing(
  configured: CampaignPacing,
  stats: AnswerRateStats,
): AdjustedPacing {
  if (stats.sampleSize < MIN_SAMPLE_FOR_ADJUST) {
    return {
      secondsBetweenDials: configured.secondsBetweenDials,
      maxConcurrent: configured.maxConcurrent,
      rationale: `sample-size ${stats.sampleSize} < ${MIN_SAMPLE_FOR_ADJUST}; using configured pacing`,
      adjusted: false,
    };
  }
  let secondsMult = 1;
  let concurrencyMult = 1;
  let band: string;
  if (stats.answerRate < 0.1) {
    // Sparse answers — most calls vacate the slot fast (voicemail/no-answer).
    // Tighten dial spacing and slightly bump concurrency.
    secondsMult = 0.5;
    concurrencyMult = 1.5;
    band = "low (<10%)";
  } else if (stats.answerRate > 0.4) {
    // Plenty of answers — calls hold slots for full conversations.
    // Widen dial spacing and stick to configured concurrency.
    secondsMult = 2;
    concurrencyMult = 1;
    band = "high (>40%)";
  } else {
    // Middle band — leave configured alone.
    return {
      secondsBetweenDials: configured.secondsBetweenDials,
      maxConcurrent: configured.maxConcurrent,
      rationale: `answer-rate ${(stats.answerRate * 100).toFixed(0)}% in mid band; using configured pacing`,
      adjusted: false,
    };
  }
  const effectiveSeconds = Math.max(
    5,
    Math.round(configured.secondsBetweenDials * secondsMult),
  );
  const effectiveConcurrent = Math.max(
    1,
    Math.round(configured.maxConcurrent * concurrencyMult),
  );
  return {
    secondsBetweenDials: effectiveSeconds,
    maxConcurrent: effectiveConcurrent,
    rationale: `answer-rate ${(stats.answerRate * 100).toFixed(0)}% (${band}); secondsBetweenDials × ${secondsMult}, maxConcurrent × ${concurrencyMult}`,
    adjusted: true,
  };
}

export interface CampaignEstimate {
  pendingLeads: number;
  /** Best-guess total minutes to drain the queue. */
  estimatedMinutesRemaining: number;
  /** Best-guess total cost based on observed mean. */
  estimatedRemainingCostUsd: number;
  /** The stats snapshot the estimate was built from. */
  basis: AnswerRateStats;
  /** Notes — e.g. "low confidence: only 3 calls completed". */
  notes: string[];
}

/**
 * Estimate run time + cost to drain a campaign's pending leads.
 * Uses observed mean duration + mean cost when sample is large
 * enough; otherwise falls back to defaults that the caller passes
 * in (so we don't bake assumptions about typical AI call shape).
 *
 * The estimate is deliberately rough — it's the kind of number an
 * operator wants for "how long will this take?" / "what will it
 * cost me?", not a precise scheduling tool.
 */
export function estimateRemaining(args: {
  pendingLeads: number;
  effectiveConcurrent: number;
  stats: AnswerRateStats;
  fallbackDurationSec: number;
  fallbackCostUsd: number;
}): CampaignEstimate {
  const notes: string[] = [];
  let meanDurationSec = args.stats.meanDurationSec;
  let meanCostUsd = args.stats.meanCostUsd;
  if (args.stats.sampleSize < MIN_SAMPLE_FOR_ADJUST) {
    meanDurationSec = args.fallbackDurationSec;
    meanCostUsd = args.fallbackCostUsd;
    notes.push(
      `Low sample (${args.stats.sampleSize}); using fallback duration ${args.fallbackDurationSec}s and cost $${args.fallbackCostUsd.toFixed(2)}.`,
    );
  }
  const callsToMake = args.pendingLeads;
  const concurrent = Math.max(1, args.effectiveConcurrent);
  // Wall-clock minutes ≈ (calls × mean-duration) / concurrent / 60
  const estimatedMinutesRemaining = Math.round(
    (callsToMake * meanDurationSec) / concurrent / 60,
  );
  const estimatedRemainingCostUsd = Math.round(callsToMake * meanCostUsd * 100) / 100;
  return {
    pendingLeads: callsToMake,
    estimatedMinutesRemaining,
    estimatedRemainingCostUsd,
    basis: args.stats,
    notes,
  };
}
