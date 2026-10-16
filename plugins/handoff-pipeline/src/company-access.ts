import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface HandOffConfig {
  allowedCompanies?: string[];
}

export function isCompanyAllowed(allowedCompanies: string[] | undefined, companyId: string): boolean {
  if (!Array.isArray(allowedCompanies) || allowedCompanies.length === 0) return false;
  return allowedCompanies.includes("*") || allowedCompanies.includes(companyId);
}

export function assertCompanyAllowed(
  ctx: { logger: Pick<PluginContext["logger"], "warn"> },
  route: string,
  allowedCompanies: string[] | undefined,
  companyId: string,
): void {
  if (isCompanyAllowed(allowedCompanies, companyId)) return;
  ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { route, companyId, resourceKey: "handoff-pipeline" });
  throw new Error(
    `[ECOMPANY_NOT_ALLOWED] Hand-off is not enabled for company ${companyId}. Select it in the plugin settings.`,
  );
}
