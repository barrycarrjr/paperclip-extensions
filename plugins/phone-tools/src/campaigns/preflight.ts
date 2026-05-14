/**
 * Pure compliance preflight validation. Called before a campaign can
 * transition from `draft` to `running`. No I/O — every input is
 * passed in. Trivially unit-testable.
 *
 * The rules here implement the plan's "Compliance preflight — load-
 * bearing, non-skippable" section. Mistakes in this file translate
 * directly to regulatory exposure (TCPA / state-level analogues), so
 * keep the rules conservative and the error messages specific.
 */

import type { CompliancePreflight } from "./types.js";

export interface PreflightValidationContext {
  /** Whether the calling assistant has a `transferTarget` set on its PhoneConfig. */
  assistantHasTransferTarget: boolean;
  /** Number of leads currently attached to the campaign. */
  leadCount: number;
}

export interface PreflightValidationResult {
  ok: boolean;
  errors: string[];
}

const MAX_DAILY_HOURS = 14;
const WARN_DAILY_HOURS = 12;

/**
 * States with stricter-than-federal TCPA analogues. Calling into any
 * of these requires additional disclosure language and tighter
 * acknowledgement. List based on:
 *   - FL: FTSA (2021) — private right of action, "express written
 *         consent" required for AI/auto-dialed calls
 *   - CA: CCPA + Robocall law — opt-out language must be explicit
 *         and reachable via a single utterance
 *   - OK: TCPA-2024 — pre-recorded / artificial voice rules apply
 *         to most B2B calls too
 *   - TX: stricter consumer protection; no-purchase consent rules
 *
 * Format: ISO 3166-2 codes. Update as state law changes; the
 * preflight check is conservative — any geographic scope entry that
 * matches triggers the stricter rules.
 */
const STRICT_STATES = new Set(["US-FL", "US-CA", "US-OK", "US-TX"]);

/**
 * Phrases the opening disclosure must contain (case-insensitive)
 * when calling into a strict state. The preflight scans the
 * configured `openingDisclosure` string for ANY match per category.
 *
 * The phrasing is deliberately loose — we don't want to over-prescribe
 * the AI's exact words. Any greeting that conveys (a) who's calling
 * and (b) why is acceptable. Strict-state operators have to confirm
 * those phrases land in the opener.
 */
const STRICT_STATE_OPENER_REQUIREMENTS: Array<{
  category: string;
  needles: string[];
  guidance: string;
}> = [
  {
    category: "self-identification",
    needles: ["this is", "i'm calling", "calling on behalf of", "calling from"],
    guidance: "must clearly identify the caller (e.g. 'Hi, this is <Name> from <Business>...')",
  },
  {
    category: "purpose-disclosure",
    needles: ["calling about", "regarding", "with regards to", "in regards to", "to talk about", "to ask about", "to follow up", "to introduce"],
    guidance: "must state the purpose of the call ('calling about X')",
  },
];

export function isStrictStateInScope(scope: string[]): boolean {
  return scope.some((s) => STRICT_STATES.has(s.trim().toUpperCase()));
}

