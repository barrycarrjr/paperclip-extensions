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
  /**
   * Email capability — when on, the system prompt tells the assistant
   * it can also read, draft, and send mail. The actual transport is
   * the `email-tools` plugin, whose MCP tools the assistant inherits
   * through the standard plugin grant — no per-assistant wiring needed.
   */
  emailEnabled?: boolean;
  /**
   * Calendar capability — when on, the system prompt tells the
   * assistant it can schedule, reschedule, and decline events via
   * the `google-workspace` plugin's calendar tools.
   */
  calendarEnabled?: boolean;
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
  "gather-information":
    "When you're calling to gather information, ask the specific questions you were sent to ask, take detailed notes (prices, dates, names, hours, availability, specs — whatever was requested), confirm anything ambiguous before hanging up, and thank them. After the call ends, deliver the full findings back so the operator has everything needed to act on it.",
};

const TASK_LABELS: Record<string, string> = {
  "schedule-meetings": "Schedule meetings",
  "take-messages": "Take messages",
  "confirm-appointments": "Confirm appointments",
  "follow-up": "Follow up after calls",
  "gather-information": "Gather information",
};

function trimTrailingPunctuation(name: string): string {
  return name.replace(/[.\s]+$/, "");
}

/**
 * Per-call substitution of the `{the reason for call}` placeholder that
 * `composeAssistant` emits in the wizard-generated firstMessage.
 *
 * Phone calls are placed via the `phone_call_make` tool; the calling agent
 * passes a per-call `reason` (e.g. "getting a price on a golf cart"). At
 * call-initiation the plugin reads the assistant's stored firstMessage,
 * runs it through this function, and ships the result as a
 * `firstMessageOverride` in `StartCallInput` so the engine speaks the
 * substituted text instead of the literal placeholder.
 *
 * If no reason is provided, the entire sentence containing the placeholder
 * is stripped so the call still opens cleanly ("Hi, this is Alex. Is this
 * a good moment to talk?") — speaking the literal token would be worse
 * than dropping the clause entirely.
 *
 * If the firstMessage doesn't contain the placeholder (operator edited it
 * to a fixed greeting), the function returns it unchanged.
 */
