import os from "node:os";

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function mask(value: string): string {
  return value ? `${value[0]}${"*".repeat(Math.max(1, Array.from(value).length - 1))}` : "*";
}

function lastPathSegment(value: string): string {
  return value.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean).at(-1) ?? "";
}

function replaceLastPathSegment(value: string, replacement: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  const separator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return separator < 0 ? replacement : `${normalized.slice(0, separator + 1)}${replacement}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mirrors the host's optional current-user redaction for persisted comment bodies. */
export function redactCurrentUserForStoredComment(input: string): string {
  const userNames = unique([
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
    (() => { try { return os.userInfo().username; } catch { return undefined; } })(),
  ]);
  const homeDirs = unique([
    process.env.HOME,
    process.env.USERPROFILE,
    (() => { try { return os.homedir(); } catch { return undefined; } })(),
    ...userNames.flatMap((name) => [`/Users/${name}`, `/home/${name}`, `C:\\Users\\${name}`]),
  ]);
  let result = input;
  for (const homeDir of homeDirs.sort((a, b) => b.length - a.length)) {
    if (!result.includes(homeDir)) continue;
    result = result.split(homeDir).join(replaceLastPathSegment(homeDir, mask(lastPathSegment(homeDir))));
  }
  for (const userName of userNames.sort((a, b) => b.length - a.length)) {
    if (!result.includes(userName)) continue;
    result = result.replace(new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(userName)}(?![A-Za-z0-9._-])`, "g"), mask(userName));
  }
  return result;
}

export function storedCorrectionBodyMatches(stored: string, expected: string): boolean {
  return stored === expected || stored === redactCurrentUserForStoredComment(expected);
}
