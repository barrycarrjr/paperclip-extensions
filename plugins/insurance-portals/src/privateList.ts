/**
 * Keep an operator's private-details list up to date with what the portals
 * show: policy and account numbers and property addresses.
 *
 * Some operators keep such a list for a pre-push check that stops these
 * details from being published (one line per item, "#" for comments). The
 * plugin only appends, only to a file that already exists, and only items
 * not already listed; it never rewrites or removes a line, and never logs the
 * values.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./localFolder.js";

export const DEFAULT_PRIVATE_LIST = join(homedir(), ".config", "private-push-guard", "patterns.txt");

/** The list file to update, or null when there is none or it is turned off. */
export function privateListPath(setting: string | undefined): string | null {
  const v = (setting ?? "").trim();
  if (/^off$/i.test(v)) return null;
  const path = v ? expandHome(v) : DEFAULT_PRIVATE_LIST;
  return existsSync(path) ? path : null;
}

/**
 * Append the items not already in the list. Returns how many were added.
 * Matching ignores case, and an item already covered by a listed entry
 * (the entry appears inside it) counts as listed.
 */
export async function addPrivateItems(path: string, carrier: string, items: string[], today: string): Promise<number> {
  const current = await readFile(path, "utf8");
  const listed = current
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/^(re|allow):/.test(l))
    .map((l) => l.toLowerCase());
  const fresh: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item.length < 5 || /[\r\n]/.test(item)) continue;
    const low = item.toLowerCase();
    if (listed.some((l) => low.includes(l)) || fresh.some((f) => f.toLowerCase() === low)) continue;
    fresh.push(item);
  }
  if (fresh.length === 0) return 0;
  const block = `${current.endsWith("\n") ? "" : "\n"}\n# Added by insurance-portals from ${carrier}, ${today}\n${fresh.join("\n")}\n`;
  await appendFile(path, block, "utf8");
  return fresh.length;
}
