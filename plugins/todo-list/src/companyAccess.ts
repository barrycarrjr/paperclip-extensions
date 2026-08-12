import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * The company allow-list gate.
 *
 * Note carefully what this does and does not do here. It decides whether the
 * plugin is switched on for the company the operator happens to be looking at.
 * It does NOT decide which to-dos they can see: that is `user_id` alone, in
 * src/todos.ts. Both checks run, and they answer different questions.
 *
 * Practical consequence: configure `allowedCompanies` as ["*"]. A narrower list
 * means the to-do list vanishes while you are in a company that is not on it,
 * even though the items themselves are yours and unchanged.
 */
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
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { tool: route, companyId, resourceKey: "todo-list" });
    throw new Error(
      `[ECOMPANY_NOT_ALLOWED] To-dos has no allowedCompanies configured. Set ["*"] for portfolio-wide, which is the recommended setting for a personal list.`,
    );
  }
  if (allowedCompanies.includes("*")) return;
  if (!allowedCompanies.includes(companyId)) {
    ctx.logger.warn("ECOMPANY_NOT_ALLOWED", { tool: route, companyId, resourceKey: "todo-list" });
    throw new Error(
      `[ECOMPANY_NOT_ALLOWED] To-dos is not assigned to company ${companyId}.`,
    );
  }
}
