/**
 * The words to show for a failed plugin call.
 *
 * usePluginAction and usePluginData fail with a plain `{ code, message }`
 * object rather than an Error, so `String(err)` showed "[object Object]" for
 * every refusal.
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * What the dashboard widget says when it cannot show backup status. A company
 * that is not on the allowed list is told so in words, not with a code.
 */
export function widgetErrorText(err: unknown): string {
  const text = errorText(err);
  return text.includes("ECOMPANY_NOT_ALLOWED")
    ? "Backups are not turned on for this company."
    : `Backup status is not available: ${text}`;
}
