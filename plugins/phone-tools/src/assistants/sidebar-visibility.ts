/**
 * Pure sidebar-visibility logic extracted from the worker so it can be
 * unit-tested without spinning up a plugin host.
 *
 * Returns whether the Assistants sidebar entry should appear for a given
 * `(companyId, accounts)` pair.
 *
 * Visibility rules (from plan §2):
 * 1. Plugin not installed → handled by the host's `usePluginSlots` filter.
 *    Not represented here; the worker isn't running, so this function is
 *    never called.
 * 2. Plugin installed but the company is not in any account's
 *    `allowedCompanies` list → return `{ visible: false, reason: ... }`.
 * 3. Plugin installed, company allow-listed in at least one account
 *    (either via the wildcard `"*"` or by UUID) → `{ visible: true }`.
 */

export interface SidebarVisibilityAccount {
  allowedCompanies?: string[];
}

export interface SidebarVisibilityResult {
  visible: boolean;
  reason: "ok" | "no-company" | "no-accounts" | "company-not-allow-listed";
}

export function computeSidebarVisibility(
  companyId: string | null | undefined,
  accounts: SidebarVisibilityAccount[],
): SidebarVisibilityResult {
  if (!companyId) return { visible: false, reason: "no-company" };
  if (accounts.length === 0) return { visible: false, reason: "no-accounts" };
  const matching = accounts.some((a) => {
    const allow = a.allowedCompanies ?? [];
    return allow.includes("*") || allow.includes(companyId);
  });
  return matching
    ? { visible: true, reason: "ok" }
    : { visible: false, reason: "company-not-allow-listed" };
}
