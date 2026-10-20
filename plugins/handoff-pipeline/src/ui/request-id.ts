let fallbackSequence = 0;

// These keys deduplicate requests; they are not credentials or security tokens.
export function createRequestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `request-${Date.now().toString(36)}-${(fallbackSequence++).toString(36)}-${Math.random().toString(36).slice(2)}`;
}