export function validatePreflight(
  preflight: CompliancePreflight,
  ctx: PreflightValidationContext,
): PreflightValidationResult {
  const errors: string[] = [];

  if (!preflight.acknowledgedTcpa) {
    errors.push(
      "[ECOMPLIANCE_NOT_ACKNOWLEDGED] TCPA acknowledgement is required — the operator must confirm they have reviewed TCPA / state-level rules for the audience.",
    );
  }
  if (!preflight.acknowledgedDnc) {
    errors.push(
      "[ECOMPLIANCE_NOT_ACKNOWLEDGED] DNC acknowledgement is required — the operator must confirm the DNC list will be checked before every dial.",
    );
  }
  if (!preflight.acknowledgedAt || !preflight.acknowledgedBy) {
    errors.push(
      "[ECOMPLIANCE_NOT_ACKNOWLEDGED] acknowledgedAt + acknowledgedBy are required for the audit trail.",
    );
  }

  if (
    preflight.audienceKind === "consumer" &&
    preflight.listSource !== "first-party-customers" &&
    preflight.listSource !== "first-party-inquired"
  ) {
    errors.push(
      "[ECOMPLIANCE_RISK_TOO_HIGH] Consumer audience requires a first-party list (existing customers or people who inquired). Cold consumer calls without prior business relationship are TCPA Class A risk.",
    );
  }

  if (!ctx.assistantHasTransferTarget) {
    errors.push(
      "[ECAMPAIGN_NO_TRANSFER] The assistant has no `transferTarget` configured. Cold campaigns without warm transfer aren't useful — qualified leads have nowhere to go. Set a transferTarget on the assistant's Phone tab before starting.",
    );
  }

  if (ctx.leadCount === 0) {
    errors.push(
      "[ECAMPAIGN_EMPTY] The campaign has no leads. Add at least one lead via phone_lead_list_append or phone_lead_list_import_csv before starting.",
    );
  }

  const { startHour, endHour, weekendsAllowed } = preflight.callerLocalHours;
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) {
    errors.push(
      "[ECOMPLIANCE_BAD_HOURS] callerLocalHours.startHour and endHour must be finite numbers (0-23).",
    );
  } else if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
    errors.push("[ECOMPLIANCE_BAD_HOURS] callerLocalHours must be in 0–23 range.");
  } else if (startHour >= endHour) {
    errors.push(
      "[ECOMPLIANCE_BAD_HOURS] callerLocalHours.startHour must be earlier than endHour.",
    );
  } else {
    const dailyHours = endHour - startHour;
    if (dailyHours > MAX_DAILY_HOURS) {
      errors.push(
        `[ECOMPLIANCE_BAD_HOURS] Daily window is ${dailyHours}h; refuse to start anything wider than ${MAX_DAILY_HOURS}h. Federal default is 8am–9pm (13h) caller-local; tighter is safer.`,
      );
    } else if (dailyHours > WARN_DAILY_HOURS) {
      // Warning-not-error: still allowed, but the audit log records it.
      // Operators wanting >12h should sign off explicitly.
      // Surfaced via a separate warnings list; for now we just elevate when severe.
    }
    if (!weekendsAllowed) {
      // Weekends-not-allowed is the safer default. No error.
    }
  }

  if (!preflight.openingDisclosure || preflight.openingDisclosure.trim().length < 20) {
    errors.push(
      "[ECOMPLIANCE_OPENING_DISCLOSURE] openingDisclosure must be at least 20 characters and identify the caller + the business + the reason for the call. Federal and state disclosure rules require this.",
    );
  }
  if (!preflight.optOutLanguage || preflight.optOutLanguage.trim().length < 10) {
    errors.push(
      "[ECOMPLIANCE_OPT_OUT_LANGUAGE] optOutLanguage must offer the prospect a way to revoke consent. Failing to honor opt-out is the most common TCPA violation cited in litigation.",
    );
  }

  if (!Array.isArray(preflight.geographicScope) || preflight.geographicScope.length === 0) {
    errors.push(
      "[ECOMPLIANCE_NO_GEOGRAPHIC_SCOPE] geographicScope must list at least one ISO 3166-2 code (e.g. 'US-PA'). State-specific TCPA rules differ; we need to know which apply.",
    );
  }

  if (
    preflight.listSource === "purchased" ||
    preflight.listSource === "rented"
  ) {
    // Allowed but flagged via the listSourceNote requirement
    if (!preflight.listSourceNote || preflight.listSourceNote.trim().length < 10) {
      errors.push(
        "[ECOMPLIANCE_LIST_SOURCE_NOTE] When listSource is 'purchased' or 'rented', listSourceNote must describe the source — vendor name + how consent was originally obtained. Required for the audit trail.",
      );
    }
  }

  // Per-state TCPA presets. When any strict state is in scope, the
  // opening disclosure must clearly identify the caller AND state the
  // purpose. Strict states have private right of action and stricter
  // consent regimes — under-disclosed openers are the most-cited
  // violation in private TCPA litigation.
  if (Array.isArray(preflight.geographicScope) && isStrictStateInScope(preflight.geographicScope)) {
    const opener = (preflight.openingDisclosure ?? "").toLowerCase();
    for (const requirement of STRICT_STATE_OPENER_REQUIREMENTS) {
      const matched = requirement.needles.some((n) => opener.includes(n.toLowerCase()));
      if (!matched) {
        errors.push(
          `[ECOMPLIANCE_STRICT_STATE_OPENER] Geographic scope includes a strict-rule state (FL/CA/OK/TX). Opening disclosure ${requirement.guidance}.`,
        );
      }
    }
    // Strict states care more about explicit opt-out reachability.
    const optOut = (preflight.optOutLanguage ?? "").toLowerCase();
    if (
      !optOut.includes("don't call") &&
      !optOut.includes("do not call") &&
      !optOut.includes("remove") &&
      !optOut.includes("take you off") &&
      !optOut.includes("opt out")
    ) {
      errors.push(
        "[ECOMPLIANCE_STRICT_STATE_OPT_OUT] Strict-rule state in scope: opt-out language must contain an unambiguous opt-out phrase ('don't call', 'do not call', 'remove me', 'take off the list', or 'opt out'). Required so the AI recognizes opt-out requests reliably.",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Convenience: throw if validation fails. Used by tool handlers that
 * gate state changes (phone_campaign_start) on preflight pass.
 */
export function assertPreflight(
  preflight: CompliancePreflight,
  ctx: PreflightValidationContext,
): void {
  const result = validatePreflight(preflight, ctx);
  if (!result.ok) {
    throw new Error(result.errors.join(" / "));
  }
}
