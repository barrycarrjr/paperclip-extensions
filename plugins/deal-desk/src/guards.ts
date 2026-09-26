/**
 * The rules this plugin enforces in code rather than trusting to a prompt.
 *
 * Pure decisions, no database. The service looks up whatever a rule needs
 * (for example whether a conservative scenario exists) and hands the answer
 * in here, so every rule can be tested on its own.
 *
 * 1. An add-back cannot be accepted without an evidence document id, and
 *    cannot be rejected without a note saying why.
 * 2. Every scenario names its earnings basis. A seller_claimed scenario cannot
 *    be saved before a conservative one exists for the same deal, and a custom
 *    one needs its cash flow figure and a note explaining it.
 * 3. The exit multiple is an assumption and is labelled as one (see
 *    ASSUMED_MULTIPLE_LABEL, used by the tool text). A comparables note is
 *    stored beside a scenario and never changes its numbers.
 * 4. Money inputs are required whole cents (enforced in dealInputs.ts).
 * 5. Passwords, logins and usernames are never stored: a field named for one,
 *    or text written like "password: ...", is refused. Full tax ids are
 *    refused as in business-records.
 * 6. Company isolation is companyAccess.ts plus the company filter in sql.ts.
 */

import type { AdjustmentStatus, EarningsBasis } from "./domain.js";
import { ADJUSTMENT_STATUSES, EARNINGS_BASES } from "./domain.js";
import { DealDeskError, assertNoSensitiveIds, invalid, isUuid } from "./validate.js";

// ---- Rule 1: evidence before acceptance ----

export function checkAdjustmentStatusChange(args: {
  status: AdjustmentStatus;
  /** The evidence the adjustment will carry after the change (the one sent, else the one already on file). */
  evidenceDocumentId: string | null | undefined;
  note: string | null | undefined;
}): void {
  const { status } = args;
  if (!(ADJUSTMENT_STATUSES as readonly string[]).includes(status)) {
    throw invalid(`status must be one of: ${ADJUSTMENT_STATUSES.join(", ")}.`);
  }
  if (status === "accepted" && !isUuid(args.evidenceDocumentId)) {
    throw new DealDeskError(
      "EEVIDENCE_REQUIRED",
      "an add-back can only be accepted with evidenceDocumentId: the id of the document in Business Records that proves it (for example the invoice, bank statement or payroll record, added first with business_add_document). A seller saying so is not evidence; leave it unverified.",
    );
  }
  if (status === "rejected" && !(typeof args.note === "string" && args.note.trim().length > 0)) {
    throw new DealDeskError("ENOTE_REQUIRED", "rejecting an add-back needs a note saying why it was rejected.");
  }
}

// ---- Rule 2: earnings basis ----

export function checkScenarioBasis(args: {
  earningsBasis: EarningsBasis;
  hasConservativeScenario: boolean;
  cashFlowCentsGiven: boolean;
  basisNote: string | null | undefined;
  periodLabel: string | null | undefined;
}): void {
  const { earningsBasis } = args;
  if (!(EARNINGS_BASES as readonly string[]).includes(earningsBasis)) {
    throw invalid(`earningsBasis must be one of: ${EARNINGS_BASES.join(", ")}.`);
  }
  if (earningsBasis === "custom") {
    if (!args.cashFlowCentsGiven) {
      throw invalid("earningsBasis custom needs cashFlowCents: the yearly cash flow figure this scenario uses, in whole cents.");
    }
    if (!(typeof args.basisNote === "string" && args.basisNote.trim().length > 0)) {
      throw new DealDeskError(
        "ENOTE_REQUIRED",
        "earningsBasis custom needs basisNote explaining where the cash flow figure comes from (for example which period, which add-backs, and why).",
      );
    }
    return;
  }
  if (args.cashFlowCentsGiven) {
    throw invalid(
      `cashFlowCents is only accepted with earningsBasis custom. For ${earningsBasis} the figure comes from the period's earnings and add-backs (see deal_normalize).`,
    );
  }
  if (!(typeof args.periodLabel === "string" && args.periodLabel.trim().length > 0)) {
    throw invalid(`earningsBasis ${earningsBasis} needs periodLabel: the earnings period whose SDE the scenario uses.`);
  }
  if (earningsBasis === "seller_claimed" && !args.hasConservativeScenario) {
    throw new DealDeskError(
      "ECONSERVATIVE_FIRST",
      "a seller_claimed scenario can only be saved after a conservative scenario exists for this deal, so the seller's number is never shown on its own. Run a conservative scenario first.",
    );
  }
}

// ---- Rule 3: assumed, never market ----

/** How the exit multiple is named in every piece of tool text. */
export const ASSUMED_MULTIPLE_LABEL = "assumed exit multiple";

// ---- Rule 5: no secrets, no full tax ids ----

const SECRET_KEY_RE = /pass(word|wd|code)|login|user_?name/i;
const SECRET_VALUE_RE = /\b(password|passwd|passcode|pwd|login|user ?name)\s*[:=]\s*\S/i;

/**
 * The path of the first field that is named for a credential (any key
 * containing password, login or username) or whose text is written like a
 * credential ("password: ...", "login=..."), or null. Plain prose that only
 * mentions a login ("the seller will hand over the logins at closing") is not
 * refused.
 */
export function findSecretField(value: unknown, path = ""): string | null {
  if (typeof value === "string") {
    return SECRET_VALUE_RE.test(value) ? path || "(value)" : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findSecretField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (SECRET_KEY_RE.test(key)) return childPath;
      const hit = findSecretField(child, childPath);
      if (hit) return hit;
    }
  }
  return null;
}

export function assertNoSecrets(input: unknown): void {
  const field = findSecretField(input);
  if (field) {
    throw new DealDeskError(
      "ESECRET_NOT_ALLOWED",
      `${field} looks like a password, login or username. Deal Desk never stores credentials; put them in Paperclip's secrets store (or leave them on the share) and refer to them by name.`,
    );
  }
}

/** Rule 5 in one call: credentials first, then full tax ids. */
export function assertNoSensitiveContent(input: unknown): void {
  assertNoSecrets(input);
  assertNoSensitiveIds(input);
}
