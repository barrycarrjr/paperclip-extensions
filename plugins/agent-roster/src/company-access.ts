export interface RosterConfig {
  allowedCompanies?: string[];
}

export function isCompanyAllowed(allowedCompanies: unknown, companyId: string): boolean {
  if (!companyId || !Array.isArray(allowedCompanies) || allowedCompanies.length === 0
      || !allowedCompanies.every((id) => typeof id === "string" && id.length > 0)) return false;
  return allowedCompanies.includes("*") || allowedCompanies.includes(companyId);
}
