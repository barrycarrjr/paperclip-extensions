/**
 * The reply writer, with the agent replaced by a stand-in that records the
 * prompt and streams back whatever a test wants.
 *
 * What matters: the prompt carries the review and the public-posting rules,
 * the answer is read out of the runner's result envelope rather than out of
 * the surrounding log, the session is always closed, and a run that says
 * nothing useful fails with a sentence rather than putting harness output
 * in the reply box.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildReplyPrompt,
  cleanReply,
  extractAgentAnswer,
  extractReply,
  generateReplyWithAgent,
  pickReplyAgent,
} from "./aiReply.js";

// en-dash and em-dash, built from code points so this file carries neither.
const LONG_DASHES = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");

const INPUT = {
  businessName: "Example Print Shop",
  reviewerName: "Pat Customer",
  rating: 2,
  reviewText: "Slow service and my order was late.",
};

/**
 * What a run really streams, taken from a live run on 2026-10-21: a line of
 * harness preamble, then the runner's own JSON lines. Returning this text
 * as the reply is the exact bug these tests pin down.
 */
const PREAMBLE =
  '[paperclip] No project or prior session workspace was available. Using fallback workspace "C:\\Users\\x" for this run.\n' +
  '{"type":"system","subtype":"init","tools":["Task","Bash","Read"]}\n';

/** The runner's result envelope, which is the only place the answer is trusted from. */
function resultLine(result: string): string {
  return JSON.stringify({ type: "result", uuid: "u", result }) + "\n";
}

