/** Show only readable error text, never an object's details or serialized body. */
export function uiErrorText(error: unknown): string {
  const message = typeof error === "string" ? error
    : error && typeof error === "object" && "message" in error ? error.message : undefined;
  return typeof message === "string" && message.trim()
    ? message
    : "The request failed. Please try again.";
}
