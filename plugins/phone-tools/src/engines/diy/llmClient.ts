/**
 * Provider-neutral LLM HTTP client used by the DIY phone engine to drive
 * conversation turns. NO SDK dependency — pure fetch + JSON. The plugin
 * must stay LLM-SDK-agnostic per the operator's portfolio rule (no
 * @anthropic-ai/sdk or openai package imports).
 *
 * Two providers wired:
 *   - "anthropic"   POST https://api.anthropic.com/v1/messages
 *   - "openai"      POST https://api.openai.com/v1/chat/completions
 *
 * Both produce a non-streaming full-response. v0.6.0 chooses simplicity
 * over latency; streaming-into-TTS lands in v0.6.x once the basic
 * turn-by-turn path is verified.
 */

export type LlmProvider = "anthropic" | "openai";

export interface LlmTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LlmClientOpts {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  /** Max tokens in the assistant reply. Defaults to 256 (phone-appropriate). */
  maxTokens?: number;
}

export async function llmComplete(
  opts: LlmClientOpts,
  systemPrompt: string,
  history: LlmTurn[],
): Promise<string> {
  if (opts.provider === "anthropic") {
    return llmCompleteAnthropic(opts, systemPrompt, history);
  }
  if (opts.provider === "openai") {
    return llmCompleteOpenAI(opts, systemPrompt, history);
  }
  throw new Error(`[ELLM_PROVIDER_UNKNOWN] Unknown LLM provider "${opts.provider as string}"`);
}

async function llmCompleteAnthropic(
  opts: LlmClientOpts,
  systemPrompt: string,
  history: LlmTurn[],
): Promise<string> {
  const url = "https://api.anthropic.com/v1/messages";
  const messages = history
    .filter((h) => h.role !== "system")
    .map((h) => ({ role: h.role, content: h.content }));
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 256,
    system: systemPrompt,
    messages,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[ELLM_ANTHROPIC_${res.status}] ${text.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = (data.content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
  return text.trim();
}

async function llmCompleteOpenAI(
  opts: LlmClientOpts,
  systemPrompt: string,
  history: LlmTurn[],
): Promise<string> {
  const url = "https://api.openai.com/v1/chat/completions";
  const messages = [
    { role: "system", content: systemPrompt },
    ...history
      .filter((h) => h.role !== "system")
      .map((h) => ({ role: h.role, content: h.content })),
  ];
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 256,
    messages,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[ELLM_OPENAI_${res.status}] ${text.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Default model per provider — used when the AssistantConfig doesn't
 * specify one. Anthropic default is Claude Haiku 4.5 (fast, cheap, ample
 * for phone-call turn responses). OpenAI default is gpt-4o-mini.
 */
export function defaultModelFor(provider: LlmProvider): string {
  if (provider === "anthropic") return "claude-haiku-4-5-20251001";
  if (provider === "openai") return "gpt-4o-mini";
  return "";
}
