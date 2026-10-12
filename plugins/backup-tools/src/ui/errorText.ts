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
 * What the Restore tab says when a restore is refused or fails. The worker's
 * messages start with a code, which suits logs and API callers. A person gets
 * a sentence.
 */
export function restoreErrorText(err: unknown): string {
  const text = errorText(err);
  if (text.includes("EBACKUP_RESTORE_NOT_ADMIN")) return "Only an instance admin can preview or apply a restore.";
  if (text.includes("EBACKUP_RESTORE_RUNNING")) return "A restore is already running. Wait for it to finish.";
  if (text.includes("EBACKUP_BACKUP_RUNNING")) return "A backup is running. Try the restore again when it finishes.";
  if (text.includes("ESNAPSHOT_IN_FLIGHT")) {
    return "Paperclip is busy with a backup or another restore. Try again when it finishes.";
  }
  if (text.includes("EBACKUP_RESTORE_NOT_CONFIRMED")) return "Type RESTORE THIS INSTANCE exactly to apply the restore.";
  if (text.includes("EBACKUP_INTEGRITY_FAILED") && text.includes("cut off")) {
    return "The archive is incomplete: it stops before its end, so it cannot be restored.";
  }
  if (text.includes("EBACKUP_INTEGRITY_FAILED")) {
    return "The archive could not be decrypted. The passphrase may be wrong, or the archive is damaged.";
  }
  if (text.includes("EBACKUP_DEST_NOT_FOUND")) return "No destination has that ID. The Destinations tab lists them.";
  if (text.includes("EBACKUP_DOWNLOAD_FAILED")) {
    return "The archive could not be read from that destination. Check the archive key.";
  }
  if (text.includes('"system.restoreSnapshot" timed out')) {
    return "Paperclip did not say how the restore ended within 30 minutes. It may still be running. Check the instance before you try again.";
  }
  if (text.includes("EBACKUP_RESTORE_UNSUPPORTED")) {
    return "This build of the plugin cannot restore. It needs rebuilding with Paperclip's current plugin toolkit.";
  }
  return text.replace(/^\[[A-Z_0-9]+\]\s*/, "");
}

/** True when nobody can say whether the failed restore changed the database. */
export function restoreOutcomeUnknown(error: string | null): boolean {
  return String(error).includes('"system.restoreSnapshot" timed out');
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
