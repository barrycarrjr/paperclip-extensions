import { strict as assert } from "node:assert";
import os from "node:os";
import { test } from "node:test";
import { redactCurrentUserForStoredComment, storedCorrectionBodyMatches } from "./host-correction.js";

test("stored corrections must match the exact prepared content", () => {
  const expected = "Hand-off review correction for run run-a\n\nWrong total\n\nCorrected output:\nCorrect output";
  assert.equal(storedCorrectionBodyMatches(expected, expected), true);
  assert.equal(storedCorrectionBodyMatches(expected.replace("Correct output", "Unrelated output"), expected), false);
});

test("stored corrections accept only the host-redacted form of prepared content", () => {
  const expected = `Hand-off review correction for run run-a\n\nWrong path\n\nCorrected output:\nRead ${os.homedir()}\\report.txt`;
  const redacted = redactCurrentUserForStoredComment(expected);
  assert.equal(storedCorrectionBodyMatches(redacted, expected), true);
  assert.equal(storedCorrectionBodyMatches(`${redacted} changed`, expected), false);
});