export function substituteCallReason(firstMessage: string, reason?: string | null): string {
  if (!firstMessage.includes("{the reason for call}")) return firstMessage;
  const trimmed = (reason ?? "").trim();
  if (!trimmed) {
    // Drop the whole sentence containing the placeholder. Replace with a
    // single space rather than empty, otherwise the [^.!?]* on the left
    // eats the space before the placeholder-sentence and the sentences
    // either side get glued together ("Alex.Is this...").
    return firstMessage
      .replace(/[^.!?]*\{the reason for call\}[^.!?]*[.!?]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return firstMessage.replace(/\{the reason for call\}/g, trimmed);
}

export function composeAssistant(answers: AssistantWizardAnswers): ComposedAssistant {
  const name = trimTrailingPunctuation((answers.name ?? "").trim()) || "Alex";
  const principal = trimTrailingPunctuation((answers.principal ?? "").trim()) || "the operator";
  const tasks = answers.tasks ?? [];
  const customTasks = (answers.customTasks ?? "").trim();

  // `{the reason for call}` is a wizard-time placeholder the operator is expected
  // to replace with the assistant's typical purpose (e.g. "the golf cart inquiry",
  // "your dental appointment") in the wizard's Review step before saving. The
  // engine speaks firstMessage verbatim, so leaving the placeholder unfilled
  // would cause the agent to literally say "the reason for call" on every call —
  // the wizard UI surfaces this as an editable field for that reason.
  const firstMessage =
    `Hi, this is ${name}. I'm calling regarding {the reason for call}. Is this a good moment to talk?`;

  const taskBullets = tasks
    .map((id) => TASK_INSTRUCTIONS[id])
    .filter((text): text is string => Boolean(text))
    .map((text) => `- ${text}`)
    .join("\n");

  const intro = answers.type === "ea"
    ? `You are ${name}, a personal executive assistant working on behalf of ${principal}. You help with phone calls — scheduling, confirming, taking messages, following up, and gathering information — and you keep things short, polite, and to the point.`
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

  const preflight = `\n\nBefore you place a call:
- Check you have what you need to complete the task — at minimum the phone number, and whatever specifics the call requires (an appointment time to confirm, a question to ask, a price range to negotiate).
- If anything required is missing or ambiguous, do NOT place the call with a hallucinated number or made-up details. Post one comment on the issue listing every gap (e.g. "I need the phone number for ACME Carts, and a target budget for the quote"), reassign the issue back to the reporter, and wait.
- Batch all questions in one round — multiple round-trips of one question each wastes ${principal}'s time.
- This only applies when missing info would cause a wrong outcome (wrong number, wrong person, wrong commitment). Tone and minor style choices don't count.`;

  const callingStyle = `\n\nCalling style:
- Speak in short, natural sentences. You are on a phone call, not in a chat.
- One question at a time. Wait for the person to answer.
- Don't volunteer ${principal}'s name on the call. Most people you're calling won't recognize it, and leading with it sounds odd. Introduce yourself as ${name}, an assistant calling on behalf of a client, and go straight to the reason for the call. Only share ${principal}'s name if the person specifically asks who you're calling for.
- You initiated this call. You are the inquiring party — you're seeking information or trying to accomplish a specific task. The person you're calling is the source of that information (a seller, a vendor, a receptionist, etc.) — they are NOT your customer. Don't ask them if they have questions for you, don't offer to help them with anything, and don't act like customer service. Stay in the role of the caller making an inquiry.
- Close the call directly. Once you've got the information or commitment you came for, thank them briefly ("Thanks, that's what I needed — have a good day.") and end the call. Don't fish for further conversation by asking "anything else?" or "is there anything else you'd like to share?" — that pattern belongs to inbound support calls, not outbound inquiries.
- If you're put on hold, stay quiet and wait.
- If you reach voicemail, leave a brief, polite message: identify yourself as ${name}, state the reason for the call (without naming ${principal}). Then end the call.
- Don't make commitments on behalf of ${principal} that go beyond what you've been told.`;

  // Capability sections — only render for channels actually enabled in
  // the wizard. Each section tells the assistant the channel exists,
  // names the plugin that provides the tools, and lays out a few
  // ground rules. The actual tool registration happens elsewhere:
  // installed plugins grant their MCP tools to every agent in the
  // company automatically.
  const channelSections: string[] = [];
  if (answers.emailEnabled) {
    channelSections.push(
      `Email channel — you can read, draft, and send email on behalf of ${principal} using the email-tools plugin.
- Always show ${principal} a draft before sending unless they've told you to send directly.
- Quote prior thread content rather than re-summarising it — the recipient already has the history.
- Keep subject lines short and accurate; no clickbait phrasing.
- For anything ambiguous or sensitive (money, legal, personal), draft only — never send autonomously.`,
    );
  }
  if (answers.calendarEnabled) {
    channelSections.push(
      `Calendar channel — you can schedule, reschedule, and decline events on ${principal}'s calendar using the google-workspace plugin's calendar tools.
- Confirm the time zone before booking.
- Default duration is 30 minutes unless told otherwise.
- Don't double-book over an existing event — propose adjacent slots instead.
- Include the meeting purpose in the event title so ${principal} can see at a glance what it is.`,
    );
  }
  const channelsBlock = channelSections.length
    ? `\n\nOther channels you can use (in addition to phone):\n\n${channelSections.join("\n\n")}`
    : "";

  const systemPrompt = `${intro}${taskListing}${taskHowTo}${customSection}${preflight}${callingStyle}${channelsBlock}`;

  return { firstMessage, systemPrompt };
}
