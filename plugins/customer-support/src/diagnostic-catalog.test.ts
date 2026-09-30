import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticScript, validateDiagnosticOptions } from "./diagnostic-catalog.js";
import { buildRepairRecipe } from "./repair-catalog.js";

test("diagnostic filters reject unknown commands, inappropriate options and unbounded requests", () => {
  assert.throws(() => validateDiagnosticOptions("arbitrary", {}));
  assert.throws(() => validateDiagnosticOptions("events", { hours: 169 }));
  assert.throws(() => validateDiagnosticOptions("events", { log: "Security" }));
  assert.throws(() => validateDiagnosticOptions("storage", { printer: "Queue" }));
  assert.throws(() => validateDiagnosticOptions("network", { port: 445 }));
  assert.throws(() => validateDiagnosticOptions("events", { script: "Anything" }));
  assert.deepEqual(validateDiagnosticOptions("events", { log: "Application", limit: 10 }), { log: "Application", limit: 10 });
});
test("operator supplied names are encoded as data rather than executable PowerShell", () => {
  const value = "Queue'; Remove-Item C:\\*; #";
  const script = diagnosticScript("Get-Printer", { printer: value });
  assert.doesNotMatch(script, /Remove-Item/);
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)![1]!;
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString()), { printer: value });
  const recipe = buildRepairRecipe("cancel_print_job", { printer: value, jobId: 1, submittedAtUtc: "2026-01-01T00:00:00.0000000Z" });
  assert.doesNotMatch(recipe.script, /Remove-Item/);
  assert.match(recipe.script, /identity changed/);
  assert.match(recipe.recoveryNotes, /cannot be undone/);
});
test("repair recipes reject wildcard services and require print job identity and verification", () => {
  assert.throws(() => buildRepairRecipe("restart_service", { service: "*" }));
  assert.throws(() => buildRepairRecipe("cancel_print_job", { printer: "Queue", jobId: 1 }));
  assert.throws(() => buildRepairRecipe("restart_spooler", { force: true }));
  const recipe = buildRepairRecipe("restart_spooler", {});
  assert.match(recipe.script, /Restart-Service/); assert.doesNotMatch(recipe.script, /-Force|Remove-Item/);
  assert.match(recipe.verificationScript, /Service is not running/);
});
