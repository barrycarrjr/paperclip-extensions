import type { PluginContext } from "@paperclipai/plugin-sdk";

export function isCompanyAllowed(
  allowedCompanies: string[] | undefined,
  companyId: string,
): boolean {
  if (!allowedCompanies || allowedCompanies.length === 0) return false;
  if (allowedCompanies.includes("*")) return true;
  return allowedCompanies.includes(companyId);
}

export function assertCompanyAccess(
  ctx: PluginContext,
  args: {
    route: string;
    allowedCompanies: string[] | undefined;
    companyId: string;
  },
): void {
  const { route, allowedCompanies, companyId } = args;
  if (!allowedCompanies || allowedCompanies.length === 0) {
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { tool: route, companyId, resourceKey: "notepad" });
    throw new Error(
      `[ECOMPANY_NOT_ALLOWED] Notepad has no allowedCompanies configured. Add the company UUID, or set ["*"] for portfolio-wide.`,
    );
  }
  if (allowedCompanies.includes("*")) return;
  if (!allowedCompanies.includes(companyId)) {
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { tool: route, companyId, resourceKey: "notepad" });
    throw new Error(
      `[ECOMPANY_NOT_ALLOWED] Notepad is not assigned to company ${companyId}.`,
    );
  }
}
