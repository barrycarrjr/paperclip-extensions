/**
 * What the Backups page and the dashboard widget say when a plugin call fails.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { errorText, restoreErrorText, restoreOutcomeUnknown, widgetErrorText } from "./errorText.js";

test("a refusal from usePluginAction shows its message, not [object Object]", () => {
  // The bridge fails with a plain object, not an Error.
  const refusal = { code: "WORKER_ERROR", message: "[EBACKUP_NO_DESTINATIONS] no enabled destinations configured" };
  assert.equal(errorText(refusal), "[EBACKUP_NO_DESTINATIONS] no enabled destinations configured");
});

test("an Error or a bare value still shows as before", () => {
  assert.equal(errorText(new Error("worker stopped")), "worker stopped");
  assert.equal(errorText("timed out"), "timed out");
});

test("the Restore tab says in words why a restore was refused or failed", () => {
  // A refusal arrives from usePluginAction as a plain object.
  assert.equal(
    restoreErrorText({
      code: "WORKER_ERROR",
      message: "[EBACKUP_RESTORE_NOT_ADMIN] only an instance admin can preview or apply a restore",
    }),
    "Only an instance admin can preview or apply a restore.",
  );
  // A failure arrives as the restore's own error text.
  assert.equal(
    restoreErrorText("[EBACKUP_INTEGRITY_FAILED] envelope HMAC verification failed"),
    "The archive could not be decrypted. The passphrase may be wrong, or the archive is damaged.",
  );
  assert.equal(
    restoreErrorText("ESNAPSHOT_IN_FLIGHT: cannot restore while a backup is running"),
    "Paperclip is busy with a backup or another restore. Try again when it finishes.",
  );
  assert.equal(
    restoreErrorText("[EBACKUP_INTEGRITY_FAILED] the archive is cut off: it has no end marker"),
    "The archive is incomplete: it stops before its end, so it cannot be restored.",
  );
  // Anything else keeps its words and loses its code.
  assert.equal(restoreErrorText("[EBACKUP_DEST_UNREACHABLE] (s3) connect ECONNREFUSED"), "(s3) connect ECONNREFUSED");
});

test("a restore that ran out of time is not reported as rolled back", () => {
  const timedOut = '"system.restoreSnapshot" timed out after 1800000ms';
  assert.match(restoreErrorText(timedOut), /It may still be running/);
  assert.equal(restoreOutcomeUnknown(timedOut), true);
  assert.equal(restoreOutcomeUnknown("ESNAPSHOT_IN_FLIGHT: cannot restore while a backup is running"), false);
});

test("the dashboard widget says in words that a company is not on the allowed list", () => {
  assert.equal(
    widgetErrorText({ code: "WORKER_ERROR", message: "[ECOMPANY_NOT_ALLOWED]" }),
    "Backups are not turned on for this company.",
  );
  assert.equal(
    widgetErrorText({ code: "TIMEOUT", message: "worker did not answer" }),
    "Backup status is not available: worker did not answer",
  );
});
