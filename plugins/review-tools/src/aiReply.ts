/**
 * A reply written by one of the company's own agents.
 *
 * It goes through `ctx.agents.sessions`, the same path the notepad plugin
 * uses, so the words are produced by whatever adapter that agent already
 * runs on and are billed and rate limited exactly like every other agent
 * run in Paperclip. The earlier version of this file carried its own
 * provider setting and API key, which was wrong: it asked an operator to
 * find and paste a second credential for a capability the instance already
 * has, and it put the plugin outside the agent accounting everything else
 * goes through.
 *
 * The prompt is deliberately narrow. The text goes on a public Google
 * listing under the business's name, so it must not promise refunds, blame
 * the customer, invent facts, or run long. The template in draftReply.ts
 * remains the fallback when no agent can be reached, and the person always
 * reads and can edit the text before anything is posted.
 */
import type { AgentSessionEvent, PluginContext } from "@paperclipai/plugin-sdk";

/** Long enough for a careful short answer, short enough that a wedged run is not a hang. */
export const REPLY_TIMEOUT_MS = 90_000;

/**
 * How long to keep reading after the run reports it finished.
 *
 * The run's status and its output arrive on separate channels, so the
 * "finished" event regularly lands before the last lines of output. Settling
 * on the status alone captured only the harness preamble and put that in the
 * reply box, which is what this grace period exists to prevent.
 */
export const TRAILING_OUTPUT_GRACE_MS = 4_000;

const MAX_REPLY_WORDS = 120;

export interface AiReplyInput {
  businessName: string;
  reviewerName: string;
  /** 1 to 5. */
  rating: number;
  reviewText: string | null;
  /** The person's own edits so far, if any; the agent improves rather than replaces. */
  draft?: string | null;
  /** Tone, sign-off, things never to say. From the plugin settings. */
  instructions?: string;
}

/** The whole prompt. One message, because a reply needs no conversation. */
export function buildReplyPrompt(input: AiReplyInput): string {
  const stars = Math.max(1, Math.min(5, Math.round(input.rating)));
  const lines = [
    `Write a short public reply to a Google review of ${input.businessName}.`,
    "",
    `Reviewer: ${input.reviewerName || "Anonymous"}`,
    `Rating: ${stars} out of 5`,
    `Review: ${input.reviewText && input.reviewText.trim() ? input.reviewText.trim() : "(no written text, just the star rating)"}`,
  ];
  if (input.draft && input.draft.trim()) {
    lines.push("", "The owner has started a reply. Keep its meaning and improve it:", input.draft.trim());
  }
  lines.push(
    "",
    "The reply is posted publicly under the business's name, so:",
    `- Keep it under ${MAX_REPLY_WORDS} words. Two or three sentences is usually right.`,
    "- Thank the reviewer by first name if a name is given, never by full name.",
    "- Refer to one specific thing they mentioned, so it reads as written for them.",
    "- For four or five stars: warm, specific and brief. Invite them back once at most.",
    "- For three stars or fewer: apologise plainly, do not argue, do not explain internal reasons, and invite them to contact the business directly so it can be put right. Do not promise refunds, discounts or outcomes.",
    "- Never mention competitors, pricing, staff names, or anything not in the review.",
    "- No hashtags, no emoji, no long dashes.",
    "- Plain everyday words. Do not sound like a template or a press release.",
  );
  if (input.instructions && input.instructions.trim()) {
    lines.push("", "Instructions from the business owner:", input.instructions.trim());
  }
  lines.push(
    "",
    'Answer with JSON and nothing else, in the form {"reply": "the reply text"}.',
    "Do not use a code fence. Do not add any commentary before or after the JSON.",
  );
  return lines.join("\n");
}

/**
 * The agent's final answer out of its run output.
 *
 * The output is the run's whole log: a line of harness preamble, then one
 * JSON object per line from the agent runner, the last of which is its
 * result envelope carrying the answer as a string. Only that envelope is
 * trusted. Earlier attempts read the raw text, which meant the preamble
 * ("No project or prior session workspace was available...") could be
 * returned as the reply.
 */
export function extractAgentAnswer(raw: string): string | null {
  let answer: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; result?: unknown; subtype?: unknown };
      // The last result line wins: a run that retried itself leaves the
      // answer it settled on last.
      if (parsed.type === "result" && typeof parsed.result === "string") answer = parsed.result;
    } catch {
      // A partial or non-JSON line is just log noise.
    }
  }
  return answer;
}

/**
 * The reply text out of whatever the agent streamed back.
 *
 * Two layers: the runner's result envelope, then the JSON object this
 * plugin asked the agent for inside it. If the envelope holds prose rather
 * than that object, the prose is used, because by then it is the agent's
 * own answer and not harness output. Anything else is refused rather than
 * guessed at: this text is headed for a public listing.
 */
