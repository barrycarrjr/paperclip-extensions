export interface RosterConfig {
  allowedCompanies?: string[];
}

export function isCompanyAllowed(allowedCompanies: string[] | undefined, companyId: string): boolean {
  if (!Array.isArray(allowedCompanies) || allowedCompanies.length === 0) return false;
  return allowedCompanies.includes("*") || allowedCompanies.includes(companyId);
}