/** An agent that emits the given chunks, then reports the run finished. */
function fakeAgent(
  script: Array<{ stream?: string; message?: string; eventType?: string }>,
  opts: { silent?: boolean } = {},
) {
  const calls = { created: 0, closed: 0, prompts: [] as string[] };
  const ctx = {
    agents: {
      sessions: {
        async create() {
          calls.created++;
          return { sessionId: "session-1", agentId: "agent-1", companyId: "c", status: "active", createdAt: "" };
        },
        async sendMessage(
          _sessionId: string,
          _companyId: string,
          opt: { prompt: string; onEvent?: (e: unknown) => void },
        ) {
          calls.prompts.push(opt.prompt);
          if (!opts.silent) {
            for (const [i, step] of script.entries()) {
              opt.onEvent?.({
                sessionId: "session-1",
                runId: "run-1",
                seq: i,
                eventType: step.eventType ?? "chunk",
                stream: step.stream ?? "stdout",
                message: step.message ?? null,
                payload: null,
              });
            }
            opt.onEvent?.({
              sessionId: "session-1",
              runId: "run-1",
              seq: 99,
              eventType: "done",
              stream: "system",
              message: null,
              payload: null,
            });
          }
          return { runId: "run-1" };
        },
        async close() {
          calls.closed++;
        },
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return { ctx: ctx as unknown as Parameters<typeof generateReplyWithAgent>[0]["ctx"], calls };
}

test("the prompt carries the review, the rating, the rules and the owner's instructions", () => {
  const prompt = buildReplyPrompt({ ...INPUT, instructions: "Sign as The Example team." });
  assert.match(prompt, /Example Print Shop/);
  assert.match(prompt, /Reviewer: Pat Customer/);
  assert.match(prompt, /Rating: 2 out of 5/);
  assert.match(prompt, /my order was late/);
  assert.match(prompt, /apologise plainly/);
  assert.match(prompt, /Do not promise refunds/);
  assert.match(prompt, /Sign as The Example team\./);
  assert.match(prompt, /"reply"/);
  assert.doesNotMatch(prompt, LONG_DASHES);
});

test("a draft is handed over to be improved rather than replaced", () => {
  const prompt = buildReplyPrompt({ ...INPUT, draft: "Thanks Pat, sorry about that." });
  assert.match(prompt, /Keep its meaning and improve it/);
  assert.match(prompt, /Thanks Pat, sorry about that\./);
  assert.match(buildReplyPrompt({ ...INPUT, reviewText: null }), /no written text/);
});

test("the reply comes from the result envelope, never from the harness preamble", async () => {
  const agent = fakeAgent([
    { message: PREAMBLE },
    { message: resultLine('{"reply": "Thanks Pat, we are sorry the order ran late."}') },
  ]);
  const text = await generateReplyWithAgent({ ctx: agent.ctx, companyId: "c", agentId: "agent-1" }, INPUT);
  assert.equal(text, "Thanks Pat, we are sorry the order ran late.");
  assert.doesNotMatch(text, /fallback workspace/);
  assert.equal(agent.calls.created, 1);
  assert.equal(agent.calls.closed, 1, "the session is closed");
  assert.match(agent.calls.prompts[0]!, /Rating: 2 out of 5/);
});

test("an answer that lands after the run reports finishing is still picked up", async () => {
  // The run's status and its output come down separate channels, so the
  // finished event regularly beats the last lines of output.
  const calls = { closed: 0 };
  const ctx = {
    agents: {
      sessions: {
        async create() {
          return { sessionId: "s", agentId: "a", companyId: "c", status: "active", createdAt: "" };
        },
        async sendMessage(_s: string, _c: string, opt: { onEvent?: (e: unknown) => void }) {
          const emit = (eventType: string, message: string | null, stream = "stdout") =>
            opt.onEvent?.({ sessionId: "s", runId: "r", seq: 0, eventType, stream, message, payload: null });
          emit("chunk", PREAMBLE);
          emit("done", null, "system");
          setTimeout(() => emit("chunk", resultLine('{"reply": "Late but here."}')), 10);
          return { runId: "r" };
        },
        async close() {
          calls.closed++;
        },
      },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as Parameters<typeof generateReplyWithAgent>[0]["ctx"];

  const text = await generateReplyWithAgent({ ctx, companyId: "c", agentId: "a" }, INPUT);
  assert.equal(text, "Late but here.");
  assert.equal(calls.closed, 1);
});

test("output on another stream is ignored, so tool noise cannot become the reply", async () => {
  const agent = fakeAgent([
    { stream: "stderr", message: resultLine('{"reply": "from stderr"}') },
    { stream: "stdout", message: resultLine('{"reply": "from stdout"}') },
  ]);
  const text = await generateReplyWithAgent({ ctx: agent.ctx, companyId: "c", agentId: "agent-1" }, INPUT);
  assert.equal(text, "from stdout");
});

test("an agent that errors, says nothing useful, or never answers each fails with its own sentence", async () => {
  const errored = fakeAgent([{ eventType: "error", stream: "system", message: "adapter refused" }]);
  await assert.rejects(
    () => generateReplyWithAgent({ ctx: errored.ctx, companyId: "c", agentId: "agent-1" }, INPUT),
    /\[EAI_AGENT_ERROR\].*adapter refused/,
  );
  assert.equal(errored.calls.closed, 1, "closed even after an error");

  // Preamble and nothing else. This is what used to reach the reply box.
  const preambleOnly = fakeAgent([{ message: PREAMBLE }]);
  await assert.rejects(
    () => generateReplyWithAgent({ ctx: preambleOnly.ctx, companyId: "c", agentId: "agent-1" }, INPUT),
    /\[EAI_EMPTY\]/,
  );

  const blank = fakeAgent([{ message: resultLine("   ") }]);
  await assert.rejects(
    () => generateReplyWithAgent({ ctx: blank.ctx, companyId: "c", agentId: "agent-1" }, INPUT),
    /\[EAI_EMPTY\]/,
  );

  const silent = fakeAgent([], { silent: true });
  await assert.rejects(
    () => generateReplyWithAgent({ ctx: silent.ctx, companyId: "c", agentId: "agent-1", timeoutMs: 20 }, INPUT),
    /\[EAI_TIMEOUT\]/,
  );
  assert.equal(silent.calls.closed, 1, "closed after a timeout, so nothing is left open");
});

test("the answer comes from the last result envelope, and log noise is not an answer", () => {
  assert.equal(extractAgentAnswer(PREAMBLE), null, "preamble alone is not an answer");
  assert.equal(extractAgentAnswer(PREAMBLE + resultLine("hello")), "hello");
  assert.equal(extractAgentAnswer(resultLine("first") + resultLine("second")), "second");
  // A truncated trailing line cannot take the answer down with it.
  assert.equal(extractAgentAnswer(resultLine("kept") + '{"type":"result","result":'), "kept");
});

test("extractReply reads the asked-for object, a fence, or the agent's own prose", () => {
  assert.equal(extractReply(resultLine('{"reply": "first"} then {"reply": "second"}')), "second");
  assert.equal(extractReply(resultLine('```json\n{"reply": "fenced"}\n```')), "fenced");
  assert.equal(extractReply(resultLine("Just the words, no JSON.")), "Just the words, no JSON.");
  assert.equal(extractReply(PREAMBLE), null);
  assert.equal(extractReply("   "), null);
});

test("cleanReply strips wrappers and long dashes", () => {
  const dashed = "Thanks Pat" + String.fromCharCode(0x2014) + "see you soon.";
  assert.equal(cleanReply(dashed), "Thanks Pat, see you soon.");
  assert.equal(cleanReply("Response:  'Hello there.'"), "Hello there.");
  assert.doesNotMatch(cleanReply(dashed), LONG_DASHES);
});

test("the agent to ask is chosen predictably, and unavailable ones are skipped", () => {
  const agents = [
    { id: "a", name: "Chief Financial Officer", role: "cfo", status: "idle" },
    { id: "b", name: "Review Responder", role: "general", status: "idle" },
    { id: "c", name: "CEO", role: "ceo", status: "idle" },
  ];
  assert.equal(pickReplyAgent(agents)!.id, "b", "a reviews agent wins on name");
  assert.equal(pickReplyAgent([agents[0]!, agents[2]!])!.id, "c", "then role order, ceo last");
  assert.equal(
    pickReplyAgent([{ id: "x", name: "Review Responder", role: "general", status: "paused" }, agents[2]!])!.id,
    "c",
    "a paused agent is skipped even when its name matches",
  );
  assert.equal(pickReplyAgent([{ id: "y", name: "Mike", role: "assistant", status: "terminated" }]), null);
  assert.equal(pickReplyAgent([]), null);
});