export function extractReply(raw: string): string | null {
  const answer = extractAgentAnswer(raw);
  if (answer === null) return null;

  const text = answer.trim();
  if (!text) return null;

  const candidates: string[] = [];
  const pattern = /\{[^{}]*"reply"\s*:\s*"(?:[^"\\]|\\.)*"[^{}]*\}/g;
  for (const match of text.matchAll(pattern)) candidates.push(match[0]);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!) as { reply?: unknown };
      if (typeof parsed.reply === "string" && parsed.reply.trim()) return cleanReply(parsed.reply);
    } catch {
      // Try the one before it.
    }
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]!.trim() : text;
  const cleaned = cleanReply(body);
  return cleaned || null;
}

/** Strip the wrappers an answer sometimes arrives in. */
export function cleanReply(text: string): string {
  let out = text.trim();
  const unquote = (s: string) =>
    (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1).trim() : s;
  out = unquote(out);
  out = out.replace(/^(reply|response)\s*:\s*/i, "");
  out = unquote(out);
  // Long dashes are never wanted on a public post; the prompt says so too.
  out = out.replace(/\s*[–—]\s*/g, ", ");
  return out.trim();
}

interface AgentLike {
  id: string;
  name?: string;
  status?: string;
  role?: string;
}

/**
 * Which agent to ask, when the settings do not name one.
 *
 * Preference order, and it is deliberately boring: an agent whose name says
 * it handles reviews, then a general-purpose one, then the assistant, then
 * the CEO. Paused and terminated agents are skipped because a session
 * against one is refused, and being skipped silently is better than an
 * error about an agent the operator did not choose.
 */
export function pickReplyAgent(agents: AgentLike[]): AgentLike | null {
  const usable = agents.filter((a) => a.status !== "paused" && a.status !== "terminated");
  const byName = usable.find((a) => /review/i.test(a.name ?? ""));
  if (byName) return byName;
  const order = ["general", "assistant", "chief-of-staff", "ceo"];
  for (const role of order) {
    const match = usable.find((a) => a.role === role);
    if (match) return match;
  }
  return usable[0] ?? null;
}

type SessionCtx = Pick<PluginContext, "agents" | "logger">;

export interface GenerateDeps {
  ctx: SessionCtx;
  companyId: string;
  agentId: string;
  timeoutMs?: number;
}

/**
 * Ask the agent for the reply and return its text.
 *
 * The session is always closed, including on a timeout, so a slow run does
 * not leave one open behind the page.
 */
export async function generateReplyWithAgent(deps: GenerateDeps, input: AiReplyInput): Promise<string> {
  const { ctx, companyId, agentId } = deps;
  const timeoutMs = deps.timeoutMs ?? REPLY_TIMEOUT_MS;

  let sessionId: string | null = null;
  try {
    const session = await ctx.agents.sessions.create(agentId, companyId, {
      reason: "review-tools: write a review reply",
    });
    sessionId = session.sessionId;

    let buffer = "";
    let streamError: string | null = null;
    let settle: (() => void) | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finished = new Promise<void>((resolve) => {
      settle = () => {
        clearTimeout(graceTimer);
        resolve();
      };
    });

    const onEvent = (event: AgentSessionEvent) => {
      if (event.eventType === "chunk" && event.stream === "stdout" && event.message) {
        buffer += event.message;
        // The answer can arrive before or after the run reports finishing,
        // so stop as soon as there is one either way.
        if (extractReply(buffer)) settle?.();
      } else if (event.eventType === "error") {
        streamError = event.message ?? "the agent run reported an error";
        settle?.();
      } else if (event.eventType === "done") {
        // Not settled here: the last lines of output usually follow this.
        if (extractReply(buffer)) settle?.();
        else if (!graceTimer) graceTimer = setTimeout(() => settle?.(), TRAILING_OUTPUT_GRACE_MS);
      }
    };

    await ctx.agents.sessions.sendMessage(sessionId, companyId, {
      prompt: buildReplyPrompt(input),
      reason: "review-tools: write a review reply",
      onEvent,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([finished.then(() => "done" as const), timedOut]);
      if (outcome === "timeout") {
        throw new Error(
          `[EAI_TIMEOUT] ${agentLabel(agentId)} did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again, or write the reply by hand.`,
        );
      }
    } finally {
      clearTimeout(timer);
    }

    if (streamError) throw new Error(`[EAI_AGENT_ERROR] The agent could not write a reply: ${streamError}`);

    const reply = extractReply(buffer);
    if (!reply) {
      ctx.logger.warn("review-tools: the agent returned nothing usable for a reply", {
        agentId,
        head: buffer.slice(0, 240),
      });
      throw new Error("[EAI_EMPTY] The agent returned no reply text. Try again, or write the reply by hand.");
    }
    return reply;
  } finally {
    if (sessionId) {
      await ctx.agents.sessions.close(sessionId, companyId).catch(() => {
        // A session that will not close is not worth failing a reply over.
      });
    }
  }
}

function agentLabel(agentId: string): string {
  return `The agent (${agentId.slice(0, 8)})`;
}
