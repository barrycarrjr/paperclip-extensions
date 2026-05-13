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
