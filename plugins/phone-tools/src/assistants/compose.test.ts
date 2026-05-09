/**
 * Unit tests for composeAssistant (pure function).
 *
 * Run with: `pnpm test` (uses node --test --import tsx).
 * Pure-function tests live in src/ alongside the implementation so they
 * always travel with refactors and so the dist/ bundle skips them
 * automatically (esbuild only sees the worker entrypoint).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { composeAssistant, type AssistantWizardAnswers } from "./compose.js";

const baseEa: AssistantWizardAnswers = {
  type: "ea",
  name: "Stephen",
  principal: "Barry",
  tasks: ["schedule-meetings", "take-messages"],
  customTasks: "",
  phoneEnabled: true,
  voice: "alloy",
  callerIdNumberId: "num-1",
};

test("EA: firstMessage uses name and principal", () => {
  const result = composeAssistant(baseEa);
  assert.equal(
    result.firstMessage,
    "Hi, this is Stephen calling on behalf of Barry. Is this a good moment to talk?",
  );
});

test("EA: systemPrompt includes assistant identity", () => {
  const result = composeAssistant(baseEa);
  assert.match(result.systemPrompt, /You are Stephen/);
  assert.match(result.systemPrompt, /on behalf of Barry/);
});

test("EA: included tasks render their how-to lines", () => {
  const result = composeAssistant({
    ...baseEa,
    tasks: ["schedule-meetings"],
  });
  assert.match(result.systemPrompt, /Schedule meetings/);
  assert.match(result.systemPrompt, /schedule a meeting/i);
  assert.doesNotMatch(result.systemPrompt, /take a clear message/);
});

test("EA: empty tasks omit task sections", () => {
  const result = composeAssistant({
    ...baseEa,
    tasks: [],
  });
  assert.doesNotMatch(result.systemPrompt, /What you can help with:/);
  assert.doesNotMatch(result.systemPrompt, /How to handle each task:/);
});

test("EA: customTasks appear in their own section", () => {
  const result = composeAssistant({
    ...baseEa,
    customTasks: "Reschedule Tuesday's call to Wednesday at 3pm ET if needed.",
  });
  assert.match(result.systemPrompt, /Additional context the operator provided:/);
  assert.match(result.systemPrompt, /Reschedule Tuesday/);
});

test("Custom: uses Custom-type intro and never inlines EA tasks", () => {
  const result = composeAssistant({
    ...baseEa,
    type: "custom",
    tasks: ["schedule-meetings", "take-messages"],
  });
  assert.match(result.systemPrompt, /The operator will give you specific objectives/);
  assert.doesNotMatch(result.systemPrompt, /What you can help with:/);
  assert.doesNotMatch(result.systemPrompt, /How to handle each task:/);
});

test("Calling style is always present", () => {
  const result = composeAssistant(baseEa);
  assert.match(result.systemPrompt, /Calling style:/);
  assert.match(result.systemPrompt, /Speak in short, natural sentences/);
  assert.match(result.systemPrompt, /If you reach voicemail/);
});

test("Falls back gracefully on missing name/principal", () => {
  const result = composeAssistant({
    ...baseEa,
    name: "",
    principal: "",
  });
  assert.match(result.firstMessage, /^Hi, this is Alex/);
  assert.match(result.firstMessage, /on behalf of the operator/);
});

test("Trailing punctuation in name/principal is trimmed", () => {
  const result = composeAssistant({
    ...baseEa,
    name: "Stephen.",
    principal: "Barry.  ",
  });
  assert.match(result.firstMessage, /Hi, this is Stephen calling on behalf of Barry\./);
});

test("Unknown task IDs are silently skipped (no how-to section, no crash)", () => {
  const result = composeAssistant({
    ...baseEa,
    tasks: ["does-not-exist", "take-messages"],
  });
  assert.match(result.systemPrompt, /take a clear message/);
});
