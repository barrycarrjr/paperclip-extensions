/**
 * Whether a company may use a Google account, from that account's allow-list.
 *
 * This is the plugin's only per-company authorisation, so it fails closed.
 * An empty or missing list means nobody, not everybody: the README always
 * promised "Empty = unusable (fail-safe deny)" and the code used to do the
 * opposite. "*" is the one explicit way to say every company, the same
 * convention phone-tools uses, so an operator who genuinely wants a shared
 * account has to say so rather than get it by leaving a field blank.
 *
 * Pure and separate from the OAuth code so it can be tested without secrets.
 */
export function isCompanyAllowedForAccount(
  allowedCompanies: readonly string[] | null | undefined,
  companyId: string | null | undefined,
): boolean {
  if (!companyId) return false;
  if (!allowedCompanies || allowedCompanies.length === 0) return false;
  if (allowedCompanies.includes("*")) return true;
  return allowedCompanies.includes(companyId);
}
