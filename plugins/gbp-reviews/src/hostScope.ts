/**
 * The company and user the HOST checked, not the ones the browser claimed.
 *
 * Every bridge call from a plugin page arrives with two copies of the company
 * id: `companyId` at the top of the request body, which the host validates
 * against the caller's memberships, and whatever the page put inside
 * `params`, which used to be forwarded to the worker untouched. A member of
 * company A could therefore send a validated A on the outside and B on the
 * inside, and a handler reading `params.companyId` acted on B.
 *
 * The host now writes `params.hostScope` LAST, after spreading the browser's
 * params, so it cannot be spoofed from the page. Handlers read this key and
 * nothing else for scoping. A missing or null company is refused rather than
 * treated as "show everything": the page is always opened inside a company,
 * and an instance-admin call with no company has no business posting a
 * public reply or reading one company's reviews.
 */

export interface HostScope {
  /** The company the host validated; null for an instance-admin global call. */
  companyId: string | null;
  /** The signed-in board user; null when the caller is not a user. */
  userId: string | null;
}

export interface CompanyScope extends HostScope {
  companyId: string;
}

function isIdOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * The host scope as sent, or null when it is absent or not the right shape.
 * Shape is checked strictly: a number, an array, or an object missing either
 * field all count as "not there", because the only thing that can write this
 * key correctly is the host.
 */
export function readHostScope(params: unknown): HostScope | null {
  if (!params || typeof params !== "object") return null;
  const raw = (params as { hostScope?: unknown }).hostScope;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { companyId, userId } = raw as { companyId?: unknown; userId?: unknown };
  if (!("companyId" in raw) || !("userId" in raw)) return null;
  if (!isIdOrNull(companyId) || !isIdOrNull(userId)) return null;
  return { companyId, userId };
}

export const ESCOPE_MESSAGE = "[ESCOPE] This page must be opened inside a company.";

/**
 * The scope with a company in it, or a thrown [ESCOPE]. Handlers call this
 * first so that no query or Google call runs on behalf of nobody.
 */
export function requireCompanyScope(params: unknown): CompanyScope {
  const scope = readHostScope(params);
  if (!scope || !scope.companyId) throw new Error(ESCOPE_MESSAGE);
  return { companyId: scope.companyId, userId: scope.userId };
}
