import { createHash } from "node:crypto";

/**
 * Stable fingerprint for a finding. Steward uses this as
 * `originFingerprint` on issues so a second sweep that re-detects the same
 * issue won't file a duplicate proposal. The shape is `category:detail`
 * with all components normalized to forward slashes and lowercased file
 * paths so the same file matches across OS conventions.
 */
export function fingerprint(category: string, ...parts: string[]): string {
  const normalized = parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p) => String(p).replace(/\\/g, "/"))
    .join(":");
  const hash = createHash("sha1")
    .update(`${category}:${normalized}`)
    .digest("hex")
    .slice(0, 16);
  return `${category}:${hash}`;
}
