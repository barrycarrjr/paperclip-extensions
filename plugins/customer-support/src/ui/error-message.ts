/** Show the public bridge message, never its internal details or an object dump. */
export function supportErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object" && "message" in error &&
      typeof error.message === "string" && error.message.trim()) return error.message;
  return "The request failed. Refresh this page and check the plugin's status in Settings.";
}
