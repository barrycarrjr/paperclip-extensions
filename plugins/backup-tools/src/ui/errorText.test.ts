/**
 * What the Backups page and the dashboard widget say when a plugin call fails.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { errorText, widgetErrorText } from "./errorText.js";

test("a refusal from usePluginAction shows its message, not [object Object]", () => {
  // The bridge fails with a plain object, not an Error.
  const refusal = { code: "WORKER_ERROR", message: "[EBACKUP_NO_DESTINATIONS] no enabled destinations configured" };
  assert.equal(errorText(refusal), "[EBACKUP_NO_DESTINATIONS] no enabled destinations configured");
});

test("an Error or a bare value still shows as before", () => {
  assert.equal(errorText(new Error("worker stopped")), "worker stopped");
  assert.equal(errorText("timed out"), "timed out");
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
