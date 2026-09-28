import { IntakeError, type Config, type RemoteAccessProfile } from "./routing.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const account = /^[A-Za-z0-9_.-]+\\[A-Za-z0-9_.@$-]+$/;
const address = /^[A-Za-z0-9._-]+$/;
const transports = new Set(["Auto", "WinRMHttps", "WinRMHttp", "Wmi"]);

export interface ResolvedRemoteAccess {
  profileId: string;
  companyId: string;
  target: string;
  credentialUser: string;
  passwordRef: string;
  transport: "Auto" | "WinRMHttps" | "WinRMHttp" | "Wmi";
  allowProcessExecutionPolicyBypass: boolean;
}

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((number, part) => ((number << 8) | Number(part)) >>> 0, 0);
}

function inIpv4Cidr(target: string, cidr: string): boolean {
  const [base, prefixText, extra] = cidr.split("/");
  const prefix = Number(prefixText);
  const targetNumber = ipv4Number(target);
  const baseNumber = ipv4Number(base ?? "");
  if (extra !== undefined || targetNumber === null || baseNumber === null ||
      !/^\d{1,2}$/.test(prefixText ?? "") || prefix < 8 || prefix > 32) return false;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return ((targetNumber & mask) >>> 0) === ((baseNumber & mask) >>> 0);
}

function inDnsSuffix(target: string, suffix: string): boolean {
  const normalized = suffix.toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(normalized) &&
    ipv4Number(target) === null && target.toLowerCase().endsWith(`.${normalized}`);
}

/** Resolve one company/target binding before any credential is read or command is run. */
export function resolveRemoteAccess(config: Config, companyId: string, target: string): ResolvedRemoteAccess {
  if (!uuid.test(companyId) || !address.test(target)) throw new IntakeError(422, "Invalid company or target");
  const companyProfiles = (config.remoteAccessProfiles ?? []).filter((profile) =>
    typeof profile.companyId === "string" && profile.companyId.toLowerCase() === companyId.toLowerCase());
  const exact = companyProfiles.flatMap((profile) => (profile.targets ?? [])
    .filter((candidate) => typeof candidate.address === "string" && candidate.address.toLowerCase() === target.toLowerCase())
    .map((candidate) => ({ profile, candidate })));
  const scoped = companyProfiles.flatMap((profile) => (profile.scopes ?? [])
    .filter((candidate) => typeof candidate.value === "string" &&
      (candidate.kind === "dns_suffix" ? inDnsSuffix(target, candidate.value)
        : candidate.kind === "ipv4_cidr" && inIpv4Cidr(target, candidate.value)))
    .map((candidate) => ({ profile, candidate })));
  // An explicit computer binding may narrow the account or transport used inside a broad scope.
  const matches = exact.length ? exact : scoped;
  if (matches.length !== 1) throw new IntakeError(403, "Remote target is unavailable for this company");
  const { profile, candidate } = matches[0]!;
  if (typeof profile.id !== "string" || !profile.id.trim() ||
      typeof profile.credentialUser !== "string" || !account.test(profile.credentialUser) ||
      typeof profile.passwordRef !== "string" || !uuid.test(profile.passwordRef) ||
      !transports.has(candidate.transport) ||
      (candidate.allowProcessExecutionPolicyBypass !== undefined &&
        typeof candidate.allowProcessExecutionPolicyBypass !== "boolean")) {
    throw new IntakeError(422, "Remote access profile is invalid");
  }
  return {
    profileId: profile.id,
    companyId,
    target,
    credentialUser: profile.credentialUser,
    passwordRef: profile.passwordRef,
    transport: candidate.transport,
    allowProcessExecutionPolicyBypass: candidate.allowProcessExecutionPolicyBypass === true,
  };
}
