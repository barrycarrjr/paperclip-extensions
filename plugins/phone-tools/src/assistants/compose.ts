/**
 * Assistant prompt composition.
 *
 * Pure function: takes the wizard's answers and returns the `firstMessage`
 * and `systemPrompt` that go onto the engine-side assistant. The plugin's
 * safety preamble is auto-prepended downstream by the engine layer; do not
 * duplicate the safety rules here.
 *
 * The function is intentionally string-template based (no inlining of skill
 * markdown files in Phase A) so it's deterministic and trivially unit-testable.
 * Phase B can swap to skill-markdown inlining behind the same signature.
 */

export type AssistantWizardType = "ea" | "custom";

export interface AssistantWizardAnswers {
  type: AssistantWizardType;
  name: string;
  principal: string;
  tasks: string[];
  customTasks?: string;
  phoneEnabled: boolean;
  voice: string;
  callerIdNumberId: string;
}

export interface ComposedAssistant {
  firstMessage: string;
  systemPrompt: string;
}

const TASK_INSTRUCTIONS: Record<string, string> = {
  "schedule-meetings":
    "When the person you're calling is trying to schedule a meeting, propose times that you've been told work, confirm the time zone, and read the agreed time back before ending the call.",
  "take-messages":
    "If the person can't take the call right now or asks you to call back, take a clear message: who they are, what they want, and the best time/number to reach them.",
  "confirm-appointments":
    "When confirming an existing appointment, state the date, time, and location, confirm the person can still make it, and offer to reschedule if they can't.",
  "follow-up":
    "When following up on a prior conversation, briefly recap what was discussed, ask whether the next step has happened, and arrange a follow-up if not.",
};

const TASK_LABELS: Record<string, string> = {
  "schedule-meetings": "Schedule meetings",
  "take-messages": "Take messages",
  "confirm-appointments": "Confirm appointments",
  "follow-up": "Follow up after calls",
};

function trimTrailingPunctuation(name: string): string {
  return name.replace(/[.\s]+$/, "");
}

export function composeAssistant(answers: AssistantWizardAnswers): ComposedAssistant {
  const name = trimTrailingPunctuation((answers.name ?? "").trim()) || "Alex";
  const principal = trimTrailingPunctuation((answers.principal ?? "").trim()) || "the operator";
  const tasks = answers.tasks ?? [];
  const customTasks = (answers.customTasks ?? "").trim();

  const firstMessage =
    `Hi, this is ${name} calling on behalf of ${principal}. Is this a good moment to talk?`;

  const taskBullets = tasks
    .map((id) => TASK_INSTRUCTIONS[id])
    .filter((text): text is string => Boolean(text))
    .map((text) => `- ${text}`)
    .join("\n");

  const intro = answers.type === "ea"
    ? `You are ${name}, a personal executive assistant working on behalf of ${principal}. You help with phone calls — scheduling, confirming, taking messages, and following up — and you keep things short, polite, and to the point.`
    : `You are ${name}, an AI assistant working on behalf of ${principal}. The operator will give you specific objectives for each call. Stay focused on the objective and don't go beyond what was asked.`;

  // Task listing + how-to guidance only render for EA assistants. Custom
  // assistants get their objective from per-call operator input, so inlining
  // canned task instructions would confuse the prompt.
  const taskListing = answers.type === "ea" && tasks.length > 0
    ? `\n\nWhat you can help with:\n${tasks.map((id) => `- ${TASK_LABELS[id] ?? id}`).join("\n")}`
    : "";

  const taskHowTo = answers.type === "ea" && taskBullets
    ? `\n\nHow to handle each task:\n${taskBullets}`
    : "";

  const customSection = customTasks
    ? `\n\nAdditional context the operator provided:\n${customTasks}`
    : "";

  const callingStyle = `\n\nCalling style:
- Speak in short, natural sentences. You are on a phone call, not in a chat.
- One question at a time. Wait for the person to answer.
- If you're put on hold, stay quiet and wait.
- If you reach voicemail, leave a brief, polite message identifying who you are, who you're calling for, and how to reach back. Then end the call.
- Don't make commitments on behalf of ${principal} that go beyond what you've been told.`;

  const systemPrompt = `${intro}${taskListing}${taskHowTo}${customSection}${callingStyle}`;

  return { firstMessage, systemPrompt };
}
