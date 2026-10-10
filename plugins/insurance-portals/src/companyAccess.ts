import type { PluginContext } from "@paperclipai/plugin-sdk";

export interface AssertCompanyAccessArgs {
  tool: string;
  resourceLabel: string;
  resourceKey: string;
  allowedCompanies: string[] | undefined;
  companyId: string;
}

export function assertCompanyAccess(
  ctx: PluginContext,
  args: AssertCompanyAccessArgs,
): void {
  const { tool, resourceLabel, resourceKey, allowedCompanies, companyId } = args;
  if (!allowedCompanies || allowedCompanies.length === 0) {
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { tool, companyId, resourceKey });
    throw new Error(
      `[ECOMPANY_NOT_ALLOWED] ${resourceLabel} has no allowedCompanies configured. Add the company UUID, or set ["*"] for portfolio-wide.`,
    );
  }
  if (allowedCompanies.includes("*")) return;
  if (!allowedCompanies.includes(companyId)) {
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { tool, companyId, resourceKey });
    throw new Error(
      `[ECOMPANY_NOT_ALLOWED] ${resourceLabel} is not assigned to company ${companyId}.`,
    );
  }
}
