import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * The company allow-list gate, same shape as business-records (copied from it;
 * only the plugin name and resource key differ).
 *
 * Deal figures are sensitive (what the buyer would pay, what the seller
 * earns), so the intended setting is the HQ company only. Every tool and API
 * route calls assertCompanyAccess before touching the database; a company
 * outside the list gets [ECOMPANY_NOT_ALLOWED] and no data at all.
 */

const RESOURCE_KEY = "deal-desk";

export function isCompanyAllowed(allowedCompanies: string[] | undefined, companyId: string): boolean {
  if (!allowedCompanies || allowedCompanies.length === 0) return false;
  if (allowedCompanies.includes("*")) return true;
  return allowedCompanies.includes(companyId);
}

/** The refusal message for this company, or null when it is allowed. Pure. */
export function companyAccessError(allowedCompanies: string[] | undefined, companyId: string): string | null {
  if (!allowedCompanies || allowedCompanies.length === 0) {
    return `[ECOMPANY_NOT_ALLOWED] Deal Desk has no allowedCompanies configured. Add the HQ company on the plugin settings page.`;
  }
  if (isCompanyAllowed(allowedCompanies, companyId)) return null;
  return `[ECOMPANY_NOT_ALLOWED] Deal Desk is not assigned to company ${companyId}.`;
}

export function assertCompanyAccess(
  ctx: { logger: Pick<PluginContext["logger"], "warn"> },
  args: {
    route: string;
    allowedCompanies: string[] | undefined;
    companyId: string;
  },
): void {
  const { route, allowedCompanies, companyId } = args;
  const error = companyAccessError(allowedCompanies, companyId);
  if (error) {
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { tool: route, companyId, resourceKey: RESOURCE_KEY });
    throw new Error(error);
  }
}
