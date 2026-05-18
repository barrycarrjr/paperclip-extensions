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
import { composeAssistant, substituteCallReason, type AssistantWizardAnswers } from "./compose.js";

const baseEa: AssistantWizardAnswers = {
  type: "ea",
  name: "Stephen",
  principal: "Barry",
  tasks: ["schedule-meetings", "take-messages"],
  customTasks: "",
  phoneEnabled: true,
  emailEnabled: false,
  calendarEnabled: false,
  voice: "alloy",
  callerIdNumberId: "num-1",
};

test("EA: firstMessage uses name and includes the reason placeholder", () => {
  const result = composeAssistant(baseEa);
  assert.equal(
    result.firstMessage,
    "Hi, this is Stephen. I'm calling regarding {the reason for call}. Is this a good moment to talk?",
  );
});

test("EA: firstMessage does NOT leak principal name (operator fills reason via wizard)", () => {
  const result = composeAssistant(baseEa);
  assert.doesNotMatch(result.firstMessage, /Barry/);
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

test("Calling style includes the no-name-leak rule referencing both names", () => {
  const result = composeAssistant(baseEa);
  assert.match(result.systemPrompt, /Don't volunteer Barry's name on the call/);
  assert.match(result.systemPrompt, /assistant calling on behalf of a client/);
  assert.match(result.systemPrompt, /Only share Barry's name if the person specifically asks/);
});

test("Voicemail rule does not mention giving a callback number", () => {
  const result = composeAssistant(baseEa);
  // Voicemail block should still exist, just not instruct giving a callback number.
  assert.match(result.systemPrompt, /If you reach voicemail/);
  assert.doesNotMatch(result.systemPrompt, /callback number/);
});

test("gather-information task renders its label and how-to instructions", () => {
  const result = composeAssistant({
    ...baseEa,
    tasks: ["gather-information"],
  });
  assert.match(result.systemPrompt, /Gather information/);
  assert.match(result.systemPrompt, /take detailed notes/);
  assert.match(result.systemPrompt, /deliver the full findings back/);
});

test("Intro line mentions gathering information for EA assistants", () => {
  const result = composeAssistant(baseEa);
  assert.match(result.systemPrompt, /and gathering information/);
});

test("substituteCallReason: substitutes a provided reason into the placeholder", () => {
  const tpl = "Hi, this is Alex. I'm calling regarding {the reason for call}. Is this a good moment to talk?";
  const out = substituteCallReason(tpl, "getting a price on a golf cart");
  assert.equal(
    out,
    "Hi, this is Alex. I'm calling regarding getting a price on a golf cart. Is this a good moment to talk?",
  );
});

test("substituteCallReason: trims whitespace from the reason", () => {
  const tpl = "Hi, this is Alex. I'm calling regarding {the reason for call}. Is this a good moment to talk?";
  const out = substituteCallReason(tpl, "   confirming Friday's appointment   ");
  assert.match(out, /regarding confirming Friday's appointment\. /);
});

test("substituteCallReason: drops the placeholder sentence when no reason is provided", () => {
  const tpl = "Hi, this is Alex. I'm calling regarding {the reason for call}. Is this a good moment to talk?";
  const out = substituteCallReason(tpl, undefined);
  assert.equal(out, "Hi, this is Alex. Is this a good moment to talk?");
  assert.doesNotMatch(out, /the reason for call/);
});

test("substituteCallReason: handles empty-string reason like undefined", () => {
  const tpl = "Hi, this is Alex. I'm calling regarding {the reason for call}. Is this a good moment to talk?";
  const out = substituteCallReason(tpl, "");
  assert.equal(out, "Hi, this is Alex. Is this a good moment to talk?");
});

test("substituteCallReason: leaves a non-templated firstMessage unchanged", () => {
  const tpl = "Hi, this is Alex. Is this a good moment to talk?";
  assert.equal(substituteCallReason(tpl, "anything"), tpl);
  assert.equal(substituteCallReason(tpl, undefined), tpl);
});

test("Preflight check block is always present and demands missing-info bouncing", () => {
  const result = composeAssistant(baseEa);
  assert.match(result.systemPrompt, /Before you place a call/);
  assert.match(result.systemPrompt, /Check you have what you need/);
  assert.match(result.systemPrompt, /do NOT place the call with a hallucinated number/);
  assert.match(result.systemPrompt, /reassign the issue back to the reporter/);
  assert.match(result.systemPrompt, /Batch all questions in one round/);
});

test("Preflight check is present for custom-type assistants too", () => {
  const result = composeAssistant({ ...baseEa, type: "custom" });
  assert.match(result.systemPrompt, /Before you place a call/);
  assert.match(result.systemPrompt, /reassign the issue back to the reporter/);
});

test("substituteCallReason: works on the composed default from composeAssistant", () => {
  const composed = composeAssistant(baseEa);
  const withReason = substituteCallReason(composed.firstMessage, "the golf cart pricing");
  assert.match(withReason, /^Hi, this is Stephen\./);
  assert.match(withReason, /regarding the golf cart pricing\./);
  assert.doesNotMatch(withReason, /\{the reason for call\}/);
});

test("Falls back gracefully on missing name/principal", () => {
  const result = composeAssistant({
    ...baseEa,
    name: "",
    principal: "",
  });
  assert.match(result.firstMessage, /^Hi, this is Alex/);
  assert.match(result.systemPrompt, /on behalf of the operator/);
});

test("Trailing punctuation in name/principal is trimmed", () => {
  const result = composeAssistant({
    ...baseEa,
    name: "Stephen.",
    principal: "Barry.  ",
  });
  assert.match(result.firstMessage, /^Hi, this is Stephen\./);
  assert.match(result.systemPrompt, /on behalf of Barry\b/);
});

test("Unknown task IDs are silently skipped (no how-to section, no crash)", () => {
  const result = composeAssistant({
    ...baseEa,
    tasks: ["does-not-exist", "take-messages"],
  });
  assert.match(result.systemPrompt, /take a clear message/);
});

test("No channels block when only Phone is enabled", () => {
  const result = composeAssistant(baseEa);
  assert.doesNotMatch(result.systemPrompt, /Other channels you can use/);
  assert.doesNotMatch(result.systemPrompt, /Email channel/);
  assert.doesNotMatch(result.systemPrompt, /Calendar channel/);
});

test("Email capability renders an email channel section naming email-tools", () => {
  const result = composeAssistant({ ...baseEa, emailEnabled: true });
  assert.match(result.systemPrompt, /Other channels you can use/);
  assert.match(result.systemPrompt, /Email channel/);
  assert.match(result.systemPrompt, /email-tools/);
  assert.match(result.systemPrompt, /draft before sending/);
});

test("Calendar capability renders a calendar channel section naming google-workspace", () => {
  const result = composeAssistant({ ...baseEa, calendarEnabled: true });
  assert.match(result.systemPrompt, /Other channels you can use/);
  assert.match(result.systemPrompt, /Calendar channel/);
  assert.match(result.systemPrompt, /google-workspace/);
  assert.match(result.systemPrompt, /time zone/);
});

test("Both email and calendar render together under one channels heading", () => {
  const result = composeAssistant({
    ...baseEa,
    emailEnabled: true,
    calendarEnabled: true,
  });
  const matches = result.systemPrompt.match(/Other channels you can use/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(result.systemPrompt, /Email channel/);
  assert.match(result.systemPrompt, /Calendar channel/);
});
